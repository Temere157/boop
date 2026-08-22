import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "./plugin.js";

/**
 * Discover and load plugins from a list of directories, in order.
 *
 * Each entry in `dirs` is scanned for `.ts`/`.js` files (skipping `.d.ts`
 * and dotfiles); each file is dynamically `import()`ed and its exports
 * inspected for a {@link Plugin} (a default export, or the single named
 * export whose value looks like one). A module with no plugin, more than
 * one, or a plugin of the wrong shape throws, naming the file — the same
 * startup-failure tone as a malformed config (see {@link "./config.js"}).
 * A plugin name that already appeared in an earlier directory is skipped
 * (first directory wins), so a later directory can't silently shadow a
 * core plugin.
 *
 * Plugin files are loaded directly: at dev time `tsx` handles the `.ts`,
 * and in production Node's type stripping loads it. For that to work a
 * plugin must stay within erasable syntax (no enums, namespaces, parameter
 * properties, …) — enforced by the `plugins/` project's `erasableSyntaxOnly`.
 * Every boop import in a plugin is `import type`, so the boop contract never
 * has to be resolvable at runtime: the `@boop/plugin` specifier is erased.
 */
export async function loadPlugins(dirs: string[]): Promise<Plugin[]> {
  const out: Plugin[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
      if (file.endsWith(".d.ts")) continue;
      if (file.startsWith(".")) continue;
      const url = pathToFileURL(join(dir, file)).href;
      const mod = (await import(url)) as Record<string, unknown>;
      const plugin = pickPlugin(mod, file);
      if (seen.has(plugin.name)) continue;
      seen.add(plugin.name);
      out.push(plugin);
    }
  }
  return out;
}

/**
 * Extracts the {@link Plugin} from a loaded module: a `default` export that
 * looks like a plugin, or the single named export that does. Throws if the
 * module has no plugin, more than one, or a candidate with the wrong
 * shape. A `default` export that re-exports a named one is deduped by
 * reference.
 */
function pickPlugin(mod: Record<string, unknown>, file: string): Plugin {
  const candidates: Plugin[] = [];
  if (looksLikePlugin(mod.default)) candidates.push(mod.default as Plugin);
  for (const value of Object.values(mod)) {
    if (looksLikePlugin(value)) candidates.push(value as Plugin);
  }
  const unique = [...new Set(candidates)];
  if (unique.length === 0) {
    throw new Error(`${file}: no Plugin export found`);
  }
  if (unique.length > 1) {
    throw new Error(
      `${file}: multiple Plugin exports found; export one as default`,
    );
  }
  return unique[0]!;
}

function looksLikePlugin(value: unknown): value is Plugin {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { init?: unknown }).init === "function"
  );
}
