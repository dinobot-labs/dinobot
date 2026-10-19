import { posix } from "node:path";

/** Bounded lexical analysis, NOT a shell interpreter. Unsupported syntax is evidence loss. */
export const SHELL_LIMIT = 16000;
const TOKEN_LIMIT = 512;
const NEWLINE = String.fromCharCode(10);
type Word = { text: string; dynamic: boolean };
type Command = { words: Word[]; before: string; redirected: boolean };
export type RiskKind = "push" | "publish" | "delete";
export type ShellAnalysis = { risky: string[]; riskKinds: RiskKind[]; verifier: string | null; checkSucceeded: boolean; checkFailureAttributable: boolean; unknown: string[] };
const literal = (w: Word | undefined) => w && !w.dynamic ? w.text : undefined;
export const scratchPath = (p: string) => p.startsWith("/") && posix.normalize(p).startsWith("/tmp/");

function lex(source: string): { commands: Command[]; unknown: string[] } {
 const commands: Command[] = []; const unknown: string[] = [];
 if (source.length > SHELL_LIMIT) return { commands, unknown: ["length_limit"] };
 let words: Word[] = [], word = "", dynamic = false, started = false, quote = "", before = "", count = 0, redirected = false;
 const flush = () => { if (started) { words.push({text:word,dynamic}); count++; } word=""; dynamic=false; started=false; };
 const end = (op: string) => { flush(); if(words.length) commands.push({words,before,redirected}); words=[]; before=op; redirected=false; };
 for(let i=0;i<source.length;i++) {
  const c=source[i]!;
  if(count > TOKEN_LIMIT) { unknown.push("token_limit"); return {commands:[],unknown}; }
  if(quote === "'") { if(c === "'") quote=""; else word+=c; continue; }
  if(c === "\\" && source[i+1] !== undefined) { const next=source[++i]!; if(next !== NEWLINE) {word+=next;started=true;} continue; }
  if(c === '"') { quote = quote === '"' ? "" : '"'; started=true; continue; }
  if(!quote && c === "'") { quote=c; started=true; continue; }
  // Never look inside substitutions, grouping, heredocs or compound control syntax.
  if(c.charCodeAt(0) < 32 && c !== NEWLINE && c.charCodeAt(0) !== 9) return {commands:[],unknown:['control_character']};
  if(c === '$' && source[i+1] === '(') { unknown.push('substitution'); return {commands,unknown}; }
  if(c.charCodeAt(0) === 96 || (!quote && /[(){}]/.test(c))) { unknown.push("compound_syntax"); return {commands,unknown}; }
  if(c === '$' || (!quote && /[*?\[~]/.test(c))) dynamic=true;
  if(quote) { word+=c; continue; }
  if(c === '#' && !started) { while(i<source.length && source[i] !== NEWLINE) i++; end(';'); continue; }
  if(c === ' ' || c === '\t') { flush(); continue; }
  if(c === ';' || c === NEWLINE || c === '|' || c === '&') {
   let op = c === NEWLINE ? ';' : c;
   if(source[i+1] === c && (c === '|' || c === '&')) {op+=c;i++;}
   end(op); if(op === '|' || op === '&' || op === '||') unknown.push("control_flow"); continue;
  }
  if(c === '<' || c === '>') {
   redirected=true;
   // Discard targets as arguments, but retain potential pre-execution failure.
   // File effects remain unknown.
   if(/^\d+$/.test(word)) { word='';started=false; } else flush();
   if(source[i+1] === '<') return {commands,unknown:[...unknown,"heredoc"]};
   if(source[i+1] === '>') i++;
   if(source[i+1] === '&') {i++; if(!/[012]/.test(source[i+1] ?? '')) unknown.push("redirect"); else i++;continue;}
   while(source[i+1] === ' ') i++;
   let target=''; while(i+1<source.length && !/[\s;&|]/.test(source[i+1]!)) target+=source[++i];
   // Only literal targets are modeled. Never swallow executable syntax (backticks,
   // process substitution, etc.) as a harmless input filename.
   if(!/^[A-Za-z0-9_./:=@+-]+$/.test(target)) unknown.push("redirect");
   if(c === '>' && target !== '/dev/null') unknown.push("redirect_effect");
   continue;
  }
  started=true; word+=c;
 }
 if(quote) return {commands:[],unknown:[...unknown,"unclosed_quote"]};
 end('');
 return {commands,unknown};
}

function unwrap(words: Word[]): Word[] {
 let out=words.slice();
 while(out.length && /^[A-Za-z_][\w]*=/.test(out[0]!.text)) out.shift();
 if(literal(out[0]) === 'env') { out.shift(); while(out.length && /^[A-Za-z_][\w]*=/.test(out[0]!.text)) out.shift(); }
 if(literal(out[0]) === 'command' || literal(out[0]) === 'time') out.shift();
 if(literal(out[0]) === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(literal(out[1]) ?? '')) out=out.slice(2);
 return out;
}
/** Only command and subcommand positions can identify checks. Arguments are never scanned for prose. */
function check(words: Word[]): string | null {
 const [head,...args]=words.map(w=>literal(w));
 if(!head || args.some(a=>a === undefined)) return null;
 const a=args as string[];
 if(a.some(arg=>['--help','-h','--version','--collect-only','--listTests','--list-tests','--watch','-w','--showConfig'].includes(arg))) return null;
 if(['bun','npm','pnpm','yarn'].includes(head)) {
  const sub=a[0] === 'run' ? a[1] : a[0];
  if(sub === 'test') return 'test';
  if(sub === 'typecheck' || sub === 'check') return 'typecheck';
  if(sub === 'lint') return 'lint';
 }
 if(['pytest','vitest','jest'].includes(head) || ['cargo','go'].includes(head) && a[0] === 'test') return 'test';
 if(['tsc','mypy','pyright'].includes(head) || head === 'cargo' && a[0] === 'check' || head === 'go' && a[0] === 'vet') return 'typecheck';
 if(['eslint','ruff','shellcheck'].includes(head) || head === 'biome' && ['check','lint'].includes(a[0] ?? '')) return 'lint';
 if(['bash','sh','zsh'].includes(head) && a[0] === '-n' || head === 'node' && a[0] === '--check' || /^python3?$/.test(head) && a[0] === '-m' && a[1] === 'py_compile' || head === 'luac' && a[0] === '-p' || head === 'jq' && (a[0] === '.' || a[0] === '-e' && a[1] === '.')) return 'syntax';
 if(['jsonlint','tomllint','yamllint'].includes(head) || head === 'nginx' && a[0] === '-t' || head === 'hyprctl' && a[0] === 'configerrors' || head === 'ghostty' && a[0] === '+validate-config') return 'config';
 return null;
}
const READ_COMMANDS = new Set(['printf','echo','cat','head','tail','ls','pwd','rg','grep','wc','stat','true','false','sleep','diff','sort','uniq','cut','which','date']);
export function analyzeShell(source: string): ShellAnalysis {
 const parsed=lex(source); const unknown=parsed.unknown; const risky:string[]=[]; const riskKinds:RiskKind[]=[];
 const risk = (action: string, kind: RiskKind) => { risky.push(action); riskKinds.push(kind); };
 let cwd: string | null = null, verifier: string | null = null, checkSucceeded=true;
 let cwdChanged=false, cwdUncertain=false;
 for(const c of parsed.commands) {
  const words=unwrap(c.words); const head=literal(words[0]); const args=words.slice(1);
  if(c.before && c.before !== '&&') {
   checkSucceeded=false;
   // A separator does not restore the initial cwd. Without successful cd evidence,
   // retain the whole source as action identity rather than grant bare-command authority.
   if(cwdChanged) { cwdUncertain=true; unknown.push('cwd_control_flow'); }
   cwd=null;
  }
  if(!head) { if(words.length) unknown.push('dynamic_command'); continue; }
  if(words.some(w=>w.dynamic)) unknown.push('dynamic_word');
  // Keep word boundaries, wrappers and a known cwd in action identity; joining bare words can grant the wrong target.
  const render = (value: string) => /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value);
  const action = cwdUncertain ? source : (cwd ? 'cd ' + render(cwd) + ' && ' : '') + c.words.map(w=>render(w.text)).join(' ');
  const cls=check(words); verifier ??= cls;
  if(cls) continue;
  if(head === 'cd') { const dest=literal(args[0]); cwdChanged=true; cwd=dest?.startsWith('/') ? posix.normalize(dest) : dest && cwd ? posix.resolve(cwd,dest) : null; if(!cwd) { cwdUncertain=true; unknown.push('cwd'); } continue; }
  if(head === 'rm') {
   const flags=args.filter(w=>w.text.startsWith('-')).map(w=>w.text);
   const recursive=flags.some(f=>f === '--recursive' || /^-[^-]*[rR]/.test(f));
   const targets=args.filter(w=>!w.text.startsWith('-'));
   if(!targets.length || targets.some(w=>w.dynamic)) { unknown.push('rm_target'); continue; }
   if(recursive && targets.some(w=>!scratchPath(w.text.startsWith('/') ? w.text : cwd ? posix.resolve(cwd,w.text) : w.text))) risk(action,'delete');
   else if(!recursive) unknown.push('rm_effect');
   continue;
  }
  if(head === 'git') {
   let i=0; while(['-C','-c','--git-dir','--work-tree'].includes(literal(args[i]) ?? '') && literal(args[i+1])) i+=2;
   const sub=literal(args[i]);
   if(sub === 'push' || sub === 'reset' && args.slice(i+1).some(w=>literal(w) === '--hard')) risk(action,sub === 'push' ? 'push' : 'delete');
   else if(!['status','diff','log','show','rev-parse','ls-files','ls-tree','grep'].includes(sub ?? '')) unknown.push('git_effect');
   continue;
  }
  if(['npm','bun','pnpm','yarn'].includes(head) && literal(args[0]) === 'publish') { risk(action,'publish');continue; }
  if(!READ_COMMANDS.has(head)) unknown.push('unmodeled_command');
 }
 // Nonzero compound status cannot identify which command failed. Redirection
 // setup can also fail before a verifier executes, even for literal targets.
 // Neither ambiguity invalidates successful checks in otherwise supported syntax.
 const checkFailureAttributable = parsed.commands.length === 1 && !parsed.commands[0]!.redirected && check(parsed.commands[0]!.words) !== null && unknown.length === 0;
 return {risky,riskKinds,verifier,checkSucceeded:verifier !== null && checkSucceeded && unknown.length === 0,checkFailureAttributable,unknown:[...new Set(unknown)]};
}
