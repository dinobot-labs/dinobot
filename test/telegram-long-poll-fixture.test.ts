import { expect, test } from "bun:test";
import { TelegramLongPoll } from "./fixtures/telegram-long-poll.ts";
import { FakeClock, flush, rawGate } from "./fixtures/issuance.ts";
import { telegramProgress } from "../src/channels/telegram-progress.ts";

test("empty queue expires at requested timeout; stale updates cannot wake it", async () => {
 const clock = new FakeClock(0), queue = new TelegramLongPoll(clock.timer);
 let settled = false;
 const pending = queue.poll(2, 1, new AbortController().signal).then(value => { settled = true; return value; });
 queue.push({update_id:1});
 await clock.advance(999);
 expect(settled).toBe(false);
 await clock.advance(1);
 expect(await pending).toEqual([]);
 expect(clock.pending).toBe(0);
 queue.close();
});

for (const mode of ["abort", "close", "pre-aborted"] as const) test("long poll cleanup: " + mode, async () => {
 const clock = new FakeClock(0), queue = new TelegramLongPoll(clock.timer), control = new AbortController();
 if (mode === "pre-aborted") control.abort();
 const pending = queue.poll(1, 20, control.signal);
 if (mode === "close") queue.close(); else control.abort();
 expect(await pending).toEqual([]);
 expect(clock.pending).toBe(0);
 queue.close();
 expect(await queue.poll(1, 1, new AbortController().signal)).toEqual([]);
});

test("real gate and reporter can type while an empty getUpdates request is outstanding", async () => {
 const clock = new FakeClock(0), queue = new TelegramLongPoll(clock.timer), gate = rawGate(clock);
 const control = new AbortController(), off = gate.registerTyping("chat:-100", "10");
 let pending = false, nextPoll = 0;
 const typing: {at:number; pending:boolean}[] = [];
 const reporter = telegramProgress({chat:"-100", topic:"10", now:clock.now, call:async () => {
  const result = await gate.progress("chat:-100", false, control.signal, () => {
   typing.push({at:clock.t, pending});
   return {started:true,value:undefined};
  }, undefined, "10");
  return {ok:true, ...(!result.started ? {local:true as const}: {})};
 }});
 try {
  // Same poll-first phase that starved typing with the old immediate-empty response double.
  // Both the 1s server timeout and 100ms repoll delay come from the real adapter/config.
  for (let elapsed=0; elapsed<=6000; elapsed+=100) {
   if (!pending && clock.t>=nextPoll) {
    pending = true;
    const issued = await gate.poll(control.signal, () => ({started:true,value:queue.poll(0, 1, control.signal)}));
    expect(issued.started).toBe(true);
    if (issued.started) void issued.value.then(() => {pending=false; nextPoll=clock.t+100;});
    await flush();
   }
   if (elapsed>0 && elapsed%1000===0) await reporter.tick();
   await clock.advance(100);
  }
  expect(typing.length).toBeGreaterThan(0);
  expect(typing.some(call => call.pending)).toBe(true);
 } finally { queue.close(); control.abort(); off(); gate.close(); await flush(); }
 expect(clock.pending).toBe(0);
});

test("empty long poll stays pending until a new update, then offset acknowledges it", async () => {
 const queue = new TelegramLongPoll();
 const signal = new AbortController().signal;
 let settled = false;
 const waiting = queue.poll(1, 1, signal).then(value => { settled = true; return value; });
 try {
  await flush();
  expect(settled).toBe(false);
  queue.push({update_id:1});
  expect(await waiting).toEqual([{update_id:1}]);
  expect(await queue.poll(1, 0, signal)).toEqual([{update_id:1}]);
  expect(await queue.poll(2, 0, signal)).toEqual([]);
 } finally { queue.close(); }
});
