import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type {
  HttpResponse,
  Plugin,
  ResponseChannel,
  SessionStatus,
} from "@boop/plugin";

/** Absolute path to this plugin's webui source directory (`…/webui/src/`). */
const SRC_DIR = fileURLToPath(new URL("./src/", import.meta.url));

/** Heartbeat interval: how often to ping each connection to probe liveness. */
const HEARTBEAT_MS = 15_000;

/** Content-Type for text extensions served verbatim; unknown text extensions fall back to the caller. */
const TEXT_CONTENT_TYPE: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

/** Content-Type for binary extensions served verbatim; unknown falls back to octet-stream. */
const BINARY_CONTENT_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

/** Content-Type for `.ts` served as JavaScript after type stripping. */
const TS_CONTENT_TYPE = "text/javascript; charset=utf-8";

/**
 * A server-to-client WebSocket frame.
 * `reply` carries an agent message rendered as a bubble; `status` carries a global busy/idle transition (plus the event source on `busy`) so every client — not just the one that triggered the work — shows a working indicator.
 * Both sides live in this repo, so the shape is changed atomically.
 */
type ServerFrame =
  | { readonly type: "reply"; readonly text: string }
  | { readonly type: "status"; readonly status: SessionStatus; readonly source: string | null };

/** An HTTP redirect (302) to `location`. */
const redirect = (location: string): HttpResponse => ({
  status: 302,
  headers: { location },
});

/**
 * Serves one file from the webui's `src/` directory.
 * `.ts` files have their type annotations stripped (`node:module#stripTypeScriptTypes`) and are served as `text/javascript`, so the browser loads them as modules with no build step; everything else is served verbatim with its extension's Content-Type.
 */
async function serveFile(
  filePath: string,
  name: string,
): Promise<HttpResponse> {
  const ext = extname(name);
  if (ext === ".ts") {
    const body = stripTypeScriptTypes(await readFile(filePath, "utf8"));
    return {
      status: 200,
      headers: { "content-type": TS_CONTENT_TYPE },
      body,
    };
  }
  const textType = TEXT_CONTENT_TYPE[ext];
  if (textType !== undefined) {
    const body = await readFile(filePath, "utf8");
    return { status: 200, headers: { "content-type": textType }, body };
  }
  // Binary assets (icons, etc.) are read as a Buffer so the bytes are not corrupted by UTF-8 decoding.
  const body = await readFile(filePath);
  return {
    status: 200,
    headers: {
      "content-type": BINARY_CONTENT_TYPE[ext] ?? "application/octet-stream",
    },
    body,
  };
}

/**
 * A live response channel backing a single open WebSocket.
 * It is registered for the life of the connection and unregistered the moment the socket closes (or the heartbeat's pong probe fails), so the agent's `respond` tool lookup misses promptly after a client goes away — surfacing as a semantic error rather than a silent drop (see the response registry).
 *
 * `send` writes the message as a single WebSocket text frame; a closed or closing socket rejects so the `respond` tool reports the failure.
 * The channel id is carried in each enqueued event's payload, so the session handling it knows which channel to reply on.
 */
class WebuiChannel implements ResponseChannel {
  readonly id: string;
  readonly description: string;
  private readonly ws: WebSocket;

  constructor(id: string, ws: WebSocket) {
    this.id = id;
    this.ws = ws;
    this.description =
      "live webui WebSocket (stays open while the client is connected; closes when the socket drops)";
  }

  async send(message: string): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("webui socket is not open");
    }
    // Wrap the agent's reply in a `reply` frame so the client can distinguish it from `status` control frames on the same socket.
    this.ws.send(JSON.stringify({ type: "reply", text: message } satisfies ServerFrame));
  }
}

