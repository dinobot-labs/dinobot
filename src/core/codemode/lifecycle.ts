/** Finite host-side protocol state. Terminal is absorbing; admission IDs are contiguous and never reused. */
export class CellLifecycle {
	private issued = 0;
	private readonly pending = new Set<number>();
	private stopped = false;
	constructor(
		private readonly maxCalls: number,
		private readonly maxConcurrent: number,
	) {}
	get terminal() {
		return this.stopped;
	}
	get active() {
		return this.pending.size;
	}
	get admitted() {
		return this.issued;
	}
	admit(id: number): boolean {
		if (
			this.stopped ||
			id !== this.issued + 1 ||
			this.issued >= this.maxCalls ||
			this.pending.size >= this.maxConcurrent
		)
			return false;
		this.issued++;
		this.pending.add(id);
		return true;
	}
	settle(id: number): boolean {
		if (this.stopped || !this.pending.delete(id)) return false;
		return true;
	}
	finish(): boolean {
		if (this.stopped) return false;
		this.stopped = true;
		return true;
	}
}
