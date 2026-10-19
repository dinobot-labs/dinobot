/** A non-2xx answer; status distinguishes permanent failures from transient transport failures. */
export class HttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
		this.name = "HttpError";
	}
}

class TransportFailure extends Error {
	constructor(readonly reason: unknown) { super("SSE transport failed"); }
}

/** Internal timing policy, injectable for bounded transport tests. */
export interface SseTiming {
	initialDelay: number;
	maxDelay: number;
	healthyDuration: number;
	idleTimeout: number;
}
const timing: SseTiming = { initialDelay: 250, maxDelay: 10_000, healthyDuration: 30_000, idleTimeout: 45_000 };

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
		if (signal.aborted) finish();
	});
}

/** Each invocation owns exactly one attempt at a time. Only body-less GET subscriptions retry. */
export async function streamSse<T>(url: URL, onEvent: (event: T) => void, signal: AbortSignal, body?: unknown, policy: SseTiming = timing): Promise<void> {
	const retry = body === undefined;
	const method = retry ? "GET" : "POST";
	let backoff = policy.initialDelay;
	while (!signal.aborted) {
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		let firstByte: number | undefined;
		let stalled = false;
		let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock"> | undefined;
		const touch = () => {
			if (!retry) return;
			clearTimeout(watchdog);
			watchdog = setTimeout(() => { stalled = true; abort(); }, policy.idleTimeout);
		};
		try {
			touch(); // Covers a server that accepts TCP but never sends headers, too.
			let response: Response;
			try {
				response = await fetch(url, { signal: controller.signal, method, ...(retry ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
			} catch (error) { throw new TransportFailure(error); }
			if (!response.ok) {
				// Do not wait for an unbounded error body before classifying the status.
				const error = new HttpError(response.status, `${method} ${url.pathname}: HTTP ${response.status}`);
				if (response.status === 408 || response.status === 429 || response.status >= 500) throw new TransportFailure(error);
				throw error;
			}
			if (!response.body) throw new TransportFailure(new Error(`${method} ${url.pathname}: no response body`));
			const streamReader = response.body.getReader();
			reader = streamReader;
			// Decoder, line buffer, and pending event never cross attempt boundaries.
			const decoder = new TextDecoder();
			let line = "";
			let skipLF = false;
			let data: string[] = [];
			const endLine = () => {
				if (line === "") {
					const value = data.join("\n");
					data = [];
					if (value !== "" && !signal.aborted) onEvent(JSON.parse(value) as T);
				} else if (line === "data" || line.startsWith("data:")) {
					let value = line.slice(5);
					if (value.startsWith(" ")) value = value.slice(1);
					data.push(value);
				}
				line = "";
			};
			while (!signal.aborted) {
				let result: Awaited<ReturnType<typeof streamReader.read>>;
				try { result = await streamReader.read(); } catch (error) { throw new TransportFailure(error); }
				if (signal.aborted || result.done) break;
				if (result.value.byteLength) { firstByte ??= performance.now(); touch(); }
				for (const char of decoder.decode(result.value, { stream: true })) {
					if (signal.aborted) break;
					if (skipLF && char === "\n") { skipLF = false; continue; }
					skipLF = char === "\r";
					if (char === "\n" || char === "\r") endLine(); else line += char;
				}
				// Parsing and callbacks deliberately live outside the transport catch.
			}
		} catch (error) {
			if (!(error instanceof TransportFailure)) throw error;
			if (!signal.aborted && !retry) throw error.reason;
		} finally {
			clearTimeout(watchdog);
			signal.removeEventListener("abort", abort);
			controller.abort();
			if (reader) {
				try { await reader.cancel(); } catch { /* Transport already failed/aborted. */ }
				reader.releaseLock();
			}
		}
		if (!retry || signal.aborted) return;
		// A snapshot followed by immediate EOF is not a healthy connection.
		if (!stalled && firstByte !== undefined && performance.now() - firstByte >= policy.healthyDuration) backoff = policy.initialDelay;
		await delay(backoff, signal);
		backoff = Math.min(policy.maxDelay, backoff * 2);
	}
}
