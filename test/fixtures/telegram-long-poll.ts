export type PollUpdate = { update_id: number };
type Timer = (callback: () => void, ms: number) => () => void;
const timer: Timer = (callback, ms) => {
 const handle = setTimeout(callback, ms);
 return () => clearTimeout(handle);
};
/** Local getUpdates double: an empty queue waits for updates, the requested timeout, or cancellation. */
export class TelegramLongPoll<T extends PollUpdate> {
 #updates: T[] = [];
 #waiters = new Set<() => void>();
 #closed = false;
 constructor(private readonly schedule: Timer = timer) {}
 push(...updates: T[]) {
  if (this.#closed) throw new Error("Long poll fixture is closed");
  this.#updates.push(...updates);
  for (const wake of [...this.#waiters]) wake();
 }
 poll(offset: number, timeoutSeconds: number, signal: AbortSignal): Promise<T[]> {
  // Telegram keeps returned updates until a later request acknowledges them via offset.
  this.#updates = this.#updates.filter(update => update.update_id >= offset);
  const available = () => this.#updates.filter(update => update.update_id >= offset);
  if (this.#closed || signal.aborted) return Promise.resolve([]);
  if (available().length || timeoutSeconds <= 0) return Promise.resolve(available());
  return new Promise(resolve => {
   let cancelTimer = () => {};
   const finish = (updates: T[]) => {
    cancelTimer();
    signal.removeEventListener("abort", abort);
    this.#waiters.delete(wake);
    resolve(updates);
   };
   const abort = () => finish([]);
   const wake = () => {
    if (this.#closed) return finish([]);
    const updates = available();
    if (updates.length) finish(updates);
   };
   this.#waiters.add(wake);
   signal.addEventListener("abort", abort, {once:true});
   cancelTimer = this.schedule(() => finish([]), timeoutSeconds * 1000);
  });
 }
 close() {
  this.#closed = true;
  for (const wake of [...this.#waiters]) wake();
 }
}
