import { expect, test } from "bun:test";
import { FFIType as T, JSCallback, linkSymbols } from "bun:ffi";
import { requireWindowsHandle, windowsPrivateFileABI } from "../../src/telegram-private-files/windows.ts";

const abi = windowsPrivateFileABI(T);
const allBits = (1n << 64n) - 1n;

test("Windows ABI distinguishes every opaque HANDLE from memory pointers", () => {
 expect(abi.kernel).toEqual({
  CreateFileW: { args:[T.ptr,T.u32,T.u32,T.ptr,T.u32,T.u32,T.u64], returns:T.u64 },
  CloseHandle: { args:[T.u64], returns:T.i32 },
  GetFileInformationByHandle: { args:[T.u64,T.ptr], returns:T.i32 },
  GetFileType: { args:[T.u64], returns:T.u32 },
  ReadFile: { args:[T.u64,T.ptr,T.u32,T.ptr,T.ptr], returns:T.i32 },
  WriteFile: { args:[T.u64,T.ptr,T.u32,T.ptr,T.ptr], returns:T.i32 },
  FlushFileBuffers: { args:[T.u64], returns:T.i32 },
  LocalFree: { args:[T.ptr], returns:T.ptr },
 });
 expect(abi.security).toEqual({
  OpenProcessToken: { args:[T.u64,T.u32,T.ptr], returns:T.i32 },
  GetTokenInformation: { args:[T.u64,T.u32,T.ptr,T.u32,T.ptr], returns:T.i32 },
  ConvertSidToStringSidW: { args:[T.ptr,T.ptr], returns:T.i32 },
  ConvertStringSecurityDescriptorToSecurityDescriptorW: { args:[T.ptr,T.u32,T.ptr,T.ptr], returns:T.i32 },
  GetSecurityInfo: { args:[T.u64,T.u32,T.u32,T.ptr,T.ptr,T.ptr,T.ptr,T.ptr], returns:T.u32 },
  GetAclInformation: { args:[T.ptr,T.ptr,T.u32,T.u32], returns:T.i32 },
  GetAce: { args:[T.ptr,T.u32,T.ptr], returns:T.i32 },
 });
});

test("HANDLE validation preserves all 64 bits and rejects null/invalid sentinels", () => {
 for (const value of [1n, (1n << 53n) + 1n, (1n << 63n) + 1n, allBits - 1n]) {
  expect(requireWindowsHandle(value)).toBe(value);
 }
 for (const value of [null, 0n, -1n, allBits]) {
  expect(() => requireWindowsHandle(value)).toThrow();
 }
});

test("production HANDLE signatures round-trip high bits through real Bun FFI", () => {
 // ABI probe only: synthetic opaque values must never be passed to Windows APIs.
 // Real file/token/ACL behavior is exercised separately by private-files.test.ts.
 let returned = 1n;
 const seen: bigint[] = [];
 const create = new JSCallback(() => returned, abi.kernel.CreateFileW);
 const close = new JSCallback((handle: bigint) => { seen.push(handle); return 1; }, abi.kernel.CloseHandle);
 const native = linkSymbols({
  CreateFileW: { ...abi.kernel.CreateFileW, ptr:create.ptr! },
  CloseHandle: { ...abi.kernel.CloseHandle, ptr:close.ptr! },
 });
 try {
  for (const value of [1n, (1n << 53n) + 1n, (1n << 63n) + 1n, allBits - 1n]) {
   returned = value;
   const handle = native.symbols.CreateFileW(null, 0, 0, null, 0, 0, 0n);
   expect(requireWindowsHandle(handle)).toBe(value);
   expect(native.symbols.CloseHandle(handle)).toBe(1);
   expect(seen.at(-1)).toBe(value);
  }
  for (const value of [0n, allBits]) {
   returned = value;
   expect(() => requireWindowsHandle(native.symbols.CreateFileW(null, 0, 0, null, 0, 0, 0n))).toThrow();
  }
 } finally { native.close(); close.close(); create.close(); }
});
