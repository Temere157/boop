import { randomUUID } from "node:crypto";
import { open, readFile, readdir, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";
import type { PushSubscription } from "web-push";
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

/** The push service's contact address for this VAPID identity, per the VAPID spec (a `mailto:` or `https:` URI), used when the user has not set `vapidSubject` in the plugin's config. */
const DEFAULT_VAPID_SUBJECT = "mailto:boop@localhost";

/** The config file the webui plugin reads its own options from (a sibling of the plugin state dir). */
const CONFIG_FILE = "config.json";

/** Hard cap on a push payload, since push services reject bodies over ~4KB; a longer reply is truncated so the notification still delivers. */
const PUSH_PAYLOAD_MAX = 4000;

/**
 * Loads the plugin's `vapidSubject` from its own config file (`{configDir}/config.json`), falling back to {@link DEFAULT_VAPID_SUBJECT} when the file is missing, malformed, or omits the key.
 * A missing file is the default, not an error, so the plugin works with no user config; the config file is read by this plugin, written by the user.
 */
async function loadVapidSubject(configDir: string): Promise<string> {
  try {
    const raw = await readFile(join(configDir, CONFIG_FILE), "utf8");
    const parsed = JSON.parse(raw) as { vapidSubject?: unknown };
    if (parsed !== null && typeof parsed.vapidSubject === "string" && parsed.vapidSubject.length > 0) {
      return parsed.vapidSubject;
    }
  } catch {
    // Missing or malformed config file: fall back to the default.
  }
  return DEFAULT_VAPID_SUBJECT;
}

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
 * Manages the push-subscription file: a JSON array of `{ clientId, subscription }` entries, one per browser.
 * Loaded at startup (each entry registering a {@link PushChannel}), mutated live as clients subscribe/unsubscribe, and rewritten on every mutation so a crash loses at most the in-flight change.
 * The store keys on `clientId` — the per-browser id the client persists in `localStorage` — so a browser that reconnects reuses its stored subscription rather than duplicating.
 */
class PushSubscriptionStore {
  private readonly subs = new Map<string, PushSubscription>();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Loads the file; a missing or malformed file is treated as empty so a corrupt state never blocks startup. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as { subscriptions?: unknown };
      if (parsed !== null && Array.isArray(parsed.subscriptions)) {
        for (const entry of parsed.subscriptions) {
          if (typeof entry !== "object" || entry === null) continue;
          const e = entry as { clientId?: unknown; subscription?: unknown };
          if (typeof e.clientId !== "string" || e.clientId === "") continue;
          const sub = sanitizePushSubscription(e.subscription);
          if (sub === undefined) continue;
          this.subs.set(e.clientId, sub);
        }
      }
    } catch {
      // Missing or malformed file: start empty.
    }
  }

  /** Snapshot of `(clientId, subscription)` pairs, for startup registration. */
  entries(): readonly { clientId: string; subscription: PushSubscription }[] {
    return [...this.subs.entries()].map(([clientId, subscription]) => ({
      clientId,
      subscription,
    }));
  }

  /** Number of stored subscriptions, for the startup log line. */
  get size(): number {
    return this.subs.size;
  }

  /** Insert or replace the subscription for `clientId`, persisting immediately. */
  upsert(clientId: string, subscription: PushSubscription): void {
    this.subs.set(clientId, subscription);
    void this.save();
  }

  /** Remove the subscription for `clientId` (idempotent), persisting immediately. */
  remove(clientId: string): void {
    this.subs.delete(clientId);
    void this.save();
  }

  /** Rewrites the state file from the current map. */
  private async save(): Promise<void> {
    const file = {
      subscriptions: [...this.subs.entries()].map(([clientId, subscription]) => ({
        clientId,
        subscription,
      })),
    };
    await writeFile(this.path, JSON.stringify(file, null, 2), "utf8");
  }
}

