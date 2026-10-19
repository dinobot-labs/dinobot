import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { LSP_OPERATIONS, type LspManager } from "../core/lsp.ts";

/** The same registered capability serves direct calls and durable codemode calls. */
export function lspExtension(manager: LspManager) {
	return defineExtension({
		name: "lsp",
		sections: [
			section("lsp_guidance", () =>
				"Use lsp for semantic code inspection when a language server is installed: status discovers availability without starting servers, then hover, definition, references, document_symbols, workspace_symbols or diagnostics. In modes with codemode, call await tools.lsp(args). Servers are started lazily from local executables; nothing is automatically installed. Relative paths use this conversation's working directory. Input line and character are 1-based UTF-16; returned LSP URI ranges are 0-based UTF-16. Files are synchronized from disk before queries. No diagnostics publication or unversioned/stale diagnostics is not proof of a clean file. Inspect freshness and errors. LSP is read-only: use managed edit tools for changes and re-query afterward. Server analysis is not a substitute for relevant tests."),
		],
		tools: [
			defineTool({
				name: "lsp",
				description: "Inspect installed language servers or query code semantics. Operations: status, hover, definition, references, document_symbols, workspace_symbols, diagnostics. Document operations require path inside cwd; hover/definition/references also require 1-based line and UTF-16 character. For workspace_symbols supply path or select server explicitly. Optional server selects a configured server by name. Servers are local trusted executables, never auto-installed. Results retain raw LSP ranges (0-based UTF-16) and diagnostic provenance.",
				parameters: Type.Object({
					operation: Type.Union(LSP_OPERATIONS.map((operation) => Type.Literal(operation))),
					path: Type.Optional(Type.String({ minLength: 1 })),
					line: Type.Optional(Type.Integer({ minimum: 1 })),
					character: Type.Optional(Type.Integer({ minimum: 1 })),
					query: Type.Optional(Type.String()),
					server: Type.Optional(Type.String({ minLength: 1 })),
				}),
				replay: "safe",
				execute: async (input, api, context) => {
					const env = api.env;
					try {
						if (!env) throw new Error("LSP requires a local execution environment");
						const result = await manager.execute(input, env.cwd, context.abortSignal);
						return { content: [{ type: "text", text: JSON.stringify(result) }] };
					} catch (error) {
						context.abortSignal?.throwIfAborted();
						return {
							isError: true,
							content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
						};
					}
				},
			}),
		],
	});
}