/**
 * A builtin webui plugin.
 * It serves a small single-page webui from its `src/` directory under `/ui/`, and upgrades `/ws` to a live WebSocket that is both an event provider (client connect + submitted messages are enqueued) and a response channel (the agent's `respond` tool writes back through the same socket).
 * Each connection owns one {@link WebuiChannel} keyed by the client's per-tab instance id, registered for the life of the connection; a heartbeat (ping/pong) unregisters the channel promptly when a client vanishes without a clean close, and a reconnect re-registers under the same id so the agent's reply path survives a blip.
 * The plugin also subscribes to the core's global busy/idle status bus and broadcasts every transition to all connected clients as a `status` frame, so each tab shows a working indicator whenever any event is being handled — not just the ones it triggered.
 *
 * The plugin depends only on the {@link Plugin} contract (plus the `ws` server library), not on any core implementation, so it could be moved to an external package as-is.
 *
 *   GET  /ui/<file>   ->  serves a file from src/ (`.ts` type-stripped)
 *   GET  /ui/         ->  serves index.html (the SPA entry)
 *   GET  /            ->  302 to /ui/
 *   WS   /ws          ->  per-connection event provider + response channel
 *
 * Events enqueued, each carrying `responseChannel` (the reply path, keyed by the per-tab instance id), `clientId` (the persistent parent — one per browser, shared across tabs), and `instanceId` (the per-tab sub-id, new per tab):
 *   { source: "webui", payload: { type: "connect", responseChannel, clientId, instanceId } }   — only on a new tab (a fresh, unseen instance id), not on a reconnect
 *   { source: "webui", payload: { type: "message", text, responseChannel, clientId, instanceId } }
 *
 * Frames sent to every connected client, so each tab reflects the agent's global state rather than only its own conversation:
 *   { type: "reply", text }                 — an agent reply (via the `respond` tool)
 *   { type: "status", status, source }       — a busy/idle transition from the core status bus (source is the event source on `busy`, `null` on `idle`)
 */
