import { randomUUID } from "node:crypto";
import type { Event } from "./event.js";
import { ExecutorRegistry } from "./executors.js";
import { HttpServer } from "./http.js";
import { log } from "./log.js";
import { mainLoop, type EventExecutor } from "./main.js";
import { McpUnixServer } from "./mcp/server.js";
import type { EventSink, PluginHost } from "./plugin.js";
import { claudeExecutorPlugin } from "./plugins/claude.js";
import { consolePlugin } from "./plugins/console.js";
import { httpIngestPlugin } from "./plugins/ingest.js";
import { EventQueue } from "./queue.js";
import { SessionRunner } from "./session.js";
import { ToolRegistry } from "./tools.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const queue = new EventQueue();
const httpServer = new HttpServer();
const toolRegistry = new ToolRegistry();
const executorRegistry = new ExecutorRegistry();
const mcpServer = new McpUnixServer("boop", "0.1.0");

// Adapter from the internal EventQueue to the plugin-facing EventSink.
// Plugins never construct Events directly; the core stamps id + timestamp.
const events = log("events");
const eventSink: EventSink = {
  enqueue(source, payload) {
    const event: Event = {
      id: randomUUID(),
      source,
      payload,
      createdAt: Date.now(),
    };
    events.info("received", { id: event.id, source, payload });
    queue.push(event);
  },
};

const pluginHost: PluginHost = {
  events: eventSink,
  http: httpServer,
  tools: toolRegistry,
  executors: executorRegistry,
  log,
};

// Builtin plugins. Each depends only on the Plugin contract, so any of
// these could be extracted into its own package without changes.
const builtinPlugins = [httpIngestPlugin, consolePlugin, claudeExecutorPlugin];
for (const plugin of builtinPlugins) {
  await plugin.init(pluginHost);
}

await httpServer.listen(port, host);
log("http").info("listening", `http://${host}:${port}`);

// Per-event handler: prepare the session (system prompt + tools + event)
// and hand it to the registered low-level session executor, then record
// the returned transcript as JSONL (in the XDG state dir) and log it.
// See {@link SessionRunner} and {@link startRecording}.
const runner = new SessionRunner(toolRegistry, executorRegistry, mcpServer);
const execute: EventExecutor = (event) => runner.run(event);

// Graceful shutdown: closing the queue lets a pending pull reject so the
// main loop exits; then we stop accepting HTTP connections.
let shuttingDown = false;
const stop = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  log("core").info("shutting down", signal);
  queue.close();
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

await mainLoop(queue, execute);
await httpServer.close();
await mcpServer.close();
