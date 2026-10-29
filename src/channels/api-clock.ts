/** Shared unslewed clock. Physical guarantees are conditional on protocol P2/P3 (upper rate 1001/1000). */
import { readFileSync, readlinkSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

export type GateClock = { readonly frame: string; readonly rate: readonly [bigint, bigint]; observeNs(): bigint; readonly exact?: boolean; timer(fn: () => void, ms: number): () => void };
export class GateUnavailable extends Error { override name = "GateUnavailable"; }
export function safe(n: bigint): number {
 if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new GateUnavailable("API clock/integer range");
 return Number(n);
}
export function integer(n: number): bigint {
 if (!Number.isSafeInteger(n) || n < 0) throw new GateUnavailable("Corrupt API integer");
 return BigInt(n);
}
export function add(a: number, b: number): number { return safe(integer(a) + integer(b)); }
export function interval(ms: number, rate: readonly [bigint, bigint]): number {
 const [p,q] = rate;
 if (p < 0n || q <= 0n) throw new GateUnavailable("Invalid API clock rate");
 return safe(((q+p)*integer(ms)+q-1n)/q);
}
export function enclosure(ns: bigint, exact = false): {lo: number; hi: number} {
 if (typeof ns !== "bigint" || ns < 0n) throw new GateUnavailable("Invalid native clock value");
 const q = ns / 1000000n;
 if (exact && ns % 1000000n !== 0n) throw new GateUnavailable("Noninteger exact test clock");
 return {lo: safe(q), hi: safe(q + (exact ? 0n : 1n))};
}
let native: (() => bigint) | undefined;
/** Deliberately lazy: importing generic channels never loads ffi or libc. No wall/hrtime fallback. */
export function systemClock(): GateClock {
 if (process.platform === "linux" && ["x64", "arm64"].includes(process.arch)) return linuxClock();
 if (process.platform === "win32" && process.arch === "x64") return windowsClock();
 if (process.platform === "darwin" && ["x64", "arm64"].includes(process.arch)) return darwinClock();
 throw new GateUnavailable("Unsupported native clock ABI");
}

let darwinNative: (() => bigint) | undefined;
let darwinIdentity: string | undefined;
/** Darwin LP64: CLOCK_UPTIME_RAW is unslewed, system-wide and excludes suspend (like Linux RAW).
 * The kernel boot UUID, not wall time minus uptime, identifies comparable persisted observations. */
function darwinClock(): GateClock {
 if (!darwinNative) {
  const { dlopen, FFIType, ptr } = createRequire(import.meta.url)("bun:ffi") as typeof import("bun:ffi");
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
   clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
   sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  });
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  const observe = () => {
   // Darwin clockid_t CLOCK_UPTIME_RAW=8; time_t and long are signed 64-bit on x64/arm64.
   if (library.symbols.clock_gettime(8, ptr(bytes)) !== 0) throw new GateUnavailable("clock_gettime failed");
   const s = view.getBigInt64(0, true), n = view.getBigInt64(8, true);
   if (s < 0n || n < 0n || n >= 1000000000n) throw new GateUnavailable("Invalid timespec");
   return s * 1000000000n + n;
  };
  observe(); // Fail before publishing a partial native implementation.
  let identity: string;
  try {
   const name = Buffer.from("kern.bootsessionuuid\0"), boot = Buffer.alloc(64), size = new BigUint64Array([64n]);
   if (library.symbols.sysctlbyname(ptr(name), ptr(boot), ptr(size), null, 0n) !== 0 || size[0] !== 37n || boot[36] !== 0) throw new Error("boot identity");
   identity = boot.subarray(0, 36).toString("ascii").toLowerCase();
   if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(identity)) throw new Error("boot identity");
  } catch { identity = "uncomparable:" + crypto.randomUUID(); }
  darwinIdentity = identity;
  darwinNative = observe;
 }
 return { frame: "darwin-uptime-raw-v1:" + darwinIdentity, rate: [1n, 1000n], observeNs: darwinNative, timer(fn, ms) { const t = setTimeout(fn, ms); return () => clearTimeout(t); } };
}

