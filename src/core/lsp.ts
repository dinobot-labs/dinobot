import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";

export interface LspServerConfig {
  name: string;
  command: string[];
  extensions: string[];
  languageId?: string;
  rootMarkers?: string[];
  initializationOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}
export interface LspOptions {
  servers?: readonly LspServerConfig[];
  timeoutMs?: number;
}
export const LSP_OPERATIONS = ["status", "hover", "definition", "references", "document_symbols", "workspace_symbols", "diagnostics"] as const;
export interface LspInput {
  operation: typeof LSP_OPERATIONS[number];
  path?: string;
  line?: number;
  character?: number;
  query?: string;
  server?: string;
}

const DEFAULTS: readonly LspServerConfig[] = [
  { name: "typescript", command: ["typescript-language-server", "--stdio"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"], rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"] },
  { name: "python", command: ["pyright-langserver", "--stdio"], extensions: [".py"], languageId: "python", rootMarkers: ["pyproject.toml", "pyrightconfig.json", "setup.py"] },
  { name: "rust", command: ["rust-analyzer"], extensions: [".rs"], languageId: "rust", rootMarkers: ["Cargo.toml"] },
  { name: "go", command: ["gopls"], extensions: [".go"], languageId: "go", rootMarkers: ["go.mod", "go.work"] },
  { name: "clang", command: ["clangd"], extensions: [".c", ".h", ".cpp", ".hpp"], rootMarkers: ["compile_commands.json", ".clangd", "CMakeLists.txt"] },
];
const MAX_CLIENTS = 8;
const MAX_DOCUMENTS = 64;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const MAX_STDERR_BYTES = 8192;
type JsonObject = Record<string, unknown>;
interface Document { path: string; text: string; version: number }
interface Publication { version?: number; diagnostics: unknown[] }
interface Client {
  key: string;
  config: LspServerConfig;
  root: string;
  process: ChildProcessWithoutNullStreams;
  connection: MessageConnection;
  capabilities: JsonObject;
  initialized: boolean;
  documents: Map<string, Document>;
  publications: Map<string, Publication>;
  stderr: string;
  failure?: Error;
  dead: boolean;
  exited: Promise<void>;
  retirement?: Promise<void>;
}
function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function check(signal: AbortSignal): void { if (signal.aborted) throw signal.reason ?? new Error("LSP aborted"); }
function within(root: string, file: string): boolean {
  const part = relative(root, file);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
async function executable(command: string, cwd: string): Promise<string | undefined> {
  const candidates: string[] = [];
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) candidates.push(resolve(cwd, command));
  else {
    for (let dir = cwd; ; dir = dirname(dir)) {
      candidates.push(join(dir, "node_modules", ".bin", command));
      if (dirname(dir) === dir) break;
    }
    candidates.push(...(process.env.PATH ?? "").split(delimiter).map(dir => resolve(cwd, dir || ".", command)));
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* Not installed at this candidate. */ }
  }
  return undefined;
}
async function readDocument(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`LSP target is not a regular file: ${path}`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`LSP document exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
    // A bounded read also covers a file growing after stat, without allocating its new size.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_FILE_BYTES) throw new Error(`LSP document exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
    return buffer.subarray(0, size).toString("utf8");
  } finally { await handle.close(); }
}
async function nativeTypescript(cwd: string): Promise<string | undefined> {
  const command = await executable("tsc", cwd);
  if (!command) return undefined;
  try {
    const binary = await realpath(command);
    // Verify package identity and its declared binary, not just a command named tsc.
    const packageRoot = dirname(dirname(binary));
    const metadata = object(JSON.parse(await readDocument(join(packageRoot, "package.json"))));
    const major = typeof metadata.version === "string" ? Number(metadata.version.split(".")[0]) : 0;
    const bin = object(metadata.bin).tsc;
    if (metadata.name !== "typescript" || major < 7 || !Number.isInteger(major) || typeof bin !== "string") return undefined;
    if (await realpath(resolve(packageRoot, bin)) !== binary) return undefined;
    return command;
  } catch { return undefined; }
}
function lines(text: string): string[] { return text.split(/\r\n|\r|\n/); }
function endPosition(text: string): { line: number; character: number } {
  const parts = lines(text);
  return { line: parts.length - 1, character: parts[parts.length - 1]!.length };
}
function position(input: LspInput, text: string): { line: number; character: number } {
  const { line, character } = input;
  if (!Number.isInteger(line) || !Number.isInteger(character) || line! < 1 || character! < 1) {
    throw new Error("LSP positional operations require positive 1-based line and character (UTF-16 code units)");
  }
  const parts = lines(text);
  if (line! > parts.length || character! > parts[line! - 1]!.length + 1) throw new Error("LSP position is outside the document line");
  return { line: line! - 1, character: character! - 1 };
}
function language(config: LspServerConfig, path: string): string {
  if (config.languageId) return config.languageId;
  const ext = extname(path);
  return ({ ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact", ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp" } as Record<string, string>)[ext] ?? ext.slice(1);
}
function syncOptions(client: Client): { openClose: boolean; change: number; save: unknown } {
  const sync = client.capabilities.textDocumentSync;
  // The legacy numeric form implies open/close notifications.
  if (typeof sync === "number") return { openClose: sync !== 0, change: sync, save: false };
  const options = object(sync);
  return { openClose: options.openClose === true, change: typeof options.change === "number" ? options.change : 0, save: options.save };
}

