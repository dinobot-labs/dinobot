/// <reference path="./env.d.ts" />
/**
 * Korean webfont subset (BRIEF 10: fonts at most 160 KB for `/` and 260 KB for `/ko/`).
 *
 * The Latin faces (Geist, Geist Mono, Doto) ship as static woff2 files in public/fonts. Korean needs ~11k Hangul
 * syllables, so the full Pretendard Variable woff2 (2.0 MB) is never shipped. Instead, at config time (dev and build),
 * this module collects every Korean character that appears anywhere under src/ (page templates, dictionaries,
 * scene labels), subsets Pretendard Variable to exactly those glyphs (all weights, 45-920), and writes
 * public/fonts/dinobot-kr.woff2.
 *
 * Licensing: Pretendard is OFL-1.1 with the Reserved Font Name "Pretendard". A subset is a Modified Version, so
 * the subset is renamed "dinobot KR" in its name table (copyright, trademark and license records are kept
 * verbatim). See docs/licenses.md.
 *
 * Caching: the character set, the source font and SUBSET_VERSION are hashed into
 * node_modules/.cache/dinobot-landing/fonts.json; an unchanged hash skips the work (a cold run takes ~0.5 s).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative } from "node:path";

/** Bump when the subsetting or renaming logic changes, to invalidate caches. */
const SUBSET_VERSION = 3;
export const KOREAN_FAMILY = "dinobot KR";
const POSTSCRIPT_FAMILY = "dinobotKR";
const RESERVED_NAME = "Pretendard";
export const KOREAN_SUBSET_FILE = "public/fonts/dinobot-kr.woff2";
const SOURCE_FONT = "pretendard/dist/web/variable/woff2/PretendardVariable.woff2";

/** Code point ranges served by the Korean face. Keep in sync with the unicode-range in src/client/styles/base.css. */
export const KOREAN_RANGES: readonly (readonly [number, number])[] = [
	[0x1100, 0x11ff], // Hangul Jamo
	[0x3000, 0x303f], // CJK Symbols and Punctuation
	[0x3130, 0x318f], // Hangul Compatibility Jamo
	[0xa960, 0xa97f], // Hangul Jamo Extended-A
	[0xac00, 0xd7a3], // Hangul Syllables
	[0xd7b0, 0xd7ff], // Hangul Jamo Extended-B
	[0xff00, 0xffef], // Halfwidth and Fullwidth Forms
];

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".html", ".json", ".css", ".svg", ".md"]);

const isKorean = (cp: number) => KOREAN_RANGES.some(([a, b]) => cp >= a && cp <= b);

function walk(dir: string, files: string[] = []): string[] {
	if (!existsSync(dir)) return files;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, files);
		else if (SCAN_EXTENSIONS.has(extname(entry.name))) files.push(path);
	}
	return files;
}

/** Every Korean character used under the given directories, sorted by code point. */
export function collectKoreanText(dirs: string[]): string {
	const set = new Set<number>();
	for (const dir of dirs) {
		for (const file of walk(dir)) {
			for (const ch of readFileSync(file, "utf8")) {
				const cp = ch.codePointAt(0) ?? 0;
				if (isKorean(cp)) set.add(cp);
			}
		}
	}
	return String.fromCodePoint(...[...set].sort((a, b) => a - b));
}

// ---------------------------------------------------------------- sfnt name table rewrite

const u16 = (b: Buffer, o: number) => b.readUInt16BE(o);
const u32 = (b: Buffer, o: number) => b.readUInt32BE(o);

function checksum(data: Buffer): number {
	const padded = data.length % 4 ? Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]) : data;
	let sum = 0;
	for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
	return sum;
}

function decodeName(platform: number, raw: Buffer): string {
	if ((platform === 0 || platform === 3) && raw.length % 2 === 0) return Buffer.from(raw).swap16().toString("utf16le");
	return raw.toString("latin1");
}

function encodeName(platform: number, text: string): Buffer {
	if (platform === 0 || platform === 3) return Buffer.from(text, "utf16le").swap16();
	return Buffer.from(text, "latin1");
}

/** Name IDs that must stay verbatim: copyright (0), trademark (7), license description (13) and URL (14). */
const KEEP_VERBATIM = new Set([0, 7, 13, 14]);
/** Name IDs kept by the subset besides harfbuzz's defaults (0-6 and those fvar/STAT reference). */
const PRESERVE_NAME_IDS = [7, 8, 9, 11, 12, 13, 14];
/** PostScript-style names, which may not contain spaces (fvar instance PostScript names are caught by the no-space rule). */
const POSTSCRIPT_IDS = new Set([6, 25]);

