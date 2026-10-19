import { expect, test } from "bun:test";
import { ancestorIsDaemon, insideUnit, lockIsStale, parsePids, parseShow, psPids, startedByOther, stopped, unitState, unixSeconds } from "../script/reinstall-lib.ts";

test("systemctl show output and unix timestamps parse", () => {
	const show = parseShow("LoadState=loaded\nActiveState=active\nExecMainStartTimestamp=@1791125418\nExecStart={ path=/home/u/.local/bin/dinobot ; argv[]=/home/u/.local/bin/dinobot serve }\n");
	expect(unitState(show)).toEqual({ load: "loaded", active: "active", startedAt: 1791125418, execStart: "{ path=/home/u/.local/bin/dinobot ; argv[]=/home/u/.local/bin/dinobot serve }" });
	expect(unixSeconds("")).toBeUndefined();
	expect(unixSeconds("n/a")).toBeUndefined();
	expect(unitState({})).toEqual({ load: "not-found", active: "inactive", startedAt: undefined, execStart: "" });
});

test("a run inside the daemon unit's cgroup is detected (it would be killed by stopping the unit)", () => {
	expect(insideUnit("0::/user.slice/user-1000.slice/user@1000.service/app.slice/dinobot.service\n", "dinobot.service")).toBe(true);
	expect(insideUnit("0::/user.slice/user-1000.slice/user@1000.service/app.slice/dinobot-reinstall-1.service\n", "dinobot.service")).toBe(false);
	expect(insideUnit("0::/user.slice/user-1000.slice/session-2.scope\n", "dinobot.service")).toBe(false);
});

test("the unit is recreated only once unloaded, inactive or failed", () => {
	const s = (load: string, active: string) => ({ load, active, execStart: "" });
	expect(stopped(s("not-found", "inactive"))).toBe(true);
	expect(stopped(s("loaded", "inactive"))).toBe(true);
	expect(stopped(s("loaded", "failed"))).toBe(true);
	expect(stopped(s("loaded", "deactivating"))).toBe(false);
	expect(stopped(s("loaded", "active"))).toBe(false);
});

test("a unit started by someone else counts only when it runs the new binary after the install (recorded 2026-10-04 race)", () => {
	const bin = "/home/u/.local/bin/dinobot";
	const state = (startedAt: number | undefined, execStart = `{ path=${bin} ; argv[]=${bin} serve }`) => ({ load: "loaded", active: "active", startedAt, execStart });
	expect(startedByOther(state(1000), bin, 1000)).toBe(true);
	expect(startedByOther(state(999), bin, 1000)).toBe(false); // the old daemon
	expect(startedByOther(state(undefined), bin, 1000)).toBe(false);
	expect(startedByOther(state(1001, "{ path=/other/dinobot }"), bin, 1000)).toBe(false);
	expect(startedByOther({ ...state(1001), active: "activating" }, bin, 1000)).toBe(false);
});

test("a lock is stale only when its holder is gone", () => {
	expect(lockIsStale(123, () => true)).toBe(false);
	expect(lockIsStale(123, () => false)).toBe(true);
	expect(lockIsStale(undefined, () => true)).toBe(true);
});

test("pgrep output yields only positive integer pids", () => {
	expect(parsePids("123\n456\n")).toEqual([123, 456]);
	expect(parsePids("")).toEqual([]);
	expect(parsePids("\n\n")).toEqual([]);
	expect(parsePids("abc\n0\n-5\n1.5\n78\n")).toEqual([78]);
});

test("a daemon ancestor anywhere up the parent chain counts, cycles and missing parents do not hang", () => {
	const chain = (links: Record<number, number | undefined>) => (pid: number) => links[pid];
	// shell (100) -> bun run (50) -> daemon (7) -> launchd (1)
	expect(ancestorIsDaemon(100, new Set([7]), chain({ 100: 50, 50: 7, 7: 1 }))).toBe(true);
	// daemon is not an ancestor
	expect(ancestorIsDaemon(100, new Set([7]), chain({ 100: 50, 50: 1 }))).toBe(false);
	// daemon pid set is empty
	expect(ancestorIsDaemon(100, new Set(), chain({ 100: 50 }))).toBe(false);
	// missing parent information stops the walk
	expect(ancestorIsDaemon(100, new Set([7]), chain({}))).toBe(false);
	// a ppid cycle terminates instead of looping forever
	expect(ancestorIsDaemon(100, new Set([7]), chain({ 100: 50, 50: 100 }))).toBe(false);
	// direct parent is the daemon
	expect(ancestorIsDaemon(7, new Set([7]), chain({}))).toBe(true);
});

test("ps output is matched by args substring, not pgrep (macOS pgrep -f misses some processes)", () => {
	const ps = "  407 /sbin/launchd\n85773 /Users/roach/.bun/bin/bun /Users/roach/.bun/install/global/node_modules/dinobot/main.js serve --config /Users/roach/.config/dinobot/dinobot.yaml\n98275 bun /Users/roach/.bun/bin/dinobot\n";
	const needle = "serve --config /Users/roach/.config/dinobot/dinobot.yaml";
	expect(psPids(ps, needle)).toEqual([85773]);
	expect(psPids(ps, "serve --config /other.yaml")).toEqual([]);
	expect(psPids("", needle)).toEqual([]);
	// junk lines and needles in the pid column alone never match
	expect(psPids("garbage\nserve --config x\n", "serve --config")).toEqual([]);
});
