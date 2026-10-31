import type { Plugin } from "./types.ts";
import { asidePlugin } from "./aside/index.ts";
import { browserPlugin } from "./browser/index.ts";
import { calendarPlugin } from "./calendar/index.ts";
import { computerPlugin } from "./computer/index.ts";
import { githubPlugin } from "./github/index.ts";
import { googlePlugin } from "./google/index.ts";
import { imageGenPlugin } from "./image_gen/index.ts";
import { mcpPlugin } from "./mcp/index.ts";
import { pmPlugin } from "./pm/index.ts";
import { skillsPlugin } from "./skills/index.ts";
import { slackPersonalPlugin } from "./slack_personal/index.ts";
import { webPlugin } from "./web/index.ts";

/** Every plugin this build can enable. Customer manifests select from these by id. */
export const pluginCatalog: Readonly<Record<string, Plugin>> = {
	[asidePlugin.id]: asidePlugin,
	[browserPlugin.id]: browserPlugin,
	[calendarPlugin.id]: calendarPlugin,
	[computerPlugin.id]: computerPlugin,
	[githubPlugin.id]: githubPlugin,
	[googlePlugin.id]: googlePlugin,
	[imageGenPlugin.id]: imageGenPlugin,
	[mcpPlugin.id]: mcpPlugin,
	[pmPlugin.id]: pmPlugin,
	[skillsPlugin.id]: skillsPlugin,
	[webPlugin.id]: webPlugin,
	[slackPersonalPlugin.id]: slackPersonalPlugin,
};
