import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boopConfigDir } from "./paths.js";
import type { LogLevel } from "./plugin.js";

/** Every valid {@link LogLevel}; used to validate the config and `BOOP_LOG`. */
const LOG_LEVELS: ReadonlySet<LogLevel> = new Set([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "silent",
]);

/**
 * Boop's config, loaded once at startup: a small JSON file with optional
 * keys (unknown keys ignored), read from {@link configPath}. A missing file
 * is the empty config (all defaults); a malformed file fails startup.
 */
export interface BoopConfig {
  /** Id of the session executor to run each event's session. */
  readonly executor?: string;
  /** The port to listen on for the HTTP server. */
  readonly port: number;
  /** The host to listen on for the HTTP server. */
  readonly host: string;
  /** The log level to use (trace, debug, info, warn, error, silent). */
  readonly logLevel: LogLevel;
  readonly [key: string]: unknown;
}

/**
 * The config file path: `$XDG_CONFIG_HOME/boop/config.json`, falling back
 * to `~/.config/boop/config.json` (per the XDG Base Directory spec),
 * mirroring the state dir session recordings live in (see
 * {@link startRecording}).
 */
export function configPath(): string {
  return join(boopConfigDir(), "config.json");
}

/**
 * Loads boop's config from {@link configPath} and merges it with
 * environment variable overrides.
 *
 * Environment variables:
 * - `BOOP_EXECUTOR`: overrides `executor`
 * - `BOOP_PORT`: overrides `port`
 * - `BOOP_HOST`: overrides `host`
 * - `BOOP_LOG`: overrides `logLevel`
 *
 * Defaults:
 * - `port`: 3000
 * - `host`: "0.0.0.0"
 * - `logLevel`: "info"
 */
export function loadConfig(): BoopConfig {
  const path = configPath();
  // Read the file if present; a missing file is fine (all defaults, env
  // still applies below). Anything else — a read error or malformed JSON —
  // fails startup naming the path.
  let config: Record<string, unknown> = {};
  try {
    const raw = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`malformed JSON in ${path}: ${message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${path} must contain a JSON object`);
    }
    config = parsed as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT") throw error;
  }

  const executor = config.executor;
  if (executor !== undefined && typeof executor !== "string") {
    throw new Error(`${path}: "executor" must be a string (an executor id)`);
  }

  const port = config.port !== undefined ? config.port : 3000;
  if (typeof port !== "number") {
    throw new Error(`${path}: "port" must be a number`);
  }

  const host = config.host !== undefined ? config.host : "0.0.0.0";
  if (typeof host !== "string") {
    throw new Error(`${path}: "host" must be a string`);
  }

  const logLevel = config.logLevel !== undefined ? config.logLevel : "info";
  if (typeof logLevel !== "string" || !LOG_LEVELS.has(logLevel as LogLevel)) {
    throw new Error(
      `${path}: "logLevel" must be one of ${[...LOG_LEVELS].join(", ")}`,
    );
  }

  const finalPort = process.env.BOOP_PORT ? Number(process.env.BOOP_PORT) : port;
  if (process.env.BOOP_PORT !== undefined && Number.isNaN(finalPort)) {
    throw new Error(`BOOP_PORT environment variable must be a number`);
  }

  const finalLogLevel = process.env.BOOP_LOG ?? logLevel;
  if (typeof finalLogLevel !== "string" || !LOG_LEVELS.has(finalLogLevel as LogLevel)) {
    throw new Error(
      `BOOP_LOG must be one of ${[...LOG_LEVELS].join(", ")}`,
    );
  }

  return {
    ...config,
    executor: process.env.BOOP_EXECUTOR ?? executor,
    port: finalPort,
    host: process.env.BOOP_HOST ?? host,
    logLevel: finalLogLevel as LogLevel,
  } as BoopConfig;
}
