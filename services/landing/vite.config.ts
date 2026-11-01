import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { pages } from "./vite/pages.ts";

const root = import.meta.dirname;

// The pages plugin (vite/pages.ts) renders src/pages/*.html with src/content/{en,ko}.ts into the root HTML entries
// (index.html, ko/index.html, privacy/index.html, ko/privacy/index.html, design/index.html, 404.html) and sets
// environments.client.build.rollupOptions.input. Never set the top-level build.rollupOptions.input: it breaks the
// Worker build.
export default defineConfig({
	plugins: [pages({ root }), cloudflare()],
	environments: {
		client: {
			// Every supported browser has native modulepreload; skip the polyfill chunk on each page.
			build: { modulePreload: { polyfill: false } },
		},
	},
});
