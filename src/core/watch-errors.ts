import type { WatchEnd } from "@earendil-works/chord";

/** A closed observation is never evidence that the operation it observed succeeded. */
export function watchEndError(end: WatchEnd, label: string): Error {
	if (end.kind === "failed" || end.kind === "listener_error") return end.error instanceof Error ? end.error : new Error(`${label} failed`, { cause: end.error });
	return new Error(`${label} closed: ${end.kind}`);
}
