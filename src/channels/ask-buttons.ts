import type { AskChoice, AskPrompt } from "./types.ts";

export const CHOICE_TOKEN = /^da:([0-9a-f]{32}):([0-3])$/;
const ID = /^[0-9a-f]{32}$/;
export function encodeChoice(askId: string, option: number): string {
 const token = `da:${askId}:${option}`;
 if (!CHOICE_TOKEN.test(token)) throw new Error("Invalid ask choice");
 return token;
}
export function decodeChoice(token: unknown): AskChoice | undefined {
 const match = typeof token === "string" ? CHOICE_TOKEN.exec(token) : null;
 return match ? { askId: match[1]!, option: Number(match[2]) } : undefined;
}
export function choiceLabel(ask: AskPrompt, option: number, index: number, total: number): string {
 const raw = ask.options[option]!;
 const points = Array.from(raw);
 return (total > 1 ? `Q${index + 1} ` : "") + points.slice(0, 60).join("") + (points.length > 60 ? "…" : "") + (raw === ask.default ? " (기본값)" : "");
}
export function choiceFallbackText(choice: AskChoice): string { return `[ask ${choice.askId}] choice #${choice.option + 1}`; }
export function parseAskChoice(value: unknown): AskChoice | undefined {
 if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
 const v = value as Record<string, unknown>;
 if (Object.keys(v).some((k) => k !== "askId" && k !== "option") || typeof v.askId !== "string" || !ID.test(v.askId) || typeof v.option !== "number" || !Number.isInteger(v.option) || v.option < 0 || v.option > 3) return undefined;
 return { askId: v.askId, option: v.option };
}
export function parseAskPrompts(value: unknown): AskPrompt[] | undefined {
 if (!Array.isArray(value) || value.length > 3) return undefined;
 const out: AskPrompt[] = [];
 for (const v of value) {
  if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.id !== "string" || !ID.test(v.id) || typeof v.question !== "string" || v.question.length > 4000 || !Array.isArray(v.options) || v.options.length < 2 || v.options.length > 4 || v.options.some((o: unknown) => typeof o !== "string" || o.length > 500 || !o.trim()) || new Set(v.options.map((o: string) => o.trim())).size !== v.options.length || typeof v.default !== "string" || v.default.length > 2000 || !Number.isInteger(v.deadlineAt)) return undefined;
  out.push({ id: v.id, question: v.question, options: [...v.options], default: v.default, deadlineAt: v.deadlineAt });
 }
 return out;
}