function linuxClock(): GateClock {
 if (!native) {
  const { dlopen, FFIType, ptr } = createRequire(import.meta.url)("bun:ffi") as typeof import("bun:ffi");
  const library = dlopen("libc.so.6", { clock_gettime: {args:[FFIType.i32, FFIType.ptr], returns:FFIType.i32} });
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  // Linux x64/arm64 glibc timespec: two signed 64-bit little-endian fields.
  native = () => {
   if (library.symbols.clock_gettime(4, ptr(bytes)) !== 0) throw new GateUnavailable("clock_gettime failed");
   const s = view.getBigInt64(0, true), n = view.getBigInt64(8, true);
   if (s < 0n || n < 0n || n >= 1000000000n) throw new GateUnavailable("Invalid timespec");
   return s*1000000000n+n;
  };
 }
 let identity: string;
 try {
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[0-9a-f-]{36}$/.test(boot)) throw new Error("boot identity");
  const a = "/proc/self/ns/time", b = "/proc/self/ns/time_for_children";
  let ns = "no-timens";
  if (existsSync(a) || existsSync(b)) {
   const id = readlinkSync(a);
   if (id !== readlinkSync(b)) throw new Error("inconsistent time namespace");
   const offsets = readFileSync("/proc/self/timens_offsets", "utf8");
   const lines = offsets.trim().split("\n");
   if (lines.length !== 2 || !lines.every(l => /^\s*(monotonic|boottime)\s+-?\d+\s+\d+\s*$/.test(l))) throw new Error("unverified time offsets");
   ns = id + ":" + offsets;
  }
  identity = JSON.stringify([boot,ns]);
 } catch { identity = "uncomparable:" + crypto.randomUUID(); }
 return {frame:"linux-glibc-raw-v3:"+identity, rate:[1n,1000n], observeNs:native, timer(fn,ms) { const t=setTimeout(fn,ms); return () => clearTimeout(t); }};
 }

 /** Windows x64: QPC is a monotonic system-wide counter; its rate is fixed after boot. */
 let winNative: (() => bigint) | undefined;
 let winIdentity: string | undefined;
 function windowsClock(): GateClock {
  if (!winNative) {
  const { dlopen, FFIType, ptr } = createRequire(import.meta.url)("bun:ffi") as typeof import("bun:ffi");
  const kernel32 = dlopen("kernel32.dll", {
   QueryPerformanceCounter: {args:[FFIType.ptr], returns:FFIType.i32},
   QueryPerformanceFrequency: {args:[FFIType.ptr], returns:FFIType.i32},
   GetSystemTimeAsFileTime: {args:[FFIType.ptr], returns:FFIType.void},
  });
  const counter = new BigInt64Array(1);
  const freq = new BigInt64Array(1);
  const filetime = new BigInt64Array(1);
  if (kernel32.symbols.QueryPerformanceFrequency(ptr(freq)) === 0) throw new GateUnavailable("QueryPerformanceFrequency failed");
  const hz = freq[0];
  if (hz === undefined || hz <= 0n) throw new GateUnavailable("Invalid QPC frequency");
  winNative = () => {
   if (kernel32.symbols.QueryPerformanceCounter(ptr(counter)) === 0) throw new GateUnavailable("QueryPerformanceCounter failed");
   const ticks = counter[0];
   if (ticks === undefined || ticks < 0n) throw new GateUnavailable("Invalid QPC counter");
   return (ticks*1000000000n)/hz;
  };
  // Reconstruct the boot instant (wall FILETIME minus QPC uptime) and bucket it to
  // 60 s: stable across restarts within one Windows session so persisted cooldowns
  // and spacing survive, and necessarily different after a real reboot. QPC drift
  // over days can move the bucket by at most seconds, which only ever discards a
  // soon-expiring hold - the gate treats a foreign frame as fresh by contract.
  kernel32.symbols.GetSystemTimeAsFileTime(ptr(filetime));
  const now = filetime[0];
  if (now === undefined || now <= 0n) throw new GateUnavailable("Invalid FILETIME");
  winIdentity = "boot:" + ((now - winNative()/100n)/600000000n).toString();
  }
  return {frame:"win-qpc-raw-v1:"+winIdentity, rate:[1n,1000n], observeNs:winNative, timer(fn,ms) { const t=setTimeout(fn,ms); return () => clearTimeout(t); }};
 }
