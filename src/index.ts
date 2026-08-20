import { randomUUID } from "node:crypto";
import type { Event } from "./event.js";
import { HttpServer } from "./http.js";
import { mainLoop } from "./main.js";
import type { EventSink, PluginHost } from "./plugin.js";
import { mockPlugin } from "./plugins/mock.js";
import { EventQueue } from "./queue.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const queue = new EventQueue();
const httpServer = new HttpServer();

// Adapter from the internal EventQueue to the plugin-facing EventSink.
// Plugins never construct Events directly; the core stamps id + timestamp.
const eventSink: EventSink = {
  enqueue(source, payload) {
    const event: Event = {
      id: randomUUID(),
      source,
      payload,
      createdAt: Date.now(),
    };
    queue.push(event);
  },
};

const pluginHost: PluginHost = { events: eventSink, http: httpServer };

// Builtin plugins. Each depends only on the Plugin contract, so any of
// these could be extracted into its own package without changes.
const builtinPlugins = [mockPlugin];
for (const plugin of builtinPlugins) {
  await plugin.init(pluginHost);
}

await httpServer.listen(port, host);
console.log(`http listening on http://${host}:${port}`);

// TODO: event executor. This is where a transient session is spawned per
// event: load relevant context from memory, run the LLM with its tools,
// flush anything worth remembering back to memory, then end the session.
const execute = async (_event: Event): Promise<void> => {
  // TODO: implement the event executor (sessions + memory + LLM + tools).
};

// Graceful shutdown: closing the queue lets a pending pull reject so the
// main loop exits; then we stop accepting HTTP connections.
let shuttingDown = false;
const stop = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);
  queue.close();
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

await mainLoop(queue, execute);
await httpServer.close();