function rewriteNameTable(name: Buffer): { table: Buffer; renamed: number } {
	const format = u16(name, 0);
	const count = u16(name, 2);
	const stringOffset = u16(name, 4);
	const records: { platform: number; encoding: number; language: number; id: number; data: Buffer }[] = [];
	for (let i = 0; i < count; i++) {
		const o = 6 + i * 12;
		const length = u16(name, o + 8);
		const offset = u16(name, o + 10);
		records.push({
			platform: u16(name, o),
			encoding: u16(name, o + 2),
			language: u16(name, o + 4),
			id: u16(name, o + 6),
			data: name.subarray(stringOffset + offset, stringOffset + offset + length),
		});
	}
	let langTags: Buffer[] = [];
	if (format === 1) {
		const tagCount = u16(name, 6 + count * 12);
		for (let i = 0; i < tagCount; i++) {
			const o = 8 + count * 12 + i * 4;
			langTags.push(name.subarray(stringOffset + u16(name, o + 2), stringOffset + u16(name, o + 2) + u16(name, o)));
		}
	}
	let renamed = 0;
	for (const record of records) {
		if (KEEP_VERBATIM.has(record.id)) continue;
		const text = decodeName(record.platform, record.data);
		if (!text.includes(RESERVED_NAME)) continue;
		const replacement = POSTSCRIPT_IDS.has(record.id) || !/\s/.test(text) ? POSTSCRIPT_FAMILY : KOREAN_FAMILY;
		record.data = encodeName(record.platform, text.split(RESERVED_NAME).join(replacement));
		renamed++;
	}
	const strings: Buffer[] = [];
	let cursor = 0;
	const recordBytes = Buffer.alloc(count * 12);
	records.forEach((r, i) => {
		const o = i * 12;
		recordBytes.writeUInt16BE(r.platform, o);
		recordBytes.writeUInt16BE(r.encoding, o + 2);
		recordBytes.writeUInt16BE(r.language, o + 4);
		recordBytes.writeUInt16BE(r.id, o + 6);
		recordBytes.writeUInt16BE(r.data.length, o + 8);
		recordBytes.writeUInt16BE(cursor, o + 10);
		strings.push(r.data);
		cursor += r.data.length;
	});
	const tagBytes = Buffer.alloc(format === 1 ? 2 + langTags.length * 4 : 0);
	if (format === 1) {
		tagBytes.writeUInt16BE(langTags.length, 0);
		langTags.forEach((tag, i) => {
			tagBytes.writeUInt16BE(tag.length, 2 + i * 4);
			tagBytes.writeUInt16BE(cursor, 4 + i * 4);
			strings.push(tag);
			cursor += tag.length;
		});
	} else langTags = [];
	const header = Buffer.alloc(6);
	header.writeUInt16BE(format, 0);
	header.writeUInt16BE(count, 2);
	header.writeUInt16BE(6 + recordBytes.length + tagBytes.length, 4);
	return { table: Buffer.concat([header, recordBytes, tagBytes, ...strings]), renamed };
}

/** Replaces the name table of a TrueType/OpenType font and fixes the table checksums and head.checkSumAdjustment. */
export function renameFont(sfnt: Buffer): { font: Buffer; renamed: number } {
	const flavor = sfnt.subarray(0, 4);
	const numTables = u16(sfnt, 4);
	const tables: { tag: string; data: Buffer }[] = [];
	for (let i = 0; i < numTables; i++) {
		const o = 12 + i * 16;
		const tag = sfnt.toString("latin1", o, o + 4);
		const offset = u32(sfnt, o + 8);
		const length = u32(sfnt, o + 12);
		tables.push({ tag, data: Buffer.from(sfnt.subarray(offset, offset + length)) });
	}
	const name = tables.find((t) => t.tag === "name");
	const head = tables.find((t) => t.tag === "head");
	if (!name || !head) throw new Error("subset font has no name or head table");
	const { table, renamed } = rewriteNameTable(name.data);
	name.data = table;
	head.data.writeUInt32BE(0, 8); // checkSumAdjustment is recomputed below
	tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
	const entrySelector = Math.floor(Math.log2(numTables));
	const searchRange = 2 ** entrySelector * 16;
	const header = Buffer.alloc(12 + numTables * 16);
	flavor.copy(header, 0);
	header.writeUInt16BE(numTables, 4);
	header.writeUInt16BE(searchRange, 6);
	header.writeUInt16BE(entrySelector, 8);
	header.writeUInt16BE(numTables * 16 - searchRange, 10);
	const bodies: Buffer[] = [];
	let offset = header.length;
	let headOffset = 0;
	tables.forEach((t, i) => {
		const o = 12 + i * 16;
		header.write(t.tag, o, 4, "latin1");
		header.writeUInt32BE(checksum(t.data), o + 4);
		header.writeUInt32BE(offset, o + 8);
		header.writeUInt32BE(t.data.length, o + 12);
		if (t.tag === "head") headOffset = offset;
		const padded = t.data.length % 4 ? Buffer.concat([t.data, Buffer.alloc(4 - (t.data.length % 4))]) : t.data;
		bodies.push(padded);
		offset += padded.length;
	});
	const font = Buffer.concat([header, ...bodies]);
	font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOffset + 8);
	return { font, renamed };
}

