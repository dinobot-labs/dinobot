// Ambient types for the untyped build-time dependencies used by vite/fonts.ts.
declare module "subset-font" {
	interface SubsetOptions {
		targetFormat?: "sfnt" | "truetype" | "woff" | "woff2";
		preserveNameIds?: number[];
		variationAxes?: Record<string, number | { min: number; max: number; default?: number }>;
		noLayoutClosure?: boolean;
	}
	export default function subsetFont(font: Buffer | Uint8Array, text: string, options?: SubsetOptions): Promise<Buffer>;
}

declare module "fontverter" {
	const fontverter: {
		convert(font: Buffer | Uint8Array, format: "sfnt" | "truetype" | "woff" | "woff2", fromFormat?: string): Promise<Buffer>;
		detectFormat(font: Buffer | Uint8Array): string;
	};
	export default fontverter;
}
