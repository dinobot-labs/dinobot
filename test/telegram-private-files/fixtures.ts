import { chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** Expose ONLY disposable fake test files. chmod is not a Windows security boundary. */
export function exposePrivateFixture(path: string): void {
 if (process.platform === "win32") execFileSync(join(process.env.SystemRoot ?? "C:/Windows", "System32", "icacls.exe"), [path, "/grant", "*S-1-1-0:(R)"], { windowsHide:true, stdio:"pipe" });
 else chmodSync(path, 0o644);
}
