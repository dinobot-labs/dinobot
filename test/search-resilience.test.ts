import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { EntryRecord, Harness } from "@earendil-works/pi-durable";
import { openSessionIndex } from "../src/core/search.ts";

function fixture(path = ":memory:") {
 let listener!: Parameters<Harness["subscribeCommits"]>[0];
 let stops = 0; let pageHook = (_page: number) => {};
 const history: EntryRecord[] = [];
 const mins: number[] = [];
 const harness = {
  subscribeCommits(fn: typeof listener) { listener = fn; return () => { stops++; }; },
  async snapshot() { return { threads: { "tui:test": 1 } }; },
  async conversation() { return { async entries(query: { minEntryId: number }, limit: number, cursor?: { offset: number }) {
   mins.push(query.minEntryId);
   const offset = cursor?.offset ?? 0; pageHook(offset / limit);
   const rows = history.filter(e => e.id >= query.minEntryId).toReversed();
   return { items: rows.slice(offset, offset + limit), next: offset + limit < rows.length ? { offset: offset + limit } : undefined };
  } }; },
 } as unknown as Harness;
 const db = new Database(path);
 const index = openSessionIndex(harness, ":memory:", db);
 const add = (id: number, publish = true) => {
  const entry = { id, conversationId: 1, kind: "message", model: [{ role: "user", content: `needle ${id}`, timestamp: id }] } as unknown as EntryRecord;
  history.push(entry);
  if (publish) listener({ seq: id, changes: [{ type: "entry", value: entry }] } as unknown as Parameters<typeof listener>[0], context);
 };
 const count = () => (db.query("SELECT count(*) AS n FROM entries").get() as { n: number }).n;
 return { db, index, harness, add, count, mins, stops: () => stops, hook(fn: typeof pageHook) { pageHook = fn; } };
}

test("readonly timer failure retains batch for delayed retry and preserves text", async () => {
 const f = fixture();
 try {
  f.db.run("PRAGMA query_only = ON"); f.add(1);
  await Bun.sleep(30); expect(f.count()).toBe(0);
  f.db.run("PRAGMA query_only = OFF");
  await Bun.sleep(140); expect(f.count()).toBe(1);
  expect(f.index.latest([1]).get(1)).toEqual({ at: 1, role: "user", text: "needle 1" });
 } finally { f.index.close(); }
});

test("persistent failure opens circuit; overflow and later commits recover from history", async () => {
 const f = fixture();
 f.db.run("PRAGMA query_only = ON");
 try {
  for (let id = 1; id <= 1000; id++) f.add(id);
  await Bun.sleep(450); expect(f.count()).toBe(0);
  f.db.run("PRAGMA query_only = OFF");
  f.add(1001); await Bun.sleep(450); expect(f.count()).toBe(0);
  await f.index.catchUp(context); expect(f.count()).toBe(1001);
  f.add(1002); await Bun.sleep(20); expect(f.count()).toBe(1002);
 } finally { f.index.close(); }
});

test("bounded stream batch does not advance durable checkpoint past omitted entries", async () => {
 const f = fixture();
 try {
  for (let id = 1; id <= 450; id++) f.add(id);
  await Bun.sleep(20); expect(f.count()).toBe(200);
  f.add(451); await Bun.sleep(20); expect(f.count()).toBe(201);
  await f.index.catchUp(context); expect(f.count()).toBe(451);
  expect((await f.index.search("needle", {}, context)).results[0]?.hits).toBe(300);
  expect(f.mins.at(-1)).toBe(452);
 } finally { f.index.close(); }
});

test("newest-first partial scan failure never checkpoints over older missing pages", async () => {
 const f = fixture();
 try {
  for (let id = 1; id <= 450; id++) f.add(id, false);
  f.hook(page => { if (page === 1) f.db.run("PRAGMA query_only = ON"); });
  await expect(f.index.catchUp(context)).rejects.toThrow();
  expect(f.count()).toBe(200);
  expect(f.db.query("SELECT * FROM search_checkpoint").all()).toEqual([]);
  f.hook(() => {}); f.db.run("PRAGMA query_only = OFF");
  await f.index.catchUp(context); expect(f.count()).toBe(450);
 } finally { f.index.close(); }
});

test("closed SQLite timer and repeated cleanup do not escape or retain subscription", async () => {
 const f = fixture();
 f.add(1); f.db.close();
 await Bun.sleep(30);
 expect(() => f.index.close()).not.toThrow();
 expect(() => f.index.close()).not.toThrow();
 f.add(2); await Bun.sleep(350); expect(f.stops()).toBe(1);
});

test('restart repairs a partial scan despite higher streamed rows persisted before close', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'search-resilience-'));
 const path = join(dir, 'index.sqlite');
 const f = fixture(path);
 try {
  for (let id = 1; id <= 450; id++) f.add(id, false);
  f.hook(page => { if (page === 1) throw new Error('interrupted scan'); });
  await expect(f.index.catchUp(context)).rejects.toThrow('interrupted scan');
  f.add(451); await Bun.sleep(20); expect(f.count()).toBe(201);
  f.index.close(); f.hook(() => {});
  const db = new Database(path);
  const reopened = openSessionIndex(f.harness, path, db);
  try {
   await reopened.catchUp(context);
   expect(db.query('SELECT count(*) AS n FROM entries').get()).toEqual({ n: 451 });
   expect(db.query('SELECT entry_id FROM search_checkpoint').get()).toEqual({ entry_id: 451 });
  } finally { reopened.close(); }
 } finally { f.index.close(); await rm(dir, { recursive: true, force: true }); }
});

test('entry/body transaction rolls back together and can be reconstructed', async () => {
 const f = fixture();
 try {
  f.db.run("CREATE TRIGGER reject_entry AFTER INSERT ON entries BEGIN SELECT RAISE(ABORT, 'injected'); END");
  f.add(1); await Bun.sleep(20);
  expect(f.count()).toBe(0);
  expect(f.db.query('SELECT count(*) AS n FROM entries_fts').get()).toEqual({ n: 0 });
  f.db.run('DROP TRIGGER reject_entry');
  await f.index.catchUp(context);
  expect(f.count()).toBe(1);
  expect(f.db.query('SELECT count(*) AS n FROM entries_fts').get()).toEqual({ n: 1 });
 } finally { f.index.close(); }
});

test('close during asynchronous catch-up never accesses closed SQLite', async () => {
 const f = fixture();
 f.add(1, false);
 f.hook(() => f.index.close());
 await f.index.catchUp(context);
 expect(f.stops()).toBe(1);
 f.index.close();
});
