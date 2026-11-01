import { handleFetch } from "./app.ts";
import type { Env } from "./env.ts";

export default {
	fetch(request: Request, env: Env): Promise<Response> {
		return handleFetch(request, env);
	},
};
