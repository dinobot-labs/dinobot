/**
 * Setup wizard copy in English and Korean. The TUI sends its locale with every command; anything that is not Korean
 * falls back to English. The /report consent text is legal wording and stays Korean regardless (ADR 0073).
 * The locale comes from the POSIX variables and, when none is set (Windows, most macOS GUI terminals), from the
 * operating system's language setting, so a Korean Windows gets the Korean onboarding.
 */
export type SetupLocale = "en" | "ko";

/**
 * POSIX precedence: LC_ALL, then LC_MESSAGES, then LANG. `ko`, `ko_KR.UTF-8`, `ko-KR` are Korean. None of them set: the
 * operating system's language setting (`system`), since Windows and macOS GUI terminals usually export no LANG at all.
 */
export function detectLocale(
	env: Readonly<Record<string, string | undefined>> = process.env,
	system: () => string | undefined = systemLocale,
): string | undefined {
	for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
		const value = env[name];
		if (value !== undefined && value !== "") return value;
	}
	return system();
}

/** The OS language setting as ICU resolves it (`ko-KR` on a Korean Windows or macOS); undefined when unavailable. */
export function systemLocale(): string | undefined {
	try {
		const locale = new Intl.DateTimeFormat().resolvedOptions().locale;
		return locale === "" ? undefined : locale;
	} catch {
		return undefined;
	}
}

export function resolveLocale(locale: string | undefined): SetupLocale {
	return locale !== undefined && /^ko(?:$|[_.@-])/i.test(locale) ? "ko" : "en";
}

type Copy = {
	readonly step: (index: number, total: number, title: string) => string;
	readonly titles: { readonly model: string; readonly next: string; readonly channels: string; readonly plugins: string; readonly report: string; readonly apply: string };
	readonly welcome: string;
	readonly loginIntro: string;
	readonly loginFailed: (message: string) => string;
	readonly loginOnly: string;
	readonly chooseModel: string;
	readonly checkingModel: (model: string) => string;
	readonly modelOk: (model: string) => string;
	readonly modelFailed: (model: string, message: string) => string;
	readonly modelRetry: string;
	readonly modelContinue: string;
	readonly modelKept: (model: string) => string;
	readonly nextMessage: (model: string) => string;
	readonly quick: string;
	readonly quickHint: string;
	readonly full: string;
	readonly fullHint: string;
	readonly channelsMessage: string;
	readonly terminal: string;
	readonly always: string;
	readonly telegram: string;
	readonly telegramHint: string;
	readonly slack: string;
	readonly slackHint: string;
	readonly discord: string;
	readonly discordHint: string;
	readonly configuredElsewhere: string;
	readonly telegramToken: string;
	readonly telegramTokenPlaceholder: string;
	readonly telegramReuse: string;
	readonly telegramPairingWithoutToken: (path: string) => string;
	readonly telegramOpen: string;
	readonly telegramOr: (command: string) => string;
	readonly telegramWaiting: string;
	readonly telegramPaired: (bot: string) => string;
	readonly telegramFailed: (message: string) => string;
	readonly telegramRetry: string;
	readonly telegramSkip: string;
	readonly pluginsMessage: string;
	readonly web: string;
	readonly webHint: string;
	readonly webOff: string;
	readonly computer: string;
	readonly computerHint: string;
	readonly computerUnavailable: string;
	readonly browser: string;
	readonly browserHint: string;
	readonly browserMode: (mode: "dedicated" | "attach") => string;
	readonly browserChoice: string;
	readonly browserDedicated: string;
	readonly browserRecommended: string;
	readonly browserDedicatedHint: string;
	readonly browserAttach: string;
	readonly browserAttachHint: string;
	readonly browserNeedsComputer: string;
	readonly browserAttachOff: string;
	readonly google: string;
	readonly googleHint: string;
	readonly calendar: string;
	readonly calendarHint: string;
	readonly installing: (what: string) => string;
	readonly installed: (what: string) => string;
	readonly installFailed: (what: string, message: string) => string;
	readonly grantPermissions: (command: string) => string;
	readonly reportMessage: string;
	readonly reportLater: string;
	readonly reportTurnOn: string;
	readonly reportKeep: string;
	readonly reportChange: string;
	readonly applyMessage: (path: string) => string;
	readonly applyRestart: string;
	readonly applyConfirm: string;
	readonly applyCancel: string;
	readonly nothingChanged: string;
	readonly added: (entry: string) => string;
	readonly removed: (entry: string) => string;
	readonly summaryModel: string;
	readonly summaryChannels: string;
	readonly summaryFeatures: string;
	readonly summaryReport: string;
	readonly reportOn: (auto: boolean) => string;
	readonly reportOff: string;
	readonly summaryAgain: string;
	readonly summaryAdvanced: (path: string) => string;
	/** The last words of the whole first-run wizard: hand the agent material about yourself and your projects. */
	readonly contextTip: string;
	readonly unknownSection: (section: string, sections: string) => string;
	readonly needsTui: string;
	readonly resumeHint: string;
	readonly applying: string;
	readonly applied: string;
	readonly applyOutcome: {
		readonly conflict: string;
		readonly invalid: (problems: string) => string;
		readonly unreachable: string;
		readonly olderDaemon: string;
		readonly otherManifest: (path: string) => string;
		readonly unsafeChange: string;
		readonly busy: (threads: string) => string;
		readonly external: (path: string) => string;
		readonly stuck: (pid: number) => string;
		readonly rolledBack: (reason: string, log: string) => string;
		readonly failed: (reason: string, log: string) => string;
		readonly recovered: string;
		/** Offered after a failed apply: send a problem report with the outcome (ADR 0103). */
		readonly reportHint: (manifestPath: string) => string;
	};
};

