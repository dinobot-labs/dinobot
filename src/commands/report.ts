import { CONSENT_TEXT, CONSENT_VERSION } from "../report/consent.ts";
import { type Owner, type ReportRecord, type ReportService, shortId } from "../report/service.ts";
import type { CommandInvocation, SlashCommand } from "./types.ts";

/**
 * /report: send a session report to the dinobot developer (ADR 0073).
 * TUI: interactive consent checklist and preview. Channels: per-person consent with an explicit
 * `/report agree <version>`, and two-step send because channels cannot prompt; other participants'
 * messages are removed from channel reports.
 */
const USAGE = [
	"/report [메모]            지금 대화를 보고 (보내기 전 미리보기)",
	"/report setup            동의 확인·변경 (TUI)",
	"/report consent          동의 문구 보기 (채널)",
	"/report agree <버전>      동의 (채널)",
	"/report send <id>        미리 본 보고 보내기 (채널)",
	"/report cancel <id>      미리 본 보고 버리기 (채널)",
	"/report list             내 보고 목록",
	"/report undo <id>        보고 취소·삭제",
	"/report withdraw         동의 철회 + 서버의 내 보고 삭제",
	"/report auto on|off      자동 보고 켜기·끄기 (TUI, /report on|off 도 같음)",
	"/report status           동의·자동 보고 상태",
].join("\n");

const SUBCOMMANDS = new Set(["setup", "consent", "agree", "send", "cancel", "list", "undo", "withdraw", "auto", "status", "help"]);

const ownerOf = (invocation: CommandInvocation): Owner => (invocation.surface === "tui" ? "owner" : `${invocation.channel}:${invocation.userId}`);

const KIND_LABEL: Record<string, string> = { manual: "수동", auto: "자동" };
const STATUS_LABEL: Record<string, string> = { pending: "전송 대기", sent: "보냄", failed: "실패", deleted: "삭제됨" };

function describe(record: ReportRecord): string {
	const when = record.createdAt.slice(0, 16).replace("T", " ");
	const rule = record.trigger ? ` · ${record.trigger.rule}` : "";
	const error = record.status === "failed" && record.error ? ` · ${record.error}` : "";
	return `${shortId(record.id)}  ${when} UTC  ${KIND_LABEL[record.kind] ?? record.kind}${rule}  ${STATUS_LABEL[record.status] ?? record.status}  ${record.channel}:${record.threadKey}${error}`;
}

function redactionSummary(redactions: Record<string, number>): string {
	const parts = Object.entries(redactions).map(([kind, n]) => `${kind} ${n}`);
	return parts.length ? parts.join(", ") : "없음";
}

export async function setupTui(service: ReportService, invocation: CommandInvocation): Promise<boolean> {
	const { io } = invocation;
	io.print(CONSENT_TEXT);
	const answer = await io.prompt({
		type: "checklist",
		message: "동의할 항목을 고르세요 (1·2·3은 모두 필요, 4는 선택)",
		options: [
			{ id: "collect", label: "1. 세션 보고 개인정보 수집·이용에 동의합니다", checked: false },
			{ id: "transfer", label: "2. 개인정보 국외 이전(Cloudflare)에 동의합니다", checked: false },
			{ id: "age14", label: "3. 만 14세 이상입니다", checked: false },
			{ id: "auto", label: "4. 욕설·불만 감지 시 자동 보고를 켭니다 (선택)", checked: false },
		],
		signal: io.signal,
	});
	let checked: string[];
	try {
		checked = JSON.parse(answer) as string[];
		if (!Array.isArray(checked)) throw new Error();
	} catch {
		throw new Error("malformed checklist answer; nothing changed");
	}
	if (!["collect", "transfer", "age14"].every((id) => checked.includes(id))) {
		io.print("1·2·3에 모두 동의하지 않아 보고 기능을 켜지 않았습니다. dinobot의 다른 기능은 그대로 쓸 수 있습니다.");
		return false;
	}
	const receipt = await service.recordConsent("owner", checked.includes("auto"));
	io.print(`동의를 기록했습니다 (${receipt.version}, ${receipt.at}). 자동 보고: ${checked.includes("auto") ? "켜짐" : "꺼짐"}`, "success");
	return true;
}

