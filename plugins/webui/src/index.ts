// The webui entry.
// Connects a WebSocket to `/ws`, renders incoming agent replies as bubbles in a centered #stream column, and sends each submitted message as a JSON frame (`{ type: "message", text, history }`) carrying this tab's recent prior turns so the transient session handling the event can see what was already discussed in this tab.
// The backend (`plugins/webui/index.ts`) enqueues a `webui` event per new tab (a `connect`) and per submitted message, and registers a response channel so the agent's `respond` tool writes back through the same socket — those replies arrive here as `reply` frames in the `onmessage` envelope.
// The same socket also carries `status` frames: global busy/idle transitions from the core, so this tab shows a working indicator whenever any event is being handled — not just the ones it triggered.
// A reconnect (network blip, server restart) reuses the same per-tab instance id with `fresh:false` so it does not enqueue a fresh `connect`; only a new tab — a new instance id — does (see the hello frame sent in `connect`).
// An idle tab closes its own connection on a client-tracked clock (20 minutes visible, 10 hidden) and shows a yellow dot; focusing the input, typing into it, or the tab becoming visible reconnects it with the same instance id (a `fresh:false` hello).
// The tab's favicon mirrors the connection state too (the black-and-white logo given a pale wash of the header dot's color, so the state is visible outside the page).
//
// Stays within erasable syntax (no enums, namespaces, or parameter properties) so the server's type-stripping pipeline serves it unchanged.

const app = document.getElementById("app");
const stream = document.getElementById("stream") as HTMLOListElement | null;
const status = document.getElementById("status") as HTMLSpanElement | null;
const form = document.getElementById("composer") as HTMLFormElement | null;
const input = document.getElementById("composer-input") as HTMLInputElement | null;
const sendButton = document.getElementById("composer-send") as HTMLButtonElement | null;
const notifyButton = document.getElementById("notify") as HTMLButtonElement | null;
const favicon = document.getElementById("favicon") as HTMLLinkElement | null;

/** `localStorage` key for the persistent parent id (one per browser, shared across tabs). */
const CLIENT_ID_KEY = "boop.client-id";
/** `sessionStorage` key for the per-tab instance id (cleared when the tab closes, so a new tab gets a new id). */
const INSTANCE_ID_KEY = "boop.instance-id";
/** `sessionStorage` key for the rendered message history (cleared when the tab closes, so a fresh tab starts empty, but a reload replays the conversation in place). */
const MESSAGES_KEY = "boop.messages";
/** Idle timeouts for the tab's own connection, tracked client-side: a visible tab (the user is watching) sits idle 20 minutes before its socket closes, a hidden one 10. */
const IDLE_TIMEOUT_VISIBLE_MS = 20 * 60_000;
const IDLE_TIMEOUT_HIDDEN_MS = 10 * 60_000;

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