const en: Copy = {
	step: (index, total, title) => `Setup ${index}/${total} · ${title}`,
	titles: { model: "Connect a model", next: "Ready", channels: "Where to chat", plugins: "Features", report: "Problem reports", apply: "Apply" },
	welcome: "Welcome! Sign in to a model provider to start.",
	loginIntro: "Connect an AI model account to start using dinobot. It takes about a minute; everything else can be changed later with /setup.",
	loginFailed: (message) => `Login failed: ${message}`,
	loginOnly: "That account cannot run chat models in this build yet. Choose another provider.",
	chooseModel: "Choose the model dinobot should use",
	checkingModel: (model) => `Checking that ${model} answers…`,
	modelOk: (model) => `${model} is connected and answering.`,
	modelFailed: (model, message) => `${model} did not answer: ${message}`,
	modelRetry: "Choose another model",
	modelContinue: "Continue anyway",
	modelKept: (model) => `Model: ${model}`,
	nextMessage: (model) => `✓ ${model} connected. You can use dinobot in this terminal right now.`,
	quick: "Start now",
	quickHint: "recommended",
	full: "Set up more",
	fullHint: "Telegram, computer use, browser, Google, problem reports",
	channelsMessage: "Where do you want to talk to dinobot? Space toggles, Enter continues (choose nothing to skip).",
	terminal: "Terminal (TUI)",
	always: "always on",
	telegram: "Telegram",
	telegramHint: "chat from your phone · about 1 minute",
	slack: "Slack",
	slackHint: "configure in dinobot.yaml (see the Slack runbook)",
	discord: "Discord",
	discordHint: "needs a public HTTPS address (see the messaging runbook)",
	configuredElsewhere: "configured in dinobot.yaml",
	telegramToken: "In Telegram, open @BotFather, send /newbot and follow the steps. Paste the bot token it gives you here:",
	telegramTokenPlaceholder: "123456789:AA…",
	telegramReuse: "Using the Telegram bot you paired earlier.",
	telegramPairingWithoutToken: (path) => `A Telegram pairing already exists without its token (${path}). Remove it to pair again.`,
	telegramOpen: "Open this link on your phone and press Start (valid for 5 minutes, keep it private):",
	telegramOr: (command) => `Or send ${command} to the bot in a private chat.`,
	telegramWaiting: "Waiting for you in Telegram… (Esc stops setup)",
	telegramPaired: (bot) => `Telegram ${bot} connected. Only you can talk to it.`,
	telegramFailed: (message) => `Telegram setup failed: ${message}`,
	telegramRetry: "Try again",
	telegramSkip: "Skip Telegram",
	pluginsMessage: "Turn on features. Space toggles, Enter continues.",
	web: "Web search",
	webHint: "on by default",
	webOff: "turned off in dinobot.yaml",
	computer: "Computer use",
	computerHint: "see and operate desktop apps · installs a helper program",
	computerUnavailable: "Computer use is not available on this platform.",
	browser: "Browser",
	browserHint: "open sites, read pages, fill forms in a real Chrome (no automation fingerprint)",
	browserMode: (mode) => (mode === "attach" ? "your own Chrome" : "the bot's own Chrome"),
	browserChoice: "Which Chrome should the agent use?",
	browserDedicated: "Start with a Chrome just for the bot",
	browserRecommended: "recommended",
	browserDedicatedHint: "a separate Chrome profile: your own browser and logins stay untouched; sign in there only where the bot needs it",
	browserAttach: "Use my own Chrome as it is",
	browserAttachHint:
		"works with the sites you are already signed in to · also turns on computer use: on first use the agent turns on Chrome's remote debugging (chrome://inspect) and clicks Allow in Chrome's permission dialog with computer use",
	browserNeedsComputer: "Using your own Chrome needs computer use too: the agent turns on remote debugging and accepts Chrome's permission dialog with it.",
	browserAttachOff: "Computer use could not be installed, so the browser stays off. Run /setup plugins again, or choose the bot's own Chrome.",
	google: "Google (Gmail · Calendar · Drive)",
	googleHint: "read your mail, events and files · the agent sends a sign-in link on first use",
	calendar: "Calendar (reminders)",
	calendarHint: "keeps your events and reminds you in the same chat, preparing material ahead · no account needed",
	installing: (what) => `Installing ${what}…`,
	installed: (what) => `${what} installed.`,
	installFailed: (what, message) => `${what} could not be installed (${message}). Computer use stays off; try again later with \`dinobot init\`.`,
	grantPermissions: (command) => `Grant its macOS permissions once: ${command}`,
	reportMessage: "When dinobot misbehaves you can send the conversation to the dinobot developers so they can fix it. You always see a preview first, and secrets are removed.",
	reportLater: "Later",
	reportTurnOn: "Read the consent text and turn on",
	reportKeep: "Keep as is",
	reportChange: "Review consent",
	applyMessage: (path) => `Save these changes to ${path}? dinobot restarts briefly to apply them.`,
	applyRestart: "Restarting takes a few seconds. Running conversations are never interrupted: if one is busy, nothing is changed.",
	applyConfirm: "Apply",
	applyCancel: "Cancel (change nothing)",
	nothingChanged: "Nothing was changed.",
	added: (entry) => `+ ${entry}`,
	removed: (entry) => `− ${entry}`,
	summaryModel: "Model",
	summaryChannels: "Chat",
	summaryFeatures: "Features",
	summaryReport: "Reports",
	reportOn: (auto) => `on${auto ? " (automatic reports on)" : ""}`,
	reportOff: "off (/report setup)",
	summaryAgain: "Run /setup any time to change these.",
	summaryAdvanced: (path) => `Advanced settings (GitHub, MCP, Slack): ${path}`,
	contextTip:
		"One last thing: give the agent as much as you can about yourself and your projects, so it can get to know you. Folders of notes, documents and project files: pour them all in.\n" +
		"In the chat, attach a folder with @folder:path (or just paste its path) and ask the agent to read it and remember it. It keeps what it learns in memory and uses it in later conversations.",
	unknownSection: (section, sections) => `unknown setup section "${section}" (available: ${sections})`,
	needsTui: "/setup needs the terminal (TUI); run `dinobot setup`.",
	resumeHint: "Setup is not finished: run /setup any time to connect Telegram, computer use, Google or problem reports.",
	applying: "Applying setup: saving dinobot.yaml and restarting dinobot…",
	applied: "Setup applied; dinobot restarted with the new settings.",
	applyOutcome: {
		conflict: "dinobot.yaml changed while setup was running, so nothing was saved. Run /setup again.",
		invalid: (problems) => `The new settings did not validate, so nothing was saved:\n${problems}`,
		unreachable: "Could not reach the dinobot daemon, so nothing was changed.",
		olderDaemon: "The running dinobot daemon is older than this TUI and cannot be restarted safely. Nothing was changed; restart dinobot and run /setup again.",
		otherManifest: (path) => `The running daemon uses another manifest (${path}), so nothing was changed.`,
		unsafeChange: "The new settings would move the data directory or API port, which setup never does. Nothing was changed.",
		busy: (threads) => `Some conversations are still working (${threads}). Nothing was changed; run /setup again when they finish.`,
		external: (path) => `Saved ${path}. This dinobot daemon is managed outside the TUI (for example by systemd), so restart that service to apply the changes.`,
		stuck: (pid) => `The old dinobot daemon (pid ${pid}) did not stop in time. The previous settings were restored and nothing new was started; open dinobot again once it has exited.`,
		rolledBack: (reason, log) => `dinobot could not start with the new settings (${reason}). The previous settings were restored and dinobot is running again.${log ? `\n${log}` : ""}`,
		failed: (reason, log) => `dinobot could not start (${reason}). The previous settings are restored on disk; open dinobot again.${log ? `\n${log}` : ""}`,
		recovered: "An earlier setup was interrupted; dinobot.yaml was brought back in line with the running daemon.",
		reportHint: (path) => `To send this problem to the dinobot developer with diagnostics: /report (or in a terminal: dinobot report send --trigger setup-failed --config ${JSON.stringify(path)})`,
	},
};

