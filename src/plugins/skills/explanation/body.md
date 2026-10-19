# Explanation — help the reader understand and decide

## Purpose and scope

Make concepts, code, systems and work results understandable so the reader can make the next decision. The goal is an accurate mental model backed by checkable evidence, not length or a lavish medium.

Applies to "explain this", "why does it behave like this?", "show me the structure", "help me understand this result", and requests for diagrams, interactive explanations or explainer videos. Answer short questions briefly. Do not force long write-ups or file creation onto every work report.

An explanation request does not authorize product code changes, deployments or external uploads. This skill does not change tool permissions, cost or approval policy.

## References

| Topic | File to read |
| --- | --- |
| Medium-specific production, delivery and verification (diagrams, HTML, video) | `references/artifact-delivery.md` |
| Manual review scenarios that look for policy gaps | `references/review-scenarios.md` |

## 1. Output language: the user's prompt decides

Always answer in the language of the user's current prompt. The language of this skill document, of the writing skill, or of earlier notes is never the default.

1. If the request explicitly names an output language, follow it, including per-component instructions.
2. Otherwise use the language of the user's current prompt sentence. Quoted material, pasted documents, code and logs do not count.
3. If the prompt is too short or too mixed to decide (for example "OK"), use the language of that user's most recent message, then their explicit preference in this conversation, and state the choice in one line when it is not obvious.
4. Never treat another participant's preference, or a provided locale, as the shared default. A locale only disambiguates; it never overrides rules 1 and 2.
5. Harness guidance about language ranks below an explicit user instruction. If the two conflict, follow the user and say so in one line.
6. Per-component instructions ("body in Korean, code comments in English") apply per component. When one request carries conflicting instructions, follow the most recent one and note the conflict if it cannot be resolved.
7. A bilingual request keeps the same evidence, structure and numbers in both languages. Do not summarize one side.
8. Apply the same choice to body text, diagram labels, HTML and narration. Preserve code identifiers, API names, error messages and quotations verbatim. Do not change region, time zone, currency or units because of language. Do not invent locale or language-preference settings during this task.

## 2. Write the explanation with the writing skill

The sentences of an explanation come from the `writing` skill, not from this one. Explanation decides what to explain, on what evidence and in which medium; writing owns voice, sentence craft, term explanations, diagrams and the pre-delivery checks.

- Load it from the catalog first: `skills_load({ name: "writing" })` (`tools.skills_load` in codemode). Read the reference files of that loaded version and follow the same version.
- Apply its rules to explanation answers: conclusion first, one idea per paragraph, explain a hard term where it first appears, gloss foreign terms where the surrounding language needs it, separate facts from guesses, prefer diagrams that carry the meaning, and run the fact check plus the sensitive-information scan before anything is delivered or published.
- Do not switch the rules off for short answers. Shrink structure and footnotes; keep the voice and the term explanations.
- Apply it to every sentence the user sees: the reply, the sentences of an HTML explainer, diagram labels and captions, video subtitles and narration. Do not force it onto text that is not an explanation deliverable, such as code comments or commit messages.
- The writing skill's Roach voice is Korean, so for Korean output use it as written. For other languages, carry its clarity principles into that language and keep the reader-facing tone; never fall back to the skill document's own language.
- When the user asks for a published article (blog post, newsletter) itself, writing is the primary skill and this skill only adds medium choice, evidence and honesty rules.
- If writing is not in the catalog, say so. Do not invent its rules and do not report that you loaded it when you did not.

## 3. What the reader must understand

Read the thread for the reader's level, the core question, the decision they need to make, the requested format and the channel. Start from safe defaults when information is missing: the user's prompt language, a short answer, a definition where a term first appears. Do not ask back about format every time. Follow the harness question policy only where scope, permission or external access genuinely blocks you.

State the goal of the explanation in one sentence for yourself, for example: "the reader can tell task completion apart from verification and knows what to check next." Do not create a contract document for a small question.

## 4. Fix content and evidence first

