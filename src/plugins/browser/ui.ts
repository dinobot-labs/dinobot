/** Desktop-only contract. These commands are deliberately not browser_use actions. */
export interface BrowserTab { index: number; title: string; url: string; owned: boolean }
export interface BrowserViewState {
 connected: boolean; mode: "dedicated" | "attach"; control: "agent" | "user";
 tabs: BrowserTab[]; current: number; url: string; title: string; width: number; height: number; frame?: string;
 dialog?: { type: string; message: string };
}
export interface ChromeProfile { id: string; name: string }
export interface BrowserReply { ok: boolean; error?: string; text?: string; state?: BrowserViewState; profiles?: ChromeProfile[]; imported?: number; skipped?: number }
export type UiInput = { kind: "click"; x: number; y: number; button: "left" | "right" | "middle" } | { kind: "text"; text: string } | { kind: "key"; key: string } | { kind: "wheel"; dx: number; dy: number };

export function validateUiInput(args: Record<string, unknown>): UiInput {
 const bad = (): never => { throw new Error("InvalidArguments: invalid desktop browser input"); };
 const only = (names: string[]) => { if (Object.keys(args).some((key) => !names.includes(key))) bad(); };
 const finite = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
 switch (args.kind) {
  case "click": {
   only(["kind", "x", "y", "button"]);
   const button = args.button ?? "left";
   if (!finite(args.x, 0, 8192) || !finite(args.y, 0, 8192) || !["left", "right", "middle"].includes(String(button))) return bad();
   return { kind: "click", x: args.x, y: args.y, button: button as "left" | "right" | "middle" };
  }
  case "text":
   only(["kind", "text"]);
   if (typeof args.text !== "string" || args.text.length > 20_000) return bad();
   return { kind: "text", text: args.text };
  case "key":
   only(["kind", "key"]);
   if (typeof args.key !== "string" || !/^[\x20-\x7e]{1,100}$/.test(args.key)) return bad();
   return { kind: "key", key: args.key };
  case "wheel":
   only(["kind", "dx", "dy"]);
   if (!finite(args.dx, -10_000, 10_000) || !finite(args.dy, -10_000, 10_000)) return bad();
   return { kind: "wheel", dx: args.dx, dy: args.dy };
  default: return bad();
 }
}

export async function bounded<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
 finally { clearTimeout(timer); }
}
