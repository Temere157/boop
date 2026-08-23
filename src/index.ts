import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath, loadConfig } from "./config.js";
import { boopConfigDir, boopStateDir } from "./paths.js";
import type { Event } from "./event.js";
import { ExecutorRegistry } from "./executors.js";
import { HttpServer } from "./http.js";
import { log, setLevel } from "./log.js";
import { mainLoop, type EventExecutor } from "./main.js";
import { McpUnixServer } from "./mcp/server.js";
import type { EventSink, PluginHost } from "./plugin.js";
import { PreparerRegistry } from "./preparers.js";
import { ResponseChannelRegistry, registerRespondTool } from "./responses.js";
import { loadPlugins } from "./load-plugins.js";
import { EventQueue } from "./queue.js";
import { SessionRunner } from "./session.js";
import { StatusBus } from "./status.js";
import { ToolRegistry } from "./tools.js";

const config = loadConfig();

setLevel(config.logLevel);

const port = config.port;
const host = config.host;

const queue = new EventQueue();
const httpServer = new HttpServer();
const toolRegistry = new ToolRegistry();
const executorRegistry = new ExecutorRegistry();
const mcpServer = new McpUnixServer("boop", "0.1.0");
const responseChannels = new ResponseChannelRegistry();
const preparerRegistry = new PreparerRegistry();
// Shared bus the main loop emits busy/idle transitions onto around every event it handles; plugins (the webui) subscribe to mirror it to their clients.
const statusBus = new StatusBus();
// The `respond` tool is core (the plugin boundary is the channels, not the tool), so it is registered here rather than by a plugin.
registerRespondTool(toolRegistry, responseChannels);

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

// Per-plugin directory bases: `{boopStateDir}/plugins/{name}/` for state and `{boopConfigDir}/plugins/{name}/` for config, scoped by plugin name.
const pluginsStateDir = join(boopStateDir(), "plugins");
const pluginsConfigDir = join(boopConfigDir(), "plugins");

// Plugin directories scanned at startup, in order.
// For now just the core plugins shipped in `plugins/`, resolved relative to this module so it works whether this runs from `src/` under tsx or `dist/` compiled.
const pluginDirs = [fileURLToPath(new URL("../plugins/", import.meta.url))];
const plugins = await loadPlugins(pluginDirs);
// Each plugin depends only on the Plugin contract, so any of these could be extracted into its own package without changes.
// Each gets its own `paths.stateDir` and `paths.configDir` (created before init) so a plugin can keep state and read its own config without colliding with another.
for (const plugin of plugins) {
  const stateDir = join(pluginsStateDir, plugin.name);
  const configDir = join(pluginsConfigDir, plugin.name);
  await mkdir(stateDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  const pluginHost: PluginHost = {
    events: eventSink,
    http: httpServer,
    tools: toolRegistry,
    executors: executorRegistry,
    responses: responseChannels,
    status: statusBus,
    prepare: preparerRegistry,
    log,
    paths: { stateDir, configDir },
  };
  await plugin.init(pluginHost);
}

await httpServer.listen(port, host);
log("http").info("listening", `http://${host}:${port}`);

// Exactly one executor runs each event's session; the id is resolved at startup: BOOP_EXECUTOR overrides the config file's `executor` key, and with no override the sole registered executor is used.
// Several registered executors is a configuration error (the core can't guess which agentic loop to own); none is not — the session runner warns and skips events until one is registered.
const executorIds = executorRegistry.ids();
const requested = config.executor;
let executorId: string | undefined;
if (requested !== undefined) {
  if (!executorIds.includes(requested)) {
    throw new Error(
      `no session executor registered with id "${requested}"; available: ${executorIds.join(", ")}`,
    );
  }
  executorId = requested;
} else if (executorIds.length === 1) {
  executorId = executorIds[0];
} else if (executorIds.length > 1) {
  throw new Error(
    `multiple session executors registered (${executorIds.join(", ")}); set "executor" in ${configPath()} or BOOP_EXECUTOR to choose`,
  );
}
log("core").info("executor", { id: executorId ?? null, available: executorIds });

// Per-event handler: prepare the session (system prompt + tools + event) and hand it to the configured low-level session executor, then record the returned transcript as JSONL (in the XDG state dir) and log it.
// See {@link SessionRunner} and {@link startRecording}.
const runner = new SessionRunner(
  toolRegistry,
  executorRegistry,
  mcpServer,
  responseChannels,
  preparerRegistry,
  executorId,
);
// Per-event handler: prepare the session (system prompt + tools + event) and hand it to the configured low-level session executor, then record the returned transcript as JSONL (in the XDG state dir) and log it.
// Emit a busy transition on the status bus around the run (and idle in `finally`, so a throwing session still clears the indicator), so subscribed clients (the webui) show a working indicator for every event whatever its source.
// See {@link SessionRunner} and {@link startRecording}.
const execute: EventExecutor = async (event) => {
  statusBus.notify("busy", event.source);
  try {
    await runner.run(event);
  } finally {
    statusBus.notify("idle", null);
  }
};

// Graceful shutdown: closing the queue lets a pending pull reject so the main loop exits; then we stop accepting HTTP connections.
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