export class LspManager {
  private readonly servers: readonly LspServerConfig[];
  private readonly timeoutMs: number;
  private readonly useDefaults: boolean;
  private readonly clients = new Map<string, Client>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly operations = new Set<AbortController>();
  private readonly active = new Map<AbortSignal, Client>();
  private readonly retirements = new Set<Promise<void>>();
  private closed = false;

  constructor(options: LspOptions = {}) {
    this.servers = structuredClone(options.servers ?? DEFAULTS);
    this.useDefaults = options.servers === undefined;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) throw new Error("LSP timeoutMs must be positive and at most 2147483647");
    const names = new Set<string>();
    for (const server of this.servers) {
      if (!server.name || names.has(server.name) || !server.command.length || server.command.some(arg => typeof arg !== "string" || arg.includes("\0")) || !server.command[0]) throw new Error("LSP server names must be unique and commands must be nonempty strings");
      if (server.rootMarkers?.some(marker => isAbsolute(marker) || marker.split(/[\\/]/).includes(".."))) throw new Error("LSP root markers must be relative paths without parent traversal");
      names.add(server.name);
    }
  }

  private async installed(config: LspServerConfig, cwd: string): Promise<{ config: LspServerConfig; executable: string | undefined }> {
    if (this.useDefaults && config.name === "typescript") {
      const native = await nativeTypescript(cwd);
      if (native) return { config: { ...config, command: ["tsc", "--lsp", "--stdio"] }, executable: native };
    }
    return { config, executable: await executable(config.command[0]!, cwd) };
  }

  async execute(input: LspInput, cwd: string, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error("LSP manager is closed");
    if (!LSP_OPERATIONS.includes(input.operation)) throw new Error(`Unknown LSP operation: ${input.operation}`);
    const controller = new AbortController();
    this.operations.add(controller);
    const abort = () => controller.abort(new Error("LSP operation aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error(`LSP operation timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    let cancelWait: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      cancelWait = () => {
        const stderr = this.active.get(controller.signal)?.stderr;
        reject(new Error(`${errorText(controller.signal.reason)}${stderr ? `\nLSP stderr: ${stderr}` : ""}`));
      };
      controller.signal.addEventListener("abort", cancelWait, { once: true });
      if (controller.signal.aborted) cancelWait();
    });
    try { return await Promise.race([this.perform(input, cwd, controller.signal), cancelled]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (cancelWait) controller.signal.removeEventListener("abort", cancelWait);
      this.operations.delete(controller);
    }
  }

  private async perform(input: LspInput, cwd: string, signal: AbortSignal): Promise<unknown> {
    check(signal);
    const workspace = await realpath(cwd);
    check(signal);
    const selected = input.server ? this.servers.filter(server => server.name === input.server) : this.servers;
    if (input.server && !selected.length) throw new Error(`Unknown LSP server: ${input.server}`);
    if (input.operation === "status") {
      const servers = await Promise.all(selected.map(async configured => {
        const { config, executable } = await this.installed(configured, workspace);
        return {
          name: config.name, command: config.command, executable: executable ?? null,
          running: [...this.clients.values()].some(client => client.config.name === config.name && !client.dead),
          roots: [...this.clients.values()].filter(client => client.config.name === config.name && !client.dead).map(client => client.root),
        };
      }));
      check(signal);
      return { servers: servers.map(server => ({ ...server, available: server.executable !== null })) };
    }
    if (!input.path && input.operation !== "workspace_symbols") throw new Error(`LSP ${input.operation} requires path`);
    const path = input.path ? await realpath(resolve(workspace, input.path)) : undefined;
    // cwd is the explicit workspace boundary, including after symlink resolution.
    if (path && !within(workspace, path)) throw new Error("LSP target must be inside cwd (including symlink targets)");
    const matches = path ? selected.filter(server => server.extensions.includes(extname(path))) : selected;
    if (!matches.length) throw new Error(`No matching LSP server for ${path ?? "workspace"}`);
    if (!path && !input.server && matches.length !== 1) throw new Error("LSP workspace_symbols without path requires an explicit server");
    let config: LspServerConfig | undefined;
    let command: string | undefined;
    for (const candidate of matches) {
      const installed = await this.installed(candidate, workspace);
      command = installed.executable;
      if (command) { config = installed.config; break; }
    }
    if (!config || !command) throw new Error(`LSP server executable not installed: ${matches.map(server => `${server.name} (${server.command[0]})`).join(", ")}`);
    let root = workspace;
    for (let dir = path ? dirname(path) : workspace; within(workspace, dir); dir = dirname(dir)) {
      if ((await Promise.all((config.rootMarkers ?? []).map(marker => exists(join(dir, marker))))).some(Boolean)) { root = dir; break; }
      if (dir === workspace) break;
    }
    check(signal);
    const key = JSON.stringify([config.name, root]);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const task = previous.then(async () => {
      check(signal);
      if (this.closed) throw new Error("LSP manager is closed");
      let client = this.clients.get(key);
      // Never replace a process whose termination has not been confirmed.
      if (client?.dead) { await this.retire(client); client = this.clients.get(key); }
      check(signal);
      if (this.closed) throw new Error("LSP manager is closed");
      if (!client || client.dead) {
        if (this.clients.size >= MAX_CLIENTS) throw new Error(`LSP client limit (${MAX_CLIENTS}) reached; close the manager to release servers`);
        client = this.start(key, config!, command!, root);
        this.clients.set(key, client);
      }
      const current = client;
      this.active.set(signal, current);
      const token = new CancellationTokenSource();
      const cancel = () => { token.cancel(); void this.retire(current).catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        check(signal);
        if (!current.initialized) await this.initialize(current, token);
        check(signal);
        const result = await this.request(current, input, path, token, signal);
        check(signal);
        if (current.failure) throw current.failure;
        const output = { server: config!.name, root, operation: input.operation, positionEncoding: "utf-16", outputCoordinates: "0-based", result };
        if (Buffer.byteLength(JSON.stringify(output)) > MAX_RESULT_BYTES) throw new Error(`LSP result exceeds ${MAX_RESULT_BYTES} bytes; narrow the query`);
        return output;
      } catch (error) {
        await this.retire(current);
        throw new Error(`${config!.name}: ${errorText(current.failure ?? error)}${current.stderr ? `\nLSP stderr: ${current.stderr}` : ""}`);
      } finally {
        this.active.delete(signal);
        signal.removeEventListener("abort", cancel);
        token.dispose();
      }
    });
    const tail = task.then(() => {}, () => {});
    this.queues.set(key, tail);
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    return task;
  }

  private start(key: string, config: LspServerConfig, command: string, root: string): Client {
    const child = spawn(command, config.command.slice(1), { cwd: root, stdio: ["pipe", "pipe", "pipe"], shell: false });
    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    const exited = new Promise<void>(resolveExit => { child.once("exit", () => resolveExit()); child.once("error", () => resolveExit()); });
    const client: Client = { key, config, root, process: child, connection, capabilities: {}, initialized: false, documents: new Map(), publications: new Map(), stderr: "", dead: false, exited };
    child.stderr.on("data", (chunk: Buffer) => { client.stderr = Buffer.from(client.stderr + chunk.toString()).subarray(-MAX_STDERR_BYTES).toString(); });
    const fail = (error: Error) => { client.failure ??= error; void this.retire(client).catch(() => {}); };
    child.on("error", error => fail(error));
    child.on("exit", (code, signal) => { if (!client.dead) fail(new Error(`LSP process exited (${signal ?? code})`)); });
    connection.onError(([error]) => fail(error));
    connection.onClose(() => { if (!client.dead) fail(new Error("LSP connection closed")); });
    connection.onRequest("workspace/configuration", (params: { items?: { section?: string }[] }) => (params.items ?? []).map(item => {
      let settings: unknown = config.settings ?? {};
      for (const part of item.section?.split(".") ?? []) settings = object(settings)[part];
      return settings ?? null;
    }));
    connection.onRequest("workspace/workspaceFolders", () => [{ uri: pathToFileURL(root).href, name: root.split(sep).pop() || root }]);
    connection.onRequest("workspace/applyEdit", () => ({ applied: false, failureReason: "LSP tools are read-only" }));
    connection.onNotification("textDocument/publishDiagnostics", (params: { uri: string; version?: number; diagnostics: unknown[] }) => {
      const doc = client.documents.get(params.uri);
      if (!doc || !Array.isArray(params.diagnostics)) return;
      if (params.version !== undefined && params.version !== doc.version) return;
      const publication = { ...(params.version === undefined ? {} : { version: params.version }), diagnostics: params.diagnostics };
      if (Buffer.byteLength(JSON.stringify(publication)) > MAX_RESULT_BYTES) { fail(new Error("LSP diagnostics exceed result byte limit")); return; }
      client.publications.set(params.uri, publication);
    });
    connection.listen();
    return client;
  }

  private async initialize(client: Client, token: CancellationTokenSource): Promise<void> {
    const rootUri = pathToFileURL(client.root).href;
    const initialized = await client.connection.sendRequest<{ capabilities?: JsonObject }>("initialize", {
      processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: client.root.split(sep).pop() || client.root }],
      capabilities: { general: { positionEncodings: ["utf-16"] }, workspace: { configuration: true, workspaceFolders: true, applyEdit: false }, textDocument: { synchronization: { didSave: true }, publishDiagnostics: { versionSupport: true }, diagnostic: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
      initializationOptions: client.config.initializationOptions,
    }, token.token);
    client.capabilities = initialized.capabilities ?? {};
    const encoding = client.capabilities.positionEncoding;
    if (encoding !== undefined && encoding !== "utf-16") throw new Error(`Unsupported LSP position encoding: ${encoding}`);
    await client.connection.sendNotification("initialized", {});
    if (client.config.settings) await client.connection.sendNotification("workspace/didChangeConfiguration", { settings: client.config.settings });
    client.initialized = true;
  }

  private async synchronize(client: Client, path: string | undefined, signal: AbortSignal): Promise<Document | undefined> {
    const sync = syncOptions(client);
    const targetUri = path ? pathToFileURL(path).href : undefined;
    const paths = new Map([...client.documents].map(([uri, doc]) => [uri, doc.path]));
    if (path && targetUri) paths.set(targetUri, path);
    for (const [uri, file] of paths) {
      check(signal);
      const old = client.documents.get(uri);
      let text: string;
      try { text = await readDocument(file); }
      catch (error) {
        if (old && (error as NodeJS.ErrnoException).code === "ENOENT") {
          if (sync.openClose) await client.connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
          client.documents.delete(uri);
          client.publications.delete(uri);
          if (uri !== targetUri) continue;
        }
        throw error;
      }
      check(signal);
      if (old?.text === text) continue;
      const doc: Document = { path: file, text, version: (old?.version ?? 0) + 1 };
      if (!old && client.documents.size >= MAX_DOCUMENTS) throw new Error(`LSP tracked document limit (${MAX_DOCUMENTS}) reached`);
      if (!old && !sync.openClose) throw new Error("LSP server does not support document open synchronization");
      if (old && sync.change !== 1 && sync.change !== 2 && !sync.openClose) throw new Error("LSP server cannot synchronize changed documents");
      // Set version before notifications, so immediately arriving diagnostics see the new snapshot.
      client.documents.set(uri, doc);
      if (!old || (sync.change !== 1 && sync.change !== 2)) {
        if (old) await client.connection.sendNotification("textDocument/didClose", { textDocument: { uri } });
        await client.connection.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: language(client.config, file), version: doc.version, text } });
      } else {
        const change = sync.change === 2 ? { range: { start: { line: 0, character: 0 }, end: endPosition(old.text) }, rangeLength: old.text.length, text } : { text };
        await client.connection.sendNotification("textDocument/didChange", { textDocument: { uri, version: doc.version }, contentChanges: [change] });
      }
      if (sync.save) await client.connection.sendNotification("textDocument/didSave", { textDocument: { uri }, ...(object(sync.save).includeText === true ? { text } : {}) });
    }
    return targetUri ? client.documents.get(targetUri) : undefined;
  }

  private async request(client: Client, input: LspInput, path: string | undefined, token: CancellationTokenSource, signal: AbortSignal): Promise<unknown> {
    const doc = await this.synchronize(client, path, signal);
    check(signal);
    const textDocument = path ? { uri: pathToFileURL(path).href } : undefined;
    if (input.operation === "diagnostics") {
      if (client.capabilities.diagnosticProvider) {
        const report = await client.connection.sendRequest<unknown>("textDocument/diagnostic", { textDocument }, token.token);
        if (object(report).kind !== "full" || !Array.isArray(object(report).items)) {
          throw new Error("LSP diagnostic request without previousResultId requires a full report with items");
        }
        return { source: "pull", version: doc!.version, freshness: "current", report };
      }
      const publication = client.publications.get(textDocument!.uri);
      return {
        source: "push", version: doc!.version,
        freshness: !publication ? "unknown" : publication.version === undefined ? "unversioned" : publication.version === doc!.version ? "current" : "pending",
        publishedVersion: publication?.version ?? null,
        diagnostics: publication?.diagnostics ?? null,
      };
    }
    const methods: Record<string, [string, string]> = {
      hover: ["hoverProvider", "textDocument/hover"], definition: ["definitionProvider", "textDocument/definition"], references: ["referencesProvider", "textDocument/references"],
      document_symbols: ["documentSymbolProvider", "textDocument/documentSymbol"], workspace_symbols: ["workspaceSymbolProvider", "workspace/symbol"],
    };
    const [capability, method] = methods[input.operation]!;
    if (!client.capabilities[capability]) throw new Error(`LSP server does not support ${input.operation}`);
    const params: JsonObject = input.operation === "workspace_symbols" ? { query: input.query ?? "" } : { textDocument };
    if (["hover", "definition", "references"].includes(input.operation)) params.position = position(input, doc!.text);
    if (input.operation === "references") params.context = { includeDeclaration: true };
    return client.connection.sendRequest(method, params, token.token);
  }

  private retire(client: Client): Promise<void> {
    if (client.retirement) return client.retirement;
    client.dead = true;
    client.connection.dispose();
    const retirement = (async () => {
      const wait = async (ms: number): Promise<void> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([client.exited, new Promise<void>(done => { timer = setTimeout(done, ms); })]); }
        finally { clearTimeout(timer); }
      };
      if (client.process.exitCode === null && client.process.signalCode === null) client.process.kill("SIGTERM");
      await wait(250);
      if (client.process.exitCode === null && client.process.signalCode === null) client.process.kill("SIGKILL");
      await wait(250);
      client.process.stdin.destroy();
      client.process.stdout.destroy();
      client.process.stderr.destroy();
      if (client.process.pid !== undefined && client.process.exitCode === null && client.process.signalCode === null) {
        throw new Error(`LSP ${client.config.name} process termination was not confirmed; its client slot is retained${client.stderr ? `\nLSP stderr: ${client.stderr}` : ""}`);
      }
      if (this.clients.get(client.key) === client) this.clients.delete(client.key);
    })();
    client.retirement = retirement;
    this.retirements.add(retirement);
    void retirement.then(() => this.retirements.delete(retirement), () => this.retirements.delete(retirement));
    return retirement;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const operation of this.operations) operation.abort(new Error("LSP manager is closed"));
    await Promise.all([...this.clients.values()].map(client => this.retire(client)));
    await Promise.all(this.retirements);
  }
}
