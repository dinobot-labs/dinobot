import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, statSync, symlinkSync, chownSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { exposePrivateFixture } from "./fixtures.ts";
import { createPrivateFile, readPrivateFile } from "../../src/telegram-private-files/index.ts";
import { runTelegramSetup } from "../../src/cli/telegram-setup.ts";
import { telegramChannel } from "../../src/channels/telegram.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive:true, force:true }); });
function fixture() { const dir = mkdtempSync(join(tmpdir(), "telegram-private-")); dirs.push(dir); return { dir, token:join(dir,"token"), pairing:join(dir,"pairing.json") }; }
const fake = "123456:FAKE_credential_for_offline_tests_only";

test("private creation and bounded regular-file reading", () => {
 const f = fixture(); createPrivateFile(f.token, fake);
 expect(readPrivateFile(f.token,1024)).toBe(fake);
 expect(() => readPrivateFile(f.token,4)).toThrow("private permissions");
 expect(() => readPrivateFile(f.dir,1024)).toThrow();
 expect(() => createPrivateFile(f.token,"replace")).toThrow();
 expect(readFileSync(f.token,"utf8")).toBe(fake);
});

test("private token completes offline setup and runtime credential/pairing reads", async () => {
 const f = fixture(); createPrivateFile(f.token,fake);
 let code = "", polls = 0; const calls: string[] = [];
 await runTelegramSetup(["connect","--token-file",f.token,"--pairing-file",f.pairing], {
  output(line) { const match = /[?]start=([A-Za-z0-9_-]+)/.exec(line); if (match) code = match[1]!; expect(line).not.toContain(fake); },
  fetch: async url => {
   const method = new URL(url).pathname.split("/").pop()!; calls.push(method);
   return Response.json({ok:true,result: method === "getMe" ? {id:123456,is_bot:true,username:"FauxSetupBot"} : method === "getWebhookInfo" ? {url:""} : polls++ === 0 ? [{update_id:1,message:{from:{id:42,is_bot:false},chat:{id:42,type:"private"},text:"/start " + code}}] : []});
  },
 });
 expect(calls).toEqual(["getMe","getWebhookInfo","getUpdates","getUpdates"]);
 expect(JSON.parse(readPrivateFile(f.pairing,65536))).toEqual({botId:"123456",userId:"42",chatIds:["42"]});
 const channel = telegramChannel({mode:"polling",botTokenFile:f.token,pairingPath:f.pairing,databasePath:join(f.dir,"db.sqlite"),port:0});
 await channel.stop();
});

test.skipIf(process.platform !== "win32")("Windows exposed ACL fails closed in setup and runtime without disclosing secrets", async () => {
 const f = fixture(); createPrivateFile(f.token,fake);
 exposePrivateFixture(f.token);
 expect(() => readPrivateFile(f.token,1024)).toThrow("private permissions");
 let network = false;
 await expect(runTelegramSetup(["connect","--token-file",f.token,"--pairing-file",f.pairing],{fetch:async () => { network=true; throw new Error(); }})).rejects.toThrow();
 expect(network).toBe(false);
 expect(() => readPrivateFile(f.token,1024)).toThrow("private permissions"); // setup did not repair exposed ACL
 expect(() => telegramChannel({mode:"polling",botTokenFile:f.token,pairingPath:f.pairing,databasePath:join(f.dir,"db.sqlite"),port:0})).toThrow("Unable to read Telegram bot credential");
 expect(readFileSync(f.token,"utf8")).toBe(fake);
});

test.skipIf(process.platform === "win32")("POSIX mode and symlink guards remain fail closed", () => {
 const f = fixture(); createPrivateFile(f.token,fake);
 expect(statSync(f.token).mode & 0o777).toBe(0o600);
 for (const mode of [0o640,0o604,0o610,0o601]) { chmodSync(f.token,mode); expect(() => readPrivateFile(f.token,1024)).toThrow(); expect(statSync(f.token).mode & 0o777).toBe(mode); }
 chmodSync(f.token,0o600); symlinkSync(f.token,f.pairing); expect(() => readPrivateFile(f.pairing,1024)).toThrow();
 writeFileSync(f.token,"x".repeat(1025)); expect(() => readPrivateFile(f.token,1024)).toThrow();
});


test.skipIf(process.platform !== "win32")("generated file excludes exposed parent inheritance and exposes a protected current-user-only ACL", () => {
 const f = fixture();
 execFileSync("icacls.exe",[f.dir,"/grant","*S-1-1-0:(OI)(CI)(R)"],{windowsHide:true,stdio:"pipe"});
 createPrivateFile(f.token,fake);
 expect(readPrivateFile(f.token,1024)).toBe(fake);
 // Independent OS inspection, not just round-tripping the implementation's own validator.
 const script = "$a=Get-Acl -LiteralPath $env:DINOBOT_ACL_FIXTURE; [pscustomobject]@{protected=$a.AreAccessRulesProtected; owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {$_.IdentityReference.Value})} | ConvertTo-Json -Compress";
 const result = JSON.parse(execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{env:{...process.env,DINOBOT_ACL_FIXTURE:f.token},windowsHide:true,timeout:10000}).toString());
 expect(result.protected).toBe(true); expect(result.owner).toBe(result.current); expect(result.rules).toEqual([result.current]);
});

test.skipIf(process.platform !== "win32")("null Windows DACL is rejected rather than mistaken for private", () => {
 const f = fixture(); createPrivateFile(f.token,fake);
 const {dlopen,FFIType:T,ptr} = createRequire(import.meta.url)("bun:ffi") as typeof import("bun:ffi");
 const lib = dlopen("advapi32.dll",{SetNamedSecurityInfoW:{args:[T.ptr,T.u32,T.u32,T.ptr,T.ptr,T.ptr,T.ptr],returns:T.u32}});
 try {
  const name=Buffer.from(f.token+"\0","utf16le");
  expect(lib.symbols.SetNamedSecurityInfoW(ptr(name),1,4,null,null,null,null)).toBe(0);
  expect(() => readPrivateFile(f.token,1024)).toThrow("private permissions");
 } finally {lib.close();}
});

test.skipIf(process.platform !== "win32")("Windows directory reparse point is never followed", () => {
 const f = fixture(); symlinkSync(f.dir,f.pairing,"junction");
 expect(() => readPrivateFile(f.pairing,65536)).toThrow("regular file");
});

test("unsafe pairing permissions fail closed after valid credential read", async () => {
 const f = fixture(); createPrivateFile(f.token,fake); createPrivateFile(f.pairing,JSON.stringify({botId:"123456",userId:"42",chatIds:["42"]}));
 exposePrivateFixture(f.pairing);
 expect(() => telegramChannel({mode:"polling",botTokenFile:f.token,pairingPath:f.pairing,databasePath:join(f.dir,"db.sqlite"),port:0})).toThrow("Invalid or unavailable Telegram pairing file");
});

// A disposable real foreign-owned inode (Docker/Linux root), not a mocked stat.
test.skipIf(process.platform === "win32" || process.getuid?.() !== 0)("POSIX foreign owner is rejected despite mode 0600", () => {
 const f = fixture(); createPrivateFile(f.token,fake);
 chownSync(f.token,12345,12345);
 expect(statSync(f.token).mode & 0o777).toBe(0o600);
 expect(() => readPrivateFile(f.token,1024)).toThrow("owned by the current user");
});
