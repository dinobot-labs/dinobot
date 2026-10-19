/** Adapter-local rate targets. A bound store owns deadlines across process restarts. */
export type NativeCooldownStore = { get(key: string): number | undefined; set(key: string, until: number): void; prune(now: number): void };
export class NativeCooldown {
 private readonly until = new Map<string, number>();
 private store: NativeCooldownStore | undefined;
 constructor(private readonly key: (target: Record<string,string>) => string) {}
 bind(store: NativeCooldownStore | undefined): void { this.until.clear(); this.store = store; }
 remaining(target: Record<string,string>): number {
  const key=this.key(target), due=this.store ? this.store.get(key) ?? 0 : this.until.get(key) ?? 0;
  if (due <= Date.now()) { this.until.delete(key); return 0; }
  return due-Date.now();
 }
 limited(target: Record<string,string>, delay: number): void {
  const now=Date.now(), key=this.key(target);
  if (this.store) {
   this.store.prune(now);
   this.store.set(key, Math.max(this.store.get(key) ?? 0, now+delay));
  } else {
   for (const [key,due] of this.until) if (due <= now) this.until.delete(key);
   this.until.set(key, Math.max(this.until.get(key) ?? 0, now+delay));
  }
 }
}
