import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { windowsPrivateFiles } from "./windows.ts";

/** Read a small current-user-owned regular file, rejecting links and unsafe permissions.
 * Windows validates the DACL and reads through the SAME no-reparse native handle.
 * Existing input files are never chmod'ed or otherwise repaired implicitly. */
export function readPrivateFile(path: string, limit: number): string {
 try {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 65536) throw new Error();
  if (process.platform === "win32") return windowsPrivateFiles().read(resolve(path), limit);
  if (!lstatSync(path).isFile()) throw new Error();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
   const stat = fstatSync(fd);
   if (!stat.isFile() || stat.size > limit || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
   const bytes = Buffer.alloc(limit + 1);
   let size = 0;
   while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, null); if (!n) break; size += n; }
   if (size > limit) throw new Error();
   return bytes.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
 } catch { throw new Error("Private file must be a readable, small regular file owned by the current user with private permissions (POSIX mode 0600 or a private Windows ACL)."); }
}

/** Exclusive creation; access protection is established BEFORE data is written. Caller owns publication/cleanup. */
export function createPrivateFile(path: string, text: string): void {
 try {
  if (process.platform === "win32") { windowsPrivateFiles().create(resolve(path), text); return; }
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
 } catch { throw new Error("Unable to create private file securely"); }
}

/** Windows does not support Node directory fsync. File contents were flushed before publication. */
export function syncPrivateDirectory(path: string): void {
 if (process.platform === "win32") return;
 const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
 try { fsyncSync(fd); } finally { closeSync(fd); }
}
