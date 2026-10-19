/** Fixed metadata only: neither a path nor free text is a secret-safe vocabulary. */
export function safePreview(args: unknown): string | undefined {
 if (!args || typeof args !== "object" || Array.isArray(args)) return;
 const a=args as Record<string,unknown>;
 for (const field of ["path","file_path"]) {
  const v=a[field];
  if (typeof v !== "string" || v.length > 200 || /(?:secret|token|credential|password|\.env|private|auth|key|sk[_-]|gh[pousr]_|AKIA)/i.test(v)) continue;
  // Emit only an extension category, never any user-supplied basename/directory.
  if (/\.(?:ts|tsx|js|jsx|json|md|txt)$/.test(v)) return "file (."+v.split(".").at(-1)+")";
 }
 if (typeof a.command === "string") {
  const match=/^(?:bun|npm|pnpm) (test|run (?:typecheck|build))(?=\s|$)/.exec(a.command);
  if (match) return match[0];
  if (/^git (status|diff|log)(?=\s|$)/.test(a.command)) return "git inspect";
 }
}
/** Untrusted/legacy hint values must pass the same fixed metadata vocabulary. */
export function safeHint(value: string): string | undefined {
 if (/^(?:(?:bun|npm|pnpm) (?:test|run (?:typecheck|build))|git inspect|file \(\.(?:ts|tsx|js|jsx|json|md|txt)\))$/.test(value)) return value;
 return safePreview({path:value});
}
export const TODO_SUMMARY = "step in progress";

/** Longest detail line (UTF-16 units) the core sends; the card clips again in code points. */
export const DETAIL_CHARS = 200;
/** Argument fields, in priority order, whose first line is the detailed hint (ADR 0057). */
const DETAIL_FIELDS = ["command", "path", "file_path", "pattern", "query", "url", "description", "key", "name", "prompt"] as const;
const SECRET_PATTERNS: readonly RegExp[] = [
 /\b(?:sk|rk|pk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{8,}/g,
 /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
 /\bAKIA[0-9A-Z]{12,}/g,
 /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
 /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
 /\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*\S+/gi,
 /\b[A-Za-z0-9+/=_-]{40,}\b/g,
];
/**
 * Best-effort masking of token-shaped substrings (ADR 0057). Not an allowlist and not a proof: the detailed card mode
 * accepts that ordinary file names, commands and queries are shown; callers who need the fixed vocabulary use safePreview.
 */
export function redactSecrets(text: string): string {
 let out = text;
 for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
 return out;
}
/** One line of the primary argument, control characters removed, secrets masked, at most DETAIL_CHARS units. */
export function detailPreview(args: unknown): string | undefined {
 if (!args || typeof args !== "object" || Array.isArray(args)) return;
 const a = args as Record<string, unknown>;
 for (const field of DETAIL_FIELDS) {
  const v = a[field];
  if (typeof v !== "string") continue;
  const line = redactSecrets(v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim());
  if (line === "") continue;
  return line.length > DETAIL_CHARS ? line.slice(0, DETAIL_CHARS - 1) + "…" : line;
 }
}
