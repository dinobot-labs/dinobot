/** Handle-based Windows ACL I/O. Loaded only on Windows; no shell, credential argv or path-based ACL race. */
import { createRequire } from "node:module";

// GetCurrentProcess() pseudo-handle: unsigned -1, NOT a memory address.
const CURRENT_PROCESS_HANDLE = 0xffffffffffffffffn;

let implementation: ReturnType<typeof load> | undefined;
export function windowsPrivateFiles() { return implementation ??= load(); }

function load() {
 if (!["x64", "arm64"].includes(process.arch)) throw new Error("Unsupported Windows private-file ABI");
 const { dlopen, FFIType: T, ptr, read } = createRequire(import.meta.url)("bun:ffi") as typeof import("bun:ffi");
 const abi = windowsPrivateFileABI(T);
 const kernel = dlopen("kernel32.dll", abi.kernel);
 const security = dlopen("advapi32.dll", abi.security);
 const k = kernel.symbols, s = security.symbols;
 const wide = (value: string) => { if (value.includes("\0")) throw new Error(); return Buffer.from(value + "\0", "utf16le"); };
 const pointer = (value: BigUint64Array) => Number(value[0]) as ReturnType<typeof ptr>;
 const slot = () => new BigUint64Array(1);
 function sidString(sid: ReturnType<typeof ptr>): string {
  const out = slot();
  if (!s.ConvertSidToStringSidW(sid, ptr(out))) throw new Error();
  const address = pointer(out);
  try {
   let result = "";
   for (let i = 0; i < 256; i++) { const c = read.u16(address, i * 2); if (!c) return result; result += String.fromCharCode(c); }
   throw new Error();
  } finally { k.LocalFree(address); }
 }
 function currentSid(): string {
  const token = slot();
  if (!s.OpenProcessToken(CURRENT_PROCESS_HANDLE, 8, ptr(token))) throw new Error(); // TOKEN_QUERY, current process
  const handle = requireWindowsHandle(token[0]!);
  try {
   const size = new Uint32Array(1);
   s.GetTokenInformation(handle, 1, null, 0, ptr(size)); // TokenUser
   if (!size[0] || size[0] > 65536) throw new Error();
   const info = new Uint8Array(size[0]);
   if (!s.GetTokenInformation(handle, 1, ptr(info), info.length, ptr(size))) throw new Error();
   return sidString(read.ptr(ptr(info)) as ReturnType<typeof ptr>);
  } finally { k.CloseHandle(handle); }
 }
 const user = currentSid();
 const trusted = new Set([user, "S-1-5-18", "S-1-5-32-544"]); // user, SYSTEM, Administrators
 function regular(handle: bigint, limit: number): void {
  const info = new Uint32Array(13); // BY_HANDLE_FILE_INFORMATION
  if (k.GetFileType(handle) !== 1 || !k.GetFileInformationByHandle(handle, ptr(info))) throw new Error();
  if ((info[0]! & (0x10 | 0x400)) !== 0 || info[8] !== 0 || info[9]! > limit) throw new Error(); // directory/reparse, high/low size
 }
 function validateAcl(handle: bigint): void {
  const owner = slot(), dacl = slot(), descriptor = slot();
  if (s.GetSecurityInfo(handle, 1, 5, ptr(owner), null, ptr(dacl), null, ptr(descriptor)) !== 0) throw new Error();
  try {
   if (!owner[0] || sidString(pointer(owner)) !== user || !dacl[0]) throw new Error();
   const info = new Uint32Array(3);
   if (!s.GetAclInformation(pointer(dacl), ptr(info), 12, 2) || !info[0]) throw new Error();
   for (let i = 0; i < info[0]; i++) {
    const ace = slot();
    if (!s.GetAce(pointer(dacl), i, ptr(ace))) throw new Error();
    const address = pointer(ace), type = read.u8(address);
    // Fail closed on object/callback/unknown ACEs rather than approximating effective access.
    if (type !== 0 && type !== 1) throw new Error();
    if (type === 0 && !trusted.has(sidString((address + 8) as ReturnType<typeof ptr>))) throw new Error();
   }
  } finally { k.LocalFree(pointer(descriptor)); }
 }
 function open(path: string, write: boolean, attributes: ReturnType<typeof ptr> | null = null) {
  const name = wide(path);
  const handle = k.CreateFileW(ptr(name), write ? 0xC0000000 : 0x80000000, write ? 0 : 1, attributes, write ? 1 : 3, 0x00200080, 0n);
  return requireWindowsHandle(handle);
 }
 return {
  read(path: string, limit: number): string {
   const handle = open(path, false);
   try {
    regular(handle, limit); validateAcl(handle);
    const bytes = Buffer.alloc(limit + 1), count = new Uint32Array(1);
    let size = 0;
    while (size < bytes.length) {
     if (!k.ReadFile(handle, ptr(bytes.subarray(size)), bytes.length - size, ptr(count), null)) throw new Error();
     if (!count[0]) break;
     size += count[0];
    }
    if (size > limit) throw new Error();
    return bytes.subarray(0, size).toString("utf8");
   } finally { k.CloseHandle(handle); }
  },
  create(path: string, text: string): void {
   // A protected DACL is supplied to CREATE_NEW, before even the first sensitive byte exists.
   const descriptor = slot(), sddl = wide("O:" + user + "D:P(A;;FA;;;" + user + ")");
   if (!s.ConvertStringSecurityDescriptorToSecurityDescriptorW(ptr(sddl), 1, ptr(descriptor), null)) throw new Error();
   try {
    const attributes = new Uint8Array(24), view = new DataView(attributes.buffer);
    view.setUint32(0, 24, true); view.setBigUint64(8, descriptor[0]!, true);
    const handle = open(path, true, ptr(attributes));
    try {
     regular(handle, 0); validateAcl(handle);
     const bytes = Buffer.from(text), count = new Uint32Array(1);
     let offset = 0;
     while (offset < bytes.length) {
      if (!k.WriteFile(handle, ptr(bytes.subarray(offset)), bytes.length - offset, ptr(count), null) || !count[0]) throw new Error();
      offset += count[0];
     }
     if (!k.FlushFileBuffers(handle)) throw new Error();
    } finally { k.CloseHandle(handle); }
   } finally { k.LocalFree(pointer(descriptor)); }
  },
 };
}