export const webuiPlugin: Plugin = {
  name: "webui",
  async init(host) {
    const log = host.log("webui");
    // Static SPA routes: one per top-level file in src/, plus the bare `/ui/` entry and a root redirect.
    // Done before returning so the routes are registered before the core server starts listening.
    const entries = await readdir(SRC_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      const filePath = join(SRC_DIR, name);
      host.http.route("GET", `/ui/${name}`, () => serveFile(filePath, name));
      log.debug("route", `GET /ui/${name}`);
    }
    host.http.route("GET", "/ui/", () =>
      serveFile(join(SRC_DIR, "index.html"), "index.html"),
    );
    host.http.route("GET", "/", () => redirect("/ui/"));
    log.info("serving webui at /ui/");

    // Live WebSocket endpoint.
    // `noServer` lets us hook the core's `upgrade` event and hand the raw socket to `ws` for the handshake.
    const wss = new WebSocketServer({ noServer: true });
    host.http.upgrade("/ws", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        onConnection(ws);
      });
    });
    log.info("websocket at /ws");

    // Instance ids the server has already enqueued a `connect` for this process lifetime.
    // A reconnect reuses the same instance id; the client's `fresh` flag tells us whether this is a new tab (fresh) or a reconnect (not fresh), and this set guards against a refresh within the same server lifetime re-enqueuing for an id we have already seen.
    const seenInstances = new Set<string>();

    // Every connected (post-hello) socket, so a status transition can be fanned out to all of them at once.
    const clients = new Set<WebSocket>();
    // The status most recently seen from the core bus, replayed to a freshly connected tab so a late joiner is correct without waiting for the next transition.
    let currentStatus: { status: SessionStatus; source: string | null } = {
      status: "idle",
      source: null,
    };

    /** Send `frame` to every open socket; a not-yet-open or already-closing socket is skipped. */
    function broadcast(frame: ServerFrame): void {
      const data = JSON.stringify(frame);
      for (const c of clients) {
        if (c.readyState === WebSocket.OPEN) c.send(data);
      }
    }

    // Subscribe to the core's global busy/idle bus: every transition is remembered and broadcast to all clients, so each tab shows a working indicator whenever any event is being handled — not just the ones it triggered.
    // The immediate replay from the bus sets `currentStatus` to the actual current state (in case an event was already being handled when the plugin initialized).
    host.status.subscribe((status, source) => {
      currentStatus = { status, source };
      broadcast({ type: "status", status, source });
    });

    function onConnection(ws: WebSocket): void {
      // Unknown until the hello frame arrives: the channel is not registered and no event is enqueued until we know which client instance this socket belongs to.
      let instanceId: string | null = null;
      let clientId = "unknown";
      let channel: WebuiChannel | null = null;

      ws.on("message", (data: RawData) => {
        const buf = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
        const text = buf.toString("utf8");

        // The first frame is the hello: { type: "hello", clientId, instanceId, fresh }.
        // Until it arrives we do not know which client instance this is, so ignore anything else; after it arrives, every frame is a user message (plain text).
        if (instanceId === null) {
          let hello: unknown;
          try {
            hello = JSON.parse(text);
          } catch {
            return;
          }
          if (typeof hello !== "object" || hello === null) return;
          const h = hello as {
            type?: string;
            clientId?: string;
            instanceId?: string;
            fresh?: boolean;
          };
          if (h.type !== "hello") return;
          instanceId =
            typeof h.instanceId === "string" ? h.instanceId : randomUUID();
          clientId = typeof h.clientId === "string" ? h.clientId : "unknown";
          const fresh = h.fresh === true;

          // Reuse the instance id as the response channel id so a reconnect re-registers under the same id and the agent's in-flight `respond` calls keep targeting the stable instance.
          // `unregister` is idempotent: it clears any stale channel left by a socket whose `close` has not fired yet, then registers the fresh one.
          host.responses.unregister(instanceId);
          channel = new WebuiChannel(instanceId, ws);
          host.responses.register(channel);
          // Now that we know which client this is, admit it to the broadcast set and replay the current status so a tab opened mid-processing shows the indicator right away.
          clients.add(ws);
          ws.send(
            JSON.stringify({
              type: "status",
              status: currentStatus.status,
              source: currentStatus.source,
            } satisfies ServerFrame),
          );

          // Enqueue a `connect` only for a genuinely new tab: `fresh` (the client's "first open of this page load") and an instance id we have not already connected this process lifetime.
          // A reconnect — network blip or server restart — sends `fresh:false`, so no new event; a refresh within the same lifetime is suppressed by the seen set.
          if (fresh && !seenInstances.has(instanceId)) {
            seenInstances.add(instanceId);
            host.events.enqueue("webui", {
              type: "connect",
              responseChannel: instanceId,
              clientId,
              instanceId,
            });
            log.debug("connect", { id: instanceId, clientId, fresh });
          } else {
            log.debug("reconnect", { id: instanceId, clientId, fresh });
          }
          return;
        }

        host.events.enqueue("webui", {
          type: "message",
          text,
          responseChannel: instanceId,
          clientId,
          instanceId,
        });
        log.debug("message", { id: instanceId, len: text.length });
      });

      // Heartbeat: ping every HEARTBEAT_MS and mark alive on pong.
      // If a pong does not arrive before the next interval the socket is terminated — which fires `close` and unregisters the channel — so a half-open connection (client vanished without a clean close) is dropped within ~2x HEARTBEAT_MS rather than lingering in the registry as a dead reply path.
      let alive = true;
      ws.on("pong", () => {
        alive = true;
      });
      const ping = setInterval(() => {
        if (!alive) {
          log.debug("heartbeat timeout, terminating", { id: instanceId });
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, HEARTBEAT_MS);

      const cleanup = (): void => {
        clearInterval(ping);
        clients.delete(ws);
        if (channel !== null) host.responses.unregister(channel.id);
        log.debug("disconnect", { id: instanceId });
      };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
    }
  },
};