/** Is web push (notifications) usable here at all? Requires the Notification API, a service worker, and the PushManager API. */
function notificationsAvailable(): boolean {
  return (
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

/**
 * Decodes a base64url string (the VAPID public key, as the server generates it) to a `Uint8Array`.
 * `pushManager.subscribe` wants the application server key as a `BufferSource`, which requires the raw bytes rather than the string.
 */
function base64UrlToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Fetches the application's VAPID public key from `/push-key`, so the browser can subscribe to web push. */
async function fetchPushKey(): Promise<string> {
  const res = await fetch("/push-key");
  if (!res.ok) throw new Error(`push-key request failed: ${res.status}`);
  const body = (await res.json()) as { publicKey?: unknown };
  if (typeof body.publicKey !== "string" || body.publicKey === "") {
    throw new Error("push-key response malformed");
  }
  return body.publicKey;
}

const run = (
  _app: HTMLElement,
  stream: HTMLOListElement,
  status: HTMLSpanElement,
  form: HTMLFormElement,
  input: HTMLInputElement,
  sendButton: HTMLButtonElement,
  notifyButton: HTMLButtonElement | null,
  favicon: HTMLLinkElement,
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
  // `connection` is `connected` (green: the socket is open), `idle` (yellow: the idle timeout closed the socket, activity reconnects), or `disconnected` (red: the socket dropped, backoff reconnect in progress).
  let connection: "connected" | "idle" | "disconnected" = "disconnected";
  let isBusy = false;
  let busySource: string | null = null;
  // A pending `transitionend` remover for `.active` (set when the merge starts, cleared on interrupt or completion), so a re-spread mid-merge does not strand a spin-stopping callback.
  let stopRemover: ((e: TransitionEvent) => void) | null = null;

  // The favicon mirrors the connection state the header dot shows (green connected, yellow idle, red disconnected): the black-and-white logo given a pale wash of the state color, so the state is visible outside the page too.
  // The colors duplicate the values in `index.css` (`#status.connected`/`#status.idle`/`#status.disconnected`), so the wash matches the dot.
  const STATUS_COLORS = {
    connected: "#16a34a",
    idle: "#facc15",
    disconnected: "#dc2626",
  };
  // The favicon canvas: the logo with the state color washed over it.
  const faviconCanvas = document.createElement("canvas");
  faviconCanvas.width = 64;
  faviconCanvas.height = 64;
  const faviconCtx = faviconCanvas.getContext("2d") as CanvasRenderingContext2D;
  // The logo the wash is applied to; the favicon is empty until it loads (then the wash is repainted onto the logo).
  const faviconBase = new Image();
  faviconBase.src = "./icon-192.png";
  // The color last painted, so a repeat state is not redrawn.
  let faviconColor: string | null = null;

  /**
   * Paints the logo (once loaded) with a pale wash of `color` onto the favicon canvas and sets the result on the `<link rel="icon">`.
   * The wash is a per-pixel multiply toward `color`, so the black-and-white shading stays mostly the logo's own (black stays black, the white parts pick up a pale wash of the color, and the transparent parts stay transparent).
   */
  function paintFavicon(color: string): void {
    faviconCtx.clearRect(0, 0, 64, 64);
    if (faviconBase.complete && faviconBase.naturalWidth > 0) {
      faviconCtx.drawImage(faviconBase, 0, 0, 64, 64);
    }
    const strength = 0.4;
    const r = 1 - strength + (strength * parseInt(color.slice(1, 3), 16)) / 255;
    const g = 1 - strength + (strength * parseInt(color.slice(3, 5), 16)) / 255;
    const b = 1 - strength + (strength * parseInt(color.slice(5, 7), 16)) / 255;
    const image = faviconCtx.getImageData(0, 0, 64, 64);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      const pr = data[i] ?? 0;
      const pg = data[i + 1] ?? 0;
      const pb = data[i + 2] ?? 0;
      data[i] = pr * r;
      data[i + 1] = pg * g;
      data[i + 2] = pb * b;
    }
    faviconCtx.putImageData(image, 0, 0);
    favicon.href = faviconCanvas.toDataURL("image/png");
  }

  /** Sets the favicon to `color` (a no-op when the same color is already shown), mirroring the header dot's connection color in the tab. */
  function setFavicon(color: string): void {
    if (faviconColor === color) return;
    faviconColor = color;
    paintFavicon(color);
  }

  faviconBase.onload = (): void => {
    // The logo is in: repaint the current color so the favicon gains the logo behind the tint.
    if (faviconColor !== null) paintFavicon(faviconColor);
  };

  /** Compose the dot's `title` from the current connection and working state so both signals stay legible regardless of which one last changed. */
  function updateTitle(): void {
    status.title = isBusy
      ? busySource === null
        ? "working"
        : `working: ${busySource}`
      : connection === "connected"
        ? "connected"
        : connection === "idle"
          ? "idle (reconnects on activity)"
          : "disconnected";
  }

  /** Sets the connection state and reflects it into the dot (its color classes and `title`), the send button (only a connected socket can submit), and the bell (a closed socket cannot report push subscriptions). */
  function setConnection(next: "connected" | "idle" | "disconnected"): void {
    connection = next;
    // Toggle the connection classes rather than overwriting `className`, so the working phase classes (`.active`/`.spread`) survive a recolor mid-work.
    status.classList.toggle("connected", next === "connected");
    status.classList.toggle("idle", next === "idle");
    status.classList.toggle("disconnected", next === "disconnected");
    updateTitle();
    // The input stays usable in every state (typing or focusing it is what marks the tab active and wakes a timed-out connection), so only the send button gates on the connection.
    sendButton.disabled = next !== "connected";
    updateNotifyButton();
    // Mirror the connection state in the tab's favicon (the browser's only state visible outside the page).
    setFavicon(STATUS_COLORS[next]);
  }

  // Whether this browser has a push subscription reported to the server (the `push:<clientId>` channel).
  // Drives the bell's on/off state and what a click does; tracked in memory only, since it is derived from live permission plus the reported subscription, and re-evaluated on each load.
  let pushEnabled = false;

  /**
   * Reflects the current notification ability and state into the bell button.
   * Disabled (and dimmed) when unsupported or disconnected; `on`/filled when a subscription is reported; otherwise an outline bell.
   */
  function updateNotifyButton(): void {
    if (notifyButton === null) return;
    if (!notificationsAvailable() || connection !== "connected") {
      notifyButton.disabled = true;
      notifyButton.classList.remove("on");
      notifyButton.setAttribute("aria-pressed", "false");
      notifyButton.title = notificationsAvailable()
        ? "notifications (offline)"
        : "notifications not supported";
      return;
    }
    notifyButton.disabled = false;
    const on = Notification.permission === "granted" && pushEnabled;
    notifyButton.classList.toggle("on", on);
    notifyButton.setAttribute("aria-pressed", on ? "true" : "false");
    if (on) {
      notifyButton.title = "notifications on";
    } else if (Notification.permission === "denied") {
      notifyButton.title = "notifications blocked";
    } else {
      notifyButton.title = "notifications off";
    }
  }

  /**
   * Enables web push for this browser: request permission (soliciting only if it has not been decided), fetch the VAPID public key, subscribe, and report the subscription to the server so it registers the `push:<clientId>` channel.
   */
  async function enableNotifications(): Promise<void> {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    if (Notification.permission === "denied") return;
    if (Notification.permission === "default") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        updateNotifyButton();
        return;
      }
    }
    try {
      const publicKey = await fetchPushKey();
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(publicKey),
      });
      if (ws === null || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({ type: "notify_subscribe", subscription: subscription.toJSON() }),
      );
      pushEnabled = true;
    } catch {
      // Subscribe failed (no service worker, push unsupported, transient network); leave the bell off.
      pushEnabled = false;
    }
    updateNotifyButton();
  }

  /**
   * Disables web push for this browser: unsubscribe the browser's push subscription and tell the server to drop the `push:<clientId>` channel.
   */
  async function disableNotifications(): Promise<void> {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription !== null) await subscription.unsubscribe();
    } catch {
      // Unsubscribe hiccup: still tell the server so it stops targeting this browser.
    }
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "notify_unsubscribe" }));
    }
    pushEnabled = false;
    updateNotifyButton();
  }

  /**
   * On (re)connect, if permission is granted, re-report the browser's existing push subscription so the server's `push:<clientId>` channel survives a blip or reload.
   * The server also presses the store at startup, so this is belt-and-braces vs strays a rotated/cleared subscription.
   */
  async function reportExistingSubscription(): Promise<void> {
    if (!notificationsAvailable() || Notification.permission !== "granted") return;
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription === null) {
        pushEnabled = false;
      } else if (ws !== null && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: "notify_subscribe", subscription: subscription.toJSON() }),
        );
        pushEnabled = true;
      }
    } catch {
      pushEnabled = false;
    }
    updateNotifyButton();
  }

  notifyButton?.addEventListener("click", () => {
    if (pushEnabled) void disableNotifications();
    else void enableNotifications();
  });

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

  // Activity that (re)marks the tab active: focusing the input or typing into it resets the idle clock and wakes a timed-out connection (the input stays enabled in every state, so focus is what a timed-out tab listens for).
  input.addEventListener("focus", markActive);
  input.addEventListener("input", markActive);

  // A hidden tab is worth 10 minutes of idleness before its connection closes; the moment it becomes visible again the user is present, so a timed-out tab reconnects immediately.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      markActive();
    } else if (connection === "connected") {
      armIdleTimer();
    }
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

  // The idle clock for this tab's own connection, tracked client-side: armed on connect, disarmed on close, and the timeout is visibility-dependent (a visible tab is worth 20 minutes, a hidden one 10).
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** The idle timeout for the tab's current visibility. */
  function idleTimeoutMs(): number {
    return document.visibilityState === "visible"
      ? IDLE_TIMEOUT_VISIBLE_MS
      : IDLE_TIMEOUT_HIDDEN_MS;
  }

  /** Clears the idle clock. */
  function disarmIdleTimer(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  }

  /** Arms the idle clock: after the visibility-dependent timeout the socket is closed on purpose and the dot turns yellow. */
  function armIdleTimer(): void {
    disarmIdleTimer();
    idleTimer = setTimeout(onIdleTimeout, idleTimeoutMs());
  }

  /** The tab has been idle long enough: close the socket on purpose (the server drops the reply channel with the connection) and show the idle state without scheduling a reconnect. */
  function onIdleTimeout(): void {
    idleTimer = null;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    setConnection("idle");
    ws.close();
  }

  /** The user is present again (focused the input, typed, or the tab became visible): wake an idle connection, or reset the idle clock on a connected one. */
  function markActive(): void {
    if (connection === "idle") {
      // `ws` is cleared on close, so a second wake before the socket opens is a no-op.
      if (ws === null) connect();
      return;
    }
    if (connection === "connected") armIdleTimer();
  }

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
      setConnection("connected");
      armIdleTimer();
      input.focus();
      // Re-report any existing push subscription so the `push:<clientId>` channel survives a reconnect or reload.
      void reportExistingSubscription();
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
      setConnection("disconnected");
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10_000);
    };

    socket.addEventListener("close", () => {
      disarmIdleTimer();
      ws = null;
      // An intentional idle-close has no reconnect: the tab is idle, so we sit closed (yellow) until activity wakes us.
      if (connection === "idle") return;
      scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      // `close` always fires after `error`; reconnect is scheduled there.
      socket.close();
    });
  }

  // Replay the persisted message history for this tab so a reload restores the conversation in place.
  recording = false;
  for (const { role, text } of history) addMessage(role, text);
  recording = true;

  setConnection("disconnected");
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
  sendButton !== null &&
  favicon !== null
) {
  run(app, stream, status, form, input, sendButton, notifyButton, favicon);
}
