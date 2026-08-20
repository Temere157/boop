/**
 * Plugin contract. Plugins are how capabilities (event providers, webhooks,
 * …) are added to boop without touching the main loop. A plugin depends
 * only on the types in this file, so any plugin can be moved to its own
 * package and depend on just this contract.
 *
 * A plugin receives a {@link PluginHost} at init time, which exposes the
 * core capabilities it may use — currently the ability to register HTTP
 * routes, to enqueue events, to register tools, to register a low-level
 * session executor, and to obtain a scoped logger. The core wires
 * concrete implementations of these interfaces; the plugin never sees them.
 */

import type { Event } from "./event.js";

/**
 * Accepts an event into the queue. Hides {@link Event} construction (id,
 * timestamp) so plugins only name their source and carry a payload.
 */
export interface EventSink {
  enqueue(source: string, payload: unknown): void;
}

/** A buffered HTTP request, with the body fully read into memory. */
export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

/** What a route handler returns. */
export interface HttpResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string | Buffer;
}

/** Handles a single matched HTTP request. */
export type RouteHandler = (
  req: HttpRequest,
) => Promise<HttpResponse> | HttpResponse;

/** Capability to register HTTP routes on the shared core server. */
export interface HttpRoutes {
  route(method: string, path: string, handler: RouteHandler): void;
}

/**
 * A single content block in a tool result. MCP-shaped: tools return a list
 * of typed blocks. Only `"text"` is modelled directly here; the rest of the
 * block is left open so future block kinds (image, audio, …) can carry
 * their own fields without changing this contract.
 */
export interface ToolContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

/**
 * What a tool handler returns. MCP-shaped: a list of content blocks plus an
 * optional `isError` flag. `isError` signals a *semantic* tool failure
 * (e.g. bad arguments) to the caller without the handler having to throw; a
 * thrown error is treated as an unexpected crash by the executor.
 */
export interface ToolResult {
  readonly content: ToolContentBlock[];
  readonly isError?: boolean;
}

/**
 * JSON Schema describing a tool's arguments. MCP passes input schemas
 * through verbatim from tool definitions, so this is a permissive JSON
 * Schema object type rather than a hand-built subset — the exact shape is
 * whatever the tool wants to advertise to the LLM.
 */
export interface ToolInputSchema {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly [key: string]: unknown;
}

/**
 * A tool's static description: the part an LLM (and any MCP client) sees
 * when deciding whether to call it. This maps directly onto an MCP tool
 * definition.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: ToolInputSchema;
}

/**
 * Invoked when the executor calls a tool. Receives the parsed arguments and
 * returns an MCP-shaped {@link ToolResult}.
 */
export type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<ToolResult> | ToolResult;

/** A registered tool: its {@link ToolDefinition} paired with its handler. */
export interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
}

/**
 * Capability to register tools — actions the agent may take during a
 * session (call an API, read a file, send a message, …). Tools are
 * MCP-shaped so they can be exposed to executors that talk MCP (e.g. an
 * MCP server bridge) without translation, and the description the LLM sees
 * is exactly what an MCP client would see.
 */
export interface Tools {
  register(definition: ToolDefinition, handler: ToolHandler): void;
}

/**
 * A tool call requested by the assistant: which tool, with what arguments,
 * under a stable id so the matching result can be correlated.
 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/**
 * A single entry in a session transcript. The core prepares the first two
 * entries (the system prompt and the event rendered as a user turn); the
 * executor appends the rest as it runs the agentic loop. The shape is
 * role-tagged and otherwise permissive (an index signature lets a
 * provider-specific executor carry extra fields without changing this
 * contract).
 */
export interface TranscriptEntry {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  /** Assistant entries that request tool calls. */
  readonly toolCalls?: readonly ToolCall[];
  /** Tool entries: which call this result answers. */
  readonly toolCallId?: string;
  /** Tool entries: which tool was called. */
  readonly toolName?: string;
  /** Tool entries: the result the tool returned. */
  readonly result?: ToolResult;
  readonly [key: string]: unknown;
}

/**
 * The full record of a session: an ordered list of transcript entries. This
 * is what the executor returns; the core records it (JSONL in the XDG
 * state dir) so each event's handling is inspectable after the fact.
 */
export interface SessionTranscript {
  readonly entries: readonly TranscriptEntry[];
}

