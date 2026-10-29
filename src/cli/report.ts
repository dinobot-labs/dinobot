import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import packageJson from "../../package.json" with { type: "json" };
import { CONSENT_VERSION } from "../report/consent.ts";
import { classifyFetchError, collectDiagnostics, diagnosticLines, type Probe, probeHttp, readManifestLoose, REPORT_CLIENTS, reportUrl, REPORT_TRIGGERS, type ReportClient } from "../report/diagnostics.ts";
import type { RedactionCounts } from "../report/redact.ts";
import { ConsentRequiredError, ReportService, shortId, type SubmitResult } from "../report/service.ts";
import { defaultManifestPath } from "./default-manifest.ts";

/**
 * `dinobot report consent|agree|send|status` (ADR 0103). Runs without a daemon and without a valid manifest: it reads the
 * manifest loosely for the data directory and API port. `send` goes through a live daemon (POST /v1/report: conversation
 * and live state) unless `--offline` or nothing answers; otherwise it collects the diagnostics here and uploads directly.
 * Exit codes: 0 sent or pending, 1 failed, 2 usage or consent version mismatch, 3 consent required.
 */
const USAGE = `Usage: dinobot report <consent|agree <version> [--auto]|send|status> [--config <path>] [--json]
  send [--note <text>] [--trigger ${REPORT_TRIGGERS.join("|")}] [--client ${REPORT_CLIENTS.join("|")}]
       [--context-file <path>] [--thread <channel>:<threadKey>] [--offline]`;

const CONTEXT_FILE_CHARS = 2 * 1024 * 1024;
const DAEMON_PROBE_MS = 2_000;
const DAEMON_SUBMIT_MS = 120_000;

/** The manifest lookup of main.ts, without creating the default manifest. */
function manifestPath(explicit: string | undefined): string | undefined {
	const path = explicit ?? process.env.DINOBOT_CONFIG;
	if (path !== undefined) return resolve(path);
	if (existsSync("dinobot.yaml")) return resolve("dinobot.yaml");
	const fallback = defaultManifestPath(homedir());
	return existsSync(fallback) ? fallback : undefined;
}

const STATUS_KO: Record<string, string> = { sent: "보냄", pending: "전송 대기(자동 재시도)", failed: "실패" };

