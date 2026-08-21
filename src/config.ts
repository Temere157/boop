import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Boop's config, loaded once at startup: a small JSON file with optional
 * keys (unknown keys ignored), read from {@link configPath}. A missing file
 * is the empty config (all defaults); a malformed file fails startup.
 */
export interface BoopConfig {
  /** Id of the session executor to run each event's session. */
  readonly executor?: string;
  readonly [key: string]: unknown;
}

/**
 * The config file path: `$XDG_CONFIG_HOME/boop/config.json`, falling back
 * to `~/.config/boop/config.json` (per the XDG Base Directory spec),
 * mirroring the state dir session recordings live in (see
 * {@link startRecording}).
 */
export function configPath(): string {
  const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(config, "boop", "config.json");
}

/**
 * Loads boop's config from {@link configPath}. A missing file yields the
 * empty config (all defaults); a malformed file throws naming the path.
 */
export function loadConfig(): BoopConfig {
  const path = configPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return {};
    throw error;
  }
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
  const config = parsed as Record<string, unknown>;
  if (config.executor !== undefined && typeof config.executor !== "string") {
    throw new Error(`${path}: "executor" must be a string (an executor id)`);
  }
  return config as BoopConfig;
}
