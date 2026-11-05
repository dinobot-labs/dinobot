import type { Op } from "@earendil-works/chord/delta";
import type { CheckpointInfo, JsonObject } from "@earendil-works/pi-durable";

/** Bound host-owned replay chains to 256 deltas; upstream documents keep their own policies. */
export function checkpointEvery256(_value: Readonly<JsonObject>, _ops: readonly Op[], info: CheckpointInfo): boolean {
	return info.deltasSinceBase >= 256;
}
