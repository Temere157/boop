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

import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Event } from "./event.js";

/**
 * Accepts an event into the queue. Hides {@link Event} construction (id,
 * timestamp) so plugins only name their source and carry a payload.
 */
export interface EventSink {
  enqueue(source: string, payload: unknown): void;
}

/**
 * A way to send a message back to the originator of an event — the mirror
 * of {@link EventSink}: where `enqueue` is "event in", a channel is "reply
 * out". Channels are independent of events: an HTTP ingest channel is
 * transient (it lives only while a single request is held open), but an
 * SMS channel could be eternal and a webui channel independently
 * transient. Whatever owns the channel registers it when it can deliver
 * and unregisters it when it can't; the core's `respond` tool looks up a
 * channel by id at call time, so a channel that closed mid-session
 * surfaces as a semantic error rather than a silent drop.
 */
export interface ResponseChannel {
  /** Stable id, surfaced to the agent via the session message. */
  readonly id: string;
  /**
   * Human-readable note for the agent, e.g. "HTTP reply to POST /ingest,
   * one-shot, ≤20s" or "SMS to +64…". The agent uses this to pick which
   * channel to send on.
   */
  readonly description?: string;
  /**
   * Deliver a message. Rejects if the channel is no longer accepting
   * replies (provider already responded / timed out / connection closed).
   * The `respond` tool surfaces that rejection as an `isError` result.
   */
  send(message: string): Promise<void>;
}

/**
 * Capability to register and unregister response channels. This is the
 * plugin boundary for replies: a provider that can deliver messages back
 * to a user (HTTP ingest, SMS, a live webui, …) registers a channel here
 * for as long as it is willing to deliver, and unregisters it when it
 * stops. The core owns the one `respond` tool that sends on whatever id
 * the agent picks — channels are the plugin part, the tool is core.
 */
