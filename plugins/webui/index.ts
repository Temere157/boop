import { readFile, readdir } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpResponse, Plugin } from "@boop/plugin";

/** Absolute path to this plugin's webui source directory (`…/webui/src/`). */
const SRC_DIR = fileURLToPath(new URL("./src/", import.meta.url));

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
 * A builtin webui plugin. It registers HTTP routes that serve a small
 * single-page webui from its `src/` directory under the `/ui/` prefix:
 * `GET /ui/` returns `index.html`, and every top-level file in `src/` is
 * served at `/ui/<basename>` (`GET /ui/index.css`, `GET /ui/index.ts`, …).
 * The router is exact match, so each served file is one route; nested
 * directories can come later. `GET /` redirects to `/ui/` so the bare
 * server root lands on the UI rather than 404ing.
 *
 * The plugin depends only on the {@link Plugin} contract, not on any core
 * implementation, so it could be moved to an external package as-is.
 */
export const webuiPlugin: Plugin = {
  name: "webui",
  async init(host) {
    const log = host.log("webui");
    const entries = await readdir(SRC_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      const filePath = join(SRC_DIR, name);
      host.http.route("GET", `/ui/${name}`, () => serveFile(filePath, name));
      log.debug("route", `GET /ui/${name}`);
    }
    // The SPA entry: `GET /ui/` serves index.html (the bare prefix). The
    // page's relative links (`./index.css`, `./index.ts`) resolve to
    // `/ui/index.css` / `/ui/index.ts` against this URL.
    host.http.route("GET", "/ui/", () =>
      serveFile(join(SRC_DIR, "index.html"), "index.html"),
    );
    // Root redirect so `GET /` lands on the UI rather than 404.
    host.http.route("GET", "/", () => redirect("/ui/"));
    log.info("serving webui at /ui/");
  },
};
