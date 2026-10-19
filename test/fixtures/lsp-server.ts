import { appendFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";

type Position = { line: number; character: number };
type Document = { text: string; version: number };
const mode = process.argv[2] ?? "normal";
// Isolate transport promise failures: an unhandled rejection must fail this process,
// not be absorbed by the Bun test runner or a global rejection listener.
if (mode === "write-failure") {
	const reader = new PassThrough();
	const writer = new Writable({ write(_chunk, _encoding, done) { done(new Error("fixture-write-failure")); } });
	const rpc = createMessageConnection(new StreamMessageReader(reader), new StreamMessageWriter(writer));
	rpc.listen();
	let rejected = false;
	try { await rpc.sendRequest("probe", {}); }
	catch (error) {
		if (!String(error).includes("fixture-write-failure")) throw error;
		rejected = true;
	}
	await Bun.sleep(20);
	rpc.dispose();
	reader.destroy();
	writer.destroy();
	if (!rejected) throw new Error("Broken writer incorrectly succeeded");
	console.log("request write rejection contained");
	process.exit(0);
}
const logPath = process.argv[3];
const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
const documents = new Map<string, Document>();
const events: string[] = [];
let protocolError: string | undefined;
let initialized = false;
let shutdown = false;
let opens = 0;
let changes = 0;
let requests = 0;
let active = 0;
let maxActive = 0;
function record(event: string) {
	events.push(event);
	if (logPath) appendFileSync(logPath, `${JSON.stringify({ event, pid: process.pid })}\n`);
}
record("spawn");
function offset(text: string, position: Position): number {
	const lines = text.split(/\r\n|\r|\n/);
	const line = lines[position.line];
	if (!Number.isInteger(position.line) || !Number.isInteger(position.character) ||
		line === undefined || position.character < 0 || position.character > line.length) throw new Error("Invalid incremental edit range");
	let start = 0;
	const endings = text.match(/\r\n|\r|\n/g) ?? [];
	for (let i = 0; i < position.line; i++) start += lines[i]!.length + endings[i]!.length;
	return start + position.character;
}
async function publish(uri: string, changed = false) {
	if (mode === "push-unpublished") return;
	if (!mode.startsWith("push-")) return;
	const document = documents.get(uri)!;
	await connection.sendNotification("textDocument/publishDiagnostics", {
		uri,
		...(mode === "push-unversioned" ? {} : { version: document.version - Number(mode === "push-stale" && changed) }),
		diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 2, message: mode === "push-stale" && changed ? "fixture-stale-publication" : "fixture-diagnostic" }],
	});
}
connection.onRequest("initialize", () => {
	record("initialize");
	return { capabilities: mode === "unsupported" ? {} : {
		positionEncoding: "utf-16",
		textDocumentSync: mode === "incremental" ? 2 : 1,
		hoverProvider: true,
		definitionProvider: true,
		referencesProvider: true,
		documentSymbolProvider: true,
		workspaceSymbolProvider: true,
		...(mode.startsWith("push-") ? {} : { diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } }),
	} };
});
connection.onNotification("initialized", () => { initialized = true; record("initialized"); });
connection.onNotification("workspace/didChangeConfiguration", () => record("settings"));
connection.onNotification("textDocument/didOpen", async (params: { textDocument: { uri: string; text: string; version: number } }) => {
	if (!initialized) protocolError = "didOpen before initialized";
	if (documents.has(params.textDocument.uri)) protocolError = "duplicate didOpen";
	documents.set(params.textDocument.uri, { text: params.textDocument.text, version: params.textDocument.version });
	opens++;
	record("open");
	await publish(params.textDocument.uri);
});
connection.onNotification("textDocument/didChange", async (params: { textDocument: { uri: string; version: number }; contentChanges: { text: string; range?: { start: Position; end: Position } }[] }) => {
	try {
		const document = documents.get(params.textDocument.uri);
		if (!document) throw new Error("change before open");
		if (params.textDocument.version !== document.version + 1) throw new Error("nonconsecutive version");
		for (const change of params.contentChanges) {
			if (change.range) {
				const start = offset(document.text, change.range.start);
				const end = offset(document.text, change.range.end);
				if (start > end) throw new Error("reversed incremental range");
				document.text = document.text.slice(0, start) + change.text + document.text.slice(end);
			} else document.text = change.text;
		}
		document.version = params.textDocument.version;
		changes++;
		record("change");
		await publish(params.textDocument.uri, true);
	} catch (error) { protocolError = String(error); }
});
connection.onNotification("textDocument/didClose", (params: { textDocument: { uri: string } }) => {
	documents.delete(params.textDocument.uri);
	record("close");
});
connection.onRequest("textDocument/hover", async (params: { textDocument: { uri: string }; position: Position }, token) => {
	if (protocolError) throw new Error(protocolError);
	if (!initialized || !documents.has(params.textDocument.uri)) throw new Error("request before initialized/open");
	requests++;
	active++;
	maxActive = Math.max(maxActive, active);
	record("hover");
	try {
		if (mode === "crash") {
			process.stderr.write("fixture-crash-evidence\n");
			process.exit(23);
		}
		if (mode === "hang") {
			token.onCancellationRequested(() => record("cancel"));
			await new Promise(() => {});
		}
		await new Promise((resolve) => setTimeout(resolve, mode === "delayed" ? 70 : 2));
		return { contents: { kind: "plaintext", value: JSON.stringify({ sentinel: "fixture-hover", ...documents.get(params.textDocument.uri), position: params.position, documents: Object.fromEntries(documents), opens, changes, requests, active, maxActive, pid: process.pid, events }) } };
	} finally { active--; }
});
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
connection.onRequest("textDocument/definition", (params: { textDocument: { uri: string } }) => ({ uri: params.textDocument.uri, range }));
connection.onRequest("textDocument/references", (params: { textDocument: { uri: string } }) => [{ uri: params.textDocument.uri, range }]);
connection.onRequest("textDocument/documentSymbol", () => [{ name: "fixture-document-symbol", kind: 12, range, selectionRange: range }]);
connection.onRequest("workspace/symbol", (params: { query: string }) => [{ name: `fixture-workspace-symbol:${params.query}`, kind: 12, location: { uri: "file:///fixture.ts", range } }]);
connection.onRequest("textDocument/diagnostic", () => ({ kind: "full", items: [{ range, message: "fixture-pull-diagnostic", severity: 2 }] }));
connection.onRequest("shutdown", () => { shutdown = true; record("shutdown"); return null; });
connection.onNotification("exit", () => { record("exit"); process.exit(shutdown ? 0 : 1); });
connection.onClose(() => process.exit(0));
connection.listen();
