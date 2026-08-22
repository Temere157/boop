import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { HttpResponse, Plugin, ResponseChannel } from "@boop/plugin";

/** Absolute path to this plugin's webui source directory (`…/webui/src/`). */
const SRC_DIR = fileURLToPath(new URL("./src/", import.meta.url));

/** Heartbeat interval: how often to ping each connection to probe liveness. */
const HEARTBEAT_MS = 15_000;

/** Content-Type per served extension; unknown falls back to octet-stream. */
const CONTENT_TYPE: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};

/** Content-Type for `.ts` served as JavaScript after type stripping. */
const TS_CONTENT_TYPE = "text/javascript; charset=utf-8";

/** An HTTP redirect (302) to `location`. */
const redirect = (location: string): HttpResponse => ({
  status: 302,
  headers: { location },
});

/**
 * Serves one file from the webui's `src/` directory. `.ts` files have their
 * type annotations stripped (`node:module#stripTypeScriptTypes`) and are
 * served as `text/javascript`, so the browser loads them as modules with no
 * build step; everything else is served verbatim with its extension's
 * Content-Type.
 */
async function serveFile(
  filePath: string,
  name: string,
): Promise<HttpResponse> {
  const ext = extname(name);
  const body = await readFile(filePath, "utf8");
  if (ext === ".ts") {
    return {
      status: 200,
      headers: { "content-type": TS_CONTENT_TYPE },
      body: stripTypeScriptTypes(body),
    };
  }
  return {
    status: 200,
    headers: {
      "content-type": CONTENT_TYPE[ext] ?? "application/octet-stream",
    },
    body,
  };
}

/**
 * A live response channel backing a single open WebSocket. It is registered
 * for the life of the connection and unregistered the moment the socket
 * closes (or the heartbeat's pong probe fails), so the agent's `respond`
 * tool lookup misses promptly after a client goes away — surfacing as a
 * semantic error rather than a silent drop (see the response registry).
 *
 * `send` writes the message as a single WebSocket text frame; a closed or
 * closing socket rejects so the `respond` tool reports the failure. The
 * channel id is carried in each enqueued event's payload, so the session
 * handling it knows which channel to reply on.
 */
class WebuiChannel implements ResponseChannel {
  readonly id: string;
  readonly description: string;
  private readonly ws: WebSocket;

  constructor(id: string, ws: WebSocket) {
    this.id = id;
    this.ws = ws;
    this.description =
      "live webui WebSocket (stays open while the client is connected; " +
      "closes when the socket drops)";
  }

  async send(message: string): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("webui socket is not open");
    }
    this.ws.send(message);
  }
}

/**
 * A builtin webui plugin. It serves a small single-page webui from its
 * `src/` directory under `/ui/`, and upgrades `/ws` to a live WebSocket
 * that is both an event provider (client connect + submitted messages are
 * enqueued) and a response channel (the agent's `respond` tool writes
 * back through the same socket). Each connection owns one
 * {@link WebuiChannel}, registered for the life of the connection; a
 * heartbeat (ping/pong) unregisters the channel promptly when a client
 * vanishes without a clean close.
 *
 * The plugin depends only on the {@link Plugin} contract (plus the `ws`
 * server library), not on any core implementation, so it could be moved to
 * an external package as-is.
 *
 *   GET  /ui/<file>   ->  serves a file from src/ (`.ts` type-stripped)
 *   GET  /ui/         ->  serves index.html (the SPA entry)
 *   GET  /            ->  302 to /ui/
 *   WS   /ws          ->  per-connection event provider + response channel
 *
 * Events enqueued per connection, each carrying `responseChannel: <id>`:
 *   { source: "webui", payload: { type: "connect", responseChannel } }
 *   { source: "webui", payload: { type: "message", text, responseChannel } }
 */
export const webuiPlugin: Plugin = {
  name: "webui",
  async init(host) {
    const log = host.log("webui");
    // Static SPA routes: one per top-level file in src/, plus the bare
    // `/ui/` entry and a root redirect. Done before returning so the
    // routes are registered before the core server starts listening.
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

    // Live WebSocket endpoint. `noServer` lets us hook the core's
    // `upgrade` event and hand the raw socket to `ws` for the handshake.
    const wss = new WebSocketServer({ noServer: true });
    host.http.upgrade("/ws", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        onConnection(ws);
      });
    });
    log.info("websocket at /ws");

    function onConnection(ws: WebSocket): void {
      const id = randomUUID();
      const channel = new WebuiChannel(id, ws);
      host.responses.register(channel);
      host.events.enqueue("webui", { type: "connect", responseChannel: id });
      log.debug("connect", { id });

      ws.on("message", (data: RawData) => {
        const buf = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
        const text = buf.toString("utf8");
        host.events.enqueue("webui", {
          type: "message",
          text,
          responseChannel: id,
        });
        log.debug("message", { id, len: text.length });
      });

      // Heartbeat: ping every HEARTBEAT_MS and mark alive on pong. If a
      // pong does not arrive before the next interval the socket is
      // terminated — which fires `close` and unregisters the channel — so a
      // half-open connection (client vanished without a clean close) is
      // dropped within ~2x HEARTBEAT_MS rather than lingering in the
      // registry as a dead reply path.
      let alive = true;
      ws.on("pong", () => {
        alive = true;
      });
      const ping = setInterval(() => {
        if (!alive) {
          log.debug("heartbeat timeout, terminating", { id });
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, HEARTBEAT_MS);

      const cleanup = (): void => {
        clearInterval(ping);
        host.responses.unregister(id);
        log.debug("disconnect", { id });
      };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
    }
  },
};
