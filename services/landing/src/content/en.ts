/**
 * English copy for the generated pages (default locale). vite/pages.ts renders src/pages/*.html with this
 * dictionary: {{meta.title}} is escaped, {{{key}}} is raw (keys ending in Html hold trusted markup).
 * src/content/ko.ts has exactly the same shape (type Content); test/content checks key parity.
 *
 * Every product claim comes from docs/product-facts.md (section numbers in the comments). Tone: crisp, neutral,
 * no exclamation marks, no emoji, nothing the facts sheet does not support (BRIEF 2).
 */
import { CONSENT_VERSION } from "../worker/waitlist.ts";
import { jsonLd, link, pillWords, SITE } from "./markup.ts";

const title = "dinobot: AI agents, for everyone";
const description =
	"dinobot is the AI teammate that lives in your chat. Ask in plain words. It plans the work, splits it up, remembers what matters, and learns how your team likes to work.";

export const en = {
	meta: {
		title,
		description,
		ogLocale: "en_US",
		ogLocaleAlt: "ko_KR",
		ogImage: "/brand/og-en.png",
		ogImageAlt: "dinobot, the dot-matrix T-rex, next to the headline: AI agents, for everyone.",
		consentVersion: CONSENT_VERSION,
		isKo: false,
		jsonLd: jsonLd({
			"@context": "https://schema.org",
			"@graph": [
				{ "@type": "Organization", "@id": `${SITE}/#org`, name: "dinobot", url: `${SITE}/`, logo: `${SITE}/apple-touch-icon.png` },
				{ "@type": "WebSite", "@id": `${SITE}/#site`, name: "dinobot", url: `${SITE}/`, inLanguage: ["en", "ko"], publisher: { "@id": `${SITE}/#org` } },
				{ "@type": "WebPage", "@id": `${SITE}/#page`, url: `${SITE}/`, name: title, description, inLanguage: "en", isPartOf: { "@id": `${SITE}/#site` } },
			],
		}),
	},
	a11y: {
		skip: "Skip to content",
		language: "Language",
		mainNav: "Main",
		home: "dinobot home",
		footerNav: "Footer",
		marqueePause: "Pause the list",
		marqueePlay: "Play the list",
	},
	nav: {
		home: "/",
		strengths: "Strengths",
		how: "How it works",
		faq: "FAQ",
		download: "Download",
		cta: "Download",
	},
	hero: {
		eyebrow: "Now available",
		eyebrowNote: "macOS, Windows and the terminal",
		/** Hero download buttons. app/download.ts swaps in the label for the visitor's OS; every button jumps to #download. */
		download: {
			cta: "Download dinobot",
			ctaMac: "Download for Mac",
			ctaWindows: "Download for Windows",
			cli: "Install the CLI",
			meta: "macOS 13+ · Windows 10 and 11 (64-bit) · CLI for Linux, macOS and Windows",
		},
		title: "AI agents, for everyone.",
		titleHtml: `AI agents, <br class="br-wide">for ${pillWords(["everyone", "your team", "anyone"])}.`,
		sub: "dinobot is the AI teammate that lives in your chat. Ask in plain words. It plans the work, splits it up, remembers what matters, and learns how your team likes to work.",
		sceneLabel: "A chat thread: someone asks dinobot to update and publish an FAQ, and dinobot replies with a five-step plan.",
		/** The dinosaur theme switch in the hero stage (ADR 0100): short visible names, full names for assistive tech. */
		dino: {
			label: "Dinosaur theme",
			options: [
				{ id: "rex", name: "T-rex", label: "T-rex, Signal theme" },
				{ id: "ptero", name: "Ptero", label: "Pterodactyl, Dusk theme" },
				{ id: "brachio", name: "Brachio", label: "Brachiosaurus, Fern theme" },
				{ id: "tricera", name: "Trike", label: "Triceratops, Canyon theme" },
			],
		},
		chat: {
			channel: "launch-notes",
			members: "4 members",
			user: "Mina",
			userInitial: "M",
			time: "10:42",
			mention: "@dinobot",
			ask: "update the pricing FAQ in English and Korean, then publish it.",
			bot: "dinobot",
			botTag: "App",
			reply: "Here is the plan. Five steps, two at the same time.",
			steps: [
				{ label: "Draft the English FAQ", who: "Helper 1" },
				{ label: "Draft the Korean FAQ", who: "Helper 2" },
				{ label: "Check both drafts", who: "Check" },
				{ label: "Approve publishing", who: "You" },
				{ label: "Publish", who: "After approval" },
			],
			askQ: "Publish the updated FAQ? This can't be undone.",
			approve: "Approve",
			deny: "Deny",
			done: "Published. Every check passed.",
			queued: "Queued",
			running: "Running",
			waiting: "Waiting",
			finished: "Done",
		},
	},
	/** The waitlist form is no longer on the page (downloads are open); this copy stays as the record of what earlier signups agreed to. */
	form: {
		label: "Email",
		placeholder: "you@company.com",
		submit: "Join the waitlist",
		consentHtml: `I'm 14 or older and agree to the collection and use of my email for the waitlist (stored on Cloudflare's servers outside Korea). ${link("/privacy/", "Privacy notice")}`,
		trust: ["No spam", "Leave any time", "Early access and updates only"],
		honeypot: "Website (leave this empty)",
		doneTitle: "You're on the list.",
		doneSub: "We'll email you about early access and updates.",
		alreadyTitle: "You're already on the list.",
		alreadySub: "Same email, same spot. We'll be in touch about early access.",
		positionLabel: "Your spot on the list",
		invalidEmail: "Check the email address and try again.",
		consentRequired: "Please tick the consent box to join.",
		rateLimited: "Too many tries. Please wait a minute and try again.",
		offline: "You're offline. Your email is still here; try again once you're connected.",
		failed: "We couldn't save that. Your email is still here; it's safe to retry.",
	},
	channels: {
		label: "Works where you chat",
		chat: [
			{ name: "Slack", glyph: "chat" },
			{ name: "Telegram", glyph: "chat" },
			{ name: "Discord", glyph: "chat" },
			{ name: "Desktop app", glyph: "laptop" },
			{ name: "Terminal app", glyph: "terminal" },
			{ name: "HTTP API", glyph: "api" },
		],
		tools: [
			{ name: "Web search", glyph: "search", tag: "on by default" },
			{ name: "GitHub", glyph: "branch", tag: "opt-in" },
			{ name: "MCP servers", glyph: "plug", tag: "opt-in" },
			{ name: "Computer use", glyph: "cursor", tag: "opt-in" },
		],
	},
	philosophy: {
		eyebrow: "What we believe",
		statement:
			"AI agents shouldn't need a specialist. If you can ask a teammate, you can ask dinobot. The planning, the handoffs and the checks happen behind the chat.",
	},
	strengths: {
		eyebrow: "Strengths",
		title: "Plain words in.",
		muted: "Real work out.",
		lede: "Four things happen behind every bigger request. You see the result in your thread; here is what dinobot does to get there.",
		chapters: [
			{
				id: "dag",
				signal: "mint",
				num: "01",
				label: "DAG",
				title: "Big requests become plans",
				body: "dinobot turns a multi-step request into a graph of steps, runs independent steps in parallel, checks every requirement, and asks before anything irreversible.",
				steps: [
					"You ask once: update the pricing FAQ in two languages, then publish it.",
					"dinobot writes a five-step plan and checks the plan itself before anything runs.",
					"Both drafts run at the same time, and a check step reviews them.",
					"Publishing can't be undone, so that step waits for your approval.",
				],
			},
			{
				id: "memory",
				signal: "teal",
				num: "02",
				label: "Memory",
				title: "Remembers what matters",
				body: "Team and project memory live in dinobot's own database, shared across threads and kept through restarts. It notes project facts as you work and recalls them when relevant.",
				steps: [
					"Monday: \u201cWe ship on Thursdays. No pushes on Fridays.\u201d",
					"In the background, dinobot notes both as project facts.",
					"Wednesday, another thread asks for this week's release checklist.",
					"The two facts come back before dinobot answers, so nobody repeats them.",
				],
			},
			{
				id: "assignment",
				signal: "cyan",
				num: "03",
				label: "Assignment",
				title: "Delegates like a team lead",
				body: "dinobot splits a job into parts and assigns each to its own helper agent, running independent parts in parallel and merging the results into one answer.",
				steps: [
					"\u201cCompare our three onboarding emails and rewrite the weakest one.\u201d",
					"Three helper agents review one email each, at the same time.",
					"Another helper rewrites the weakest email.",
					"You follow one conversation and get one merged answer.",
				],
			},
			{
				id: "evolve",
				signal: "blue",
				num: "04",
				label: "Self-improving harness",
				title: "Learns how your team works",
				body: "As work wraps up, dinobot reviews what happened and keeps short working agreements, your preferences and its own lessons, and applies them to later requests.",
				steps: [
					"You say it once: \u201cRun the tests before you tell me it's done.\u201d",
					"When the work wraps up, dinobot looks back at what happened.",
					"It keeps your correction as a working agreement.",
					"The next request starts with that agreement in effect. Reusable procedures can become versioned skills.",
				],
			},
		],
	},
	demo: {
		eyebrow: "Watch it work",
		title: "One request, start to finish.",
		muted: "Pick one and press play.",
		lede: "Plan, helpers, memory, checks and the answer, in one replayable run.",
	},
	bento: {
		eyebrow: "More strengths",
		title: "Built for work you can trust.",
		muted: "Not just answers.",
		items: [
			{
				size: "wide",
				signal: "mint",
				glyph: "b-check",
				label: "Verification",
				title: "Done means proven",
				body: "Before it starts, dinobot writes down what success looks like. It runs real checks, keeps the results, and only calls work verified when every required check passes.",
			},
			{
				size: "wide",
				signal: "indigo",
				glyph: "b-ask",
				label: "Asks",
				title: "Asks only what is yours",
				body: "dinobot settles routine choices itself and asks you only about the ones that are yours, as two to four buttons in chat. Unanswered approvals default to no.",
			},
			{
				size: "base",
				signal: "blue",
				glyph: "b-target",
				label: "Goals",
				title: "Goals that survive long work",
				body: "Every goal is written as measurable checks and shown to dinobot on every request, so the target stays clear through long sessions and restarts.",
			},
			{
				size: "base",
				signal: "cyan",
				glyph: "b-tools",
				label: "Tools",
				title: "Hands on your real tools",
				body: "Files, shell, web search and memory are built in. GitHub, Google Workspace, MCP servers and desktop control are opt-in; GitHub and Google start read-only.",
			},
			{
				size: "base",
				signal: "teal",
				glyph: "b-threads",
				label: "Session awareness",
				title: "Knows what other threads are doing",
				body: "dinobot searches past conversations, sees which threads are busy, and claims shared work before changing it, so parallel threads avoid duplicate work.",
			},
			{
				size: "wide",
				signal: "none",
				glyph: "b-code",
				label: "Codemode",
				title: "Many steps, every one recorded",
				body: "dinobot can script dozens of tool calls in one step. Each call leaves a receipt, so after a crash it checks what finished instead of repeating it.",
			},
			{
				size: "wide",
				signal: "none",
				glyph: "b-data",
				label: "Your data",
				title: "Stored where dinobot runs",
				body: "Conversations, memory and credentials are stored on the machine that runs dinobot. Model calls go to the provider you choose, and web search can be turned off.",
			},
		],
	},
	how: {
		eyebrow: "How it works",
		title: "Three steps.",
		muted: "No new app to learn.",
		steps: [
			{ glyph: "plug", title: "Install and connect", body: "Download the desktop app or install the CLI. To bring dinobot into Slack, Telegram or Discord, connect them once in dinobot.yaml." },
			{ glyph: "chat", title: "Ask in plain words", body: "Write in a thread, a topic or a direct message, or use /ask on Discord." },
			{ glyph: "check", title: "Get results in the thread", body: "dinobot plans, assigns parts to helper agents, checks results and replies where you asked." },
		],
	},
	faq: {
		eyebrow: "FAQ",
		title: "Questions, answered.",
		muted: "Plainly.",
		items: [
			{
				q: "What is dinobot?",
				a: "dinobot is an AI agent for teams. It runs as a background service on a computer or server you control and answers in Slack, Telegram, Discord or its terminal app. You ask in plain words; for bigger jobs it plans the steps, assigns parts to helper agents, remembers project context and checks the results.",
			},
			{
				q: "Do I need to know how to code?",
				a: "Not to use it: you ask in plain words in your chat or in the desktop app. The desktop app for macOS and Windows already includes the dinobot service, so you install it with one command or a download. Connecting a team chat app is still technical: someone signs in to an AI model provider and adds the chat app in a configuration file (dinobot.yaml).",
			},
			{
				q: "Which chat apps does it work with?",
				a: "Slack, Telegram and Discord, plus dinobot's own desktop app for macOS and Windows, its terminal app and a local HTTP API for scripts. Microsoft Teams is not supported.",
			},
			{
				q: "Which AI models and accounts does it use?",
				a: "Your own. You sign in to a model provider with /login, using OAuth or an API key, and pick a model with /model. A new install starts with Anthropic's claude-sonnet-4-6. If you add several accounts for one provider, dinobot moves to the next account when one hits a rate or usage limit.",
			},
			{
				q: "Where does my data live?",
				a: "On the computer that runs dinobot. Conversations, memory and skills are kept in a local SQLite database, and model credentials in a private file next to it. Your messages go to the model provider you connect, and web search queries go to Startpage or DuckDuckGo unless you turn search off. Data reaches the dinobot team only if you consent to /report, and the optional Google plugin signs in through a dinobot relay that does not store your tokens.",
			},
			{
				q: "Can it break things?",
				a: "It acts with the permissions of the machine it runs on, so connect only what it needs. Guardrails help: GitHub and Google writes stay off until you enable them, desktop control is opt-in, irreversible steps in a plan wait for a person's approval (unanswered approvals default to no), and work is certified only when real checks pass. Its code runner is not a security sandbox, so isolate the machine if you need that.",
			},
			{
				q: "Does it remember things between conversations?",
				a: "Yes. Team and project memory is shared by every thread and survives restarts. dinobot also notes project facts in the background and keeps working agreements, short rules about how you like work done, which apply to every request. You can ask it to list, change or delete any of them.",
			},
			{
				q: "Will it ask me before doing something important?",
				a: "For decisions that are yours, yes. dinobot settles routine choices itself and asks about yours with two to four options, shown as buttons in Slack, Telegram and Discord or as a picker in the terminal app, with at most three open choice questions at a time. You can always answer in your own words. Steps marked irreversible in a plan wait for your approval; other actions run without a separate approval step.",
			},
			{
				q: "Is dinobot open source?",
				a: "No. dinobot's source code is not public, and the package is published without an open-source license.",
			},
			{
				q: "Can I use it now?",
				a: "Yes. The desktop app for macOS and Windows and the CLI are open to everyone; the download section above has both. dinobot uses your own AI model account, so model usage follows your provider's plan.",
			},
			{
				q: "Why does my computer warn me about the app?",
				a: "The desktop app is not code-signed or notarized yet. The install commands download it in a way that macOS Gatekeeper and Windows SmartScreen do not stop, and they check every file against its SHA-256 checksum before installing. If you download a file directly instead, macOS blocks it the first time (allow it in System Settings, Privacy & Security, Open Anyway), and Windows SmartScreen asks you to choose More info, then Run anyway.",
			},
		],
	},
	download: {
		eyebrow: "Download",
		title: "Get dinobot.",
		muted: "Pick your setup.",
		lede: "The desktop app brings the dinobot service with it, so there is nothing else to install. The CLI runs dinobot in a terminal or on a server.",
		recommended: "For this device",
		copy: "Copy",
		copied: "Copied",
		commandLabel: "Install command",
		platforms: [
			{
				id: "mac",
				glyph: "laptop",
				name: "macOS",
				requires: "macOS 13 or later · Apple Silicon and Intel",
				how: "Paste into Terminal",
				command: "curl -fsSL https://get.dinobot.workers.dev | bash",
				detail: "Picks the build for your Mac, checks its SHA-256, installs dinobot in Applications and tells you when an update is out.",
				filesLabel: "Or download the app",
				files: [
					{ label: "Apple Silicon (.zip)", href: "https://get.dinobot.workers.dev/download/mac-arm64" },
					{ label: "Intel (.zip)", href: "https://get.dinobot.workers.dev/download/mac-x64" },
				],
				note: "Not notarized by Apple yet. The Terminal command installs without a warning. A downloaded zip is blocked the first time: open System Settings, Privacy & Security, and choose Open Anyway.",
			},
			{
				id: "windows",
				glyph: "window",
				name: "Windows",
				requires: "Windows 10 or 11 · 64-bit",
				how: "Paste into PowerShell",
				command: "irm https://get.dinobot.workers.dev/install.ps1 | iex",
				detail: "Checks the installer's SHA-256, installs dinobot for your account without admin rights and tells you when an update is out.",
				filesLabel: "Or download the installer",
				files: [{ label: "Windows installer (.exe)", href: "https://get.dinobot.workers.dev/download/windows" }],
				note: "Not code-signed yet. The PowerShell command installs without a warning. If SmartScreen stops the downloaded installer, choose More info, then Run anyway.",
			},
			{
				id: "cli",
				glyph: "terminal",
				name: "CLI",
				requires: "Linux, macOS and Windows · Bun 1.4 or later",
				how: "Install with Bun",
				command: "bun add -g dinobot",
				detail: "Then run dinobot init once to create the default settings, and dinobot to open the terminal app. dinobot update keeps it current.",
				filesLabel: "Links",
				files: [
					{ label: "Get Bun", href: "https://bun.sh" },
					{ label: "dinobot on npm", href: "https://www.npmjs.com/package/dinobot" },
				],
				note: "Runs as a background service with channels for Slack, Telegram and Discord. The desktop app is the easier start on a personal computer.",
			},
		],
		footHtml: `Latest desktop release and SHA-256 checksums: ${link("https://get.dinobot.workers.dev/latest.json", "latest.json")}`,
	},
	final: {
		eyebrow: "Get started",
		title: "Meet your new teammate.",
		muted: "On Mac, Windows and the terminal.",
		cta: "Download dinobot",
	},
	footer: {
		tagline: "AI agents, for everyone.",
		privacy: "Privacy",
		privacyHref: "/privacy/",
		top: "Back to top",
		legal: "\u00a9 2026 dinobot",
	},
	privacy: {
		title: "Privacy notice · dinobot waitlist",
		description: "How the dinobot waitlist collects, uses and stores your email address.",
		eyebrow: "Privacy",
		h1: "Waitlist privacy notice",
		lede: "This notice covers the email waitlist on this site and nothing else. It explains what we collect, why, where it is stored and how to have it removed.",
		effectiveLabel: "Effective",
		effective: "2026-10-11",
		back: "Back to the home page",
		sections: [
			{
				title: "Who is responsible",
				html: `The waitlist is run by 정승현, who decides how this data is used. Contact: ${link("mailto:dev0jsh@gmail.com", "dev0jsh@gmail.com")}.`,
			},
			{
				title: "What we collect",
				html: "Your email address, the language of the page you signed up on, the time you signed up, which form you used (optional), and the version of the consent text you agreed to. We do not store your IP address or browser details with your entry.",
			},
			{
				title: "Why we collect it",
				html: "To send you waitlist updates and an invitation when early access opens. Nothing else: no advertising, no profiling.",
			},
			{
				title: "How long we keep it",
				html: "Until one year after launch, or until you withdraw, whichever comes first. Then the entry is deleted.",
			},
			{
				title: "Where it is stored",
				html: "In a Cloudflare D1 database operated by Cloudflare, Inc. (United States) with an Asia-Pacific location hint. This means your email is transferred to and stored on servers outside Korea. It is sent over an encrypted connection when you submit the form and is kept for the period above.",
			},
			{
				title: "Sharing",
				html: "We do not sell your email or share it with anyone. Cloudflare stores it on our behalf as the hosting provider.",
			},
			{
				title: "Your rights",
				html: `You can ask to see, correct or delete your entry, or withdraw your consent, at any time by emailing ${link("mailto:dev0jsh@gmail.com", "dev0jsh@gmail.com")}. We act on requests without delay.`,
			},
			{
				title: "You may refuse",
				html: "Joining is optional. If you do not agree, simply don't submit the form; the only consequence is that you won't be on the waitlist.",
			},
			{
				title: "Cookies",
				html: "This site sets one cookie, <code>lang</code>, and only when you switch languages, to remember your choice. There are no analytics or advertising cookies.",
			},
		],
	},
	notFound: {
		title: "Page not found · dinobot",
		description: "This page does not exist.",
		eyebrow: "404",
		h1: "This page doesn't exist.",
		body: "The link may be old, or the address has a typo. Downloads are on the home page.",
		home: "Go to the home page",
		mascot: "dinobot with crossed-out eyes",
	},
};

export type Content = typeof en;