export async function runReport(argv: string[]): Promise<number> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (error) {
		console.error(`dinobot report: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
		return 2;
	}
	const { values, positionals } = parsed;
	const sub = positionals[0];
	if (values.help || sub === undefined || sub === "help") {
		console.log(USAGE);
		return sub === undefined && !values.help ? 2 : 0;
	}
	const json = values.json === true;
	const out = (value: unknown, human: string) => console.log(json ? JSON.stringify(value) : human);
	const path = manifestPath(values.config);
	const read = readManifestLoose(path);
	const url = reportUrl();
	const service = new ReportService({
		dataDir: read.dataDir,
		version: packageJson.version,
		url,
		log: (message) => console.error(`dinobot: ${message}`),
		diagnostics: async (request) => {
			const results = await collectDiagnostics({ ...(path ? { manifestPath: path } : {}), mode: "offline", client: request.client, trigger: request.trigger, version: packageJson.version, reportUrl: url, ...(request.context !== undefined ? { context: request.context } : {}) });
			const redactions: RedactionCounts = {};
			return { lines: diagnosticLines(results, { counts: redactions }), redactions };
		},
	});

	switch (sub) {
		case "consent": {
			const info = await service.consentInfo("owner");
			out(info, `${info.text}\n\n버전: ${info.version}\n동의 상태: ${info.consented ? `동의함 (${info.receipt?.at})` : "동의하지 않음"}\n동의하려면 1·2·3에 모두 동의한다는 뜻으로: dinobot report agree ${info.version}`);
			return 0;
		}
		case "agree": {
			const version = positionals[1];
			if (version !== CONSENT_VERSION) {
				if (json) console.log(JSON.stringify({ error: "version", version: CONSENT_VERSION }));
				else console.error(`dinobot report: 동의 문구를 확인한 뒤(dinobot report consent) 현재 버전으로 동의해 주세요: dinobot report agree ${CONSENT_VERSION}`);
				return 2;
			}
			const receipt = await service.recordConsent("owner", values.auto === true);
			out({ receipt }, `동의를 기록했습니다 (${receipt.version}, ${receipt.at}). 수집·이용, 국외 이전, 만 14세 이상에 동의한 것으로 기록됩니다.`);
			return 0;
		}
		case "status": {
			const consent = await service.consentInfo("owner");
			const reports = (await service.list("owner")).slice(-20).map((r) => ({ id: r.id, shortId: shortId(r.id), kind: r.kind, status: r.status, trigger: r.trigger?.rule ?? null, createdAt: r.createdAt, ...(r.sentAt ? { sentAt: r.sentAt } : {}), ...(r.error ? { error: r.error } : {}) }));
			const { text: _text, ...consentJson } = consent;
			out(
				{ consent: consentJson, reports },
				[`동의: ${consent.consented ? `${consent.receipt?.version} (${consent.receipt?.at})` : `없음 (현재 버전 ${consent.version})`}`, ...(reports.length ? reports.map((r) => `${r.shortId}  ${r.createdAt.slice(0, 16).replace("T", " ")} UTC  ${r.kind}${r.trigger ? ` · ${r.trigger}` : ""}  ${r.status}${r.error ? ` · ${r.error}` : ""}`) : ["보고가 없습니다."])].join("\n"),
			);
			return 0;
		}
		case "send":
			return send(service, values, read.port, out, json);
		default:
			console.error(`dinobot report: unknown subcommand ${sub}\n\n${USAGE}`);
			return 2;
	}
}

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			config: { type: "string", short: "c" },
			json: { type: "boolean" },
			auto: { type: "boolean" },
			note: { type: "string" },
			trigger: { type: "string" },
			client: { type: "string" },
			"context-file": { type: "string" },
			thread: { type: "string" },
			offline: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
}

type Values = ReturnType<typeof parse>["values"];

async function send(service: ReportService, values: Values, port: number | undefined, out: (value: unknown, human: string) => void, json: boolean): Promise<number> {
	const trigger = values.trigger ?? "cli";
	const client = (values.client ?? "cli") as ReportClient;
	if (!(REPORT_TRIGGERS as readonly string[]).includes(trigger) || !(REPORT_CLIENTS as readonly string[]).includes(client)) {
		console.error(`dinobot report: --trigger is one of ${REPORT_TRIGGERS.join(", ")}; --client one of ${REPORT_CLIENTS.join(", ")}`);
		return 2;
	}
	let thread: { channel: string; threadKey: string } | undefined;
	if (values.thread !== undefined) {
		const at = values.thread.indexOf(":");
		if (at <= 0 || at === values.thread.length - 1) {
			console.error("dinobot report: --thread is <channel>:<threadKey>, e.g. tui:main");
			return 2;
		}
		thread = { channel: values.thread.slice(0, at), threadKey: values.thread.slice(at + 1) };
	}
	let context: unknown;
	if (values["context-file"] !== undefined) {
		try {
			const text = (await readFile(values["context-file"], "utf8")).slice(0, CONTEXT_FILE_CHARS);
			try {
				context = JSON.parse(text);
			} catch {
				context = { unparsed: text.slice(0, 256 * 1024) };
			}
		} catch (error) {
			context = { contextFileError: (error as NodeJS.ErrnoException).code ?? String(error) };
		}
	}
	const note = values.note;

	let result: SubmitResult | undefined;
	let mode: "daemon" | "offline" = "offline";
	let probe: Probe | undefined;
	let fallback: string | undefined;
	if (!values.offline && port !== undefined) {
		const base = `http://127.0.0.1:${port}`;
		probe = await probeHttp(`${base}/healthz`, DAEMON_PROBE_MS);
		if (probe.status === "ok") {
			try {
				const res = await fetch(`${base}/v1/report`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ trigger, client, ...(note !== undefined ? { note } : {}), ...(thread ? { channel: thread.channel, thread: thread.threadKey } : {}), ...(context !== undefined ? { context } : {}) }),
					signal: AbortSignal.timeout(DAEMON_SUBMIT_MS),
				});
				if (res.status === 200) {
					result = (await res.json()) as SubmitResult;
					mode = "daemon";
				} else if (res.status === 403) return consentRequired(json);
				else fallback = `daemon answered HTTP ${res.status}${res.status === 404 ? " (older daemon or reports disabled)" : ""}`;
			} catch (error) {
				fallback = `daemon request ${classifyFetchError(error)}: ${error instanceof Error ? error.message : String(error)}`;
			}
		} else fallback = `daemon ${probe.status}`;
	} else fallback = values.offline ? "--offline" : "no api.port in the manifest";

	if (!result) {
		const supplied = typeof context === "object" && context !== null && !Array.isArray(context) ? (context as Record<string, unknown>) : context === undefined ? {} : { supplied: context };
		const offlineContext = { ...supplied, offlineCli: { daemonProbe: probe ?? null, reason: fallback } };
		try {
			result = await service.submit({ owner: "owner", trigger, client, reporter: "local", ...(note !== undefined ? { note } : {}), ...(thread ?? {}), context: offlineContext });
		} catch (error) {
			if (error instanceof ConsentRequiredError) return consentRequired(json);
			throw error;
		}
		// Reports an earlier run (or the dead daemon) left pending go out now too.
		await service.flush().catch(() => undefined);
	}
	const redactions = Object.entries(result.redactions).map(([kind, n]) => `${kind} ${n}`).join(", ") || "없음";
	out(
		{ ...result, mode, ...(mode === "offline" && fallback ? { daemon: fallback } : {}) },
		[
			`보고 ${result.shortId} ${STATUS_KO[result.status] ?? result.status} (${mode === "daemon" ? "데몬 경유" : "데몬 없이 직접"})`,
			`- 진단 ${result.diagnostics}줄, 전체 ${result.entries}줄, 압축 ${(result.compressedBytes / 1024).toFixed(1)} KiB, 지운 정보: ${redactions}`,
			...(result.error ? [`- 오류: ${result.error}`] : []),
			`- 취소·삭제: TUI에서 /report undo ${result.shortId}`,
		].join("\n"),
	);
	return result.status === "failed" ? 1 : 0;
}

function consentRequired(json: boolean): number {
	if (json) console.log(JSON.stringify({ error: "consent_required", version: CONSENT_VERSION }));
	else console.error(`dinobot report: 먼저 동의가 필요합니다. 문구: dinobot report consent · 동의: dinobot report agree ${CONSENT_VERSION}`);
	return 3;
}
