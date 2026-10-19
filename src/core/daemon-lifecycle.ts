export interface DaemonResource {
	readonly name: string;
	start(): void | Promise<void>;
	stop(): void | Promise<void>;
}

export interface DaemonStopResult {
	readonly errors: readonly Error[];
	readonly timedOut: boolean;
}

/** Signal-independent, single-use owner. Cleanup is reverse registration order.
 * The shared deadline bounds waiting, not execution: arbitrary promises cannot
 * be cancelled. After expiry remaining cleanup is still invoked, but may overlap
 * unfinished work. Synchronous blocking code cannot be bounded by a JS timer.
 */
export class DaemonLifecycle {
	private readonly resources: Pick<DaemonResource, "name" | "stop">[] = [];
	private active: { name: string; promise: Promise<void> } | undefined;
	private stopping?: Promise<DaemonStopResult>;

	constructor(private readonly timeoutMs = 10_000) {
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new RangeError("Invalid shutdown deadline");
	}

	own(name: string, stop: () => void | Promise<void>): void {
		if (this.stopping) throw new Error("Daemon is stopping");
		this.resources.push({ name, stop });
	}

	async start(resource: DaemonResource): Promise<void> {
		if (this.stopping || this.active) throw new Error("Daemon cannot start another resource now");
		// Register BEFORE invoking start: even a rejected start can own live handles.
		this.own(resource.name, () => resource.stop());
		const active = { name: resource.name, promise: Promise.resolve().then(() => resource.start()) };
		this.active = active;
		let failure: Error | undefined;
		try { await active.promise; }
		catch (cause) { failure = new Error("start " + resource.name + " failed", { cause }); }
		finally { this.active = undefined; }
		if (failure) {
			const result = await this.stop();
			throw new AggregateError([failure, ...result.errors], "Daemon startup failed", { cause: failure });
		}
		if (this.stopping) throw new Error("Daemon stopped during startup");
	}

	stop(): Promise<DaemonStopResult> {
		// Defer execution so even reentrant cleanup observes the same promise.
		return this.stopping ??= Promise.resolve().then(() => this.cleanup());
	}

	private async cleanup(): Promise<DaemonStopResult> {
		const errors: Error[] = [];
		let timedOut = false;
		const deadline = performance.now() + this.timeoutMs;
		const wait = async (name: string, action: () => void | Promise<void>) => {
			// Both synchronous throws and late rejections are observed, including after timeout.
			const settled = Promise.resolve().then(action).then(
				() => undefined,
				cause => new Error(name + " failed", { cause }),
			);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const expired = new Error(name + " exceeded shutdown deadline; operation may still be running");
			const remaining = deadline - performance.now();
			const result = await Promise.race([
				settled,
				remaining > 0 ? new Promise<Error>(resolve => { timer = setTimeout(() => resolve(expired), Math.ceil(remaining)); }) : Promise.resolve(expired),
			]);
			if (timer !== undefined) clearTimeout(timer);
			if (result) {
				errors.push(result);
				if (result === expired) timedOut = true;
			}
		};
		if (this.active) {
			const active = this.active;
			await wait("start " + active.name, () => active.promise);
		}
		for (const resource of this.resources.toReversed()) await wait("stop " + resource.name, () => resource.stop());
		return { errors, timedOut };
	}
}
