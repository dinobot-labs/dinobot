import type { JsonValue } from "@earendil-works/chord";
import { canonical, digest } from "./verification-execution.ts";

/** Policy v1: declarations, not an open-parenthesis heuristic. Offsets are UTF-16.
 * Strings/comments cannot introduce declarations or delimiters. Only colon type
 * annotations in def/function parameter lists are protected; defaults are values. */
export function parameterContext(source: string): {colons:Set<number>;defaults:Set<number>} {
 const mask=source.split(""); let quote="", comment="";
 for(let i=0;i<source.length;i++) {
  if(comment){
   if(comment==="line"&&source[i]==="\n"){comment="";continue;}
   if(comment==="block"&&source.slice(i,i+2)==="*/"){mask[i]=" ";mask[++i]=" ";comment="";continue;}
   mask[i]=" ";continue;
  }
  if(quote){
   if(source.slice(i,i+quote.length)===quote){for(let n=0;n<quote.length;n++)mask[i+n]=" ";i+=quote.length-1;quote="";continue;}
   mask[i]=" ";if(source[i]==="\\"&&i+1<mask.length)mask[++i]=" ";continue;
  }
  const c=source[i]!;
  if(c==="#"||source.slice(i,i+2)==="//"){comment="line";mask[i]=" ";continue;}
  if(source.slice(i,i+2)==="/*"){comment="block";mask[i]=" ";continue;}
  if(c===String.fromCharCode(34)||c===String.fromCharCode(39)||c===String.fromCharCode(96)){
   quote=source.slice(i,i+3)===c.repeat(3)?c.repeat(3):c;
   for(let n=0;n<quote.length;n++)mask[i+n]=" ";i+=quote.length-1;
  }
 }
 const code=mask.join(""); const colons=new Set<number>(), defaults=new Set<number>();
 for(const header of code.matchAll(/\b(?:def|function)\s*\*?\s+[A-Za-z_$][\w$]*\s*\(/g)) {
  const localColons=new Set<number>(), localDefaults=new Set<number>();
  let depth=1, nested=0, assigned=false, segment=header.index!+header[0].length;
  for(let i=segment;i<code.length&&depth;i++){const c=code[i]!;
   if(c==="("){depth++;continue;}if(c===")"){depth--;continue;}
   if(depth!==1)continue;
   if(c==="["||c==="{"){nested++;continue;}if(c==="]"||c==="}"){nested--;continue;}
   if(nested)continue;
   if(c===","){assigned=false;segment=i+1;continue;}
   if(c==="="){
    if(!assigned&&/^\s*\*{0,2}(?:api[_-]?key|password|authorization|secret|access[_-]?token)\s*:/i.test(code.slice(segment,i)))localDefaults.add(i);
    assigned=true;continue;
   }
   if(c===":"&&!assigned)localColons.add(i);
  }
  if(depth===0){for(const c of localColons)colons.add(c);for(const d of localDefaults)defaults.add(d);}
 }
 return {colons,defaults};
}
const privateNames=new Set("system systemprompt developerprompt privilegedprompt reasoning thinking thinkingsignature providersignature provideropaque providermetadata encryptedcontent apikey accesstoken refreshtoken token password secret authorization credentials customercontact customercontacts customeremail customerphone contactemail contactphone contacts".split(" "));
const privateTypes=new Set(["thinking","reasoning","redacted_thinking","opaque","provider_opaque"]);

/** Independent source-side policy projection. Never receives exporter omissions,
 * spans, exported trees or output hashes. It is NOT visibleValue/redactText. */
function policyText(source:string):string {
 const {colons:annotations,defaults}=parameterContext(source);
 const label=/\b(api[_-]?key|password|authorization|secret|access[_-]?token)([ \t]*)(=|:)([ \t]*)("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|Bearer\s+[^\s,;)\]}]+|[^\s,;)\]}]+)/gi;
 const changes:{start:number;end:number}[]=[];
 for(const eq of defaults){const tail=source.slice(eq+1);const m=/^\s*("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;)]+)/.exec(tail);if(m)changes.push({start:eq+1+m[0].length-m[1]!.length,end:eq+1+m[0].length});}
 let result="", end=0;
 for(const m of source.matchAll(label)){
  const colon=m.index!+m[1]!.length+m[2]!.length;
  if(m[3]===":"&&annotations.has(colon))continue;
  const token=m[5]!; const standalone=/^[ \t]*$/.test(source.slice(source.lastIndexOf("\n",m.index!-1)+1,m.index));
  const quoted=token.startsWith(String.fromCharCode(34))||token.startsWith(String.fromCharCode(39));
  if(m[3]===":"&&!quoted&&!/^Bearer\s/i.test(token)&&(!standalone||/^(str|string|int|number|bool|boolean|bytes|None|unknown|any)\b/.test(token)))continue;
  const start=m.index!+m[0].length-token.length;changes.push({start,end:m.index!+m[0].length});
 }
 for(const c of changes.sort((a,b)=>a.start-b.start)){if(c.start<end)continue;result+=source.slice(end,c.start)+"[credential omitted]";end=c.end;}
 result+=source.slice(end);
 return result.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,"[contact omitted]").replace(/\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,})\b/g,"[credential omitted]");
}
export function permittedSource(value:JsonValue):JsonValue|undefined {
 if(Array.isArray(value))return value.map(v=>permittedSource(v)??null);
 if(value&&typeof value==="object"){
  if(value.role==="system"||value.role==="developer"||(typeof value.type==="string"&&privateTypes.has(value.type)))return undefined;
  if(value.type==="image"||value.type==="audio"||value.type==="file")return {type:value.type,descriptor:true,hash:digest(value),mimeType:typeof value.mimeType==="string"?value.mimeType:"unknown"};
  const out:Record<string,JsonValue>={};
  for(const [key,v] of Object.entries(value)){if(privateNames.has(key.replace(/[-_]/g,"").toLowerCase()))continue;const expected=permittedSource(v);if(expected!==undefined)out[key]=expected;}return out;
 }
 if(typeof value!=="string")return value;
 if(/^\s*[\[{]/.test(value)){let parsed:JsonValue;try{parsed=JSON.parse(value);}catch(error){if(!(error instanceof SyntaxError))throw error;return policyText(value);}const expected=permittedSource(parsed);if(canonical(parsed)!==canonical(expected))return expected===undefined?undefined:JSON.stringify(expected);}
 return policyText(value);
}