const ko: Copy = {
	step: (index, total, title) => `설정 ${index}/${total} · ${title}`,
	titles: { model: "모델 연결", next: "준비 완료", channels: "대화할 곳", plugins: "기능", report: "문제 보고", apply: "적용" },
	welcome: "환영해요! 시작하려면 모델 제공자에 로그인하세요.",
	loginIntro: "dinobot을 쓰려면 AI 모델 계정을 하나 연결하세요. 1분이면 끝나고, 나머지는 나중에 /setup으로 바꿀 수 있어요.",
	loginFailed: (message) => `로그인하지 못했어요: ${message}`,
	loginOnly: "이 계정은 아직 이 빌드에서 대화 모델을 쓸 수 없어요. 다른 제공자를 고르세요.",
	chooseModel: "dinobot이 쓸 모델을 고르세요",
	checkingModel: (model) => `${model}이 응답하는지 확인하는 중…`,
	modelOk: (model) => `${model} 연결됨, 응답 확인했어요.`,
	modelFailed: (model, message) => `${model}이 응답하지 않았어요: ${message}`,
	modelRetry: "다른 모델 고르기",
	modelContinue: "그래도 계속",
	modelKept: (model) => `모델: ${model}`,
	nextMessage: (model) => `✓ ${model} 연결됨. 지금 바로 이 터미널에서 쓸 수 있어요.`,
	quick: "바로 시작",
	quickHint: "추천",
	full: "더 설정하기",
	fullHint: "텔레그램, 컴퓨터 사용, 브라우저, Google, 문제 보고",
	channelsMessage: "어디서 dinobot과 대화할까요? Space로 고르고 Enter로 넘어가요 (아무것도 안 고르면 건너뛰기).",
	terminal: "터미널 (TUI)",
	always: "항상 켜짐",
	telegram: "Telegram",
	telegramHint: "휴대폰에서 대화 · 약 1분",
	slack: "Slack",
	slackHint: "dinobot.yaml에서 설정 (Slack 런북 참고)",
	discord: "Discord",
	discordHint: "공개 HTTPS 주소 필요 (메신저 런북 참고)",
	configuredElsewhere: "dinobot.yaml에서 설정됨",
	telegramToken: "텔레그램에서 @BotFather를 열고 /newbot을 보낸 뒤 안내를 따르세요. 받은 봇 토큰을 여기에 붙여 넣으세요:",
	telegramTokenPlaceholder: "123456789:AA…",
	telegramReuse: "전에 연결한 텔레그램 봇을 그대로 써요.",
	telegramPairingWithoutToken: (path) => `토큰 없이 텔레그램 연결 정보만 남아 있어요 (${path}). 다시 연결하려면 이 파일을 지우세요.`,
	telegramOpen: "휴대폰에서 아래 링크를 열고 [시작]을 누르세요 (5분 동안 유효, 남에게 보여 주지 마세요):",
	telegramOr: (command) => `또는 봇과의 1:1 대화에서 ${command} 를 보내세요.`,
	telegramWaiting: "텔레그램에서 기다리는 중… (Esc를 누르면 설정을 멈춰요)",
	telegramPaired: (bot) => `텔레그램 ${bot} 연결됨. 나만 대화할 수 있어요.`,
	telegramFailed: (message) => `텔레그램 연결에 실패했어요: ${message}`,
	telegramRetry: "다시 시도",
	telegramSkip: "텔레그램 건너뛰기",
	pluginsMessage: "켤 기능을 고르세요. Space로 고르고 Enter로 넘어가요.",
	web: "웹 검색",
	webHint: "기본 켜짐",
	webOff: "dinobot.yaml에서 꺼짐",
	computer: "컴퓨터 사용",
	computerHint: "데스크톱 앱을 보고 조작 · 보조 프로그램 설치",
	computerUnavailable: "이 플랫폼에서는 컴퓨터 사용을 쓸 수 없어요.",
	browser: "브라우저",
	browserHint: "실제 Chrome으로 사이트 열기·읽기·양식 입력 (자동화 흔적 없음)",
	browserMode: (mode) => (mode === "attach" ? "내 Chrome" : "봇 전용 Chrome"),
	browserChoice: "에이전트가 어떤 Chrome을 쓸까요?",
	browserDedicated: "봇 전용 Chrome으로 시작",
	browserRecommended: "추천",
	browserDedicatedHint: "따로 만든 Chrome 프로필을 써요. 내 브라우저와 로그인은 건드리지 않고, 봇이 필요한 사이트만 그 창에서 로그인하면 돼요",
	browserAttach: "내 Chrome 그대로 쓰기",
	browserAttachHint:
		"이미 로그인된 사이트를 그대로 써요 · 컴퓨터 사용도 함께 켜요: 처음 쓸 때 에이전트가 Chrome 원격 디버깅(chrome://inspect)을 켜고, Chrome이 띄우는 허용 창을 컴퓨터 사용으로 눌러요",
	browserNeedsComputer: "내 Chrome을 쓰려면 컴퓨터 사용도 필요해요: 에이전트가 이걸로 원격 디버깅을 켜고 Chrome의 허용 창을 눌러요.",
	browserAttachOff: "컴퓨터 사용을 설치하지 못해서 브라우저는 꺼 둔 채로 두었어요. /setup plugins를 다시 실행하거나 봇 전용 Chrome을 고르세요.",
	google: "Google (Gmail · 캘린더 · 드라이브)",
	googleHint: "메일·일정·파일 읽기 · 처음 쓸 때 에이전트가 로그인 링크를 보내요",
	calendar: "캘린더 (일정 알림)",
	calendarHint: "일정을 기억했다가 같은 대화로 미리 알리고 준비 자료를 만들어요 · 계정 연결 필요 없음",
	installing: (what) => `${what} 설치하는 중…`,
	installed: (what) => `${what} 설치됨.`,
	installFailed: (what, message) => `${what}를 설치하지 못했어요 (${message}). 컴퓨터 사용은 꺼 둔 채로 두고, 나중에 \`dinobot init\`으로 다시 시도하세요.`,
	grantPermissions: (command) => `macOS 권한을 한 번 허용하세요: ${command}`,
	reportMessage: "dinobot이 잘못 동작했을 때 대화를 개발팀에 보내 고칠 수 있어요. 보내기 전에 항상 미리보기를 보여 주고, 비밀값은 지워서 보내요.",
	reportLater: "나중에",
	reportTurnOn: "동의 문구 보고 켜기",
	reportKeep: "그대로 두기",
	reportChange: "동의 다시 보기",
	applyMessage: (path) => `${path}에 아래 변경을 저장할까요? 적용하려고 dinobot이 잠깐 재시작돼요.`,
	applyRestart: "재시작은 몇 초면 끝나요. 실행 중인 대화는 절대 끊지 않아요: 바쁜 대화가 있으면 아무것도 바꾸지 않아요.",
	applyConfirm: "적용",
	applyCancel: "취소 (아무것도 바꾸지 않음)",
	nothingChanged: "아무것도 바꾸지 않았어요.",
	added: (entry) => `+ ${entry}`,
	removed: (entry) => `− ${entry}`,
	summaryModel: "모델",
	summaryChannels: "대화",
	summaryFeatures: "기능",
	summaryReport: "보고",
	reportOn: (auto) => `켜짐${auto ? " (자동 보고 켜짐)" : ""}`,
	reportOff: "꺼짐 (/report setup)",
	summaryAgain: "언제든 /setup 으로 다시 설정할 수 있어요.",
	summaryAdvanced: (path) => `고급 설정 (GitHub, MCP, Slack): ${path}`,
	contextTip:
		"마지막으로, 에이전트가 당신을 파악할 수 있게 당신에 대한 정보나 프로젝트에 대한 정보가 담긴 폴더들을 마구마구 넣어 주세요. 메모, 문서, 프로젝트 파일 무엇이든 좋아요.\n" +
		"대화창에서 @folder:경로 로 폴더를 붙이거나 경로를 그냥 붙여 넣고, 읽고 기억해 달라고 하세요. 에이전트가 알게 된 내용을 기억(memory)에 저장해 두고 이후 대화에서도 참고해요.",
	unknownSection: (section, sections) => `알 수 없는 설정 단계 "${section}" (가능: ${sections})`,
	needsTui: "/setup은 터미널(TUI)에서만 쓸 수 있어요. `dinobot setup`을 실행하세요.",
	resumeHint: "설정이 아직 끝나지 않았어요. 언제든 /setup 으로 텔레그램, 컴퓨터 사용, Google, 문제 보고를 설정할 수 있어요.",
	applying: "설정을 적용하는 중: dinobot.yaml을 저장하고 dinobot을 재시작해요…",
	applied: "설정을 적용했어요. dinobot이 새 설정으로 재시작됐어요.",
	applyOutcome: {
		conflict: "설정하는 동안 dinobot.yaml이 바뀌어서 아무것도 저장하지 않았어요. /setup을 다시 실행하세요.",
		invalid: (problems) => `새 설정이 검증을 통과하지 못해 아무것도 저장하지 않았어요:\n${problems}`,
		unreachable: "dinobot 데몬에 연결할 수 없어 아무것도 바꾸지 않았어요.",
		olderDaemon: "실행 중인 dinobot 데몬이 이 TUI보다 오래된 버전이라 안전하게 재시작할 수 없어요. 아무것도 바꾸지 않았어요. dinobot을 재시작한 뒤 /setup을 다시 실행하세요.",
		otherManifest: (path) => `실행 중인 데몬은 다른 설정 파일(${path})을 쓰고 있어서 아무것도 바꾸지 않았어요.`,
		unsafeChange: "새 설정이 데이터 디렉터리나 API 포트를 바꾸려고 해요. setup은 이런 변경을 하지 않아요. 아무것도 바꾸지 않았어요.",
		busy: (threads) => `아직 작업 중인 대화가 있어요 (${threads}). 아무것도 바꾸지 않았어요. 끝난 뒤 /setup을 다시 실행하세요.`,
		external: (path) => `${path}에 저장했어요. 이 dinobot 데몬은 TUI 밖에서(예: systemd) 관리되고 있으니 그 서비스를 재시작하면 적용돼요.`,
		stuck: (pid) => `이전 dinobot 데몬(pid ${pid})이 제때 멈추지 않았어요. 이전 설정으로 되돌렸고 새로 띄우지 않았어요. 종료된 뒤 dinobot을 다시 여세요.`,
		rolledBack: (reason, log) => `새 설정으로 dinobot을 시작하지 못했어요 (${reason}). 이전 설정으로 되돌렸고 dinobot이 다시 실행 중이에요.${log ? `\n${log}` : ""}`,
		failed: (reason, log) => `dinobot을 시작하지 못했어요 (${reason}). 디스크에는 이전 설정을 복구했어요. dinobot을 다시 여세요.${log ? `\n${log}` : ""}`,
		recovered: "이전 설정 작업이 중간에 끊겨서, dinobot.yaml을 실행 중인 데몬과 같은 상태로 맞췄어요.",
		reportHint: (path) => `이 문제를 진단 정보와 함께 개발자에게 보내려면: /report (터미널에서는 dinobot report send --trigger setup-failed --config ${JSON.stringify(path)})`,
	},
};

const COPY: Readonly<Record<SetupLocale, Copy>> = { en, ko };

export function setupCopy(locale: SetupLocale): Copy {
	return COPY[locale];
}

export type SetupCopy = Copy;
