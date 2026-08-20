/**
 * Plugin contract. Plugins are how capabilities (event providers, webhooks,
 * …) are added to boop without touching the main loop. A plugin depends
 * only on the types in this file, so any plugin can be moved to its own
 * package and depend on just this contract.
 *
 * A plugin receives a {@link PluginHost} at init time, which exposes the
 * core capabilities it may use — currently the ability to register HTTP
 * routes and to enqueue events. The core wires concrete implementations of
 * these interfaces; the plugin never sees them.
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

/** Core capabilities a plugin may use. */
export interface PluginHost {
  readonly events: EventSink;
  readonly http: HttpRoutes;
}

/** A plugin. {@link init} registers routes/hooks/etc. on the host. */
export interface Plugin {
  readonly name: string;
  init(host: PluginHost): Promise<void> | void;
}
