/**
 * Replaces every `[data-glyph="name"]` placeholder with the 5x5 dot glyph of the design system
 * (GLYPHS in src/client/styleguide/dots.ts, design-system.md section 11). The placeholder already has the glyph's
 * size (sections.css), so the swap never moves layout.
 */
import { renderGlyph } from "../styleguide/dots.ts";
import { $all } from "./env.ts";

export function mountGlyphs(root: ParentNode = document): void {
	for (const host of $all("[data-glyph]", root)) {
		const svg = renderGlyph(host.dataset.glyph ?? "chat");
		svg.classList.add("glyph-slot");
		host.replaceWith(svg);
	}
}
