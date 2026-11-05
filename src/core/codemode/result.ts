import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import type { JsonValue } from "@earendil-works/chord";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";

/** Validate program output without discarding the model output, usage or diagnostics on a contract error. */
export function checkedToolResult(tool: ToolRegistration, result: ToolExecutionResult): ToolExecutionResult {
	let error: string | undefined;
	if (!tool.structuredOutputSchema) {
		if (result.structuredOutput !== undefined) error = "Tool returned structuredOutput without a schema";
	} else if (result.structuredOutput === undefined) {
		if (!result.isError) error = "Tool omitted required structuredOutput";
	} else {
		const validator = compile(tool.structuredOutputSchema, { formats, unresolvedRefs: "reject" });
		if (!validator.check(result.structuredOutput)) error = "Tool structuredOutput does not match its schema";
	}
	if (!error) return result;
	const { structuredOutput: _invalid, ...rest } = result;
	return { ...rest, isError: true, diagnostics: [...(result.diagnostics ?? []), { severity: "error", code: "invalid_structured_output", message: error }] };
}

/** Image bytes remain in host receipts, including when a native tool also returns them as structured output. */
export function imageMarkers(value: JsonValue, ordinal: number): JsonValue {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(item => imageMarkers(item, ordinal));
	if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") return { type: "text", text: `[Image retained by host: call ${ordinal}, ${value.mimeType}]` };
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, imageMarkers(item, ordinal)]));
}