/** Opaque HANDLEs use u64; ptr is ONLY for memory addresses.
 * https://bun.sh/docs/runtime/ffi#pointers (Windows Note).
 * Shared declarations let the regression exercise the actual production ABI. */
export function windowsPrivateFileABI(T: typeof import("bun:ffi").FFIType) {
 return {
  kernel: {
  CreateFileW: { args: [T.ptr,T.u32,T.u32,T.ptr,T.u32,T.u32,T.u64], returns:T.u64 },
  CloseHandle: { args:[T.u64], returns:T.i32 },
  GetFileInformationByHandle: { args:[T.u64,T.ptr], returns:T.i32 },
  GetFileType: { args:[T.u64], returns:T.u32 },
  ReadFile: { args:[T.u64,T.ptr,T.u32,T.ptr,T.ptr], returns:T.i32 },
  WriteFile: { args:[T.u64,T.ptr,T.u32,T.ptr,T.ptr], returns:T.i32 },
  FlushFileBuffers: { args:[T.u64], returns:T.i32 },
  LocalFree: { args:[T.ptr], returns:T.ptr },
  },
  security: {
  OpenProcessToken: { args:[T.u64,T.u32,T.ptr], returns:T.i32 },
  GetTokenInformation: { args:[T.u64,T.u32,T.ptr,T.u32,T.ptr], returns:T.i32 },
  ConvertSidToStringSidW: { args:[T.ptr,T.ptr], returns:T.i32 },
  ConvertStringSecurityDescriptorToSecurityDescriptorW: { args:[T.ptr,T.u32,T.ptr,T.ptr], returns:T.i32 },
  GetSecurityInfo: { args:[T.u64,T.u32,T.u32,T.ptr,T.ptr,T.ptr,T.ptr,T.ptr], returns:T.u32 },
  GetAclInformation: { args:[T.ptr,T.ptr,T.u32,T.u32], returns:T.i32 },
  GetAce: { args:[T.ptr,T.u32,T.ptr], returns:T.i32 },
  },
 } as const;
}

/** Validate file/token handles without lossy Number conversion.
 * The process pseudo-handle is valid only as OpenProcessToken input. */
export function requireWindowsHandle(handle: bigint | null): bigint {
 if (handle === null || handle <= 0n || handle >= CURRENT_PROCESS_HANDLE) throw new Error();
 return handle;
}