async function manualTui(service: ReportService, invocation: CommandInvocation, note: string): Promise<void> {
	const { io } = invocation;
	if (!(await service.consent("owner")).receipt && !(await setupTui(service, invocation))) return;
	io.print("보고를 만드는 중… (내 컴퓨터에서 비밀값·개인정보를 지운 뒤 미리보기)");
	const preview = await service.prepare({ owner: "owner", channel: invocation.channel, threadKey: invocation.threadKey, reporter: invocation.userId, excludeOthers: false, ...(note ? { note } : {}) });
	io.print([
		`보고 ${shortId(preview.id)} 미리보기`,
		`- 항목 ${preview.entries}개, 압축 ${(preview.compressedBytes / 1024).toFixed(1)} KiB`,
		`- 지운 정보: ${redactionSummary(preview.redactions)}`,
		`- 제외: 주입 메시지 ${preview.omitted.nudges}, 다른 참여자 ${preview.omitted.participants}, 잘린 긴 값 ${preview.omitted.truncated}`,
		`- 보낼 내용 전체: ${preview.path}`,
	].join("\n"));
	let choice: string;
	try {
		choice = await io.prompt({
			type: "select",
			message: `보고 ${shortId(preview.id)}를 보낼까요?`,
			options: [
				{ id: "send", label: "보내기" },
				{ id: "cancel", label: "취소 (아무것도 보내지 않음)" },
			],
			signal: io.signal,
		});
	} catch (error) {
		await service.discard("owner", preview.id);
		throw error;
	}
	if (choice !== "send") {
		await service.discard("owner", preview.id);
		io.print("보고를 버렸습니다. 아무것도 보내지 않았습니다.");
		return;
	}
	await service.confirm("owner", preview.id);
	io.print(`보고 ${shortId(preview.id)}를 보냅니다. 취소·삭제: /report undo ${shortId(preview.id)}`, "success");
}

async function manualChannel(service: ReportService, invocation: CommandInvocation, note: string): Promise<void> {
	const { io } = invocation;
	const owner = ownerOf(invocation);
	if (!(await service.consent(owner)).receipt) {
		io.print(`보고하려면 먼저 동의가 필요합니다.\n\n${CONSENT_TEXT}\n\n위 1·2·3에 모두 동의하면 \`/report agree ${CONSENT_VERSION}\` 를 보내 주세요. (자동 보고는 TUI에서만 켤 수 있습니다)`);
		return;
	}
	const preview = await service.prepare({ owner, channel: invocation.channel, threadKey: invocation.threadKey, reporter: invocation.userId, excludeOthers: true, ...(note ? { note } : {}) });
	io.print([
		`보고 ${shortId(preview.id)} 준비됨 (아직 보내지 않음)`,
		`- 항목 ${preview.entries}개, 압축 ${(preview.compressedBytes / 1024).toFixed(1)} KiB`,
		`- 지운 정보: ${redactionSummary(preview.redactions)}`,
		`- 다른 참여자 메시지 ${preview.omitted.participants}개는 본문을 빼고 보냅니다`,
		`보내기: \`/report send ${shortId(preview.id)}\` · 버리기: \`/report cancel ${shortId(preview.id)}\``,
	].join("\n"));
}

async function resolveDraft(service: ReportService, owner: Owner, prefix: string): Promise<string> {
	const drafts = await service.drafts(owner);
	const matches = drafts.filter((id) => id.startsWith(prefix.toLowerCase()));
	if (prefix.length < 4 || matches.length !== 1) throw new Error(matches.length > 1 ? `${prefix} matches several drafts; give more characters` : `no draft report ${prefix}`);
	return matches[0]!;
}

