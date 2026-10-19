import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv, NativeProcessEvent } from "@earendil-works/pi-durable/env";
import { isNativeProcessEvent } from "@earendil-works/pi-durable/env/node";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { loadSoul } from "./soul.ts";

export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function inside(root: string, path: string): boolean { const p = relative(root, path); return p === "" || (!p.startsWith(`..${sep}`) && p !== ".." && !isAbsolute(p)); }
export type HostStoragePaths = { files: string[]; directories: string[] };
export type InputScope = { root: string; inputs: string[]; disposable: string[] };
export type CheckMethod = { command: string; cwd: string; runner: "process" | "bun"; args: string[]; locators: { scenarioId: string; file: string; name: string }[]; timeout: number; adapterVersion: 1 };
export type CheckObligation = { id: string; requirementIds: string[]; scenarioIds: string[]; evidence: "behavioral" | "build" | "lint" | "typecheck" | "smoke" | "human"; expected: string };
export type ProcessObservation = { command: string; cwd: string; exitCode: number | null; error: string | null; durationMs: number; output: string; report: string; truncated: boolean; observed: string[]; passed: boolean; quiescent: boolean };
export type Fingerprint = { hash: string; files: number; bytes: number; soulDigest: string };

async function gitInventory(root: string, args: string[], context: Context, deadline: number): Promise<{ text: string; code: number }> {
	context.abortSignal?.throwIfAborted();
	const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, Math.max(1, deadline - Date.now()));
	const abort = () => child.kill("SIGKILL");
	context.abortSignal?.addEventListener("abort", abort, { once: true });
	async function bounded(stream: ReadableStream<Uint8Array>): Promise<string> {
		const reader = stream.getReader(); const chunks: Uint8Array[] = []; let total = 0;
		try { for (;;) { const result = await reader.read(); if (result.done) break; total += result.value.byteLength; if (total > 16 * 1024 * 1024) { child.kill(); throw new Error("git_inventory_output_limit"); } chunks.push(result.value); } }
		finally { reader.releaseLock(); }
		return Buffer.concat(chunks).toString();
	}
	try { const [text, , code] = await Promise.all([bounded(child.stdout), bounded(child.stderr), child.exited]); context.abortSignal?.throwIfAborted(); if (timedOut) throw new Error("fingerprint_time_limit"); return { text, code }; }
	finally { clearTimeout(timer); context.abortSignal?.removeEventListener("abort", abort); }
}

