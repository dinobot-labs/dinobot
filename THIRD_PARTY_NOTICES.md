# Third-party notices

The project license does not replace third-party licenses.

- vendor/answer-me-with-html: original LICENSE and NOTICE.md retained unchanged from the source snapshot.
- src/plugins/web/{duckduckgo,http,query,search,startpage,types}.ts: adaptations of oh-my-pi, MIT. Copyright notices remain in source. Full original MIT text: licenses/oh-my-pi-MIT.txt, from @oh-my-pi/pi-ai 18.5.0.
- patches for @earendil-works/pi-tui 1.0.0 and pi-durable 1.0.2 retain upstream licensing. MIT original: licenses/earendil-pi.txt, retrieved from earendil-works/pi commit d2e7d8b7c1d31d3661f769d5caef7ba8d50c3e03/LICENSE.
- @oh-my-pi/pi-ai 18.5.0 patch: upstream MIT, licenses/oh-my-pi-MIT.txt.
- Other dependencies are installed from bun.lock, not vendored here. Their own license files and package metadata apply. The local release builder collects bundled dependency license notices into THIRD_PARTY_NOTICES.txt, including the project license; external dependencies retain their own distributions.

Do not remove third-party attribution when modifying or distributing these portions.

## Bundled prose inventory

Reviewed src/plugins/skills catalog and companion files for source/adaptation/license markers:

- optimization, debugging, clarification: the engineering-discipline-derived bodies and descriptions were removed. Replaced with short project-specific instructions. Stable skill names are API identifiers, not reused prose.
- herdr: original verbatim upstream --skill output had no bundled license grant. Removed and replaced with a short project-authored integration note; no claim to upstream authorship.
- programming: marked repository-owner-authored in source; retained.
- writing: owner-authored voice guide lineage; retained.
- dinobot, research, frontend-craft, explanation, slack-setup: repository-specific instructions and documentation; no external prose adaptation marker found in the inspected files. Retained. This marker inventory is not an independent legal authorship determination.
- vendor/answer-me-with-html and web adaptations: explicit existing licenses/attributions retained as listed above.

The replacement instructions are part of this project under its license. No rights to the removed upstream text are asserted.
