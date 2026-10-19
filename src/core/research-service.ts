import { randomUUID } from "node:crypto";
import { parseReadiness } from "./research-readiness.ts";
import { researchContext, assertResearchContext } from "./research-context.ts";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { type ConversationId, defineDoc, defineTask, type Harness, type TaskId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { advanceDag, type DagApi } from "../extensions/dag.ts";
import { AgentsDoc, MissionSpawnDoc, RESEARCH_READ_TOOLS, type SpawnApi, type SubagentSpawner } from "../extensions/subagents.ts";
import { cancel as cancelDag, createRun, RunDoc, settleOwnedNode, start as startNode } from "./dag.ts";
import {
	acceptEvaluation,
	addMission,
	type Attempt,
	bindAttempt,
	blockMission,
	budgetView,
	cancelMission,
	type CommandSpec,
	type Contract,
	createMission,
	type Evaluation,
	type Limits,
	type Mission,
	nextAction,
	ResearchDoc,
	researchHash,
	reserveAttempt,
	resolveLimits,
	settleAttempt,
	stopMission,
	validateContract,
} from "./research.ts";
import {
	applyResearchEdits,
	assertResearchEvaluatorUnchanged,
	type CodeExperimentSpec,
	createResearchWorktree,
	hashResearchBytes,
	researchArtifactHash,
	researchContainedPath,
	type ResearchEdit,
	researchPatch,
	runResearchProcess,
	validateCodeExperiment,
} from "./research-experiments.ts";
import { projectResearchReport, readResearchReport } from "./research-reports.ts";

export type ResearchStartArgs = { contract: Contract; budget?: Partial<Limits>; supersedes?: string };
type Artifact = { content: string; edits?: ResearchEdit[]; worktree?: string };
type ObservedSource = { locator: string; content: string; hash: string };
type ServiceRecord = {
	startKey: string;
	requestHash: string;
	artifacts: Record<string, Artifact>;
	raw: Record<string, string>;
	external: Record<string, { state: "intent" | "done"; pid?: number }>;
	stages?: Record<string, {
		state: "intent" | "done";
		epoch: number;
		artifactHash: string;
		contractHash: string;
		deadlineAt: number;
		argv: string[];
		receipt?: import("./research-experiments.ts").ProcessReceipt;
		receiptHash?: string;
		bytes?: number;
		predecessorReceiptHash?: string;
	}>;
	initialized: boolean;
	nodes?: Record<string, string>;
};
export const ResearchServiceDoc = defineDoc<{ records: Record<string, ServiceRecord> }>({
	kind: "dinobot.research-service",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ records: {} }),
});
const copy = <T>(value: T): T => structuredClone(value);
const boundedError = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 4000);
function parse(text: string): Record<string, unknown> {
	if (Buffer.byteLength(text) > 128 * 1024) throw new Error("Research output exceeds 128 KiB");
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected research JSON object");
	return value as Record<string, unknown>;
}
function spec(m: Mission): CodeExperimentSpec {
	const c = m.contract.command!;
	return {
		baseCommit: c.baseCommit,
		allowedPaths: c.permittedPaths,
		command: { argv: [c.executable, ...c.argv], timeoutMs: c.timeoutMs },
		evaluatorRevision: m.contract.evaluator.revision,
		authorityRef: m.contract.codeAuthorityRef!,
	};
}
function getMission(missions: Mission[], id: string): Mission {
	const m = missions.find((m) => m.id === id);
	if (!m) throw new Error("Unknown research mission");
	return m;
}
function directory(m: Mission): string {
	return `.dinobot/research/${m.id}`;
}
function environmentFingerprint(root: string, command?: CommandSpec): string {
	return researchHash({
		root,
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		bun: typeof Bun === "undefined" ? null : Bun.version,
		environment: command?.environmentAllowlist.map((key) => [key, process.env[key] ?? null]) ?? [],
	});
}
async function baseArtifactHash(root: string, command: CommandSpec): Promise<string> {
	const git = async (...args: string[]) => {
		const r = await runResearchProcess({
			argv: ["git", "-c", "core.hooksPath=/dev/null", ...args],
			cwd: root,
			timeoutMs: 30_000,
			maxOutputBytes: 1024 * 1024,
		});
		if (r.status !== "completed") throw new Error(`Cannot bind baseline: ${r.stderr || r.status}`);
		return r.stdout;
	};
	if (await realpath((await git("rev-parse", "--show-toplevel")).trim()) !== root) throw new Error("Code mission requires bound Git root");
	if ((await git("rev-parse", "--verify", `${command.baseCommit}^{commit}`)).trim() !== command.baseCommit) {
		throw new Error("Pinned base commit mismatch");
	}
	const listed = new Set(
		(await git("ls-tree", "-r", "--name-only", "-z", command.baseCommit, "--", ...command.permittedPaths)).split("\0"),
	);
	const files: [string, string | null][] = [];
	for (const path of [...command.permittedPaths].sort()) {
		files.push([path, listed.has(path) ? await git("show", `${command.baseCommit}:${path}`) : null]);
	}
	return hashResearchBytes(JSON.stringify({ base: command.baseCommit, files }));
}

