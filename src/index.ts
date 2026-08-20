import { randomUUID } from "node:crypto";
import type { Event } from "./event.js";
import { ExecutorRegistry } from "./executors.js";
import { HttpServer } from "./http.js";
import { mainLoop, type EventExecutor } from "./main.js";
import type { EventSink, PluginHost } from "./plugin.js";
import { consolePlugin } from "./plugins/console.js";
import { httpIngestPlugin } from "./plugins/ingest.js";
import { scriptedExecutorPlugin } from "./plugins/scripted.js";
import { EventQueue } from "./queue.js";
import { SessionRunner } from "./session.js";
import { ToolRegistry } from "./tools.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const queue = new EventQueue();
const httpServer = new HttpServer();
const toolRegistry = new ToolRegistry();
const executorRegistry = new ExecutorRegistry();

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

const pluginHost: PluginHost = {
  events: eventSink,
  http: httpServer,
  tools: toolRegistry,
  executors: executorRegistry,
};

// Builtin plugins. Each depends only on the Plugin contract, so any of
// these could be extracted into its own package without changes.
const builtinPlugins = [
  httpIngestPlugin,
  consolePlugin,
  scriptedExecutorPlugin,
];
for (const plugin of builtinPlugins) {
  await plugin.init(pluginHost);
}

await httpServer.listen(port, host);
console.log(`http listening on http://${host}:${port}`);

// Per-event handler: prepare the session (system prompt + tools + event)
// and hand it to the registered low-level session executor, then log the
// returned transcript. Persistence of the transcript is a TODO; for now
// logging is the record. See {@link SessionRunner}.
const runner = new SessionRunner(toolRegistry, executorRegistry);
const execute: EventExecutor = (event) => runner.run(event);

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