/**
 * Validates a client-supplied push subscription: an object with a string `endpoint` and `keys.p256dh`/`keys.auth` strings.
 * Returns the subscription or `undefined` when it is malformed, so a bad frame never reaches the push library.
 */
function sanitizePushSubscription(raw: unknown): PushSubscription | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as { endpoint?: unknown; keys?: unknown };
  if (typeof r.endpoint !== "string" || r.endpoint === "") return undefined;
  if (typeof r.keys !== "object" || r.keys === null) return undefined;
  const k = r.keys as { p256dh?: unknown; auth?: unknown };
  if (typeof k.p256dh !== "string" || typeof k.auth !== "string") return undefined;
  return { endpoint: r.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}

/**
 * Reads a `statusCode` off a rejected `sendNotification` error (a `WebPushError` carries one), or returns 0 when the error has no code.
 * Used to detect the push service's "gone" responses (404/410) so a dead subscription is pruned rather than retried forever.
 */
function pushStatusCode(err: unknown): number {
  if (typeof err === "object" && err !== null && "statusCode" in err) {
    const code = (err as { statusCode?: unknown }).statusCode;
    return typeof code === "number" ? code : 0;
  }
  return 0;
}

/**
 * A live response channel that delivers a message as a browser system notification via web push.
 * Unlike {@link WebuiChannel} (which writes through a live WebSocket), a push channel delivers even with no tab open: the push service wakes the browser's service worker, which calls `showNotification`.
 * It is registered for the life of a stored subscription (effectively eternal for the process once subscribed), and unregistered when the client unsubscribes or the push service reports the subscription gone (404/410).
 * `send` encrypts the payload with the subscription's keys and POSTs it to the push endpoint via `web-push`; a non-200 response rejects (surfacing to the `respond` tool as `isError`) and a 404/410 prunes the dead subscription before rejecting.
 */
class PushChannel implements ResponseChannel {
  readonly id: string;
  readonly description: string;
  private readonly subscription: PushSubscription;
  private readonly onDead: () => void;

  constructor(id: string, subscription: PushSubscription, onDead: () => void) {
    this.id = id;
    this.subscription = subscription;
    this.onDead = onDead;
    this.description =
      "An interruptive system notification to the user's browser via web push, delivered even with no tab open while the browser is online. " +
      "Use only when the user must be interrupted right now — a high-priority, time-sensitive event that cannot wait. " +
      "Do not send routine or informational messages here. " +
      "For anything lower priority, do not push it: remember it in memory and relay it via a webui channel once the user is online, instead of interrupting.";
  }

  async send(message: string): Promise<void> {
    const payload =
      message.length > PUSH_PAYLOAD_MAX
        ? message.slice(0, PUSH_PAYLOAD_MAX - 1) + "\u2026"
        : message;
    try {
      await webpush.sendNotification(this.subscription, payload);
    } catch (err) {
      const code = pushStatusCode(err);
      if (code === 404 || code === 410) this.onDead();
      throw err;
    }
  }
}

/** A prior turn in a tab's conversation, normalized to model-conventional roles for the session. */
type HistoryTurn = { readonly role: "user" | "assistant"; readonly text: string };

/** Hard cap on turns accepted from a client, defense in depth against a misbehaving or adversarial client. */
const HISTORY_MAX_TURNS = 40;
/** Hard cap on total history text bytes accepted from a client, so a large history can't bloat the event unbounded. */
const HISTORY_MAX_BYTES = 32_768;

/** Hard cap on a client-supplied `tz` label length, defense in depth against a misbehaving or adversarial client. */
const TZ_MAX_LEN = 64;

/** The interpretation note included in the payload alongside `history`, so the model knows how to read it. */
const HISTORY_NOTE = [
  "`history` is the prior conversation in this tab, oldest first.",
  "Each entry is `{role, text}`: `role:'user'` is what the human typed, `role:'assistant'` is what you previously sent back via the `respond` tool.",
  "Your intermediate tool calls and reasoning from those earlier events are not included — only the user-visible thread.",
  "The new message to act on is `text`.",
  "Use `history` for context on what was already discussed; do not re-ask things it already answers.",
].join(" ");

