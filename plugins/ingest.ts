import { randomUUID } from "node:crypto";
import type { Plugin, ResponseChannel } from "@boop/plugin";

/** Resolves after `ms`, for the ingest reply timeout. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A one-shot response channel backing a single POST /ingest request. The
 * route holds the HTTP connection open for up to 20s waiting for the
 * agent to call `respond`; the first `send` becomes the HTTP body, after
 * which the channel is done and any further `send` rejects. If the
 * timeout fires first the route responds 202 and the channel rejects all
 * sends — so a late `respond` surfaces as an error rather than a silent
 * drop.
 *
 * The `reply` promise and `timeout` method are provider-internal (not on
 * the {@link ResponseChannel} interface); the route holds the concrete
 * instance to drive them, while the registry and the `respond` tool see
 * only the interface.
 */
class HttpIngestChannel implements ResponseChannel {
  readonly id: string;
  readonly description: string;
  private done = false;
  private resolve!: (msg: string | undefined) => void;
  /** Resolves with the first sent message, or `undefined` on timeout. */
  readonly reply: Promise<string | undefined>;

  constructor(id: string) {
    this.id = id;
    this.description =
      "HTTP reply to POST /ingest (one-shot, closes after the first message or 20s)";
    this.reply = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  async send(message: string): Promise<void> {
    if (this.done) {
      throw new Error("channel already used or closed");
    }
    this.done = true;
    this.resolve(message);
  }

  /** Signal that no reply is coming (timeout). Idempotent. */
  timeout(): void {
    if (this.done) return;
    this.done = true;
    this.resolve(undefined);
  }
}

/**
 * A builtin HTTP ingest plugin. It registers a single HTTP endpoint that
 * accepts any request body as a UTF-8 string, enqueues it as an event,
 * and — unlike a fire-and-forget ingest — holds the HTTP response open
 * for up to 20s so the agent can reply on the way out.
 *
 * The plugin depends only on the {@link Plugin} contract, not on any core
 * implementation, so it could be moved to an external package as-is.
 *
 *   POST /ingest  ->  enqueues { source: "http-ingest", payload: { text, responseChannel } }
 *                    and registers a one-shot {@link ResponseChannel} whose
 *                    id is carried in the payload. The first `respond` on
 *                    that id becomes the 200 body; if none arrives within
 *                    20s the route responds 202.
 *
 * The channel is registered before the event is enqueued, so it is in the
 * registry by the time the session is prepared and listed in the session
 * message. It is unregistered in `finally` once the route responds,
 * regardless of outcome — after that the core `respond` tool's lookup
 * misses and returns an error.
 */
export const httpIngestPlugin: Plugin = {
  name: "http-ingest",
  init(host) {
    host.http.route("POST", "/ingest", async (req) => {
      const text = req.body.toString("utf8");
      const id = randomUUID();
      const channel = new HttpIngestChannel(id);
      host.responses.register(channel);
      host.events.enqueue("http-ingest", { text, responseChannel: id });
      try {
        const reply = await Promise.race<string | undefined>([
          channel.reply,
          sleep(20_000).then(() => undefined),
        ]);
        if (reply === undefined) {
          channel.timeout();
          return { status: 202, body: "queued (no reply within 20s)" };
        }
        return { status: 200, body: reply };
      } finally {
        host.responses.unregister(id);
      }
    });
  },
};
