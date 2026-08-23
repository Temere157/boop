// The webui entry.
// Connects a WebSocket to `/ws`, renders incoming agent replies as bubbles in a centered #stream column, and sends the composer's text on submit.
// The backend (`plugins/webui/index.ts`) enqueues a `webui` event per connection and per submitted message and registers a response channel so the agent's `respond` tool writes back through the same socket — those replies arrive here as `onmessage`.
//
// Stays within erasable syntax (no enums, namespaces, or parameter properties) so the server's type-stripping pipeline serves it unchanged.

const app = document.getElementById("app");
const stream = document.getElementById("stream") as HTMLOListElement | null;
const status = document.getElementById("status") as HTMLSpanElement | null;
const form = document.getElementById("composer") as HTMLFormElement | null;
const input = document.getElementById("composer-input") as HTMLInputElement | null;
const sendButton = document.getElementById("composer-send") as HTMLButtonElement | null;

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

function run(
  _app: HTMLElement,
  stream: HTMLOListElement,
  status: HTMLSpanElement,
  form: HTMLFormElement,
  input: HTMLInputElement,
  sendButton: HTMLButtonElement,
): void {
  /** Is the stream scrolled to (near) the bottom? Drives auto-stick. */
  function atBottom(): boolean {
    const threshold = 64;
    return (
      stream.scrollHeight - stream.scrollTop - stream.clientHeight < threshold
    );
  }

  /** Append a message bubble and stick to the bottom if we were already there. */
  function addMessage(role: "user" | "agent", text: string): void {
    const stick = atBottom();
    const li = document.createElement("li");
    li.className = `message ${role}`;
    li.textContent = text;
    stream.appendChild(li);
    if (stick) stream.scrollTop = stream.scrollHeight;
  }

  function setConnected(connected: boolean): void {
    if (connected) {
      status.className = "connected";
      status.title = "connected";
      input.disabled = false;
      sendButton.disabled = false;
    } else {
      status.className = "disconnected";
      status.title = "disconnected";
      input.disabled = true;
      sendButton.disabled = true;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text === "" || ws === null || ws.readyState !== WebSocket.OPEN) return;
    ws.send(text);
    addMessage("user", text);
    input.value = "";
  });

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
      backoff = 1000;
      setConnected(true);
      input.focus();
    });

    socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      if (text !== "") addMessage("agent", text);
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

  setConnected(false);
  connect();

  // Register the app-shell service worker so the webui opens offline and is installable as a homescreen app.
  // The guard degrades to the online-only SPA in browsers without service-worker support.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.ts", { scope: "./" }).catch(() => {
      // A registration failure only means no offline shell; the app still works online.
    });
  }
}
