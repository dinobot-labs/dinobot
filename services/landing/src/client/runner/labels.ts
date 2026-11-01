/** Runner bar strings (BRIEF 2: crisp and neutral, no exclamation marks). Same keys for both locales. */
export const RUNNER_LABELS = {
	en: {
		region: "dinobot runner",
		description: "A small running game. Click or tap the bar, or press Space or Arrow Up while it has focus, to jump.",
		hintPlay: "Click or press Space to play",
		hintPlayTouch: "Tap to play",
		hintRetry: "Click or press Space to retry",
		hintRetryTouch: "Tap to retry",
		hintStatic: "Click to jump",
		hintStaticTouch: "Tap to jump",
		hi: "HI",
		minimize: "Minimize the runner",
		restore: "Show the runner",
		gameOver: "Game over. Score",
	},
	ko: {
		region: "dinobot 러너",
		description: "작은 달리기 게임입니다. 바를 클릭하거나 탭하면, 또는 포커스가 있을 때 Space나 위쪽 화살표를 누르면 점프합니다.",
		hintPlay: "클릭하거나 Space를 눌러 플레이",
		hintPlayTouch: "탭해서 플레이",
		hintRetry: "클릭하거나 Space를 눌러 다시 시작",
		hintRetryTouch: "탭해서 다시 시작",
		hintStatic: "클릭해서 점프",
		hintStaticTouch: "탭해서 점프",
		hi: "HI",
		minimize: "러너 최소화",
		restore: "러너 펼치기",
		gameOver: "게임 종료. 점수",
	},
} as const satisfies Record<"en" | "ko", Record<string, string>>;

export type RunnerLabels = { readonly [K in keyof (typeof RUNNER_LABELS)["en"]]: string };
