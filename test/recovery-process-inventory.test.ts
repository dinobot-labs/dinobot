import { expect, test } from "bun:test";
import * as recovery from "../src/cli/quarantine-recovery.ts";
test("macOS inventory refuses recorded PID, PGID and live Cua Driver independently", () => {
 expect(typeof recovery.macosProcessBlockers).toBe("function");
 expect(recovery.macosProcessBlockers("1 1 /sbin/launchd\n10 10 /usr/bin/bun\n11 10 /usr/bin/sleep\n12 12 /opt/Cua Driver\n", [10])).toHaveLength(3);
 expect(recovery.macosProcessBlockers("1 1 /sbin/launchd\n11 10 /usr/bin/sleep\n", [10])).toHaveLength(1);
 expect(recovery.macosProcessBlockers("1 1 /sbin/launchd\n", [10])).toEqual([]);
});
for (const bad of ["1 1 /sbin/launchd", "", "10 10 bun\n", "1 1 launchd\nmalformed\n", "1 1 launchd\n2 x bun\n", "1 1 launchd\n1 1 launchd\n"]) test("incomplete/malformed macOS inventory refuses: " + JSON.stringify(bad), () => {
 expect(() => recovery.macosProcessBlockers(bad, [])).toThrow(/invalid_process_inventory|incomplete_process_inventory/);
});
test("tokenless request cannot mix historical abandonment or caller-supplied proof", () => {
 const calls = [{ conversationId: 1, taskId: "2" }];
 expect(recovery.parseTokenlessRequest({ calls, evidence: "quiescent" })).toEqual({ calls, actor: "", note: "", snapshot: "" });
 for (const bad of [null, { calls: [] }, { calls, tokens: [] }, { calls, acceptance: "yes" }, { calls: [{ conversationId: 1, taskId: "02" }] }, { calls: [{ conversationId: 0, taskId: "2" }] }]) expect(() => recovery.parseTokenlessRequest(bad)).toThrow();
});