/**
 * Lets a session executor invoke registered tools. {@link definitions} is
 * the MCP-shaped list the LLM sees; {@link call} dispatches to the matching
 * handler. The core wraps the raw {@link ToolRegistry} so a handler crash
 * or an unknown tool comes back as a semantic {@link ToolResult} with
 * `isError` rather than throwing, keeping the executor's loop running.
 */
export interface ToolInvocation {
  readonly definitions: readonly ToolDefinition[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * A handle to a per-session MCP server listening on a unix socket. The
 * executor hands {@link path} to its agent runtime (typically via a small
 * stdio-bridge shim launched as a command-based MCP server); the agent
 * connects and calls tools over the MCP stdio protocol. {@link close}
 * stops serving and unlinks the socket once the session is done.
 */
export interface McpSocket {
  /** Filesystem path of the listening unix socket. */
  readonly path: string;
  /** Stop serving and unlink the socket. Idempotent. */
  close(): Promise<void>;
}

/**
 * Serves boop's tools to an agent runtime over the MCP stdio protocol
 * (newline-delimited JSON-RPC 2.0) on a fresh per-session unix socket. The
 * executor asks for a socket only if its runtime speaks MCP (e.g.
 * claude-code in -p mode, reached via a stdio-bridge shim); a session that
 * calls tools directly need not ask for one.
 */
export interface McpServer {
  serve(tools: ToolInvocation): Promise<McpSocket>;
}

/**
 * A fully prepared transient session, handed to the low-level executor.
 * The core has already decided which event this session is for, built the
 * system prompt and the first user message (which carries the event), and
 * gathered the tools available to the agent (with a way to invoke them);
 * the executor only has to run the agentic loop (LLM ↔ tools) and return
 * a transcript. By the time the executor runs, no more preparation is
 * needed — it is the whole "do the work" half.
 *
 * {@link mcp} is an opt-in path for executors whose runtime speaks MCP: it
 * hands out a fresh unix socket serving {@link tools} over the MCP stdio
 * protocol. An executor that calls tools directly can ignore it.
 */
export interface PreparedSession {
  readonly event: Event;
  readonly systemPrompt: string;
  /**
   * The first user message of the session: the event rendered as a user
   * turn. The executor passes this to its agent runtime as the prompt,
   * keeping the event out of the system prompt (which is fixed role text).
   */
  readonly firstUserMessage: string;
  readonly tools: ToolInvocation;
  readonly mcp: McpServer;
}

/**
 * Runs a prepared session's agentic loop and returns its transcript. This
 * is the low-level executor: it owns the LLM ↔ tool-call cycle and is the
 * piece that is swapped to change provider/runtime (a real LLM, an MCP
 * client bridge, a scripted stand-in, …). There is at most one registered.
 */
export type SessionExecutor = (
  session: PreparedSession,
) => Promise<SessionTranscript>;

/**
 * Capability to register the low-level session executor. Exactly one
 * executor may be registered; a second registration is rejected because
 * two executors would both try to own the per-event agentic loop.
 */
export interface Executors {
  register(executor: SessionExecutor): void;
}

/** Log severity levels, ordered `trace` < `debug` < `info` < `warn` < `error`. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "silent";

/**
 * A scoped, level-filtered logger. Plugins obtain one via
 * {@link PluginHost.log} at init time and reuse it for the plugin's life.
 * Levels are `trace` < `debug` < `info` < `warn` < `error`; the threshold is
 * set by the core (from `BOOP_LOG`), so a plugin just calls the level it
 * wants and the core decides whether it surfaces.
 */
export interface Logger {
  readonly scope: string;
  trace(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/**
 * Capability to obtain a scoped {@link Logger}. Mirrors the core's own
 * `log(scope)` so plugins and core log identically; a plugin names its
 * subsystem and gets back a logger that emits under that scope.
 */
export type LogAccess = (scope: string) => Logger;

/** Core capabilities a plugin may use. */
export interface PluginHost {
  readonly events: EventSink;
  readonly http: HttpRoutes;
  readonly tools: Tools;
  readonly executors: Executors;
  /** Obtain a scoped, level-filtered logger. */
  readonly log: LogAccess;
}

/** A plugin. {@link init} registers routes/hooks/etc. on the host. */
export interface Plugin {
  readonly name: string;
  init(host: PluginHost): Promise<void> | void;
}