/** Host filesystem implementation: remote environments must supply their own implementation, not local guesses. */
export async function fingerprint(scope: InputScope, host: HostStoragePaths, environment: string, context: Context): Promise<Fingerprint> {
	const start = Date.now(); const root = await realpath(scope.root); let bytes = 0; let files = 0;
	const entries: unknown[] = []; const seen = new Set<string>();
	const reservedFiles = new Set(host.files.map(p => resolve(p)));
	const reservedDirs = host.directories.map(p => resolve(p));
	const reserved = (p: string) => reservedFiles.has(p) || reservedDirs.some(d => inside(d, p));
	if (reserved(root)) throw new Error(`runtime_input_collision: ${root}`);
	for (const disposable of scope.disposable) {
		const path = resolve(root, disposable);
		if (path === root || !inside(root, path)) throw new Error(`invalid_disposable_root: ${disposable}`);
	}
	const explicit = scope.inputs.map(p => resolve(root, p));
	const tracked = new Set<string>(); let gitPaths: string[] | undefined;
	// Git is an input inventory, never a verification process receipt.
	let gitRoot = root; let hasGit = false;
	for (;;) {
		try { await lstat(resolve(gitRoot, ".git")); hasGit = true; break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const parent = resolve(gitRoot, ".."); if (parent === gitRoot) break; gitRoot = parent;
	}
	if (hasGit) {
		const git = await gitInventory(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], context, start + 15_000);
		if (git.code !== 0) throw new Error("git input inventory failed");
		gitPaths = git.text.split("\0").filter(Boolean);
		const cached = await gitInventory(root, ["ls-files", "-z", "--cached"], context, start + 15_000);
		if (cached.code !== 0) throw new Error("git tracked inventory failed");
		for (const p of cached.text.split("\0").filter(Boolean)) tracked.add(resolve(root, p));
	}
	for (const p of [...tracked, ...explicit]) if (reserved(p) || reservedDirs.some(d => inside(p, d)) || [...reservedFiles].some(f => inside(p, f))) throw new Error(`runtime_input_collision: ${p}`);
	async function visit(path: string, forced = false): Promise<void> {
		context.abortSignal?.throwIfAborted();
		if (Date.now() - start > 15_000) throw new Error("fingerprint_time_limit");
		path = resolve(path); if (seen.has(path)) return;
		if (reserved(path)) { if (forced || tracked.has(path)) throw new Error(`runtime_input_collision: ${path}`); return; }
		const rel = relative(root, path); const parts = rel.split(sep);
		if (!forced && !tracked.has(path) && (parts.includes(".git") || parts.includes("node_modules") || scope.disposable.some(p => inside(resolve(root, p), path)))) return;
		seen.add(path);
		let stat;
		try { stat = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && tracked.has(path)) { entries.push([path, "missing"]); return; } throw error; }
		if (++files > 50_000) throw new Error("fingerprint_file_limit");
		if (stat.isDirectory()) {
			entries.push([path, "directory", stat.mode]); const names: string[] = [];
			for await (const entry of await opendir(path)) { context.abortSignal?.throwIfAborted(); if (Date.now() - start > 15_000) throw new Error("fingerprint_time_limit"); if (names.length >= 50_000) throw new Error("fingerprint_file_limit"); names.push(entry.name); }
			for (const name of names.sort()) await visit(resolve(path, name), forced);
		}
		else if (stat.isSymbolicLink()) { const target = await realpath(path); if (!inside(root, target) && !explicit.some(p => inside(p, target))) throw new Error(`unscoped_symlink: ${path}`); entries.push([path, "symlink", stat.mode, await readlink(path)]); await visit(target, true); }
		else if (stat.isFile()) {
			if (stat.size + bytes > 256 * 1024 * 1024) throw new Error("fingerprint_byte_limit");
			const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); const hash = createHash("sha256"); const buffer = Buffer.alloc(64 * 1024);
			try {
				const opened = await file.stat();
				if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error(`input_changed_during_capture: ${path}`);
				for (;;) { context.abortSignal?.throwIfAborted(); if (Date.now() - start > 15_000) throw new Error("fingerprint_time_limit"); const { bytesRead } = await file.read(buffer); bytes += bytesRead; if (bytes > 256 * 1024 * 1024) throw new Error("fingerprint_byte_limit"); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
				const closed = await file.stat();
				if (opened.size !== closed.size || opened.mtimeMs !== closed.mtimeMs || opened.ctimeMs !== closed.ctimeMs) throw new Error(`input_changed_during_capture: ${path}`);
			}
			finally { await file.close(); }
			entries.push([path, "file", stat.mode, hash.digest("hex")]);
		}
		else throw new Error(`unsupported_input: ${path}`);
	}
	for (const p of explicit) await visit(p, true);
	if (gitPaths) for (const p of gitPaths.sort()) await visit(resolve(root, p)); else await visit(root);
	const soul = await loadSoul(root); if (!soul.valid) throw new Error(soul.diagnostics.join("; "));
	context.abortSignal?.throwIfAborted(); if (Date.now() - start > 15_000) throw new Error("fingerprint_time_limit");
	return { hash: digest({ entries: entries.sort((a, b) => canonical(a).localeCompare(canonical(b))), scope, host, environment, soul: soul.digest, runtime: { bun: Bun.version, platform: process.platform, arch: process.arch, executable: process.execPath, bunExecutable: Bun.which("bun"), shellExecutable: Bun.which("bash"), environmentHash: digest(process.env) } }), files, bytes, soulDigest: soul.digest };
}
const list = (value: unknown): Record<string, unknown>[] => value === undefined ? [] : (Array.isArray(value) ? value : [value]) as Record<string, unknown>[];
export function parseBunReport(report: string, method: CheckMethod, check: CheckObligation): string[] {
	if (Buffer.byteLength(report) > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(report) || XMLValidator.validate(report) !== true) throw new Error("invalid_bun_report");
	const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false }).parse(report);
	if (parsed.testsuites?.name !== "bun test") throw new Error("unrecognized_bun_report");
	const suites = list(parsed.testsuites.testsuite); const cases = suites.flatMap(s => list(s.testcase));
	if (!cases.length || Number(parsed.testsuites.failures) !== 0 || Number(parsed.testsuites.errors ?? 0) !== 0) throw new Error("failed_or_empty_bun_report");
	if (cases.some(c => "failure" in c || "error" in c) || suites.some(s => Number(s.failures ?? 0) !== 0 || Number(s.errors ?? 0) !== 0 || Number(s.tests) !== list(s.testcase).length) || Number(parsed.testsuites.tests) !== cases.length) throw new Error("inconsistent_bun_report");
	const executed = cases.filter(c => !("skipped" in c));
	if (!executed.length || Number(parsed.testsuites.skipped ?? 0) !== cases.length - executed.length) throw new Error("empty_or_inconsistent_bun_report");
	return check.scenarioIds.filter(id => {
		const locator = method.locators.find(l => l.scenarioId === id);
		return locator && executed.some(c => c.name === locator.name && typeof c.file === "string" && resolve(method.cwd, c.file) === resolve(method.cwd, locator.file));
	});
}
export async function executeCheck(env: ExecutionEnv, method: CheckMethod, check: CheckObligation, reportPath: string, context: Context): Promise<ProcessObservation> {
	let output = ""; let truncated = false; const started = Date.now();
	const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
	const command = method.runner === "bun" ? [quote(method.command), "test", ...method.args.map(quote), "--reporter=junit", `--reporter-outfile=${quote(reportPath)}`].join(" ") : [method.command, ...method.args.map(quote)].join(" ");
	const events: NativeProcessEvent[] = [];
	const result = await env.exec(command, { cwd: method.cwd, timeout: method.timeout, onProcess: event => {
		if (!isNativeProcessEvent(event)) throw new Error("forged_native_process_receipt");
		events.push(event);
	}, onOutput: text => { const available = 1024 * 1024 - Buffer.byteLength(output); if (Buffer.byteLength(text) > available) truncated = true; if (available > 0) output += Buffer.from(text).subarray(0, available).toString(); } }, context);
	let report = ""; let observed: string[] = []; let error = result.ok ? null : `${result.error.code}: ${result.error.message}`;
	if (method.runner === "bun" && result.ok) {
		const info = await env.fileInfo(reportPath, context);
		if (!info.ok || info.value.size + Buffer.byteLength(output) > 1024 * 1024) { truncated = true; error = "missing_or_truncated_required_report"; }
		else {
			try {
				const file = await open(reportPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); const chunks: Buffer[] = []; let size = Buffer.byteLength(output);
				const deadline = Date.now() + 15_000;
				try {
					if (!(await file.stat()).isFile()) throw new Error("invalid_report_file_type");
					for (;;) { context.abortSignal?.throwIfAborted(); if (Date.now() >= deadline) throw new Error("report_capture_time_limit"); const buffer = Buffer.alloc(64 * 1024); const read = await file.read(buffer); if (!read.bytesRead) break; size += read.bytesRead; if (size > 1024 * 1024) { truncated = true; throw new Error("truncated_required_report"); } chunks.push(buffer.subarray(0, read.bytesRead)); }
				}
				finally { await file.close(); }
				report = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); observed = parseBunReport(report, method, check);
			} catch (e) { error = String(e); }
		}
	}
	const passed = result.ok && result.value.exitCode === 0 && !truncated && !error && check.evidence !== "human" && (check.evidence !== "behavioral" || check.scenarioIds.every(id => observed.includes(id)));
	return { command, cwd: method.cwd, exitCode: result.ok ? result.value.exitCode : null, error, durationMs: Date.now() - started, output, report, truncated, observed, passed, quiescent: nativeSettled(events) };
}
/** Every admitted native process has a canonical settlement bound to its observed start identity. Exit codes are not settlement. */
export function nativeSettled(events: readonly NativeProcessEvent[]): boolean {
	const admitted = events.filter(e => e.phase === "admitted");
	return admitted.length > 0 && admitted.every(a => events.some(e => e.nonce === a.nonce && e.phase === "settled" && e.canonical && events.some(s => s.nonce === e.nonce && s.phase === "started" && s.pid === e.pid && s.startTime === e.startTime)));
}
