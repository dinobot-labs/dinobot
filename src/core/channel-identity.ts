/** Colon is the persisted channel/thread delimiter. Keep existing valid keys unchanged. */
export function validChannelName(channel: string): boolean {
	return channel.length > 0 && !channel.includes(":");
}
