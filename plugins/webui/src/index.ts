// The webui entry.
// Connects a WebSocket to `/ws`, renders incoming agent replies as bubbles in a centered #stream column, and sends each submitted message as a JSON frame (`{ type: "message", text, history }`) carrying this tab's recent prior turns so the transient session handling the event can see what was already discussed in this tab.
// The backend (`plugins/webui/index.ts`) enqueues a `webui` event per new tab (a `connect`) and per submitted message, and registers a response channel so the agent's `respond` tool writes back through the same socket — those replies arrive here as `reply` frames in the `onmessage` envelope.
// The same socket also carries `status` frames: global busy/idle transitions from the core, so this tab shows a working indicator whenever any event is being handled — not just the ones it triggered.
// A reconnect (network blip, server restart) reuses the same per-tab instance id with `fresh:false` so it does not enqueue a fresh `connect`; only a new tab — a new instance id — does (see the hello frame sent in `connect`).
//
// Stays within erasable syntax (no enums, namespaces, or parameter properties) so the server's type-stripping pipeline serves it unchanged.

const app = document.getElementById("app");
const stream = document.getElementById("stream") as HTMLOListElement | null;
const status = document.getElementById("status") as HTMLSpanElement | null;
const form = document.getElementById("composer") as HTMLFormElement | null;
const input = document.getElementById("composer-input") as HTMLInputElement | null;
const sendButton = document.getElementById("composer-send") as HTMLButtonElement | null;

/** `localStorage` key for the persistent parent id (one per browser, shared across tabs). */
const CLIENT_ID_KEY = "boop.client-id";
/** `sessionStorage` key for the per-tab instance id (cleared when the tab closes, so a new tab gets a new id). */
const INSTANCE_ID_KEY = "boop.instance-id";
/** `sessionStorage` key for the rendered message history (cleared when the tab closes, so a fresh tab starts empty, but a reload replays the conversation in place). */
const MESSAGES_KEY = "boop.messages";

/** A v4 UUID; `crypto.randomUUID` in secure contexts (HTTPS, localhost), with a `Math.random` fallback for insecure ones (plain HTTP on a LAN IP) so the ids still exist where `randomUUID` is unavailable. */
function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** A rendered message bubble persisted across reloads within the same tab. */
interface HistoryEntry {
  role: "user" | "agent";
  text: string;
}

/** Reads the persisted message history for this tab, or an empty array if none is stored or it is malformed, so a corrupt value never breaks the page. */
function loadHistory(): HistoryEntry[] {
  const raw = sessionStorage.getItem(MESSAGES_KEY);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: HistoryEntry[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const role = (entry as { role?: unknown }).role;
    const text = (entry as { text?: unknown }).text;
    if (role !== "user" && role !== "agent") continue;
    if (typeof text !== "string") continue;
    out.push({ role, text });
  }
  return out;
}

/**
 * The user's current local timezone as `America/New_York (UTC-05:00)`, recomputed at call time so DST and a moved zone stay correct across a long-lived tab.
 * The IANA name gives the zone's semantics (including its DST rules); the offset gives instant arithmetic without the model needing to know those rules.
 * `getTimezoneOffset` already encodes DST, so the label is correct for the day it is sent.
 */
