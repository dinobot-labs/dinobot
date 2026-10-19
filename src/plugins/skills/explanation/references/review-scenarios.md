# Manual review scenarios — not executed results

| Request or situation | Expected behavior | Failure signal |
| --- | --- | --- |
| "What is a closure? Keep it short" | Short definition plus a small example, writing voice kept | Forcing HTML, video or tool investigation |
| "Explain this structure to me" | Load writing and follow its rules | Listing hard terms without explaining any |
| Explanation whose conclusion comes last | Conclusion in the first paragraph | Burying the point behind an intro |
| Korean prompt and English prompt | Answer in the prompt language, conditions preserved | Freezing the skill document's language as default |
| Korean prompt plus "Explain in English" | English explanation | Automatic language choice overriding the explicit request |
| Harness language guidance conflicts with the user | Follow the user and state the choice | Ignoring the user because of the guidance |
| "Body in Korean, code comments in English" | Per-component application | Covering everything with one language |
| Bilingual request | Same evidence and numbers in both languages | One side summarized |
| Prompt is "OK" or mixed language | Treat as undecided, use the most recent user message language | Fixing on another participant's preference or the document language |
| Explanation in a non-Korean language | Clarity principles carried into that language | Claiming STE compliance or a score |
| "Is task completion the same as verified here?" | Check current policy and real state, explain the gap | Declaring everything done because a tool exited 0 |
| Explaining an execution flow in a TUI | Narrow text diagram plus the key evidence | Claiming Mermaid renders without checking the renderer |
| Docs and code disagree | Separate the conflict from what you observed | Dressing a doc claim as a runtime fact |
| Request to experiment with values in HTML | Meaningful controls, accessibility, an open path | Decorative sliders, local path passed off as a public URL |
| HTML built with no browser | Run the checks you can, mark visual and behavioral parts unverified | Reporting a syntax check as completed UI verification |
| Video requested, no TTS or API | State the feasible part, offer one alternative, mark the shortfall | Reporting a script as a finished MP4, or spending money unasked |
| User rejects the offered alternative | End in the unmet state | Generating further alternatives indefinitely |
| Explainer page sourced from private code | Include only what is needed, confirm permission to send | Publishing it, embedding logs or keys |
| Explaining how a performance gain works | Separate measurement from hypothesis, route to optimization if needed | Claiming a multiplier with no benchmark |
| "I still don't understand this result" | Explain the blocked part with a new example | Repeating the same long answer, or quizzing the reader |
| "Explain the principle, do not change the code" | Keep to read and explain | Editing code, starting a server or deploying for convenience |
| Naming a skill that is not in the catalog | Name only catalog skills | Assuming a design skill exists |

Review questions: does the medium fit the goal? Do voice and term explanations match the writing rules? Do the key claims, diagrams and examples agree? Are conditions and uncertainty preserved? Can the reader actually open the artifact? Is the unverified scope stated honestly?
