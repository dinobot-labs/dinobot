import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { exportVisible, VisibleExportsDoc, validateVisibleExport, type VisibleExport } from "../src/core/visible-export.ts";
import { encode, CODEMODE_LIMITS } from "../src/core/codemode/protocol.ts";
import { digest } from "../src/core/verification-execution.ts";

const harnesses: Harness[] = [];
afterEach(async () => { for (const h of harnesses.splice(0)) await h.close(context); });
async function fixture(count = 80, body?: string) {
 const h = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: createModels() }, context);
 harnesses.push(h); const root = await h.root(context);
 await h.commit(async tx => {
  for (let i = 0; i < count; i++) await tx.appendEntry(root.id, { kind: "pi.user", model: [{role: "user", content: body ?? "가😀 public " + i, timestamp: i}], data: Object.fromEntries([...Array.from({length: 60}, (_, j) => ["public" + j, "value" + i + ":" + j]), ["password", "PRIVATE_SECRET"]]) });
 }, context);
 return {h, root};
}
// The real session_export result carries both text and details across codemode.
const wire = (page: VisibleExport) => ({content: [{type: "text", text: JSON.stringify(page)}], details: page});
const arrayKeys = ["conversationIds", "entryIds", "content", "allowedSourceContent", "omissions", "allowedLeafDiffs"] as const;
function join(pages: VisibleExport[]): VisibleExport {
 const full = structuredClone(pages[0]!);
 full.entries = pages.flatMap(p => p.entries);
 for (const key of arrayKeys) (full.inventory[key] as unknown[]) = pages.flatMap(p => p.inventory[key] as unknown[]);
 if (full.inventory.provenance) {
  full.inventory.provenance.canonicalEntries = pages.flatMap(p => p.inventory.provenance!.canonicalEntries);
  full.inventory.provenance.conversations = pages.flatMap(p => p.inventory.provenance!.conversations);
 }
 full.complete = true; full.nextCursor = null; return full;
}

test("limit=1 bounds full-snapshot inventory at the actual codemode encoding boundary", async () => {
 const {h, root} = await fixture();
 const first = await exportVisible(h, root.id, context, undefined, 1);
 const full = (await h.snapshot(VisibleExportsDoc, root.id, context))!.snapshots[0]!;
 expect(Buffer.byteLength(JSON.stringify(full.inventory))).toBeGreaterThan(CODEMODE_LIMITS.maxValueBytes);
 expect(() => encode(wire(first))).not.toThrow();
 expect(first.entries).toHaveLength(1);
 expect(first.inventory.content.length).toBeLessThanOrEqual(1);
 expect(first.complete).toBe(false);
 expect(first.nextCursor).toBeString();
 expect(validateVisibleExport(full, full)).toBe(true);
 const pages = [first]; const cursors = new Set<string>();
 await h.commit(tx => tx.appendEntry(root.id, {kind: "pi.user", model: [{role: "user", content: "LATE_NOT_IN_SNAPSHOT", timestamp: 99}]}), context);
 while (pages.at(-1)!.nextCursor) {
  const cursor = pages.at(-1)!.nextCursor!;
  expect(cursors.has(cursor)).toBe(false); cursors.add(cursor);
  const page = await exportVisible(h, root.id, context, cursor, 10000);
  expect(() => encode(wire(page))).not.toThrow();
  expect(page.witness).toEqual(first.witness); expect(page.complete).toBe(false);
  pages.push(page); expect(pages.length).toBeLessThan(100);
 }
 expect(pages.length).toBeGreaterThan(2); // byte budget, not just requested count
 expect(pages.some(p => p.entries.length === 0 && p.inventory.content.length > 0)).toBe(true);
 const reconstructed = join(pages);
 expect(reconstructed).toEqual(full);
 expect(digest(reconstructed.inventory)).toBe(first.witness.inventoryHash);
 expect(digest(reconstructed.entries)).toBe(first.witness.contentHash);
 expect(digest(reconstructed.inventory.provenance)).toBe(first.witness.provenanceHash!);
 expect(validateVisibleExport(reconstructed, full)).toBe(true);
 expect(JSON.stringify(reconstructed)).not.toContain("PRIVATE_SECRET");
 expect(JSON.stringify(reconstructed)).not.toContain("LATE_NOT_IN_SNAPSHOT");
});

test("empty and small exports reconstruct with limit=1, and unpaged output stays unchanged", async () => {
 for (const count of [0, 1, 2]) {
  const {h, root} = await fixture(count);
  const pages = [await exportVisible(h, root.id, context, undefined, 1)];
  while (pages.at(-1)!.nextCursor) pages.push(await exportVisible(h, root.id, context, pages.at(-1)!.nextCursor!, 1));
  const retained = (await h.snapshot(VisibleExportsDoc, root.id, context))!.snapshots[0]!;
  expect(join(pages)).toEqual(retained);
  for (const page of pages) expect(() => encode(wire(page))).not.toThrow();
  const unpaged = await exportVisible(h, root.id, context);
  expect(unpaged.complete).toBe(true); expect(unpaged.nextCursor).toBeNull();
  expect(unpaged.entries).toEqual(retained.entries); expect(unpaged.inventory).toEqual(retained.inventory);
  expect(validateVisibleExport(unpaged, unpaged)).toBe(true);
 }
});

test("indivisible oversized public body errors explicitly without truncating unpaged export", async () => {
 const body = "가😀\"\\".repeat(40000);
 const {h, root} = await fixture(1, body);
 await expect(exportVisible(h, root.id, context, undefined, 1)).rejects.toThrow("export_page_item_too_large");
 const full = await exportVisible(h, root.id, context);
 expect((full.entries[0] as any).model[0].content).toBe(body);
 expect(validateVisibleExport(full, full)).toBe(true);
});

test("invalid limits/cursors reject and exact end cursor returns no duplicate arrays", async () => {
 const {h, root} = await fixture(1);
 for (const limit of [0, -1, 1.5, 10001]) await expect(exportVisible(h, root.id, context, undefined, limit)).rejects.toThrow("invalid_export_limit");
 const full = await exportVisible(h, root.id, context);
 const total = Math.max(full.entries.length, ...arrayKeys.map(k => full.inventory[k].length), full.inventory.provenance!.canonicalEntries.length, full.inventory.provenance!.conversations.length);
 const cursor = (offset: number, snapshot = full.snapshotId) => Buffer.from(JSON.stringify({snapshot, offset})).toString("base64url");
 for (const offset of [-1, 0.5, total + 1]) await expect(exportVisible(h, root.id, context, cursor(offset), 1)).rejects.toThrow("invalid_export_cursor");
 await expect(exportVisible(h, root.id, context, cursor(0, "missing"), 1)).rejects.toThrow("invalid_export_cursor");
 const end = await exportVisible(h, root.id, context, cursor(total), 1);
 expect(end.entries).toEqual([]); for (const key of arrayKeys) expect(end.inventory[key]).toEqual([]);
 expect(end.nextCursor).toBeNull(); expect(end.complete).toBe(false);
});