export function createResearchService(
	options: {
		getHarness: () => Harness;
		spawner: { current?: SubagentSpawner };
		workspaceRoot: string;
		codeProfiles?: Record<string, CommandSpec> | undefined;
	},
) {
	const h = () => options.getHarness();
	const apiFor = (conversationId: ConversationId): DagApi => ({
		conversationId,
		commit: h().commit.bind(h()),
		snapshot: h().snapshot.bind(h()),
	});
	const processes = new Map<string, AbortController>();
	async function load(conversationId: ConversationId, missionId: string, context: Context) {
		const doc = await h().snapshot(ResearchDoc, conversationId, context);
		if (!doc) throw new Error("Research state missing");
		return getMission(doc.missions, missionId);
	}
	async function mutate<T>(
		conversationId: ConversationId,
		missionId: string,
		context: Context,
		fn: (m: Mission, s: ServiceRecord) => T,
	): Promise<T> {
		return h().commit(async (tx) => {
			const m = getMission((await tx.doc(ResearchDoc, conversationId)).missions, missionId);
			const s = (await tx.doc(ResearchServiceDoc, conversationId)).records[missionId];
			if (!s) throw new Error("Research service record missing");
			return fn(m, s);
		}, context);
	}
	async function project(conversationId: ConversationId, id: string, context: Context) {
		const m = await load(conversationId, id, context);
		if (m.contract.reportAuthorityRef === "none") return;
		const s = (await h().snapshot(ResearchServiceDoc, conversationId, context))!.records[id]!;
		try {
			// Projection status is mutable bookkeeping, not scientific state. Excluding it
			// keeps a repaired revision from embedding its previous projection failure.
			const { report: _projection, ...scientificState } = m;
			let patch: string | undefined;
			const chosen = m.selectedId ?? m.incumbentId;
			if (chosen && s.artifacts[chosen]?.worktree) patch = await researchPatch(s.artifacts[chosen]!.worktree!, spec(m));
			const result = await projectResearchReport({
				missionId: id,
				root: m.projectRoot,
				directory: directory(m),
				revision: m.revision,
				maxBytes: m.limits.maxArtifactBytes,
				report: `# Research mission\n\n${m.contract.question}\n\nStatus: ${m.status}; judgment: ${m.judgment}; reason: ${
					m.stopReason ?? "running"
				}\n\nQualitative review is not mathematical certification. Trusted code runs as the local user; no sandbox or secret holdout.\n\n\`\`\`json\n${
					JSON.stringify(scientificState, null, 2)
				}\n\`\`\`\n`,
				evidence: `# Evidence and candidate lineage\n\n${
					JSON.stringify({ candidates: m.candidates, evaluations: m.evaluations }, null, 2)
				}`,
				...(m.contract.mode === "trusted-local-code"
					? { experiments: JSON.stringify({ base: m.contract.command!.baseCommit, raw: s.raw, external: s.external, stages: s.stages ?? {} }, null, 2) }
					: {}),
				...(patch !== undefined ? { patch } : {}),
			});
			await mutate(conversationId, id, context, (current) => {
				if (current.revision === m.revision) {
					current.report.state = "current";
					current.report.writtenRevision = result.revision;
					current.report.path = directory(m);
					delete current.report.error;
				}
			});
		} catch (error) {
			await mutate(conversationId, id, context, (current) => {
				current.report.state = "failed";
				current.report.error = boundedError(error);
			});
		}
	}
	async function failAttempt(conversationId: ConversationId, id: string, attemptId: string, error: unknown, context: Context) {
		await h().commit(async (tx) => {
			const m = getMission((await tx.doc(ResearchDoc, conversationId)).missions, id);
			const a = m.attempts.find((a) => a.id === attemptId)!;
			const s = (await tx.doc(ResearchServiceDoc, conversationId)).records[id]!;
			if (a.state === "reserved" || a.state === "running") {
				const ambiguous = Object.entries(s.stages ?? {}).some(([key, stage]) => key.startsWith(`${a.id}/`) && stage.state === "intent");
				settleAttempt(m, a.id, { state: ambiguous ? "unknown" : "failed", error: boundedError(error) }, a.cancellationEpoch, Date.now());
				if (m.contract.command?.resultSchema === "research-numeric-v2" && m.status === "running") blockMission(m, "protocol_or_execution_failure", Date.now());
			}
			const runId = a.binding?.runId ?? Object.keys(s.nodes ?? {}).find((key) => s.nodes![key] === a.id)?.split("/")[0];
			const run = (await tx.doc(RunDoc, conversationId)).runs.find((r) => r.id === runId);
			if (run?.status === "running") cancelDag(run, boundedError(error), Date.now());
		}, context);
	}
	function evaluation(m: Mission, a: Attempt, raw: string, completed: boolean, sources: ObservedSource[], provenance?: string): Evaluation {
		const data = completed ? parse(raw) : {};
		if (completed && (typeof data.feedback !== "string" || !data.feedback.trim() || data.feedback.length > 4096)) {
			throw new Error("Evaluator feedback must be a nonempty string of at most 4096 characters");
		}
		const numeric = m.contract.policy.kind === "numeric";
		const e: Evaluation = {
			id: `e-${a.id}`,
			missionId: m.id,
			candidateId: a.candidateId,
			attemptId: a.id,
			binding: a.binding!,
			artifactHash: m.candidates.find((c) => c.id === a.candidateId)!.artifactHash!,
			contractHash: m.contractHash,
			evaluatorRevision: m.contract.evaluator.revision,
			environmentFingerprint: m.contract.evaluator.environmentFingerprint,
			inputFingerprint: m.contract.evaluator.inputFingerprint,
			execution: completed ? "completed" : "failed",
			validity: completed ? "valid" : "invalid",
			verdict: "inconclusive",
			requirements: m.contract.requirements.map((r) => ({ id: r.id, verdict: "unknown", evidenceIds: [] })),
			evidence: [],
			guardrails: false,
			feedback: completed ? data.feedback as string : raw.slice(0, 4000) || "Evaluator execution failed",
			receiptHash: researchHash({ binding: a.binding, raw }),
		};
		if (completed) {
			if (typeof data.guardrails !== "boolean") throw new Error("Reviewer must supply guardrails");
			e.guardrails = data.guardrails;
			if (numeric) {
				if (m.contract.command?.resultSchema === "research-numeric-v2") {
					if (data.version !== "research-numeric-v2" || !Array.isArray(data.requirements)) throw new Error("numeric-v2 complete mandatory verdicts required");
					e.requirements = data.requirements as Evaluation["requirements"];
				}
				e.samples = data.samples as number[];
				e.metric = data.metric as string;
				e.unit = data.unit as string;
			} else {
				e.requirements = data.requirements as Evaluation["requirements"];
				e.evidence = data.evidence as Evaluation["evidence"];
				e.comparison = data.comparison as NonNullable<Evaluation["comparison"]>;
				if (!["valid", "unknown", "invalid"].includes(String(data.validity))) throw new Error("Reviewer validity missing");
				e.validity = data.validity as Evaluation["validity"];
				if (!Array.isArray(e.evidence)) throw new Error("Reviewer evidence missing");
				for (const evidence of e.evidence) {
					if (evidence.access === "observed") {
						if (typeof evidence.observation !== "string" || !evidence.observation.trim()) {
							throw new Error("Observed evidence needs a literal excerpt");
						}
						const source = sources.find((s) =>
							s.locator === evidence.sourceLocator && s.content.includes(evidence.observation) &&
							(!evidence.contentHash || evidence.contentHash === s.hash)
						);
						if (!source) throw new Error("Observed evidence is not bound to a successful source read or host-supplied material");
						evidence.contentHash = source.hash;
						if (source.locator.startsWith("material:")) {
							evidence.sourceFamily = "supplied-material";
							if (!Array.isArray(evidence.limitations)) throw new Error("Evidence limitations missing");
							evidence.limitations.push("Host-supplied candidate text is not independent verification of the author's claims.");
						}
					}
				}
			}
		} else if (!numeric) e.comparison = "incomparable";
		if (e.validity === "valid" && e.guardrails) {
			if (
				m.contract.policy.kind === "numeric" && Array.isArray(e.samples) && e.samples.length === m.contract.policy.numeric.repetitions &&
				e.samples.every(Number.isFinite)
			) {
				const mean = e.samples.reduce((sum, n) => sum + n / e.samples!.length, 0), p = m.contract.policy.numeric;
				e.verdict = Number.isFinite(mean) && (p.direction === "min" ? mean <= p.goalThreshold : mean >= p.goalThreshold) ? "pass" : "fail";
			} else if (!numeric && Array.isArray(e.requirements)) {
				const required = m.contract.requirements.filter((r) => r.mandatory).map((r) => e.requirements.find((x) => x.id === r.id)?.verdict);
				e.verdict = required.every((v) => v === "pass") ? "pass" : required.some((v) => v === "fail") ? "fail" : "inconclusive";
			}
		}
		e.receiptHash = researchHash({
			binding: a.binding,
			raw,
			provenance: provenance ?? sources.map((s) => ({ locator: s.locator, hash: s.hash })),
		});
		return e;
	}
	async function observedSources(conversationId: ConversationId, id: string, a: Attempt, context: Context): Promise<ObservedSource[]> {
		const refs = (await h().snapshot(AgentsDoc, conversationId, context))?.agents ?? [];
		const ref = refs.find((r) => String(r.runnerId) === a.binding?.runnerId);
		if (!ref) return [];
		const child = await h().conversation(ref.conversationId, context);
		if (!child) return [];
		const entries = await child.entries({}, 1000, undefined, context);
		const calls = new Map<string, string>(), sources: ObservedSource[] = [];
		let bytes = 0;
		for (const entry of [...entries.items].reverse()) {
			for (const message of entry.model ?? []) {
				if (message.role === "assistant") {
					for (const block of message.content) {
						if (block.type === "toolCall" && block.name === "read" && typeof block.arguments.path === "string") {
							calls.set(block.id, block.arguments.path);
						}
					}
				}
				if (message.role === "toolResult" && message.toolName === "read" && !message.isError) {
					const locator = calls.get(message.toolCallId);
					if (!locator) {
						continue;
					}
					const content = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
					bytes += Buffer.byteLength(content);
					if (bytes > 1024 * 1024) throw new Error("Observed source receipts exceed 1 MiB");
					sources.push({ locator, content, hash: researchHash(content) });
				}
			}
		}
		// Supplied material is explicitly labeled, never confused with an independently read source.
		const s = (await h().snapshot(ResearchServiceDoc, conversationId, context))!.records[id]!;
		for (const [candidateId, artifact] of Object.entries(s.artifacts)) {
			sources.push({ locator: `material:${candidateId}`, content: artifact.content, hash: researchHash(artifact.content) });
		}
		return sources;
	}
	async function accept(
		conversationId: ConversationId,
		id: string,
		attemptId: string,
		raw: string,
		completed: boolean,
		context: Context,
		provenance?: string,
		failure?: Evaluation["failure"],
	) {
		const snapshot = await load(conversationId, id, context), admitted = snapshot.attempts.find((a) => a.id === attemptId)!;
		const sources = completed && admitted.role !== "propose" && snapshot.contract.mode === "evidence"
			? await observedSources(conversationId, id, admitted, context)
			: [];
		let prepared: Artifact | undefined, artifactHash: string | undefined;
		if (admitted.resultHash || admitted.evaluationId) return;
		if (completed && admitted.role === "propose" && snapshot.contract.mode === "trusted-local-code") {
			const parsed = parse(raw);
			if (typeof parsed.hypothesis !== "string" || !parsed.hypothesis.trim() || !Array.isArray(parsed.edits)) {
				throw new Error("Malformed code proposal");
			}
			const record = (await h().snapshot(ResearchServiceDoc, conversationId, context))!.records[id]!;
			if (record.external[attemptId]) throw new Error("Ambiguous proposal application; recovery must reconcile");
			await mutate(conversationId, id, context, (m, s) => {
				if (m.status !== "running" || m.cancellationEpoch !== admitted.cancellationEpoch || Date.now() >= admitted.deadlineAt) {
					throw new Error("Proposal application fenced");
				}
				s.external[attemptId] = { state: "intent" };
			});
			const worktree = await createResearchWorktree(
				snapshot.projectRoot,
				join(snapshot.projectRoot, directory(snapshot), "worktrees", admitted.candidateId),
				spec(snapshot),
			);
			const ancestors = [];
			let parent = snapshot.candidates.find((c) => c.id === admitted.candidateId)?.parentId;
			while (parent) {
				const c = snapshot.candidates.find((c) => c.id === parent)!;
				ancestors.unshift(c);
				parent = c.parentId;
			}
			for (const ancestor of ancestors) {
				const edits = record.artifacts[ancestor.id]?.edits;
				if (edits) await applyResearchEdits(worktree, spec(snapshot), edits);
			}
			artifactHash = await applyResearchEdits(worktree, spec(snapshot), parsed.edits as ResearchEdit[]);
			prepared = { content: raw, edits: parsed.edits as ResearchEdit[], worktree };
		}
		await h().commit(async (tx) => {
			const m = getMission((await tx.doc(ResearchDoc, conversationId)).missions, id),
				s = (await tx.doc(ResearchServiceDoc, conversationId)).records[id]!;
			const a = m.attempts.find((a) => a.id === attemptId)!;
			if (a.evaluationId || a.resultHash) return;
			if (s.external[a.id]) s.external[a.id]!.state = "done";
			if (m.status !== "running" || Date.now() >= a.deadlineAt) {
				const audit = Buffer.from(provenance ?? raw).subarray(
					0,
					Math.min(4096, m.limits.maxArtifactBytes - m.ledger.retainedArtifactBytes),
				);
				if (audit.length) {
					s.raw[`late-${a.id}`] = audit.toString("utf8");
					m.ledger.retainedArtifactBytes += audit.length;
				}
				settleAttempt(
					m,
					a.id,
					{ state: "cancelled", error: "late result fenced; bounded audit receipt retained" },
					a.cancellationEpoch,
					Date.now(),
				);
				return;
			}
			if (a.role !== "propose") {
				const bytes = Buffer.byteLength(raw) + Buffer.byteLength(provenance ?? "");
				if (m.ledger.retainedArtifactBytes + bytes > m.limits.maxArtifactBytes) {
					throw new Error("Evaluation receipts exceed retained artifact budget");
				}
				a.artifactBytes = bytes;
				m.ledger.retainedArtifactBytes += bytes;
			}
			s.raw[a.id] = raw.slice(0, 128 * 1024);
			if (provenance !== undefined) s.raw[`host-${a.id}`] = provenance;
			if (a.role === "propose") {
				if (!completed) {
					settleAttempt(m, a.id, { state: "failed", error: raw.slice(0, 4000) || "Author failed" }, a.cancellationEpoch, Date.now());
				} else {
					const parsed = parse(raw);
					if (typeof parsed.hypothesis !== "string" || !parsed.hypothesis.trim()) throw new Error("Proposal hypothesis missing");
					if (m.contract.mode === "trusted-local-code" && !Array.isArray(parsed.edits)) throw new Error("Proposal edits missing");
					s.artifacts[a.candidateId] = prepared ?? { content: raw };
					m.candidates.find((c) => c.id === a.candidateId)!.summary = parsed.hypothesis.slice(0, 4096);
					settleAttempt(
						m,
						a.id,
						{ state: "succeeded", artifactHash: artifactHash ?? researchHash(raw), artifactBytes: Buffer.byteLength(raw) },
						a.cancellationEpoch,
						Date.now(),
					);
				}
			} else {
				const e = evaluation(m, a, raw, completed, sources, provenance);
				if (failure) e.failure = failure;
				acceptEvaluation(m, e, a.cancellationEpoch, Date.now());
			}
			const run = (await tx.doc(RunDoc, conversationId)).runs.find((r) => r.id === a.binding?.runId);
			const nodeId = a.binding?.nodeId;
			if (run && nodeId && run.nodes[nodeId]?.status === "running" && (a.evaluationId || a.state === "succeeded")) {
				settleOwnedNode(run, {
					missionId: id,
					nodeId,
					receiptId: a.evaluationId ?? a.resultHash!,
					key: run.nodes[nodeId]!.key!,
					attempt: run.nodes[nodeId]!.attempt,
					result: a.evaluationId ? "Host accepted evaluation execution; see mission judgment" : "Host accepted proposal artifact",
				}, Date.now());
			} else if (run?.status === "running" && a.state === "failed") cancelDag(run, a.error ?? "Research attempt failed", Date.now());
		}, context);
	}
	async function initialize(conversationId: ConversationId, id: string, context: Context) {
		let m = await load(conversationId, id, context);
		const s = (await h().snapshot(ResearchServiceDoc, conversationId, context))!.records[id]!;
		if (s.initialized) return;
		await project(conversationId, id, context);
		m = await load(conversationId, id, context);
		if (m.contract.mode === "trusted-local-code") {
			if (m.report.state !== "current") throw new Error("Code mission requires owned report directory");
			const worktree = await createResearchWorktree(m.projectRoot, join(m.projectRoot, directory(m), "worktrees", "baseline"), spec(m));
			const hash = await researchArtifactHash(worktree, spec(m));
			if (hash !== m.contract.baseline.artifactHash) throw new Error("Baseline differs from frozen actual content hash");
			const sources: Record<string, string | null> = {};
			let bytes = 0;
			for (const path of spec(m).allowedPaths) {
				try {
					const file = await researchContainedPath(worktree, path);
					const info = await stat(file);
					bytes += info.size;
					if (!info.isFile() || bytes > 96 * 1024) throw new Error("Author source context exceeds 96 KiB");
					sources[path] = await readFile(file, "utf8");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					sources[path] = null;
				}
			}
			// Baseline content hash is derived from the explicit immutable base and allowed file contents.
			await mutate(conversationId, id, context, (current, record) => {
				if (current.ledger.retainedArtifactBytes + bytes > current.limits.maxArtifactBytes) {
					throw new Error("Baseline source exceeds retained artifact budget");
				}
				current.ledger.retainedArtifactBytes += bytes;
				record.artifacts[current.candidates[0]!.id] = {
					content: JSON.stringify({ definition: current.contract.baseline.definition, sources }),
					worktree,
				};
				record.raw.baselineArtifact = hash;
				record.initialized = true;
			});
		} else {await mutate(conversationId, id, context, (current, record) => {
				record.artifacts[current.candidates[0]!.id] = { content: current.contract.baseline.definition };
				record.initialized = true;
			});}
	}
	async function command(conversationId: ConversationId, id: string, attemptId: string, context: Context, signal: AbortSignal) {
		const m = await load(conversationId, id, context), a = m.attempts.find((a) => a.id === attemptId)!;
		const record = (await h().snapshot(ResearchServiceDoc, conversationId, context))!.records[id]!;
		if (record.external[a.id]) return;
		await mutate(conversationId, id, context, (current, s) => {
			if (current.status !== "running" || Date.now() >= a.deadlineAt || current.cancellationEpoch !== a.cancellationEpoch) {
				throw new Error("Command admission fenced");
			}
			s.external[a.id] = { state: "intent" };
		});
		const controller = new AbortController();
		processes.set(`${id}/${a.id}`, controller);
		const combined = AbortSignal.any([signal, controller.signal]);
		try {
			const c = m.candidates.find((c) => c.id === a.candidateId)!;
			const artifact = record.artifacts[c.id]!;
			if (environmentFingerprint(m.projectRoot, m.contract.command) !== m.contract.evaluator.environmentFingerprint) {
				throw new Error("Frozen evaluator environment changed");
			}
			if (!artifact.worktree) throw new Error("Candidate has no host-prepared immutable worktree");
			const before = await researchArtifactHash(artifact.worktree!, spec(m));
			if (before !== c.artifactHash) throw new Error("Candidate artifact changed before evaluation");
			await assertResearchEvaluatorUnchanged(artifact.worktree!, spec(m));
			const current = await load(conversationId, id, context);
			if (current.status !== "running" || current.cancellationEpoch !== a.cancellationEpoch || Date.now() >= a.deadlineAt) {
				throw new Error("Command dispatch fenced");
			}
			const runStage = async (stage: "preflight" | "canary" | "evaluation", argv: string[]) => {
				const key = `${a.id}/${stage}`;
				if (before !== await researchArtifactHash(artifact.worktree!, spec(m))) throw new Error("Candidate changed before stage");
				await assertResearchEvaluatorUnchanged(artifact.worktree!, spec(m));
				await mutate(conversationId, id, context, (current, s) => {
					if (current.status !== "running" || current.cancellationEpoch !== a.cancellationEpoch || Date.now() >= a.deadlineAt) throw new Error("Stage admission fenced");
					s.stages ??= {};
					if (s.stages[key]) throw new Error("Stage effect already admitted; no replay");
					const predecessor = m.contract.command!.readiness && stage !== "preflight" ? (stage === "canary" ? "preflight" : "canary") : undefined;
					const prior = predecessor ? s.stages[`${a.id}/${predecessor}`] : undefined;
					if (predecessor && (!prior || prior.state !== "done" || prior.epoch !== a.cancellationEpoch || prior.artifactHash !== before || prior.contractHash !== m.contractHash || !prior.receipt || prior.receiptHash !== researchHash(prior.receipt) || parseReadiness(prior.receipt, m.contract.command!.readiness![predecessor].checkIds).outcome !== "pass")) throw new Error("Readiness predecessor missing or stale");
					s.stages[key] = { state: "intent", epoch: a.cancellationEpoch, artifactHash: before, contractHash: m.contractHash, deadlineAt: a.deadlineAt, argv: [m.contract.command!.executable, ...argv], ...(prior?.receiptHash ? { predecessorReceiptHash: prior.receiptHash } : {}) };
				});
			const receipt = await runResearchProcess({
				argv: [m.contract.command!.executable, ...argv],
				cwd: artifact.worktree!,
				timeoutMs: Math.max(1, Math.min(m.contract.command!.timeoutMs, a.deadlineAt - Date.now())),
				maxOutputBytes: 64 * 1024,
				environment: Object.fromEntries(
					m.contract.command!.environmentAllowlist.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]),
				),
				signal: combined,
				onSpawn: async (pid) => {
					await mutate(conversationId, id, context, (_m, s) => {
						s.external[a.id]!.pid = pid;
					});
				},
			});
				await mutate(conversationId, id, context, (current, s) => {
					const stored = s.stages![key]!;
					const bytes = Buffer.byteLength(JSON.stringify(receipt));
					if (current.ledger.retainedArtifactBytes + bytes > current.limits.maxArtifactBytes) throw new Error("Stage receipts exceed retained artifact budget");
					current.ledger.retainedArtifactBytes += bytes;
					Object.assign(stored, { state: "done", receipt, receiptHash: researchHash(receipt), bytes });
				});
				if (before !== await researchArtifactHash(artifact.worktree!, spec(m))) throw new Error("Candidate changed during readiness/evaluation");
				await assertResearchEvaluatorUnchanged(artifact.worktree!, spec(m));
				return receipt;
			};
			for (const stage of ["preflight", "canary"] as const) {
				const configured = m.contract.command!.readiness?.[stage];
				if (!configured) continue;
				const receipt = await runStage(stage, configured.argv);
				const result = parseReadiness(receipt, configured.checkIds);
				if (result.outcome !== "pass") {
					if (result.outcome === "unknown") throw new Error(`Readiness ${stage} unknown: ${result.feedback}`);
					await accept(conversationId, id, a.id, result.feedback, false, context, JSON.stringify(receipt), { stage, checkIds: result.failedIds, code: "failed" });
					return;
				}
			}
			const receipt = await runStage("evaluation", m.contract.command!.argv);
			const after = await researchArtifactHash(artifact.worktree!, spec(m));
			await assertResearchEvaluatorUnchanged(artifact.worktree!, spec(m));
			await accept(
				conversationId,
				id,
				a.id,
				receipt.status === "completed" && before === after ? receipt.stdout : JSON.stringify(receipt),
				receipt.status === "completed" && before === after,
				context,
				JSON.stringify({
					receipt,
					actualArtifactHash: before,
					afterArtifactHash: after,
					contractHash: m.contractHash,
					evaluator: m.contract.evaluator,
					command: m.contract.command,
					integrity:
						"Tracked evaluator and input files match pinned base before and after command; untracked/external inputs not certified.",
				}),
			);
		} catch (error) {
			await failAttempt(conversationId, id, a.id, error, context);
		} finally {
			processes.delete(`${id}/${a.id}`);
		}
	}
	async function tick(
		conversationId: ConversationId,
		id: string,
		taskId: TaskId<string>,
		signal: AbortSignal,
		context: Context,
	): Promise<boolean> {
		let m = await load(conversationId, id, context);
		if (m.status !== "running") {
			await project(conversationId, id, context);
			return m.status !== "cancelling";
		}
		try {
			await initialize(conversationId, id, context);
		} catch (error) {
			await mutate(
				conversationId,
				id,
				context,
				(current) => blockMission(current, `Initialization blocked: ${boundedError(error)}`, Date.now()),
			);
			await cancel(conversationId, id, "Initialization blocked", context);
			return true;
		}
		m = await load(conversationId, id, context);
		for (const a of m.attempts.filter((a) => m.ledger.activeAttemptIds.includes(a.id))) {
			if (Date.now() >= a.deadlineAt) {
				await cancel(conversationId, id, "attempt_deadline", context);
				return false;
			}
			if (a.binding && a.role !== "propose" && m.contract.mode === "trusted-local-code") {
				await command(conversationId, id, a.id, context, signal);
				return false;
			}
		}
		// Policy chooses a finite round. Only the shared DAG frontier admits and dispatches nodes.
		const action = nextAction(m, Date.now());
		if (action.kind === "stop") {
			await mutate(conversationId, id, context, (current) => stopMission(current, Date.now()));
			await project(conversationId, id, context);
			return true;
		}
		const runId = await h().commit(async (tx) => {
			const current = getMission((await tx.doc(ResearchDoc, conversationId)).missions, id);
			const s = (await tx.doc(ResearchServiceDoc, conversationId)).records[id]!;
			const active = current.attempts.find((a) => current.ledger.activeAttemptIds.includes(a.id));
			if (active) return active.binding?.runId ?? Object.keys(s.nodes ?? {}).find((key) => s.nodes![key] === active.id)?.split("/")[0];
			const selected = nextAction(current, Date.now());
			if (selected.kind === "wait" || selected.kind === "stop") return undefined;
			if (selected.kind === "evaluate") {
				const proposal = current.attempts.find((a) => a.candidateId === selected.candidateId && a.role === "propose");
				if (proposal) return proposal.binding!.runId;
			}
			const newId = `${id}-${
				selected.kind === "propose"
					? `round${current.ledger.roundsAdmitted + 1}`
					: selected.kind === "confirm"
					? "confirmation"
					: "baseline"
			}`;
			const doc = await tx.doc(RunDoc, conversationId);
			if (!doc.runs.some((r) => r.id === newId)) {
				doc.runs.push(createRun(
					newId,
					{
						nodes: selected.kind === "propose"
							? [{
								id: "proposal",
								kind: "delegate",
								writes: [`research/${id}/candidate/${current.candidates.length}`],
								description: `${selected.operation} from actual feedback`,
							}, {
								id: "evaluation",
								kind: "verify",
								reads: [`research/${id}/candidate/${current.candidates.length}`],
								covers: ["execution"],
								description: "Evaluate immutable candidate using frozen protocol",
							}]
							: [{
								id: selected.kind === "confirm" ? "confirmation" : "evaluation",
								kind: "verify",
								covers: ["execution"],
								description: `Research ${selected.kind}; scientific judgment is separate`,
							}],
						edges: selected.kind === "propose" ? [["proposal", "evaluation"]] : [],
						goal: { requirements: ["execution"] },
					},
					Date.now(),
					0,
					{ missionId: id },
				));
			}
			doc.activeId = newId;
			return newId;
		}, context);
		if (!runId) return false;
		const dagApi = apiFor(conversationId);
		await advanceDag(dagApi, runId, context, {
			missionId: id,
			admit: async (_run, node) =>
				h().commit(async (tx) => {
					const current = getMission((await tx.doc(ResearchDoc, conversationId)).missions, id),
						s = (await tx.doc(ResearchServiceDoc, conversationId)).records[id]!;
					if (current.status !== "running" || Date.now() >= current.deadlineAt) return false;
					const oldId = s.nodes?.[`${runId}/${node.id}`];
					if (oldId) {
						const old = current.attempts.find((a) => a.id === oldId)!;
						return old.state === "reserved" && old.cancellationEpoch === current.cancellationEpoch && Date.now() < old.deadlineAt;
					}
					const selected = nextAction(current, Date.now());
					if (selected.kind === "wait" || selected.kind === "stop") return false;
					if ((node.id === "proposal" ? "propose" : node.id === "confirmation" ? "confirm" : "evaluate") !== selected.kind) return false;
					const attemptId = `a${current.ledger.attemptsAdmitted + 1}`;
					reserveAttempt(current, {
						id: attemptId,
						reservationKey: `${runId}/${node.id}`,
						epoch: current.cancellationEpoch,
						now: Date.now(),
						action: selected,
						...(selected.kind === "propose"
							? {
								candidateId: `c${current.candidates.length}`,
								roundId: `r${current.ledger.roundsAdmitted + 1}`,
								summary: `${selected.operation} using ${selected.feedbackReceiptIds.join(", ")}`,
							}
							: {}),
					});
					if (!s.nodes) s.nodes = {};
					s.nodes[`${runId}/${node.id}`] = attemptId;
					return true;
				}, context),
			settle: async (_run, outcomes) => {
				const s = (await h().snapshot(ResearchServiceDoc, conversationId, context))!.records[id]!;
				for (const outcome of outcomes) {
					const attemptId = s.nodes?.[`${runId}/${outcome.id}`];
					if (!attemptId) throw new Error("DAG outcome has no admitted research attempt");
					try {
						await accept(
							conversationId,
							id,
							attemptId,
							outcome.answer ?? outcome.error ?? "child failed",
							outcome.status === "completed",
							context,
						);
					} catch (error) {
						await failAttempt(conversationId, id, attemptId, error, context);
					}
				}
			},
			dispatch: async (_run, node) => {
				m = await load(conversationId, id, context);
				const state = (await h().snapshot(ResearchServiceDoc, conversationId, context))!.records[id]!;
				const a = m.attempts.find((a) => a.id === state.nodes?.[`${runId}/${node.id}`]);
				if (!a) throw new Error("DAG dispatch without reservation");
				if (m.contract.mode === "trusted-local-code" && a.role !== "propose") {
					await h().commit(async (tx) => {
						const current = getMission((await tx.doc(ResearchDoc, conversationId)).missions, id);
						const r = (await tx.doc(RunDoc, conversationId)).runs.find((x) => x.id === runId)!;
						startNode(r, node.id, `command:${a.id}`, Date.now());
						bindAttempt(
							current,
							a.id,
							{ runId, nodeId: node.id, key: r.nodes[node.id]!.key!, runnerId: `command:${a.id}` },
							a.cancellationEpoch,
							Date.now(),
						);
					}, context);
					await command(conversationId, id, a.id, context, signal);
					return;
				}
				const spawner = options.spawner.current;
				if (!spawner) throw new Error("Research subagent spawner unavailable");
				const parent = await h().conversation(conversationId, context);
				if (!parent) throw new Error("Parent conversation missing");
				const record = (await h().snapshot(ResearchServiceDoc, conversationId, context))!.records[id]!;
				const author = a.role === "propose";
				const reads = author
					? []
					: (await parent.agent(context)).tools.filter((tool) => RESEARCH_READ_TOOLS.has(tool.name)).map((tool) => tool.name);

				const instructions = author
					? 'Return ONLY a JSON object {"hypothesis":"...","evidence":[...],"edits":[{"path":"allowed relative path","content":"full replacement"}]}. Edits only in trusted-local-code mode. Use actual supplied feedback, never invent observations or authoritative scores. No tools or child tasks. For code, preserve previous corrections and change only permitted paths.'
					: 'Independent evidence reviewer. Return ONLY JSON {"validity":"valid|invalid|unknown","guardrails":true,"comparison":"better|same|worse|incomparable","feedback":"specific actual findings","requirements":[{"id":"exact required id","verdict":"pass|fail|unknown","evidenceIds":["e1"]}],"evidence":[{"id":"e1","claimIds":["requirement id"],"sourceLocator":"actual locator","location":"actual location","version":"known version or unknown","sourceFamily":"source origin","observation":"actual observed content","inference":"separate inference","assumptions":[],"counterevidence":[],"access":"observed|unavailable|unknown","limitations":[]} ]}. Include every frozen requirement exactly once. Use read tools to check sources; author claims alone are not observations. Unavailable/contradictory evidence stays unknown with limitations, and access "unavailable" or "unknown" may carry an empty observation string. Repeated sourceFamily is not independent evidence. Comparison must explain strictly improved mandatory criteria without regressions. Confirmation is final; do not propose more work.';
				const generated = a.context ?? researchContext(m, a, record.artifacts, `${instructions}\nObserved sourceLocator must equal the exact path passed to a successful read tool; observation must be a literal nonempty excerpt of that tool result. Supplied candidate text may instead use sourceLocator material:<candidateId>, explicitly labeled supplied-material rather than independent evidence. The host binds content hashes from actual receipts; never invent or transform source excerpts.`);
				assertResearchContext(generated);
				await mutate(conversationId, id, context, current => {
					const admitted = current.attempts.find(x => x.id === a.id)!;
					if (admitted.context && admitted.context.hash !== generated.hash) throw new Error("Context replay conflict");
					if (!admitted.context) {
						const bytes = Buffer.byteLength(generated.prompt) + Buffer.byteLength(generated.instructions);
						if (current.ledger.retainedArtifactBytes + bytes > current.limits.maxArtifactBytes) throw new Error("Context exceeds retained artifact budget");
						current.ledger.retainedArtifactBytes += bytes;
						admitted.context = generated;
					}
				});
				const spawnApi: SpawnApi = {
					conversationId,
					taskId,
					agent: parent.agent.bind(parent),
					commit: async (change, ctx) =>
						h().commit(async (tx) => {
							const current = getMission((await tx.doc(ResearchDoc, conversationId)).missions, id);
							if (
								current.status !== "running" || current.cancellationEpoch !== a.cancellationEpoch || Date.now() >= a.deadlineAt
							) throw new Error("Spawn fenced");
							const value = await change(tx);
							const receipt = await tx.doc(MissionSpawnDoc, conversationId, JSON.stringify([id, a.id]), null);
							if (!receipt.ref) throw new Error("Atomic spawn receipt missing");
							const r = (await tx.doc(RunDoc, conversationId)).runs.find((x) => x.id === runId)!;
							if (r.nodes[node.id]!.status !== "running") startNode(r, node.id, receipt.ref.taskId, Date.now());
							bindAttempt(
								current,
								a.id,
								{ runId, nodeId: node.id, key: r.nodes[node.id]!.key!, runnerId: String(receipt.ref.runnerId) },
								a.cancellationEpoch,
								Date.now(),
							);
							return value;
						}, ctx),
				};
				await spawner.spawn(
					{
						description: `Research ${a.role}`,
						prompt: generated.prompt,
						background: true,
						mission: { missionId: id, attemptId: a.id, metadata: { epoch: a.cancellationEpoch } },
						hostProfile: {
							role: author ? "author" : "reviewer",
							tools: reads,
							cwd: m.projectRoot,
							instructions: generated.instructions,
						},
					},
					spawnApi,
					context,
				);
			},
		});
		await project(conversationId, id, context);
		return false;
	}
	async function cancel(conversationId: ConversationId, id: string, reason: string, context: Context) {
		const active = await mutate(conversationId, id, context, (m) => cancelMission(m, reason, Date.now()));
		const refs = (await h().snapshot(AgentsDoc, conversationId, context))?.agents ?? [];
		for (const attemptId of active) {
			processes.get(`${id}/${attemptId}`)?.abort();
			const m = await load(conversationId, id, context), a = m.attempts.find((a) => a.id === attemptId)!;
			const ref = refs.find((r) => String(r.runnerId) === a.binding?.runnerId);
			if (ref && options.spawner.current) await options.spawner.current.cancel(ref);
			if (!a.binding || ref) {
				await mutate(conversationId, id, context, (current) => {
					const currentAttempt = current.attempts.find((x) => x.id === attemptId)!;
					if (["reserved", "running"].includes(currentAttempt.state)) {
						settleAttempt(current, attemptId, { state: "cancelled", error: reason }, currentAttempt.cancellationEpoch, Date.now());
					}
				});
			}
		}
		await h().commit(async (tx) => {
			for (const run of (await tx.doc(RunDoc, conversationId)).runs) {
				if (run.owner?.missionId === id && run.status === "running") cancelDag(run, reason, Date.now());
			}
		}, context);
		await project(conversationId, id, context);
		return status(conversationId, context, id);
	}
	const task = defineTask<{ missionId: string }, { phase: "advance" } | { phase: "sleep"; until: number }, string>({
		name: "dinobot.research-controller",
		version: 1,
		initial: () => ({ phase: "advance" }),
		phases: {
			advance: async (record, runtime, context) => {
				let done = false;
				try {
					done = await tick(runtime.conversationId, record.input.missionId, record.id, runtime.signal, context);
				} catch (error) {
					const m = await load(runtime.conversationId, record.input.missionId, context);
					const active = m.attempts.find((a) => m.ledger.activeAttemptIds.includes(a.id));
					if (active) await failAttempt(runtime.conversationId, m.id, active.id, error, context);
					else {
						await cancel(runtime.conversationId, m.id, boundedError(error), context);
						done = true;
					}
				}
				await runtime.commit(
					() =>
						done
							? { status: "terminal", outcome: { status: "completed", result: record.input.missionId } }
							: { status: "running", checkpoint: { phase: "sleep", until: runtime.now() + 100 } },
					context,
				);
			},
			sleep: async (record, runtime, context) => {
				await runtime.sleep(record.state.checkpoint.until, context);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "advance" } }), context);
			},
		},
		abort: async (record, runtime, context) => {
			await cancel(runtime.conversationId, record.input.missionId, "controller_cancelled", context);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
	async function status(conversationId: ConversationId, context: Context, missionId?: string) {
		const doc = await h().snapshot(ResearchDoc, conversationId, context);
		if (!doc?.missions.length) return { mission: undefined };
		const m = getMission(doc.missions, missionId ?? doc.activeId ?? doc.missions.at(-1)!.id);
		return { mission: m, budget: budgetView(m) };
	}
	async function start(args: ResearchStartArgs, api: ToolExecutionApi, context: Context) {
		const agent = await api.agent(context);
		const boundRoot = api.env?.cwd ?? agent.cwd;
		if (!boundRoot) throw new Error("Research requires an explicit conversation project binding");
		const root = await realpath(boundRoot);
		const contract = copy(args.contract);
		if (contract.mode === "evidence" && contract.policy.kind !== "qualitative") {
			throw new Error("Evidence mode requires qualitative review");
		}
		if (contract.mode === "trusted-local-code") {
			const profileId = contract.codeAuthorityRef?.startsWith("host:") ? contract.codeAuthorityRef.slice(5) : undefined;
			const profile = profileId ? options.codeProfiles?.[profileId] : undefined;
			if (!profile || (contract.command && researchHash(profile) !== researchHash(contract.command))) {
				throw new Error("Trusted code needs matching host-authorized profile");
			}
			contract.command = copy(profile);
			if (contract.reportAuthorityRef === "none") throw new Error("Code worktrees require project write/report authority");
		}
		contract.evaluator = {
			profile: contract.mode === "evidence" ? "evidence-review-v1" : "trusted-local-code-v1",
			revision: researchHash(contract.command ?? "evidence-review-v1"),
			environmentFingerprint: environmentFingerprint(root, contract.command),
			inputFingerprint: researchHash({ baseline: contract.baseline.definition, command: contract.command ?? null }),
		};
		contract.baseline.artifactHash = researchHash(contract.baseline.definition);
		validateContract(contract, resolveLimits(args.budget));
		if (contract.command) {
			validateCodeExperiment({
				baseCommit: contract.command.baseCommit,
				allowedPaths: contract.command.permittedPaths,
				command: { argv: [contract.command.executable, ...contract.command.argv], timeoutMs: contract.command.timeoutMs },
				evaluatorRevision: contract.evaluator.revision,
				authorityRef: contract.codeAuthorityRef!,
			});
		}
		contract.baseline.artifactHash = contract.command
			? await baseArtifactHash(root, contract.command)
			: researchHash(contract.baseline.definition);
		const requestHash = researchHash({ contract, budget: args.budget ?? {}, root, supersedes: args.supersedes ?? null });
		const startKey = `${api.taskId}/${api.callId}`;
		const id = await api.commit(async (tx) => {
			const doc = await tx.doc(ResearchDoc, api.conversationId), service = await tx.doc(ResearchServiceDoc, api.conversationId);
			const old = Object.entries(service.records).find(([, s]) => s.startKey === startKey);
			if (old) {
				if (old[1].requestHash !== requestHash) throw new Error("Research start replay mismatch");
				return old[0];
			}
			const active = doc.missions.find((m) => m.status === "running" || m.status === "cancelling");
			if (active) {
				if (service.records[active.id]?.requestHash !== requestHash) throw new Error("Different active research mission exists");
				return active.id;
			}
			if (args.supersedes !== undefined) {
				const predecessor = getMission(doc.missions, args.supersedes);
				if (predecessor.status === "running" || predecessor.status === "cancelling" || predecessor.ledger.activeAttemptIds.length) {
					throw new Error("Successor requires a settled predecessor in this conversation");
				}
			}
			const missionId = `research-${randomUUID()}`,
				controllerTaskId = await tx.createTask(task, { missionId }, {
					conversationId: api.conversationId,
					ownership: { kind: "conversation" },
					background: true,
				});
			const m = createMission({
				id: missionId,
				ownerConversationId: String(api.conversationId),
				controllerTaskId: String(controllerTaskId),
				projectRoot: root,
				baselineId: "baseline",
				contract,
				...(args.budget !== undefined ? { limits: args.budget } : {}),
				now: Date.now(),
				...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
			});
			if (contract.mode === "trusted-local-code") validateCodeExperiment(spec(m));
			addMission(doc, m);
			service.records[missionId] = { startKey, requestHash, artifacts: {}, raw: {}, external: {}, initialized: false };
			return missionId;
		}, context);
		return status(api.conversationId, context, id);
	}
	async function recover(context: Context) {
		// Scan every durable conversation before Harness.resume; no execution is dispatched here.
		let page = await h().commit((tx) => tx.scanConversations({}, 64), context);
		for (;;) {
			for (const conversation of page.items) {
				const doc = await h().snapshot(ResearchDoc, conversation.id, context);
				for (const m of doc?.missions ?? []) {
					const s = (await h().snapshot(ResearchServiceDoc, conversation.id, context))?.records[m.id];
					if (!s) continue;
					for (const a of m.attempts) {
						if (s.external[a.id]?.state === "intent" && (a.state === "running" || a.state === "reserved")) {
							await mutate(conversation.id, m.id, context, (current) =>
								settleAttempt(
									current,
									a.id,
									{ state: "unknown", error: "Restart after external effect intent without definitive receipt" },
									a.cancellationEpoch,
									Date.now(),
								));
						}
					}
					const current = await load(conversation.id, m.id, context);
					if ((current.status === "running" && Date.now() >= current.deadlineAt) || current.status === "cancelling") {
						await cancel(conversation.id, m.id, current.stopReason ?? "deadline", context);
					}
					await project(conversation.id, m.id, context);
				}
			}
			if (!page.next) break;
			page = await h().commit((tx) => tx.scanConversations({}, 64, page.next!), context);
		}
	}
	return {
		task,
		start,
		status,
		cancel,
		async cancelActive(conversationId: ConversationId, reason: string, context: Context) {
			const doc = await h().snapshot(ResearchDoc, conversationId, context);
			const m = doc?.missions.find((m) => m.status === "running" || m.status === "cancelling");
			return m ? cancel(conversationId, m.id, reason, context) : { mission: undefined };
		},
		recover,
		async readReport(conversationId: ConversationId, missionId: string, file: string, context: Context): Promise<string> {
			const m = await load(conversationId, missionId, context);
			if (m.contract.reportAuthorityRef === "none") throw new Error("Mission has no project reports");
			return readResearchReport(m.projectRoot, directory(m), file);
		},
	};
}
export type ResearchService = ReturnType<typeof createResearchService>;