/** Reads the name records of an sfnt (for checks): [{ id, text }]. */
export function readNames(sfnt: Buffer): { id: number; platform: number; text: string }[] {
	const numTables = u16(sfnt, 4);
	for (let i = 0; i < numTables; i++) {
		const o = 12 + i * 16;
		if (sfnt.toString("latin1", o, o + 4) !== "name") continue;
		const base = u32(sfnt, o + 8);
		const count = u16(sfnt, base + 2);
		const stringOffset = u16(sfnt, base + 4);
		const out: { id: number; platform: number; text: string }[] = [];
		for (let r = 0; r < count; r++) {
			const ro = base + 6 + r * 12;
			const platform = u16(sfnt, ro);
			const start = base + stringOffset + u16(sfnt, ro + 10);
			out.push({ id: u16(sfnt, ro + 6), platform, text: decodeName(platform, sfnt.subarray(start, start + u16(sfnt, ro + 8))) });
		}
		return out;
	}
	return [];
}

// ---------------------------------------------------------------- subset

export interface SubsetResult {
	file: string;
	chars: number;
	bytes: number;
	cached: boolean;
	ms: number;
}

interface Logger {
	info(message: string): void;
	warn(message: string): void;
}

/**
 * Makes sure public/fonts/dinobot-kr.woff2 holds every Korean character used under src/.
 * Returns null when no Korean text exists (nothing to serve).
 */
export async function ensureKoreanSubset(root: string, logger?: Logger): Promise<SubsetResult | null> {
	const t0 = Date.now();
	const text = collectKoreanText([join(root, "src")]);
	const out = join(root, KOREAN_SUBSET_FILE);
	if (!text) return null;
	const require = createRequire(join(root, "package.json"));
	let source: string;
	try {
		source = require.resolve(SOURCE_FONT);
	} catch {
		logger?.warn(`fonts: ${SOURCE_FONT} is not installed (bun install); keeping the existing ${KOREAN_SUBSET_FILE}`);
		return null;
	}
	const cacheFile = join(root, "node_modules", ".cache", "dinobot-landing", "fonts.json");
	const hash = createHash("sha256").update(`${SUBSET_VERSION}\n${statSync(source).size}\n${text}`).digest("hex");
	if (existsSync(out) && existsSync(cacheFile)) {
		try {
			const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as { hash?: string };
			if (cache.hash === hash) return { file: KOREAN_SUBSET_FILE, chars: [...text].length, bytes: statSync(out).size, cached: true, ms: Date.now() - t0 };
		} catch {}
	}
	const { default: subsetFont } = await import("subset-font");
	const { default: fontverter } = await import("fontverter");
	const sfnt = await subsetFont(readFileSync(source), text, { targetFormat: "truetype", preserveNameIds: PRESERVE_NAME_IDS });
	const { font } = renameFont(Buffer.from(sfnt));
	const woff2 = Buffer.from(await fontverter.convert(font, "woff2"));
	mkdirSync(dirname(out), { recursive: true });
	if (!existsSync(out) || !readFileSync(out).equals(woff2)) writeFileSync(out, woff2);
	mkdirSync(dirname(cacheFile), { recursive: true });
	writeFileSync(cacheFile, JSON.stringify({ hash, chars: [...text].length, bytes: woff2.length }) + "\n");
	const result = { file: KOREAN_SUBSET_FILE, chars: [...text].length, bytes: woff2.length, cached: false, ms: Date.now() - t0 };
	logger?.info(`fonts: ${relative(root, out).split("\\").join("/")} ${result.chars} Korean glyphs, ${(woff2.length / 1024).toFixed(1)} KB (${result.ms} ms)`);
	return result;
}
