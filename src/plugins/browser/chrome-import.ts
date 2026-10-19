import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BrowserContext, BrowserType } from "patchright";
import { devToolsEndpoint, parseDevToolsActivePort } from "./shared.ts";
import { bounded, type BrowserReply, type ChromeProfile } from "./ui.ts";

class ChromeImportError extends Error {}

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,80}$/;
async function smallFile(path: string, limit: number): Promise<string> {
 const file = await open(path, "r");
 try {
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > limit) throw new Error("oversized file");
  const buffer = Buffer.alloc(limit + 1); let size = 0;
  while (size < buffer.length) { const { bytesRead } = await file.read(buffer, size, buffer.length - size, null); if (!bytesRead) break; size += bytesRead; }
  if (size > limit) throw new Error("oversized file");
  return buffer.subarray(0, size).toString("utf8");
 } finally { await file.close(); }
}
/** Passive discovery: Local State profile labels only, never account names, emails, passwords or cookie databases. */
export async function chromeProfiles(root: string): Promise<ChromeProfile[]> {
 let state: { profile?: { info_cache?: unknown } };
 try { state = JSON.parse(await smallFile(join(root, "Local State"), 4 * 1024 * 1024)); }
 catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("ChromeProfilesUnavailable: Chrome 프로필 목록을 읽을 수 없습니다."); }
 const info = state?.profile?.info_cache;
 if (!info || typeof info !== "object" || Array.isArray(info)) return [];
 return Object.entries(info).filter(([id]) => PROFILE_ID.test(id)).slice(0, 100).map(([id, meta]) => {
  const label = meta && typeof meta === "object" ? (meta as Record<string, unknown>).name : undefined;
  return { id, name: typeof label === "string" && label.trim() && !label.includes("@") ? label.slice(0, 100) : id };
 });
}
export function profileMatches(actual: string, root: string, id: string, platform = process.platform): boolean {
 if (!PROFILE_ID.test(id)) return false;
 const normalize = (path: string) => { const p = resolve(path.trim()).replace(/[\\/]+$/, ""); return platform === "win32" ? p.toLowerCase() : p; };
 return normalize(actual) === normalize(join(root, id));
}
type Cookie = Parameters<BrowserContext["addCookies"]>[0][number];
function cookieForTarget(raw: unknown): Cookie | undefined {
 if (!raw || typeof raw !== "object") return undefined;
 const c = raw as Record<string, unknown>;
 if (typeof c.name !== "string" || typeof c.value !== "string" || typeof c.domain !== "string" || typeof c.path !== "string" || c.name.length > 4096 || c.value.length > 65536 || c.domain.length > 1024 || c.path.length > 4096 || !c.domain || !c.path.startsWith("/") || c.partitionKey !== undefined || c.partitionKeyOpaque === true) return undefined;
 if (typeof c.expires !== "number" || !Number.isFinite(c.expires) || (c.expires > 0 && c.expires < Date.now() / 1000)) return undefined;
 const sameSite = ["Strict", "Lax", "None"].includes(String(c.sameSite)) ? c.sameSite as "Strict" | "Lax" | "None" : undefined;
 return { name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.session === true || c.expires <= 0 ? -1 : c.expires, httpOnly: c.httpOnly === true, secure: c.secure === true, ...(sameSite ? { sameSite } : {}) };
}

/** Read decrypted cookies ONLY through the running Chrome CDP API after proving the selected profile.
 * No encrypted DB reads, copied profiles, protection bypasses, password export or cookie-bearing errors. */
export async function importChromeCookies(root: string, args: Record<string, unknown>, chromium: Pick<BrowserType, "connectOverCDP">, target: () => Promise<BrowserContext>): Promise<BrowserReply> {
 if (args.confirmed !== true || typeof args.profile !== "string" || !PROFILE_ID.test(args.profile)) throw new ChromeImportError("ChromeImportBlocked: 가져올 프로필을 선택하고 명시적으로 동의해 주세요.");
 if (!(await chromeProfiles(root)).some((p) => p.id === args.profile)) throw new ChromeImportError("ChromeImportBlocked: 선택한 Chrome 프로필을 찾을 수 없습니다.");
 let endpoint: string;
 try { const active = parseDevToolsActivePort(await smallFile(join(root, "DevToolsActivePort"), 4096)); if (!active) throw new Error(); endpoint = devToolsEndpoint(active); }
 catch { throw new ChromeImportError("ChromeImportBlocked: 실행 중인 Chrome에서 원격 디버깅을 허용해야 합니다. 보호된 로그인 정보는 우회하여 읽지 않습니다."); }
 const browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 }).catch(() => { throw new ChromeImportError("ChromeImportBlocked: Chrome 연결이 거부되었거나 사용자 허용이 필요합니다."); });
 let page: Awaited<ReturnType<BrowserContext["newPage"]>> | undefined;
 try {
  const source = browser.contexts()[0];
  if (!source) throw new ChromeImportError("ChromeImportBlocked: Chrome 프로필에 접근할 수 없습니다.");
  page = await source.newPage();
  await page.goto("chrome://version", { waitUntil: "domcontentloaded", timeout: 5000 });
  const actual = await page.locator("#profile_path").innerText({ timeout: 3000 });
  if (!profileMatches(actual, root, args.profile)) throw new ChromeImportError("ChromeProfileMismatch: 실행 중인 Chrome 프로필이 선택한 프로필과 다릅니다. 해당 프로필의 Chrome을 실행해 주세요.");
  const cdp = await source.newCDPSession(page);
  let raw: unknown[];
  try { raw = (await bounded(cdp.send("Storage.getCookies"), 5000, "Chrome cookie read timed out")).cookies; } finally { await bounded(cdp.detach(), 1500, "Chrome disconnect timed out").catch(() => {}); }
  if (!Array.isArray(raw) || raw.length > 20_000 || JSON.stringify(raw).length > 16 * 1024 * 1024) throw new ChromeImportError("ChromeImportBlocked: 로그인 데이터가 허용 크기를 초과했습니다.");
  const cookies = raw.map(cookieForTarget).filter((c): c is Cookie => c !== undefined);
  if (cookies.length) await (await target()).addCookies(cookies);
  return { ok: true, imported: cookies.length, skipped: raw.length - cookies.length, text: "쿠키 기반 로그인 정보를 가져왔습니다. 비밀번호·패스키는 가져오지 않으며 일부 사이트는 재로그인이 필요합니다." };
 } catch (error) {
  if (error instanceof ChromeImportError) throw error;
  throw new ChromeImportError("ChromeImportBlocked: 로그인 정보를 가져오지 못했습니다. Chrome 보호 기능을 우회하지 않습니다. 일부 사이트는 다시 로그인해야 합니다.");
 } finally { if (page) await bounded(page.close(), 1500, "Chrome temporary tab close timed out").catch(() => {}); await bounded(browser.close(), 1500, "Chrome disconnect timed out").catch(() => {}); }
}
