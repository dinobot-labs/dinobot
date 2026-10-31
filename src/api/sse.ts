/** Local byte backpressure only; no SSE/JSON protocol changes. */
export interface SseController extends ReadableStreamDefaultController<Uint8Array> {
	/** Wait for an admitted large frame to drain. There is only one shared waiter. */
	drained(): Promise<void>;
}

/** One lifecycle for push watches and pull-based command streams. */
export function sseStream(
	source: {
		start?(controller: SseController): void | PromiseLike<void>;
		pull?(controller: SseController): void | PromiseLike<void>;
		cancel?(reason?: unknown): void | PromiseLike<void>;
	},
	{ heartbeatMs = 15_000, maxQueuedBytes = 8 * 1024 * 1024 } = {},
): ReadableStream<Uint8Array> {
	const heartbeat = new TextEncoder().encode(": heartbeat\n\n");
	if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) throw new RangeError("Invalid SSE heartbeat interval");
	if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes <= 0) throw new RangeError("Invalid SSE queue limit");
	let ended = false;
	let closing = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let cleanup: Promise<void> | undefined;
	let controller: ReadableStreamDefaultController<Uint8Array>;
	// The finite, already encoded source frame is NOT part of the queue bound.
	// Own one copy (also detaches tiny views from huge backing stores); never
	// admit another push until it drains. JSON/string/source snapshot memory and
	// HTTP/kernel buffers are separate from the <= maxQueuedBytes stream queue.
	let frame: Uint8Array | undefined;
	let offset = 0;
	let draining: Promise<void> | undefined;
	let resolveDrain: (() => void) | undefined;
	const release = () => { frame = undefined; offset = 0; resolveDrain?.(); resolveDrain = undefined; draining = undefined; };
	const stop = (reason?: unknown) => {
		if (ended) return cleanup;
		ended = true;
		clearInterval(timer);
		release();
		try { cleanup = Promise.resolve(source.cancel?.(reason)).then(() => {}, () => {}); }
		catch { cleanup = Promise.resolve(); }
		return cleanup;
	};
	const fail = (error: unknown) => {
		if (ended) return;
		controller.error(error);
		void stop(error);
	};
	let pumping = false;
	const pump = () => {
		// Bun may synchronously request another pull while enqueue delivers to an active reader.
		if (pumping) return;
		pumping = true;
		try {
			while (frame && offset < frame.byteLength && (controller.desiredSize ?? 0) > 0) {
				const end = Math.min(frame.byteLength, offset + 64 * 1024, offset + controller.desiredSize!);
				controller.enqueue(frame.slice(offset, end));
				offset = end;
			}
			if (frame && offset === frame.byteLength) {
				frame = undefined; offset = 0;
			}
			if (draining && !frame && controller.desiredSize === maxQueuedBytes) release();
			if (closing && !frame) { controller.close(); void stop(); }
		} finally { pumping = false; }
	};
	const guarded: SseController = {
		get desiredSize() { return ended || draining ? 0 : controller.desiredSize; },
		drained() { return draining ?? Promise.resolve(); },
		enqueue(chunk) {
			if (ended || closing || !chunk) return;
			// One exceptional frame may follow already queued bytes, in order.
			if (!draining && chunk.byteLength > maxQueuedBytes) {
				frame = new Uint8Array(chunk);
				draining = new Promise<void>(resolve => { resolveDrain = resolve; });
				pump();
				return;
			}
			// Missing data invalidates later deltas: error, never silently drop it.
			if (draining || Math.max(1, chunk.byteLength) > (controller.desiredSize ?? 0)) {
				fail(new Error("SSE queue limit exceeded; reconnect for a fresh snapshot"));
				return;
			}
			controller.enqueue(new Uint8Array(chunk));
		},
		close() { if (!ended) { closing = true; pump(); } },
		error: fail,
	};
	return new ReadableStream<Uint8Array>({
		start(target) {
			controller = target;
			timer = setInterval(() => {
				if (!ended && !draining && controller.desiredSize === maxQueuedBytes && heartbeat.byteLength <= maxQueuedBytes) controller.enqueue(heartbeat);
			}, heartbeatMs);
			try { return Promise.resolve(source.start?.(guarded)).catch(fail); } catch (error) { fail(error); }
		},
		async pull() {
			if (ended) return;
			pump();
			if (ended || draining || closing) return;
			try { await source.pull?.(guarded); } catch (error) { fail(error); }
		},
		cancel: stop,
	}, { highWaterMark: maxQueuedBytes, size: (chunk) => Math.max(1, chunk?.byteLength ?? 0) });
}
