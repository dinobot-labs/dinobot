/** Pure geometry for the scenes: dotted edges along a cubic curve, ring dots. No DOM. */
import type { Item } from "./scripts.ts";

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export function rectOf(item: Item): Rect {
	return { x: item.x ?? 0, y: item.y ?? 0, w: item.w ?? 0, h: item.h ?? 0 };
}

type P = readonly [number, number];

/** Anchor points and curve controls between two rects: "h" joins facing sides, "v" bottom to top. */
export function edgeCurve(a: Rect, b: Rect, dir: "h" | "v"): [P, P, P, P] {
	if (dir === "v") {
		const p0: P = [a.x + a.w / 2, a.y + a.h];
		const p3: P = [b.x + b.w / 2, b.y];
		const k = (p3[1] - p0[1]) / 2;
		return [p0, [p0[0], p0[1] + k], [p3[0], p3[1] - k], p3];
	}
	const rightward = b.x + b.w / 2 >= a.x + a.w / 2;
	const p0: P = rightward ? [a.x + a.w, a.y + a.h / 2] : [a.x, a.y + a.h / 2];
	const p3: P = rightward ? [b.x, b.y + b.h / 2] : [b.x + b.w, b.y + b.h / 2];
	const k = (p3[0] - p0[0]) / 2;
	return [p0, [p0[0] + k, p0[1]], [p3[0] - k, p3[1]], p3];
}

function bez(c: readonly [P, P, P, P], t: number): [number, number] {
	const u = 1 - t;
	const a = u * u * u;
	const b = 3 * u * u * t;
	const d = 3 * u * t * t;
	const e = t * t * t;
	return [a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1]];
}

/** Evenly spaced dots (by arc length) along the curve, inset from both ends. Always at least 2 dots. */
export function edgeDots(a: Rect, b: Rect, dir: "h" | "v", pitch = 7, inset = 4): [number, number][] {
	const curve = edgeCurve(a, b, dir);
	const samples: [number, number][] = [];
	const lengths: number[] = [0];
	const N = 64;
	for (let i = 0; i <= N; i++) {
		const p = bez(curve, i / N);
		if (i > 0) {
			const q = samples[i - 1]!;
			lengths.push(lengths[i - 1]! + Math.hypot(p[0] - q[0], p[1] - q[1]));
		}
		samples.push(p);
	}
	const total = lengths[N]!;
	const usable = Math.max(0, total - inset * 2);
	const count = Math.max(2, Math.floor(usable / pitch) + 1);
	const step = count > 1 ? usable / (count - 1) : 0;
	const out: [number, number][] = [];
	let j = 1;
	for (let n = 0; n < count; n++) {
		const target = inset + n * step;
		while (j < N && lengths[j]! < target) j++;
		const l0 = lengths[j - 1]!;
		const l1 = lengths[j]!;
		const f = l1 > l0 ? (target - l0) / (l1 - l0) : 0;
		const p0 = samples[j - 1]!;
		const p1 = samples[j]!;
		out.push([round(p0[0] + (p1[0] - p0[0]) * f), round(p0[1] + (p1[1] - p0[1]) * f)]);
	}
	return out;
}

export function ringDots(cx: number, cy: number, r: number, n: number): [number, number][] {
	const out: [number, number][] = [];
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2 - Math.PI / 2;
		out.push([round(cx + Math.cos(a) * r), round(cy + Math.sin(a) * r)]);
	}
	return out;
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}