/**
 * Parses a client message frame.
 * The client sends `{ type: "message", text, history }`; a frame that is not valid JSON or is missing the `text` string is treated as plain text (the message is the raw frame), so an old or odd client still works.
 * Returns the message text and a sanitized history (or `undefined` when there is no usable history, so the caller omits the field and a first message looks unchanged).
 */
function parseClientMessage(raw: string): {
  text: string;
  history: HistoryTurn[] | undefined;
  tz: string | undefined;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: raw, history: undefined, tz: undefined };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { text: raw, history: undefined, tz: undefined };
  }
  const f = parsed as { type?: unknown; text?: unknown; history?: unknown; tz?: unknown };
  if (f.type !== "message" || typeof f.text !== "string") {
    return { text: raw, history: undefined, tz: undefined };
  }
  return { text: f.text, history: sanitizeHistory(f.history), tz: sanitizeTz(f.tz) };
}

/**
 * Normalizes and caps a client-supplied `history` array.
 * Each entry must be `{role:"user"|"assistant"|"agent", text:string}`; `agent` is mapped to `assistant` (the client's internal role name for a reply bubble).
 * Entries that don't match are dropped, and the result is capped to the last {@link HISTORY_MAX_TURNS} turns and {@link HISTORY_MAX_BYTES} total text bytes.
 * Returns `undefined` when nothing valid remains, so the caller omits the field and a first message looks unchanged.
 */
function sanitizeHistory(raw: unknown): HistoryTurn[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: HistoryTurn[] = [];
  let bytes = 0;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const role = (entry as { role?: unknown }).role;
    const text = (entry as { text?: unknown }).text;
    let normalized: "user" | "assistant";
    if (role === "user") {
      normalized = "user";
    } else if (role === "assistant" || role === "agent") {
      normalized = "assistant";
    } else {
      continue;
    }
    if (typeof text !== "string") continue;
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > HISTORY_MAX_BYTES) break;
    out.push({ role: normalized, text });
    if (out.length > HISTORY_MAX_TURNS) out.shift();
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Validates a client-supplied `tz` label.
 * A non-empty string within the length cap is passed through; anything else returns `undefined` so the caller omits the field and an old or odd client (one that does not send `tz`) still works unchanged.
 */
function sanitizeTz(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw.length === 0 || raw.length > TZ_MAX_LEN) return undefined;
  return raw;
}

