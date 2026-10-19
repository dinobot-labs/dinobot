import { Lexer, marked, type Token } from "marked";

export type RichPlatform = "telegram" | "slack";
type Span = { text: string; styles: string[] };
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Only public web links. Credentials, control characters, non-web schemes and oversized targets stay literal. */
export function safeLink(href: string): boolean {
 try { const u = new URL(href); return href.length <= 512 && /^https?:\/\//i.test(href) && !/[\s<>"'|`\\\x00-\x1f]/.test(href) && ["https:", "http:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}

/** Discord retains native Markdown except unsafe link targets, which use its existing plain-text attachment fallback. */
export function hasUnsafeLinks(source: string): boolean {
 let unsafe = false;
 try { marked.walkTokens(Lexer.lex(source), t => { if ((t.type === "link" || t.type === "image") && !safeLink(t.href)) unsafe = true; }); } catch { return true; }
 return unsafe;
}

/** Reuse marked lexer; never invoke its HTML renderer. Unsupported constructs retain their original source. */
function spans(source: string): Span[] {
 const out: Span[] = [];
 const add = (text: string, styles: string[] = []) => { if (text) out.push({ text, styles }); };
 const walk = (tokens: Token[] = [], styles: string[] = [], depth = 0) => {
  if (depth > 32) throw new RangeError("Markdown nesting");
  for (const t of tokens) {
   switch (t.type) {
    case "strong": case "em": case "del": walk(t.tokens, [...styles, t.type], depth + 1); break;
    case "codespan": add(t.text, ["code"]); break;
    case "code": add(t.text, ["pre"]); add("\n"); break;
    case "heading": walk(t.tokens, ["strong"], depth + 1); add("\n"); break;
    case "paragraph": walk(t.tokens, styles, depth + 1); add(/\n+$/.exec(t.raw)?.[0] ?? ""); break;
    case "text": if (t.tokens) walk(t.tokens, styles, depth + 1); else add(t.text, styles); break;
    case "escape": add(t.text, styles); break;
    case "link": {
     // Preserve both label and destination, without making unsafe destinations actionable.
     walk(t.tokens, styles, depth + 1); add(" (" + t.href + ")", safeLink(t.href) ? ["link:" + t.href] : ["code"]); break;
    }
    case "list":
     for (const item of t.items) { add(/^\s*(?:[-*+]|\d+[.)])\s+/.exec(item.raw)?.[0] ?? "• "); walk(item.tokens, styles, depth + 1); add(/\n+$/.exec(item.raw)?.[0] ?? "\n"); }
     break;
    case "br": add("\n"); break;
    case "space": add(t.raw); break;
    default: add(t.raw, styles);
   }
  }
 };
 walk(Lexer.lex(source));
 return out;
}

/** Inspect lexer provenance before Slack-generated delimiters erase it. */
export function hasSlackLiterals(source: string): boolean {
 try { return spans(source).some(s => s.styles.includes("code") ? s.text.includes("`")
   : s.styles.includes("pre") ? s.text.includes("```") : /[*_~`]/.test(s.text)); }
 catch { return true; }
}

function wrappers(platform: RichPlatform, span: Span): [string, string] {
 let open = "", close = "";
 for (const style of span.styles) {
  let pair: [string, string] | undefined;
  if (platform === "telegram") {
   const tag = ({strong:"b",em:"i",del:"s",code:"code",pre:"pre"} as Record<string,string>)[style];
   if (tag) pair = ["<" + tag + ">", "</" + tag + ">"];
   else if (style.startsWith("link:")) pair = ['<a href="' + escape(style.slice(5)) + '">', "</a>"];
  } else {
   const mark = ({strong:"*",em:"_",del:"~",code:"`",pre:"```"} as Record<string,string>)[style];
   // Slack has no escape for backticks inside code; retain literal text rather than generate an unbalanced fence.
   if (mark && !span.text.includes(mark)) pair = [mark, mark];
   else if (style.startsWith("link:")) pair = ["<" + escape(style.slice(5)) + "|", ">"];
  }
  if (pair) { open += pair[0]; close = pair[1] + close; }
 }
 return [open, close];
}

/** Each chunk is independently balanced. UTF-16 length includes escaping and wrappers; never split a scalar/entity. */
export function renderRichText(source: string, platform: RichPlatform, limit = platform === "telegram" ? 4096 : 3000): string[] {
 if (limit < 1024) throw new RangeError("rich text chunk limit");
 let parts: Span[];
 try { parts = spans(source); } catch { parts = [{ text: source, styles: [] }]; }
 const result: string[] = []; let chunk = "";
 for (const span of parts) {
  let [open, close] = wrappers(platform, span);
  // An escaped URL (or deeply nested styles) can itself exceed the whole chunk.
  // Degrade that span to escaped literal payload, rather than emitting an oversized wrapper.
  if (open.length + close.length + 10 > limit) { open = ""; close = ""; }
  let body = "";
  const flush = () => { if (body) { chunk += open + body + close; body = ""; } };
  const units = Array.from(new Intl.Segmenter(undefined, {granularity:"grapheme"}).segment(span.text), part => part.segment);
  const atoms = units.flatMap(unit => escape(unit).length + open.length + close.length <= limit ? [unit] : [...unit]);
  for (const point of atoms) {
   const encoded = escape(point);
   if (chunk.length + open.length + body.length + encoded.length + close.length > limit) {
    flush(); if (chunk) result.push(chunk); chunk = "";
   }
   body += encoded;
  }
  flush();
 }
 if (chunk) result.push(chunk);
 return result.length ? result : ["(empty response)"];
}
