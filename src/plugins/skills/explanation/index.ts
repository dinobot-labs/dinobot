// Explanation workflow (설명·이해 산출물), authored by the repository owner. The English body keeps
// the explanation language bound to the user's prompt and delegates the prose to the writing skill;
// this skill owns medium choice, evidence and honesty rules. Markdown is embedded as text so the
// compiled binary and npm bundle carry it.
import body from "./body.md" with { type: "text" };
import artifactDelivery from "./references/artifact-delivery.md" with { type: "text" };
import reviewScenarios from "./references/review-scenarios.md" with { type: "text" };

export const explanationSkill = {
	name: "explanation",
	description: "Explain concepts, code, systems and work results so the reader can understand and decide. Answer in the language of the user's prompt, write the explanation with the writing skill's voice and rules (term explanations, diagrams, fact check), ground every claim in observed evidence, and pick prose, diagram, interactive HTML or video by learning goal. Load for explanation requests (설명해 줘, 왜 이렇게 동작하지?, 구조를 보여 줘, 이 결과를 이해하고 싶어, 도식·인터랙티브 설명·설명 영상).",
	body: body.trim(),
	files: {
		"references/artifact-delivery.md": artifactDelivery,
		"references/review-scenarios.md": reviewScenarios,
	},
};