function localTzLabel(): string {
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${name} (UTC${sign}${hh}:${mm})`;
}

/** Reads `key` from `storage`, generating and persisting a fresh UUID if it is absent, so the returned id is stable across reloads for that storage's lifetime. */
function persistentId(storage: Storage, key: string): string {
  const existing = storage.getItem(key);
  if (existing !== null) return existing;
  const id = uuid();
  storage.setItem(key, id);
  return id;
}

const run = (
  _app: HTMLElement,
  stream: HTMLOListElement,
  status: HTMLSpanElement,
  form: HTMLFormElement,
  input: HTMLInputElement,
  sendButton: HTMLButtonElement,
): void => {
  /** Is the stream scrolled to (near) the bottom? Drives auto-stick. */
  function atBottom(): boolean {
    const threshold = 64;
    return (
      stream.scrollHeight - stream.scrollTop - stream.clientHeight < threshold
    );
  }

  /** The rendered message history for this tab, persisted to `sessionStorage` so a reload replays it. */
  const history: HistoryEntry[] = loadHistory();
  /** Suppress persistence while replaying the loaded history so it is not re-written verbatim. */
  let recording = true;

  /** Append a message bubble, stick to the bottom if we were already there, and persist it to the tab's history so a reload replays it. */
  function addMessage(role: "user" | "agent", text: string): void {
    const stick = atBottom();
    const li = document.createElement("li");
    li.className = `message ${role}`;
    li.textContent = text;
    stream.appendChild(li);
    if (stick) stream.scrollTop = stream.scrollHeight;
    if (recording) {
      history.push({ role, text });
      sessionStorage.setItem(MESSAGES_KEY, JSON.stringify(history));
    }
  }

  /**
   * A capped, role-normalized view of this tab's prior turns, sent with each message so the transient session handling the event can see what was already discussed in this tab.
   * The current message is excluded (it is added to `history` after the send, and it is the event's `text`), and `agent` roles are mapped to `assistant` so the model reads conventional turns.
   * Returns the last `cap` entries; older turns beyond the cap are dropped to bound the payload size.
   */
  function recentHistory(
    cap: number,
  ): { role: "user" | "assistant"; text: string }[] {
    const slice = history.slice(Math.max(0, history.length - cap));
    return slice.map((h) => ({
      role: h.role === "agent" ? "assistant" : h.role,
      text: h.text,
    }));
  }

  // Connection and working state for the merged `#status` dot, so the title composes both signals and the working phase transitions survive a disconnect that recolors the dot mid-work.
  let isConnected = false;
  let isBusy = false;
  let busySource: string | null = null;
  // A pending `transitionend` remover for `.active` (set when the merge starts, cleared on interrupt or completion), so a re-spread mid-merge does not strand a spin-stopping callback.
  let stopRemover: ((e: TransitionEvent) => void) | null = null;

  /** Compose the dot's `title` from the current connection and working state so both signals stay legible regardless of which one last changed. */
  function updateTitle(): void {
    status.title = isBusy
      ? busySource === null
        ? "working"
        : `working: ${busySource}`
      : isConnected
        ? "connected"
        : "disconnected";
  }

  function setConnected(connected: boolean): void {
    isConnected = connected;
    // Toggle the connection class rather than overwriting `className`, so the working phase classes (`.active`/`.spread`) survive a recolor mid-work.
    status.classList.toggle("connected", connected);
    status.classList.toggle("disconnected", !connected);
    updateTitle();
    input.disabled = !connected;
    sendButton.disabled = !connected;
  }

  /**
   * Merge the working indicator into the connection dot: `.spread` transitions the dots' orbital radius out (a spiral, since `.active` is already spinning) and removing it spirals them back in; `.active` keeps the spin through the merge and is cleared once the radius settles at 0.
   * `source` (on `busy`) is surfaced in the title so the cross-source nature of the signal is visible.
   */
  function setWorking(nowBusy: boolean, source: string | null): void {
    isBusy = nowBusy;
    if (nowBusy) {
      busySource = source;
      // Interrupt a merge in flight: drop its pending `stop` so `.active` survives the re-spread, and re-adding `.spread` transitions the radius back out from wherever it had reached.
      if (stopRemover !== null) {
        status.removeEventListener("transitionend", stopRemover);
        stopRemover = null;
      }
      status.classList.add("active");
      status.classList.add("spread");
    } else if (status.classList.contains("spread")) {
      // Only merge if we were actually spread; a stray `idle` while already idle is a no-op (and would otherwise strand a `stop` that no transition will fire).
      status.classList.remove("spread");
      const stop = (e: TransitionEvent): void => {
        if (e.propertyName !== "transform") return;
        // Only complete when the trailing dot (the one with the longest delay) settles, so `.active` is dropped exactly as the last dot reforms.
        if (e.target !== status.lastElementChild) return;
        status.classList.remove("active");
        status.removeEventListener("transitionend", stop);
        stopRemover = null;
      };
      stopRemover = stop;
      status.addEventListener("transitionend", stop);
    }
    updateTitle();
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text === "" || ws === null || ws.readyState !== WebSocket.OPEN) return;
    // Send the message as a JSON frame carrying this tab's recent history, so the transient session handling the event can see what was already discussed in this tab.
    // `history` excludes the current message (added to `history` below), which becomes the event's `text`.
    // `tz` is the user's current local timezone label, recomputed at send time so DST and a moved zone stay correct.
    ws.send(
      JSON.stringify({
        type: "message",
        text,
        history: recentHistory(20),
        tz: localTzLabel(),
      }),
    );
    addMessage("user", text);
    input.value = "";
  });

  // Persistent parent id (one per browser, in `localStorage`) and per-tab instance id (in `sessionStorage`, so it survives reloads but changes when the tab is closed and a new one opens).
  // The server enqueues a `connect` only for a new tab (a new instance id, signalled by `fresh:true` on the first open of this page load); a reconnect reuses the same ids with `fresh:false` so a blip or server restart does not look like a new client.
  const clientId = persistentId(localStorage, CLIENT_ID_KEY);
  const instanceId = persistentId(sessionStorage, INSTANCE_ID_KEY);
  let greeted = false;

  // Reconnect with simple linear backoff capped at ~10s.
  // The first attempt is immediate so a page load hits `/ws` right away.
  let ws: WebSocket | null = null;
  let backoff = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function connect(): void {
    const url =
      (location.protocol === "https:" ? "wss:" : "ws:") +
      "//" +
      location.host +
      "/ws";
    const socket = new WebSocket(url);
    ws = socket;

    socket.addEventListener("open", () => {
      // Greet the server with the persistent ids; `fresh` is true only on the first open of this page load, so a reconnect (network blip, server restart) reuses the same instance id without enqueuing a new `connect` event.
      // `tz` is sent on hello too so the `connect` event (a new tab, no message yet) still carries the user's local timezone.
      const fresh = !greeted;
      greeted = true;
      socket.send(
        JSON.stringify({
          type: "hello",
          clientId,
          instanceId,
          fresh,
          tz: localTzLabel(),
        }),
      );
      backoff = 1000;
      setConnected(true);
      input.focus();
    });

    socket.addEventListener("message", (event) => {
      // Server frames are JSON envelopes keyed by `type`: `reply` carries an agent message rendered as a bubble, `status` carries a global busy/idle transition so this tab reflects the agent's overall state (including work triggered from other channels).
      let frame: unknown;
      try {
        frame = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      if (typeof frame !== "object" || frame === null) return;
      const f = frame as { type?: string };
      if (f.type === "reply") {
        const text = (frame as { text?: unknown }).text;
        if (typeof text === "string" && text !== "") addMessage("agent", text);
      } else if (f.type === "status") {
        const status = (frame as { status?: unknown }).status;
        const source = (frame as { source?: unknown }).source;
        if (status === "busy" || status === "idle") {
          setWorking(
            status === "busy",
            typeof source === "string" ? source : null,
          );
        }
      }
    });

    const scheduleReconnect = (): void => {
      setConnected(false);
      ws = null;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10_000);
    };

    socket.addEventListener("close", scheduleReconnect);
    socket.addEventListener("error", () => {
      // `close` always fires after `error`; reconnect is scheduled there.
      socket.close();
    });
  }

  // Replay the persisted message history for this tab so a reload restores the conversation in place.
  recording = false;
  for (const { role, text } of history) addMessage(role, text);
  recording = true;

  setConnected(false);
  connect();

  // Register the app-shell service worker so the webui opens offline and is installable as a homescreen app.
  // The guard degrades to the online-only SPA in browsers without service-worker support.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.ts", { scope: "./" }).catch(() => {
      // A registration failure only means no offline shell; the app still works online.
    });
  }
};

if (
  app !== null &&
  stream !== null &&
  status !== null &&
  form !== null &&
  input !== null &&
  sendButton !== null
) {
  run(app, stream, status, form, input, sendButton);
}
