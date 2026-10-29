import type { Context } from "@earendil-works/chord";
import { defineDoc, defineExtension, GenerationTask, type Harness, hook, type HookApi, LiveDoc } from "@earendil-works/pi-durable";
import { AsksDoc, LinkDoc } from "../core/ask.ts";
import { RunDoc } from "../core/dag.ts";
import type { LoadedPlugin, PluginSubagent, PluginTurnEnd } from "../plugins/types.ts";
import { AgentsDoc, ProgressDoc, WAKE_REQUEST_PREFIX } from "./subagents.ts";

/**
 * Plugin turn-end hooks (ADR 0105). When a top-level conversation ends its turn with a final answer, every loaded plugin
 * with `onTurnEnd` sees committed host facts (subagents, open human asks, running DAG runs) and may return text; the first
 * text continues the run as a host message. The plugin decides from data, not from the model's prose, so a rule like
 * "a finished worker must be recorded before the turn ends" holds mechanically.
 *
 * Bounded like the goal liveness hook (ADR 0096): at most {@link PLUGIN_CONTINUATION_LIMIT} continuations per human input
 * (host wakes count against the input that started them) and none after a continued turn that made no tool call.
 */
export const PluginHookDoc = defineDoc<{ run?: string; count: number; progressed: boolean }>({
	kind: "dinobot.plugin-hooks", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ count: 0, progressed: false }),
});
export const PLUGIN_CONTINUATION_LIMIT = 3;
export const pluginContinuationPrefix = (pluginId: string) => `<from host="plugin:${pluginId}"/>`;

type Reader = Pick<HookApi, "snapshot">;
type Id = HookApi["conversationId"];

/** The subagents conversation `id` started, from committed documents. */
export async function subagentStates(reader: Reader, id: Id, context: Context): Promise<PluginSubagent[]> {
	const out: PluginSubagent[] = [];
	for (const ref of (await reader.snapshot(AgentsDoc, id, context))?.agents ?? []) {
		const progress = (await reader.snapshot(ProgressDoc, id, String(ref.runnerId), context))?.subagent;
		out.push({
			taskId: ref.taskId,
			// A ref without progress has not started its runner yet; it is live work.
			status: progress?.status ?? "running",
			description: progress?.description ?? "",
			background: ref.background,
		});
	}
	return out;
}

export async function turnEndFacts(reader: Reader, id: Id, cwd: string | undefined, context: Context): Promise<PluginTurnEnd> {
	const openHumanAsks = ((await reader.snapshot(AsksDoc, id, context))?.asks ?? []).filter((ask) => ask.to === "human" && ask.state === "open").length;
	const runningDagRuns = ((await reader.snapshot(RunDoc, id, context))?.runs ?? []).filter((run) => run.status === "running").length;
	return {
		conversationId: String(id),
		...(cwd !== undefined ? { cwd } : {}),
		subagents: await subagentStates(reader, id, context),
		openHumanAsks,
		runningDagRuns,
	};
}

export function pluginHooksExtension(getHarness: () => Harness, plugins: readonly LoadedPlugin[], report: (error: unknown) => void = () => undefined) {
	const hooked = plugins.filter((plugin) => plugin.onTurnEnd !== undefined);
	return defineExtension({
		name: "plugin-hooks",
		hooks: hooked.length === 0 ? [] : [hook(GenerationTask, {
			afterTools: async (_assistant, _results, api, context) => {
				const state = await api.snapshot(PluginHookDoc, api.conversationId, context);
				if (!state || state.count === 0 || state.progressed) return;
				await getHarness().commit(async (tx) => {
					const doc = await tx.doc(PluginHookDoc, api.conversationId);
					if (!doc.progressed) doc.progressed = true;
					return undefined;
				}, context);
			},
			onYield: async (_answer, api, context) => {
				const id = api.conversationId;
				if ((await api.snapshot(LinkDoc, id, context))?.parent !== undefined) return undefined;
				const cwd = (await getHarness().conversation(id, context).then((c) => c?.agent(context)).catch(() => undefined))?.cwd;
				const facts = await turnEndFacts(api, id, cwd, context);
				let text: string | undefined;
				let from: string | undefined;
				for (const plugin of hooked) {
					try {
						const result = await plugin.onTurnEnd!(facts);
						if (result !== undefined && result.trim() !== "") { text = result; from = plugin.id; break; }
					} catch (error) {
						report(error);
					}
				}
				if (text === undefined || from === undefined) return undefined;
				const first = (await api.snapshot(LiveDoc, id, context))?.run?.inputs?.[0];
				const record = first === undefined ? undefined : await (await getHarness().submission(first, context))?.status(context);
				const host = record?.requestId?.startsWith(WAKE_REQUEST_PREFIX) === true;
				const run = String(first ?? "");
				const count = await getHarness().commit(async (tx) => {
					const doc = await tx.doc(PluginHookDoc, id);
					if (doc.run !== run && !host) { doc.run = run; doc.count = 0; doc.progressed = false; }
					if (doc.count >= PLUGIN_CONTINUATION_LIMIT || (doc.count > 0 && !doc.progressed)) return 0;
					doc.count += 1;
					doc.progressed = false;
					return doc.count;
				}, context);
				if (!count) return undefined;
				return { continue: `${pluginContinuationPrefix(from)}\n${text}\n(host continuation ${count}/${PLUGIN_CONTINUATION_LIMIT})` };
			},
		})],
	});
}