export interface ResponseChannels {
  register(channel: ResponseChannel): void;
  unregister(id: string): void;
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

/**
 * Handles a single matched HTTP `upgrade` request (e.g. a WebSocket
 * handshake). Unlike {@link RouteHandler}, the handler receives the *raw*
 * `IncomingMessage`, socket, and the leading bytes already read, because an
 * upgrade handler owns the protocol negotiated on that socket (e.g. `ws`'s
 * `handleUpgrade`) and needs the live request stream rather than a buffered
 * body. The server destroys unmatched upgrade sockets.
 */
export type UpgradeHandler = (
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
) => void;

/**
 * Capability to register HTTP routes on the shared core server. Both
 * request/response routes ({@link route}) and `upgrade` routes
 * ({@link upgrade}, for WebSocket handshakes) are path-matched exactly.
 */
export interface HttpRoutes {
  route(method: string, path: string, handler: RouteHandler): void;
  /**
   * Register a handler for `upgrade` requests at `path` (WebSockets, etc.).
   * At most one handler per path; a later registration overwrites an earlier
   * one (so a plugin can re-register on reload, though there is no reload
   * path today).
   */
  upgrade(path: string, handler: UpgradeHandler): void;
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
 * An input message seeding a session's conversation: one of the user or
 * assistant turns that the agent runtime starts from. Distinct from
 * {@link TranscriptEntry} (the output record), which carries tool-call and
 * result fields the input never has.
 *
 * There is no `system` role here: the system prompt is kept separate on
 * {@link PreparedSession} so executors that take it as a distinct argument
 * (e.g. claude's `--system-prompt`) can pass it through unchanged. A
 * session may carry multiple user messages (e.g. the event plus
 * memory-injected context); executors that accept only a single prompt
 * merge them, while turn-based executors pass them through as turns.
 * The shape is otherwise permissive (an index signature lets a
 * provider-specific executor carry extra fields without changing this
 * contract).
 */
export type SessionMessageRole = "user" | "assistant";

export interface SessionMessage {
  readonly role: SessionMessageRole;
  readonly content: string;
  readonly [key: string]: unknown;
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
 * Runs a prepared session's agentic loop and returns its transcript. This
 * is the low-level executor: it owns the LLM ↔ tool-call cycle and is the
 * piece that is swapped to change provider/runtime (a real LLM, an MCP
 * client bridge, a scripted stand-in, …). Executors register under a
 * stable id; the core runs the one it selects per event.
 */
export type SessionExecutor = (
  session: PreparedSession,
) => Promise<SessionTranscript>;

/**
 * A hook a plugin may register to adjust a prepared session before the
 * low-level executor runs. The preparer receives the {@link PreparedSession}
 * and mutates it in place — typically by adding, editing, or reordering
 * entries in {@link PreparedSession.messages} (e.g. injecting context
 * loaded from memory). There is no ordering guarantee among preparers and
 * no return value; a preparer that needs to do async work (such as a memory
 * fetch) may return a promise the core awaits.
 */
export type SessionPreparer = (
  session: PreparedSession,
) => void | Promise<void>;

/**
 * Capability to register a session preparer. Preparers run after the core
 * has seeded the system prompt and the first user message and before the
 * executor runs; registration order is not significant (no priority), and
 * a duplicate function may be registered again.
 */
export interface SessionPreparers {
  register(preparer: SessionPreparer): void;
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
 * The system prompt is kept as a separate string (rather than a
 * `system`-role message in {@link messages}) so executors that take it as
 * a distinct argument — e.g. claude's `--system-prompt` — can pass it
 * through unchanged. {@link messages} is the ordered user/assistant turns;
 * it is mutable because registered {@link SessionPreparer}s adjust it in
 * place between seeding and the executor running.
 *
 * {@link mcp} is an opt-in path for executors whose runtime speaks MCP: it
 * hands out a fresh unix socket serving {@link tools} over the MCP stdio
 * protocol. An executor that calls tools directly can ignore it.
 */
export interface PreparedSession {
  readonly event: Event;
  readonly systemPrompt: string;
  /**
   * The ordered user/assistant turns seeding the session. Seeded with a
   * single user message carrying the event; registered preparers may add,
   * edit, or reorder entries (e.g. injected memory context) before the
   * executor runs. Mutable on purpose — preparers mutate it in place.
   */
  messages: SessionMessage[];
  readonly tools: ToolInvocation;
  readonly mcp: McpServer;
}

/**
 * Capability to register a low-level session executor under a stable id.
 * Several executors may be registered (a duplicate id is rejected); the
 * core selects which one runs each prepared session, so plugins register
 * by id rather than claim "the" executor.
 */
export interface Executors {
  register(id: string, executor: SessionExecutor): void;
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

/**
 * Per-plugin filesystem paths. Each plugin gets its own subtrees under the
 * XDG state (and, later, config) dirs, scoped by plugin name, so a plugin
 * can read and write files there without colliding with another plugin.
 * The core creates the state directory before `init` runs; a plugin reads
 * and writes files in it without any mkdir. This is the plugin-side surface
 * of the memory store: anything a plugin must keep between sessions lives
 * in {@link PluginPaths.stateDir}.
 */
export interface PluginPaths {
  /**
   * Absolute path to this plugin's persistent state directory
   * (`{boopStateDir}/plugins/{name}/`), already created. Use for data the
   * plugin must keep between sessions (memory, caches, …).
   */
  readonly stateDir: string;
}

/** Core capabilities a plugin may use. */
export interface PluginHost {
  readonly events: EventSink;
  readonly http: HttpRoutes;
  readonly tools: Tools;
  readonly executors: Executors;
  /** Register/unregister response channels (the reply-side plugin boundary). */
  readonly responses: ResponseChannels;
  /** Register a session preparer to adjust a prepared session's messages before the executor runs. */
  readonly prepare: SessionPreparers;
  /** Obtain a scoped, level-filtered logger. */
  readonly log: LogAccess;
  /** This plugin's filesystem paths (state directory created before init runs). */
  readonly paths: PluginPaths;
}

/** A plugin. {@link init} registers routes/hooks/etc. on the host. */
export interface Plugin {
  readonly name: string;
  init(host: PluginHost): Promise<void> | void;
}
