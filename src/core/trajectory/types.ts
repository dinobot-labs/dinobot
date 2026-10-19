/** Persisted source coordinates, not a reconstruction of a provider request.
 * Message/content indexes are zero-based; conversation is the source entry owner. */
export type SourceIdentity = { conversationId: number; entryId: number; byTaskId: number | null; entryKind: string; messageIndex: number; contentIndex?: number };
export type StepProvenance = { id: string; source: SourceIdentity; origin: "model" | "host" | "user" | "tool"; callId?: string; result?: SourceIdentity; parentId?: string; taskId?: number };
export type UnresolvedEvidence = { rule: string; step: number; reason: string; relatedSteps: number[] };

export type Step = {
	n: number;
	provenance?: StepProvenance;
	kind: "user" | "assistant" | "call";
	tool?: string;
	via?: "direct" | "codemode";
	cell?: string;          // root tool call id for codemode cells
	/** Source-message positions, independent of flattened step numbers. Inner
	 * calls conservatively use their root cell invocation/result bounds. */
	order?: { invoked: number; result?: number };
	args?: unknown;
	argsText?: string;
	ok?: boolean;
	output?: string;
	/** Result metadata only, never caller arguments or emitted cell prose. */
	receipt?: { ask?: unknown; workflow?: unknown } | undefined;
	text?: string;
	entryId: number;
	taskId?: number;
};
export type Violation = { rule: string; severity: "fatal" | "warn" | "info"; step: number; why: string };
