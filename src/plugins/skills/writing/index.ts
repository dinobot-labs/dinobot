// Roach writing style guide (윤문·기술 글쓰기), authored by the repository owner from
// the roach-newsletter WRITING.md voice and the blog article workflow. Markdown is
// embedded as text so the compiled binary and npm bundle carry it.
import body from "./body.md" with { type: "text" };
import voiceAndStructure from "./references/voice-and-structure.md" with { type: "text" };
import figuresAndMedia from "./references/figures-and-media.md" with { type: "text" };
import verification from "./references/verification.md" with { type: "text" };

export const writingSkill = {
	name: "writing",
	description: "Write and edit Korean tech blog posts, public articles and newsletters in the Roach voice: polite-speech mix with reader addressing, English terms in parentheses, footnote explanations for hard terms, inline SVG diagrams with dark-mode CSS variables, and mandatory fact-check plus sensitive-info scan before publishing. Load for any writing or prose-polishing task (글쓰기, 윤문, 아티클, 블로그, 뉴스레터 원고).",
	body: body.trim(),
	files: {
		"references/figures-and-media.md": figuresAndMedia,
		"references/verification.md": verification,
		"references/voice-and-structure.md": voiceAndStructure,
	},
};
