/**
 * Token catalogue for the /design/ style guide: names, roles and specimens. Values are never copied here; the
 * page reads them from the computed style, so the guide always shows what tokens.css ships.
 */
import type { Signal } from "./contrast.ts";

export const NEUTRALS: { name: string; role: string }[] = [
	{ name: "n-1", role: "Paper. Page background" },
	{ name: "n-2", role: "Band. Alternating sections, wells" },
	{ name: "n-3", role: "Hover fill" },
	{ name: "n-4", role: "Pressed, selected" },
	{ name: "n-5", role: "Hairline" },
	{ name: "n-6", role: "Strong hairline, grid dots" },
	{ name: "n-7", role: "Disabled" },
	{ name: "n-8", role: "Control boundary, 3:1" },
	{ name: "n-9", role: "Text 3. Captions" },
	{ name: "n-10", role: "Text 2. Secondary" },
	{ name: "n-11", role: "Text on tints" },
	{ name: "n-12", role: "Ink" },
];

export const SIGNAL_ROLES: Record<Signal, { chapter: string; role: string }> = {
	mint: { chapter: "01 DAG", role: "Success, joined, verified checks" },
	teal: { chapter: "02 Memory", role: "Recall, remembered facts" },
	cyan: { chapter: "03 Assignment", role: "Helper agents, hand-offs" },
	blue: { chapter: "04 Self-improving", role: "Learned agreements, skills" },
	indigo: { chapter: "Asks", role: "Human decisions, approvals" },
};

export const ROLES: { name: string; use: string }[] = [
	{ name: "bg", use: "Page background (paper)" },
	{ name: "bg-band", use: "Alternating section band" },
	{ name: "surface", use: "Cards, inputs, panels" },
	{ name: "surface-hover", use: "Hover fill (overlay)" },
	{ name: "surface-pressed", use: "Pressed and selected fill" },
	{ name: "surface-inverse", use: "Primary button, tooltip, toast" },
	{ name: "line", use: "Hairline, card ring" },
	{ name: "line-strong", use: "Secondary button ring, kbd" },
	{ name: "line-ui", use: "Input and checkbox boundary" },
	{ name: "text-1", use: "Body text and headings" },
	{ name: "text-2", use: "Secondary text, ledes" },
	{ name: "text-3", use: "Captions, placeholders" },
	{ name: "text-muted-large", use: "Headline continuation, 24px+" },
	{ name: "accent", use: "The section's signal (dots, fills)" },
	{ name: "success", use: "Joined, verified" },
	{ name: "danger-deep", use: "Errors, invalid fields" },
	{ name: "focus", use: "Focus ring, 2px at 2px" },
	{ name: "selection", use: "Text selection" },
];

export interface TypeStep {
	token: string;
	cls: string;
	size: string;
	use: string;
	en: string;
	ko: string;
}

export const TYPE_SCALE: TypeStep[] = [
	{ token: "display-xl", cls: "t-display-xl", size: "52 → 120", use: "Closing statement", en: "Ask once.", ko: "한 번만 부탁하세요." },
	{ token: "display", cls: "t-display", size: "44 → 88", use: "H1", en: "AI agents, for everyone.", ko: "누구나 쉽게 쓰는 AI 에이전트" },
	{ token: "h2", cls: "t-h2", size: "32 → 56", use: "Section titles", en: "Big requests become plans.", ko: "큰 요청은 계획부터" },
	{ token: "h3", cls: "t-h3", size: "24 → 32", use: "Chapter and card titles", en: "It remembers what matters.", ko: "중요한 것은 기억합니다" },
	{ token: "h4", cls: "t-h4", size: "19 → 22", use: "Tile titles, FAQ", en: "Done means proven", ko: "검사를 통과해야 완료입니다" },
	{ token: "lede", cls: "t-lede", size: "18 → 21", use: "Intro paragraphs", en: "dinobot is the AI teammate that lives in your chat. Ask in plain words.", ko: "dinobot은 팀 채팅 안에서 일하는 AI 팀원입니다. 평소 말투로 부탁하세요." },
	{ token: "body-lg", cls: "t-body-lg", size: "17", use: "Chapter body", en: "It plans the work, splits it up, remembers what matters, and learns how your team likes to work.", ko: "일을 계획하고, 나누고, 중요한 것은 기억하고, 팀이 일하는 방식을 배웁니다." },
	{ token: "body", cls: "t-body", size: "16", use: "Default text, inputs", en: "Write in a thread, a topic or a direct message.", ko: "스레드, 토픽, 개인 메시지에 쓰면 됩니다." },
	{ token: "small", cls: "t-small", size: "14", use: "Labels, consent, nav", en: "I'm 14 or older and agree to the collection of my email.", ko: "만 14세 이상이며 이메일 수집에 동의합니다." },
	{ token: "caption", cls: "t-caption", size: "13", use: "Trust line, captions", en: "No spam · Leave any time", ko: "스팸 없음 · 언제든 탈퇴" },
	{ token: "label", cls: "t-label", size: "12 mono", use: "Eyebrows, metadata", en: "01 · DAG orchestration", ko: "01 · DAG 오케스트레이션" },
];

