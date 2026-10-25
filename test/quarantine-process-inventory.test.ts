import { expect, test } from "bun:test";
import { liveProcessBlockers, MAX_INVENTORY_BYTES, parseProcessInventory, recoveryProcessBlockersDarwin, scanProcessInventory } from "../src/cli/quarantine-process-inventory.ts";

const SELF = 499;
const blockers = (text: string, recorded: number[]) => liveProcessBlockers(parseProcessInventory(text), recorded, SELF);

const BASE = "1 1 /sbin/launchd\n499 499 /bin/dinobot\n1234 1234 /Applications/Some.app/Contents/MacOS/some-tool\n";

test("inventory parser keeps full ps comm values", () => {
	expect(parseProcessInventory(BASE)).toEqual([
		{ pid: 1, pgid: 1, command: "/sbin/launchd" },
		{ pid: 499, pgid: 499, command: "/bin/dinobot" },
		{ pid: 1234, pgid: 1234, command: "/Applications/Some.app/Contents/MacOS/some-tool" },
	]);
});

test("inventory parser refuses truncated, empty, oversized and malformed data", () => {
	expect(() => parseProcessInventory("")).toThrow("empty_process_inventory");
	expect(() => parseProcessInventory(BASE.trimEnd())).toThrow("truncated_process_inventory");
	expect(() => parseProcessInventory(BASE + "0".repeat(MAX_INVENTORY_BYTES))).toThrow("oversized_process_inventory");
	for (const line of ["not-a-process", "12 8", "x 5 /bin/x", "12 x /bin/x", "-8 8 /bin/x", "12 12   "]) expect(() => parseProcessInventory(line + "\n")).toThrow("malformed_process_inventory");
	expect(() => parseProcessInventory(BASE + "499 499 /bin/twin\n")).toThrow("duplicate_process_inventory");
});

test("blockers refuse live recorded pid, same-group survivor and cua-driver basenames", () => {
	expect(blockers(BASE + "777 1 /sbin/launchd\n", [777, 4242])).toEqual(["live process 777 (pgid 1); identity may be reused, but maintenance refuses conservatively"]);
	expect(blockers(BASE.replace("1234 1234 /Applications/Some.app/Contents/MacOS/some-tool\n", "") + "900 1234 /bin/straggler\n", [1234])).toEqual(["same-group survivor 900 (pgid 1234) of recorded process 1234; maintenance refuses conservatively"]);
	expect(blockers(BASE + "555 555 /Applications/CUA-Driver.app/Contents/MacOS/CUA-Driver\n", [])).toEqual(["forbidden live process 555 (CUA-Driver); maintenance refuses cua-driver naming conservatively"]);
	expect(blockers(BASE + "555 555 /opt/cua-driver-helper\n", [])).toEqual(["forbidden live process 555 (cua-driver-helper); maintenance refuses cua-driver naming conservatively"]);
});

test("live match also refuses process whose pgid equals the recorded pid even without its name", () => {
	const rows = parseProcessInventory(BASE + "900 1234 /bin/straggler\n");
	expect(liveProcessBlockers(rows, [1234], SELF).join(" ")).toMatch(/same-group survivor 900/);
});

test("absent recorded pid yields no blockers, which is never historical proof", () => {
	expect(blockers(BASE, [4242])).toEqual([]);
});

test("blockers refuse corrupt inventories and recorded pids", () => {
	const rows = parseProcessInventory(BASE);
	const noSelf = parseProcessInventory("1 1 /sbin/launchd\n1234 1234 /bin/x\n");
	for (const bad of [noSelf]) expect(() => liveProcessBlockers(bad, [1234], SELF)).toThrow("process_inventory_incomplete");
	expect(() => liveProcessBlockers(rows, [0], SELF)).toThrow("invalid_recorded_pid");
	expect(() => liveProcessBlockers(rows, [-1], SELF)).toThrow("invalid_recorded_pid");
	expect(() => liveProcessBlockers(rows, [1.5], SELF)).toThrow("invalid_recorded_pid");
	expect(() => liveProcessBlockers(rows, [1234, 1234], SELF)).not.toThrow();
});

test.skipIf(process.platform !== "darwin")("real fixed-env ps scan refuses an actual lingering POSIX child by pid", async () => {
	const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], { stdout: "ignore", stderr: "ignore" });
	try {
		const rows = await scanProcessInventory();
		expect(rows.some(row => row.pid === child.pid)).toBe(true);
		expect((await recoveryProcessBlockersDarwin([child.pid])).some(b => b.includes(String(child.pid)))).toBe(true);
	} finally { child.kill(); await child.exited; }
});

test.skipIf(process.platform !== "darwin")("real inventory contains init/self and filters every live driver basename conservatively", async () => {
 const rows = await scanProcessInventory();
 expect(rows.some(row => row.pid === 1)).toBe(true);
 expect(rows.some(row => row.pid === process.pid)).toBe(true);
 const result = liveProcessBlockers(rows, [], process.pid);
 for (const row of rows.filter(row => /^cua-driver/i.test(row.command.split("/").at(-1)!))) expect(result.some(blocker => blocker.includes(String(row.pid)))).toBe(true);
});

test("inventory permits kernel IDs and spaces but rejects noncanonical IDs and control text", () => {
 expect(parseProcessInventory("0 0 kernel_task\n1 1 /sbin/launchd\n")[0]).toEqual({pid:0,pgid:0,command:"kernel_task"});
 expect(parseProcessInventory("1 1 /Applications/Some App/tool\n")[0]!.command).toBe("/Applications/Some App/tool");
 for (const value of ["01 1 /bin/x\n", "1 01 /bin/x\n", "9007199254740992 1 /bin/x\n", "1 9007199254740992 /bin/x\n", "1 1 /bin/x\x00\n", "1 1 /bin/\x1bx\n", "1 1 /bin/\ufffdx\n", "1 1 /bin/\tx\n", "1 1 /bin/x\r\n", "1 1 /bin/x\n\n"]) expect(() => parseProcessInventory(value)).toThrow();
 expect(() => liveProcessBlockers(parseProcessInventory("499 499 /bin/self\n"),[],SELF)).toThrow("process_inventory_incomplete");
 for (const pid of [NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) expect(() => liveProcessBlockers(parseProcessInventory(BASE),[pid],SELF)).toThrow("invalid_recorded_pid");
 expect(() => liveProcessBlockers(parseProcessInventory(BASE),[],NaN)).toThrow("invalid_observer_pid");
});

test("byte budget exhaustion, whitespace stderr and capture failures all refuse", async () => {
 expect(() => parseProcessInventory("1 1 /" + "x".repeat(MAX_INVENTORY_BYTES-6) + "\n")).toThrow("oversized_process_inventory");
 expect(() => parseProcessInventory("1 1 /" + "한".repeat(MAX_INVENTORY_BYTES/2) + "\n")).toThrow("oversized_process_inventory");
 for (const stderr of ["warning", " ", "\n"]) await expect(scanProcessInventory(async()=>({stdout:BASE,stderr}))).rejects.toThrow("process_inventory_stderr");
 for (const message of ["ENOENT", "timeout", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) await expect(scanProcessInventory(async()=>{throw Error(message);})).rejects.toThrow(message);
 expect(await scanProcessInventory(async()=>({stdout:BASE,stderr:""}))).toEqual(parseProcessInventory(BASE));
});
