/** Only positive transport evidence establishes absence; HTTP/parse/timeout/reset errors do not. */
export function isConnectionRefused(error: unknown): boolean {
	// Bun fetch uses ConnectionRefused; other transports use ECONNREFUSED. Never infer from messages.
	return error instanceof Error && "code" in error
		&& (error.code === "ECONNREFUSED" || error.code === "ConnectionRefused");
}
