// A minimal service worker for the webui app shell.
// It caches the SPA shell on install so the webui opens offline and reconnects the WebSocket once the server is back; a service worker cannot intercept WebSocket upgrades, so the live `/ws` connection is unaffected.
// Registered from the webui entry (src/index.ts) only in browsers that support service workers.
// The scope is typed locally because the global `ServiceWorkerGlobalScope` lives in the WebWorker lib, which the webui tsconfig does not include, so referencing it directly would not typecheck.

/** The `install`/`activate` event shape: a `waitUntil` that extends the event's lifetime. */
interface SwLifecycleEvent {
  waitUntil(promise: Promise<unknown>): void;
}

/** The `fetch` event shape: the request plus `respondWith` to supply the response. */
interface SwFetchEvent {
  readonly request: Request;
  respondWith(promise: Promise<Response> | Response): void;
}

/** The subset of the service worker global scope the shell uses. */
interface SwScope {
  addEventListener(
    type: "install" | "activate",
    listener: (event: SwLifecycleEvent) => void,
  ): void;
  addEventListener(type: "fetch", listener: (event: SwFetchEvent) => void): void;
  skipWaiting(): void;
  clients: { claim(): void };
  readonly location: Location;
}

const sw = self as unknown as SwScope;

/** Cache store name; bump the suffix to invalidate a previous shell on activate. */
const CACHE = "boop-webui-v1";

/** The committed static shell to pre-cache on install so the app opens offline even before any navigation.
 * The icon PNGs are committed, so they are safe to pre-cache here. */
const SHELL = [
  "/ui/",
  "/ui/index.html",
  "/ui/index.css",
  "/ui/index.ts",
  "/ui/manifest.webmanifest",
  "/ui/icon-192.png",
  "/ui/icon-512.png",
  "/ui/icon-512-maskable.png",
  "/ui/apple-touch-icon.png",
];

sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      sw.skipWaiting();
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      );
      sw.clients.claim();
    })(),
  );
});

sw.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  // Network-first for navigations and same-origin shell assets: online stays fresh (so dev edits show), offline falls back to the cached shell.
  // The service worker's own script (`/ui/sw.ts`) goes through here too, so update checks always hit the network and byte changes are detected.
  const mode = req.mode as string;
  if (mode === "navigate" || url.pathname.startsWith("/ui/")) {
    event.respondWith(networkFirst(req));
  }
});

/** Try the network, cache the fresh response, and fall back to the cache when offline. */
async function networkFirst(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(req);
    cache.put(req, fresh.clone());
    return fresh;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response("offline", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}
