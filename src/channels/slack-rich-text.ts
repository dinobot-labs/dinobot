import { chunks } from "./messaging.ts";
import { hasSlackLiterals, renderRichText } from "./rich-text.ts";

/** Slack cannot escape unmatched style delimiters reliably: fail closed to a native plain_text section. */
export function slackTextObject(text: string, original?: string): { type: "mrkdwn"; text: string; verbatim: true } | { type: "plain_text"; text: string } {
 if (original !== undefined && hasSlackLiterals(original)) return {type:"plain_text",text:original};
 const stack: string[] = [];
 for (const match of text.matchAll(/```|`|\*|_|~/g)) {
  const mark = match[0]; const top = stack.at(-1);
  if ((top === "`" || top === "```") && mark !== top) continue;
  if (top === mark) stack.pop(); else stack.push(mark);
 }
 if (!stack.length) return { type: "mrkdwn", text, verbatim: true };
 return { type: "plain_text", text: original ?? text.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&") };
}

/** Persist the native text-object type with each final chunk, not just ambiguous generated text. */
export function renderSlackText(source: string): string[] {
 const rich=renderRichText(source,"slack");
 const objects=rich.map(text=>slackTextObject(text,source));
 const chosen=objects.some(o=>o.type === "plain_text")
  ? chunks(source,3000).map(text=>({type:"plain_text" as const,text})) : objects;
 return chosen.map(o=>"\u0000slack:"+JSON.stringify(o));
}
export function storedSlackText(part: string): ReturnType<typeof slackTextObject> {
 // Legacy ready rows have no provenance: show their stored payload literally.
 return part.startsWith("\u0000slack:") ? JSON.parse(part.slice(7)) : {type:"plain_text",text:part};
}