export function reportCommand(service: ReportService): SlashCommand {
	return {
		name: "report",
		description: "Send this session to the dinobot developer to improve the harness (consent required)",
		usage: "[note] | setup | list | undo <id> | withdraw | auto on|off",
		surfaces: ["tui", "channel"],
		run: async (args, invocation) => {
			const { io, surface } = invocation;
			const owner = ownerOf(invocation);
			const trimmed = args.trim();
			const [first = "", ...rest] = trimmed.split(/\s+/);
			// `/report on|off` alone is the auto toggle, not a report noted "on".
			const toggle = rest.length === 0 && /^(on|off)$/i.test(first);
			const sub = toggle ? "auto" : SUBCOMMANDS.has(first.toLowerCase()) ? first.toLowerCase() : "";
			const arg = toggle ? first.toLowerCase() : sub ? rest.join(" ").trim() : trimmed;

			switch (sub) {
				case "help":
					io.print(USAGE);
					return;
				case "setup":
					if (surface !== "tui") {
						io.print(`채널에서는 \`/report consent\` 로 문구를 보고 \`/report agree ${CONSENT_VERSION}\` 로 동의합니다.`);
						return;
					}
					await setupTui(service, invocation);
					return;
				case "consent":
					io.print(`${CONSENT_TEXT}\n\n동의: \`/report agree ${CONSENT_VERSION}\``);
					return;
				case "agree": {
					if (surface === "tui") {
						await setupTui(service, invocation);
						return;
					}
					if (arg !== CONSENT_VERSION) {
						io.print(`동의 문구를 확인한 뒤 정확한 버전으로 동의해 주세요: \`/report agree ${CONSENT_VERSION}\` (문구: \`/report consent\`)`, "error");
						return;
					}
					const receipt = await service.recordConsent(owner, false);
					io.print(`동의를 기록했습니다 (${receipt.version}, ${receipt.at}). 1·2·3(수집·이용, 국외 이전, 만 14세 이상)에 동의한 것으로 기록됩니다. 철회: \`/report withdraw\``, "success");
					return;
				}
				case "send": {
					const id = await resolveDraft(service, owner, arg);
					await service.confirm(owner, id);
					io.print(`보고 ${shortId(id)}를 보냅니다. 삭제: /report undo ${shortId(id)}`, "success");
					return;
				}
				case "cancel": {
					const id = await resolveDraft(service, owner, arg);
					await service.discard(owner, id);
					io.print(`보고 ${shortId(id)}를 버렸습니다.`);
					return;
				}
				case "list": {
					const records = await service.list(owner);
					io.print(records.length ? records.map(describe).join("\n") : "보고가 없습니다.");
					return;
				}
				case "undo": {
					if (!arg) {
						io.print("usage: /report undo <id>", "error");
						return;
					}
					const result = await service.undo(owner, arg);
					io.print(
						result.result === "cancelled" ? `보고 ${shortId(result.id)}를 보내기 전에 취소했습니다.` : result.result === "deleted" ? `보고 ${shortId(result.id)}를 서버에서 삭제했습니다.` : `보고 ${shortId(result.id)}는 이미 삭제됐습니다.`,
						"success",
					);
					return;
				}
				case "withdraw": {
					if (surface === "tui") {
						const choice = await io.prompt({
							type: "select",
							message: "동의를 철회하고 이 설치에서 보낸 모든 보고를 서버에서 삭제할까요?",
							options: [
								{ id: "withdraw", label: "철회하고 삭제" },
								{ id: "keep", label: "그대로 두기" },
							],
							signal: io.signal,
						});
						if (choice !== "withdraw") return;
					} else if (arg !== "confirm") {
						io.print("동의를 철회하고 내가 보낸 보고를 모두 삭제하려면 `/report withdraw confirm` 을 보내 주세요.");
						return;
					}
					const { deleted } = await service.withdraw(owner);
					io.print(`동의를 철회했습니다. 서버에서 보고 ${deleted}개를 삭제했고 이후로는 보내지 않습니다.`, "success");
					return;
				}
				case "auto": {
					if (surface !== "tui") {
						io.print("자동 보고는 혼자 쓰는 TUI에서만 켤 수 있습니다.", "error");
						return;
					}
					if (arg !== "on" && arg !== "off") {
						io.print("usage: /report auto on|off", "error");
						return;
					}
					if (arg === "on" && !(await service.consent("owner")).receipt && !(await setupTui(service, invocation))) return;
					const ok = await service.setAuto(arg === "on");
					io.print(ok ? `자동 보고를 ${arg === "on" ? "켰습니다" : "껐습니다"}.` : "먼저 /report setup 으로 동의해 주세요.", ok ? "success" : "error");
					return;
				}
				case "status": {
					const { receipt, auto } = await service.consent(owner);
					io.print(receipt ? `동의: ${receipt.version} (${receipt.at})\n자동 보고: ${surface === "tui" ? (auto ? "켜짐" : "꺼짐") : "TUI 전용"}` : `동의하지 않음. ${surface === "tui" ? "/report setup" : "/report consent"} 로 시작합니다.`);
					return;
				}
				default:
					if (surface === "tui") await manualTui(service, invocation, arg);
					else await manualChannel(service, invocation, arg);
			}
		},
	};
}
