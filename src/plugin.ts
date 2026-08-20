/**
 * Plugin contract. Plugins are how capabilities (event providers, webhooks,
 * …) are added to boop without touching the main loop. A plugin depends
 * only on the types in this file, so any plugin can be moved to its own
 * package and depend on just this contract.
 *
 * A plugin receives a {@link PluginHost} at init time, which exposes the
 * core capabilities it may use — currently the ability to register HTTP
 * routes, to enqueue events, and to register tools. The core wires
 * concrete implementations of these interfaces; the plugin never sees them.
 */

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
 * MCP server bridge) without translation, and the LLM-facing description is
 * exactly what a client would see.
 */
export interface Tools {
  register(definition: ToolDefinition, handler: ToolHandler): void;
}

/** Core capabilities a plugin may use. */
export interface PluginHost {
  readonly events: EventSink;
  readonly http: HttpRoutes;
  readonly tools: Tools;
}

/** A plugin. {@link init} registers routes/hooks/etc. on the host. */
export interface Plugin {
  readonly name: string;
  init(host: PluginHost): Promise<void> | void;
}
