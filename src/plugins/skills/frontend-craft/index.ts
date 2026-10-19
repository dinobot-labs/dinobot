// Frontend craft: the workflow that produced the dinobot waitlist landing page (services/landing, ADR 0086),
// generalized for any polished public page. Scripts ship as .txt so TypeScript does not resolve them as modules;
// they are exposed under their real .mjs names as companion files.
import body from "./body.md" with { type: "text" };
import briefTemplate from "./templates/BRIEF.template.md" with { type: "text" };
import referenceGuide from "./templates/REFERENCE_GUIDE.md" with { type: "text" };
import shot from "./scripts/shot.mjs.txt" with { type: "text" };
import fingerprint from "./scripts/fingerprint.mjs.txt" with { type: "text" };
import serve from "./scripts/serve.mjs.txt" with { type: "text" };
import fpsProbe from "./scripts/fps-probe.example.mjs.txt" with { type: "text" };

export const frontendCraftSkill = {
	name: "frontend-craft",
	description: "Build SF-startup-grade landing, waitlist and marketing pages: research 20+ references with screenshots and fingerprints, derive a documented design system and brand assets, then build animated sections, scenes and a signature interaction. Verify with screenshot, FPS (120+), Lighthouse and live E2E QA, then deploy and merge. Use for any request for a polished public frontend page.",
	body: body.trim(),
	files: {
		"scripts/fingerprint.mjs": fingerprint,
		"scripts/fps-probe.example.mjs": fpsProbe,
		"scripts/serve.mjs": serve,
		"scripts/shot.mjs": shot,
		"templates/BRIEF.template.md": briefTemplate,
		"templates/REFERENCE_GUIDE.md": referenceGuide,
	},
};