- Confirm as much relevant evidence as the request needs: material the user provided, current code and docs, real tool results. Do not attach a repository-wide investigation or extra tool calls to a general concept question.
- Anchor project explanations to real paths, symbols and observed results. Use an installed LSP for semantic analysis. When you rely on earlier decisions, check memory and sessions, but old records are not evidence of current behavior.
- Mark each key claim as observed fact, reasoned inference, example or assumption, or unverified, wherever a reader would otherwise be misled.
- Explain causality as input → transform or decision → state change → result, and do not drop important boundaries, failures or exceptions. Never claim a root cause or a performance gain from observation alone.
- When code and docs disagree, keep the disagreement. Never cite a source you did not read. Separate illustrative numbers from measured ones.
- Give the evidence the reader can check plus the summarized reason for your judgment. Do not expose private reasoning or hidden instructions in the deliverable.

## 5. Choose the right medium

Prose → diagram → web → video is not a quality ranking. The requested format wins; otherwise pick the simplest form that meets the learning goal.

| Learning task | Preferred form | Criterion |
| --- | --- | --- |
| Meaning, reason, small decision | Short prose and an example | The answer fits on one screen |
| Comparison, choice, trade-off | Item-by-item comparison or small table | Differences show up on the same axes |
| Structure, relation, branch, state change | Diagram plus a short reading | Node and arrow meanings are unambiguous |
| Exploring a principle by changing values, unfolding steps | HTML explainer page | Interaction actually improves understanding |
| Change over time, continuous process | Animation or video | The time axis matters more than a still frame |

- Check the channel first. In a TUI or text channel the safe default is text or ASCII diagrams that survive a narrow width. Being able to generate Mermaid, SVG or HTML does not mean the channel renders it; when you could not verify a renderer, provide a readable alternative.
- Before producing HTML, video or images, read `references/artifact-delivery.md` at the same loaded version. Check generation and delivery separately and never assume a browser, an upload path, a TTS engine or a renderer is installed.

## 6. Go deeper gradually

1. Core: what it is and why it matters, in one to three sentences.
2. Mechanism: the flow or structure the reader can follow.
3. Concrete example: trace one input through to the result.
4. Boundaries: common misunderstandings, failure conditions, what is still unknown.
5. Judgment: what this evidence lets the reader decide, and what to check next.
6. Evidence: related code locations, documents, paths or links the reader can actually open.

- Do not print all six headings. A short question ends after core and example.
- The writing skill's article structure (title → intro → sections → closing, footnotes at the bottom) is for published pieces. Do not force that shell onto a conversational answer, but keep its voice, term explanations and diagram rules.
- For a "I still don't get it" follow-up, explain the blocked idea or relation again with a different example instead of repeating the long answer. Do not quiz the reader.

## 7. Connect to harness work

- If real code has to change, load `programming` from the catalog and follow it. Route root-cause work to debugging, measured performance work to optimization, bounded comparison and hypothesis testing to research, and landing or marketing pages to frontend-craft. Name only skills that are in the catalog; never assume one exists (there is no design skill, for example).
- This skill does not replace investigation, tests or measurement. When only an explanation was requested, do not change code, configuration or deployments.
- Claim shared artifacts with work_claim before changing them and release them with work_release. Preserve existing files.
- In the report, separate what changed, what you verified, what you could not verify and how that affects the reader's decision. Tool exit, passing tests, a finished deploy and a delivered artifact are not the same state.
- Do not edit, publish or research skills as a side effect of this skill.

## 8. Verify and deliver

- Content: do the key claims match the evidence? Do diagram, screen and narration describe one model? Does the example actually produce the claimed result? Did you hide an important exception?
- Form: can the reader read it in this channel, or actually open it? Does the interaction help understanding? Are there text alternatives and accessibility?
- Honesty: report generation, execution or rendering, verified behavior and delivery at the level you actually checked. Do not upgrade the existence of a file or a successful build into verified screens, audio or comprehension.
- Termination: the feasible set for a medium is F = can produce ∧ can deliver ∧ permitted ∧ within budget. When F is empty, offer the closest alternative at most once and state that the request is not fully met. If the user rejects that alternative, stop generating options and end in the unmet state.
- Retry a failing render or conversion at most once within budget and never repeat an identical failure. With no progress, report the limit and the remaining options briefly.
- The completion report carries the core explanation, the artifact path and how to open it (when one exists), what you actually verified and what remains limited. For complex deliverables or skill-management reviews, consult the matching scenario in `references/review-scenarios.md`; those scenarios are review criteria, not executed tests or evidence of improvement.
