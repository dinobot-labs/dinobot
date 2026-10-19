# Producing and delivering each medium

The writing skill owns the sentences. This file owns the production, delivery and verification boundaries of what explanation builds.

## Common: producing is not showing

1. Check the channel, the environment the user can reach, and the requested format. A local file path on a remote bot is not a path on the user's machine.
2. Search the tool catalog for the capability and read the exact contract. When a local CLI is needed, check whether it is installed and whether the project already has a command for it. A missing search result does not prove the capability is impossible everywhere.
3. Decide where to produce the artifact and how it is opened or delivered. Reuse the project's existing artifact conventions; otherwise use a task-specific directory that cannot collide. Never overwrite existing files on a hunch.
4. External hosting, uploads, paid APIs and transfers of private material follow the request scope and current permissions. Do not publish, bill or expose external data without being asked. Keep credentials in the approved secret store or environment and out of outputs, sources, HTML and logs.
5. When no suitable means exists, state the limit and offer the closest alternative once. If a narrated video was replaced by a script, report "script and storyboard, video not produced", not "video done". If the user rejects that alternative, stop and end in the unmet state.

## Diagrams and images

- Focus on one question. Choose structure, sequence or state transition as fits.
- Label what each arrow means: call, data, time or dependency. Mark relations you did not confirm in code as assumptions.
- Split large diagrams into overview and detail. Carry meaning through labels and line style as well as color, and keep a text explanation next to the diagram. Follow the writing skill's diagram reference for palette, captions and dark mode.
- Keep ASCII readable in a narrow terminal and do not depend on intricate tables or Unicode alignment.
- For Mermaid, verify the renderer is available. For SVG and images, check truncation and legibility on real output when you can; if you only wrote the source, say that rendering was not verified.

## HTML explainer pages

- For a static explanation, prefer a single HTML file the environment can already open. Do not introduce a framework, CDN or server uninvited; inside an existing app, reuse that app's structure and components.
- Show the core conclusion first and add only the interaction that earns its place, such as unfolding steps, comparison or changing an input. Do not obstruct understanding with fake controls or decorative animation.
- Essential content must remain readable when JavaScript fails. Consider semantic HTML, keyboard operation, focus, contrast, small screens and reduced motion.
- Insert user text through escaping or safe DOM APIs. Do not embed secrets or excessive internal logs. Add no analytics or external requests without need and permission.
- When a real browser is available, check the screen, the core interaction, console errors and the responsive and keyboard behavior in scope. Without a browser, separate static or syntax checks from the unverified visual and behavioral parts.
- Deliver the path, how to open it, external dependencies and the level of verification. Writing an HTML file does not create a hosting URL, an attachment or an in-channel preview.

## Video and animation

- Decide why the time axis matters and who watches it. Without a specified length, start short and do not expand into ever more elaborate production.
- Work in order: core model → per-scene storyboard → frames and script → render → review. Keep assumptions and sources traceable in on-screen notes or a companion document.
- Do not treat a famous creator's name as a quality guarantee; use concrete techniques instead, such as intuitive shapes, stepwise transformation, clear labels and synchronized narration.
- Check whether a local renderer, encoder or TTS engine exists, or an approved API. Automatic installation, large model downloads and paid calls follow the request scope and the resource and permission policy. Even a "free" local run costs compute.
- Without TTS, explain the options you can deliver, such as subtitles or a silent animation. Never clone a real person's voice and never put credentials into the artifact.
- Ship readable subtitles or a script and a static summary with the video, so the core survives without audio.
- Check what you can of the output file: playability, duration, resolution, audio presence, key frames, subtitle timing and narration sync. One frame is not verification of the whole video or its audio.
- Long renders use the harness's managed task lifetime and cancellation path. Do not start a detached process and then guess that it finished.
