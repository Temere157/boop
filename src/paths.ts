import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Boop's state directory: `$XDG_STATE_HOME/boop`, falling back to
 * `~/.local/state/boop` (per the XDG Base Directory spec). The base for
 * session recordings (`{dir}/sessions/`, see {@link "record.js"}) and for
 * per-plugin state (`{dir}/plugins/{name}/`, handed to each plugin via
 * {@link PluginPaths}).
 */
export function boopStateDir(): string {
  const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(state, "boop");
}

/**
 * Boop's config directory: `$XDG_CONFIG_HOME/boop`, falling back to
 * `~/.config/boop` (per the XDG Base Directory spec). The base for the
 * config file (see {@link "config.js"}) and, later, for per-plugin config
 * (`{dir}/plugins/{name}/`, a sibling of the per-plugin state dir).
 */
export function boopConfigDir(): string {
  const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(config, "boop");
}