export const SPACE: { token: string; px: number; use: string }[] = [
	{ token: "space-1", px: 4, use: "Icon gaps" },
	{ token: "space-2", px: 8, use: "Inline gaps" },
	{ token: "space-3", px: 12, use: "Control groups" },
	{ token: "space-4", px: 16, use: "Form rows" },
	{ token: "space-5", px: 20, use: "List rows" },
	{ token: "space-6", px: 24, use: "Card padding" },
	{ token: "space-7", px: 32, use: "Card groups" },
	{ token: "space-8", px: 40, use: "Block gaps" },
	{ token: "space-9", px: 48, use: "Heading to content" },
	{ token: "space-10", px: 64, use: "Inside sections" },
	{ token: "space-11", px: 80, use: "Small sections" },
	{ token: "space-12", px: 96, use: "Hero padding" },
	{ token: "space-13", px: 128, use: "Section rhythm, desktop" },
	{ token: "space-14", px: 160, use: "Closing statement" },
];

export const RADII: { token: string; use: string }[] = [
	{ token: "radius-1", use: "Tags, kbd" },
	{ token: "radius-2", use: "Tooltips, DAG nodes" },
	{ token: "radius-3", use: "Toasts, chat bubbles" },
	{ token: "radius-4", use: "Cards, tiles" },
	{ token: "radius-5", use: "Form card, scenes" },
	{ token: "radius-6", use: "Media frames" },
	{ token: "radius-pill", use: "Buttons, inputs, pills" },
];

export const Z_INDEX: { token: string; use: string }[] = [
	{ token: "z-base", use: "Page flow" },
	{ token: "z-raised", use: "Overlapping cards, the peeking mascot" },
	{ token: "z-sticky", use: "Sticky chapter panels" },
	{ token: "z-nav", use: "Sticky nav" },
	{ token: "z-runner", use: "Fixed bottom runner bar" },
	{ token: "z-overlay", use: "Menus, sheets" },
	{ token: "z-toast", use: "Toasts (above the runner)" },
	{ token: "z-tooltip", use: "Tooltips" },
	{ token: "z-skip", use: "Skip link" },
];

export const DURATIONS: { token: string; raw: string; use: string }[] = [
	{ token: "dur-micro", raw: "duration-120", use: "Hover overlays, presses" },
	{ token: "dur-state", raw: "duration-200", use: "Toggles, tooltips, checks" },
	{ token: "dur-enter", raw: "duration-320", use: "Panels, toasts, FAQ answers" },
	{ token: "dur-scene", raw: "duration-560", use: "Scene swaps, reveals" },
	{ token: "dur-character", raw: "duration-900", use: "Mascot moments, assembly" },
];

export const EASINGS: { token: string; duration: string; use: string; bezier?: [number, number, number, number] }[] = [
	{ token: "ease-standard", duration: "duration-320", use: "State changes", bezier: [0.4, 0, 0.2, 1] },
	{ token: "ease-out", duration: "duration-560", use: "Entrances", bezier: [0.16, 1, 0.3, 1] },
	{ token: "ease-in", duration: "duration-320", use: "Exits", bezier: [0.5, 0, 0.75, 0] },
	{ token: "ease-in-out", duration: "duration-560", use: "Travel", bezier: [0.65, 0, 0.35, 1] },
	{ token: "spring-snappy", duration: "spring-snappy-dur", use: "Checks, pops, toasts" },
	{ token: "spring-gentle", duration: "spring-gentle-dur", use: "Panels settling" },
	{ token: "spring-bouncy", duration: "spring-bouncy-dur", use: "Characters only" },
];