/**
 * A builtin webui plugin.
 * It serves a small single-page webui from its `src/` directory under `/ui/`, and upgrades `/ws` to a live WebSocket that is both an event provider (client connect + submitted messages are enqueued) and a response channel (the agent's `respond` tool writes back through the same socket).
 * Each connection owns one {@link WebuiChannel} keyed by the client's per-tab instance id, registered for the life of the connection; a heartbeat (ping/pong) unregisters the channel promptly when a client vanishes without a clean close, and a reconnect re-registers under the same id so the agent's reply path survives a blip.
 * The plugin also subscribes to the core's global busy/idle status bus and broadcasts every transition to all connected clients as a `status` frame, so each tab shows a working indicator whenever any event is being handled — not just the ones it triggered.
 *
 * It additionally provides web push: a VAPID key pair generated (and persisted) on first launch, an HTTP route exposing the public key, and a persistent `push:<clientId>` {@link PushChannel} per subscribed browser (stored in the state dir and re-registered at startup), so the agent can reach the user with a browser system notification even when no tab is open.
 *
 * The plugin depends only on the {@link Plugin} contract (plus the `ws` server library and `web-push`), not on any core implementation, so it could be moved to an external package as-is.
 *
 *   GET  /push-key    ->  the application's VAPID public key, so the browser can subscribe to web push
 *   GET  /ui/<file>   ->  serves a file from src/ (`.ts` type-stripped)
 *   GET  /ui/         ->  serves index.html (the SPA entry)
 *   GET  /            ->  302 to /ui/
 *   WS   /ws          ->  per-connection event provider + response channel (and push-subscription control frames)
 *
 * Events enqueued, each carrying `responseChannel` (the reply path, keyed by the per-tab instance id), `clientId` (the persistent parent — one per browser, shared across tabs), and `instanceId` (the per-tab sub-id, new per tab):
 *   { source: "webui", payload: { type: "connect", responseChannel, clientId, instanceId, tz? } }   — only on a new tab (a fresh, unseen instance id), not on a reconnect
 *   { source: "webui", payload: { type: "message", text, history?, historyNote?, tz?, responseChannel, clientId, instanceId } }   — `history` (and `historyNote`) are present only when the tab had prior turns, so the transient session can see what was already discussed in this tab; `tz` (the user's current local timezone label) is present when the client sent one
 *
 * Frames sent to every connected client, so each tab reflects the agent's global state rather than only its own conversation:
 *   { type: "reply", text }                 — an agent reply (via the `respond` tool)
 *   { type: "status", status, source }       — a busy/idle transition from the core status bus (source is the event source on `busy`, `null` on `idle`)
 *
 * Frames received from a client after its hello, in addition to the `{ type: "message", … }` submission:
 *   { type: "notify_subscribe", subscription }     — register the browser's web-push subscription under its `clientId`, opening a `push:<clientId>` response channel
 *   { type: "notify_unsubscribe" }                 — drop the stored subscription and close the `push:<clientId>` channel
 *
 * In addition to the per-tab {@link WebuiChannel} (chat bubbles over the socket), the plugin registers a persistent `push:<clientId>` {@link PushChannel} per subscribed browser, delivering agent replies as browser system notifications even with no tab open.
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

    // Web push setup: generate (once) and persist the VAPID key pair, then register an HTTP route that hands the public key to the browser so it can subscribe.
    // A missing or malformed key file means a fresh pair is generated and written, so the identity is stable across restarts; the private key never leaves the state dir.
    // The VAPID subject (a `mailto:` or `https:` contact) is the user's to set, read from the plugin's own config file with a default fallback.
    const vapidPath = join(host.paths.stateDir, "vapid.json");
    const vapidSubject = await loadVapidSubject(host.paths.configDir);
    let vapid: { publicKey: string; privateKey: string };
    try {
      const raw = await readFile(vapidPath, "utf8");
      const parsed = JSON.parse(raw) as { publicKey?: unknown; privateKey?: unknown };
      if (typeof parsed.publicKey === "string" && typeof parsed.privateKey === "string") {
        vapid = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      } else {
        vapid = webpush.generateVAPIDKeys();
        await writeFile(vapidPath, JSON.stringify(vapid, null, 2), "utf8");
      }
    } catch {
      vapid = webpush.generateVAPIDKeys();
      await writeFile(vapidPath, JSON.stringify(vapid, null, 2), "utf8");
    }
    webpush.setVapidDetails(vapidSubject, vapid.publicKey, vapid.privateKey);
    host.http.route("GET", "/push-key", () => ({
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ publicKey: vapid.publicKey }),
    }));
    log.info("web push ready", { publicKey: vapid.publicKey.slice(0, 8) + "…" });

    // Persisted push subscriptions, loaded at startup so a channel is registered for every known browser immediately — push delivers out-of-band, independent of any open tab or WebSocket.
    // Registering here (before any client connects) means the agent sees the channel in its very first session message and can reach the user without them having the webui open.
    const pushStore = new PushSubscriptionStore(
      join(host.paths.stateDir, "push-subscriptions.json"),
    );
    await pushStore.load();
    for (const { clientId, subscription } of pushStore.entries()) {
      const id = `push:${clientId}`;
      host.responses.register(
        new PushChannel(id, subscription, () => {
          pushStore.remove(clientId);
          host.responses.unregister(id);
        }),
      );
    }
    log.info("push subscriptions loaded", { count: pushStore.size });

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

        // The first frame is the hello: { type: "hello", clientId, instanceId, fresh, tz }.
        // Until it arrives we do not know which client instance this is, so ignore anything else; after it arrives, every frame is a submitted message — a JSON `{ type: "message", text, history, tz }` frame (parsed below), falling back to plain text for an old or odd client.
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
            tz?: string;
          };
          if (h.type !== "hello") return;
          instanceId =
            typeof h.instanceId === "string" ? h.instanceId : randomUUID();
          clientId = typeof h.clientId === "string" ? h.clientId : "unknown";
          const fresh = h.fresh === true;
          const tz = sanitizeTz(h.tz);

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
            const payload: Record<string, unknown> = {
              type: "connect",
              responseChannel: instanceId,
              clientId,
              instanceId,
            };
            // Only include `tz` when the client sent a usable label, so an old or odd client still works unchanged.
            if (tz !== undefined) payload.tz = tz;
            host.events.enqueue("webui", payload);
            log.debug("connect", { id: instanceId, clientId, fresh, tz: tz ?? null });
          } else {
            log.debug("reconnect", { id: instanceId, clientId, fresh });
          }
          return;
        }

        // A submitted message or a push-subscription control frame: the client sends a JSON frame; `notify_subscribe`/`notify_unsubscribe` toggle the browser's push channel, anything else is a `{ type: "message", text, history, tz }` frame parsed below (falling back to plain text for an old or odd client).
        let frame: unknown;
        try {
          frame = JSON.parse(text);
        } catch {
          frame = undefined;
        }
        const frameType =
          typeof frame === "object" && frame !== null
            ? (frame as { type?: unknown }).type
            : undefined;

        if (frameType === "notify_subscribe") {
          // The user granted notification permission and the browser produced a subscription: store it under this browser's `clientId` and (re)register the `push:<clientId>` channel.
          // `unregister` first so a reconnect (which already has the channel from the store) does not trip the registry's duplicate-id rejection; `clientId` is set from the hello frame before this branch is reachable.
          const subscription = sanitizePushSubscription(
            (frame as { subscription?: unknown }).subscription,
          );
          if (subscription !== undefined) {
            pushStore.upsert(clientId, subscription);
            const id = `push:${clientId}`;
            host.responses.unregister(id);
            host.responses.register(
              new PushChannel(id, subscription, () => {
                pushStore.remove(clientId);
                host.responses.unregister(id);
              }),
            );
            log.debug("push subscribed", { clientId });
          }
          return;
        }

        if (frameType === "notify_unsubscribe") {
          // The user disabled notifications: drop the stored subscription and the channel.
          pushStore.remove(clientId);
          host.responses.unregister(`push:${clientId}`);
          log.debug("push unsubscribed", { clientId });
          return;
        }

        // A submitted message: the client sends a JSON frame `{ type: "message", text, history, tz }`; parse it so the event carries the tab's recent prior turns (giving the transient session continuity) and the user's current local timezone, falling back to plain text for an old or odd client.
        const { text: messageText, history, tz } = parseClientMessage(text);
        const payload: Record<string, unknown> = {
          type: "message",
          text: messageText,
          responseChannel: instanceId,
          clientId,
          instanceId,
        };
        // Only include `history` (and the interpretation note) when there is something to carry, so a first message in a tab looks unchanged.
        if (history !== undefined) {
          payload.history = history;
          payload.historyNote = HISTORY_NOTE;
        }
        // Only include `tz` when the client sent a usable label, so an old or odd client (one without `tz`) still works unchanged.
        if (tz !== undefined) payload.tz = tz;
        host.events.enqueue("webui", payload);
        log.debug("message", {
          id: instanceId,
          len: messageText.length,
          hist: history?.length ?? 0,
        });
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
