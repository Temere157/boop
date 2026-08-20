import type { Plugin } from "../plugin.js";

/**
 * A builtin HTTP ingest plugin. It registers a single HTTP endpoint that
 * accepts any request body as a UTF-8 string and enqueues it as an event.
 *
 * The plugin depends only on the {@link Plugin} contract, not on any core
 * implementation, so it could be moved to an external package as-is.
 *
 *   POST /ingest  ->  enqueues { source: "http-ingest", payload: { text } }
 *
 * It exists to exercise the full pipeline (HTTP → queue → loop) before the
 * event executor and real providers are built.
 */
export const httpIngestPlugin: Plugin = {
  name: "http-ingest",
  init(host) {
    host.http.route("POST", "/ingest", async (req) => {
      const text = req.body.toString("utf8");
      host.events.enqueue("http-ingest", { text });
      return { status: 202, body: "queued" };
    });
  },
};
