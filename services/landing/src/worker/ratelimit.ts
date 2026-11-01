import type { RateLimitLike } from "./env.ts";

/**
 * Rate-limit key for a client address: an IPv4 address as is, an IPv6 address by its /64 prefix (one subscriber
 * usually holds a whole /64, so rotating the interface id must not buy fresh quota). Unparseable input is used as is.
 */
export function rateKey(ip: string | null): string {
	if (!ip) return "unknown";
	if (!ip.includes(":")) return ip;
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
	if (mapped) return mapped[1]!;
	const halves = ip.toLowerCase().split("::");
	if (halves.length > 2) return ip;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves[1] ? halves[1].split(":") : [];
	const zeros = halves.length === 2 ? 8 - head.length - tail.length : 0;
	const groups = [...head, ...new Array<string>(Math.max(zeros, 0)).fill("0"), ...tail];
	if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return ip;
	return `${groups
		.slice(0, 4)
		.map((group) => parseInt(group, 16).toString(16))
		.join(":")}::/64`;
}

/**
 * True when the client is over its limit. Fails open: an outage of the rate limiter must not take the waitlist
 * down (the honeypot and the timing check still apply).
 */
export async function overLimit(limiter: RateLimitLike, ip: string | null): Promise<boolean> {
	try {
		const { success } = await limiter.limit({ key: rateKey(ip) });
		return !success;
	} catch {
		console.error("rate limiter unavailable");
		return false;
	}
}
