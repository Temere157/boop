import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "./plugin.js";

/**
 * Discover and load plugins from a list of directories, in order.
 *
 * Each top-level entry in a directory is either a single plugin file (`.ts`/`.js`/`.mjs`, imported directly) or a plugin package — a directory whose entry is resolved from its `package.json` (`exports["."]` → `"main"` → `"module"`) or, failing that, an `index.{ts,js,mjs}` file.
 * The resolved entry is dynamically `import()`ed and its exports inspected for a {@link Plugin} (a default export, or the single named export whose value looks like one).
 *
 * Node resolves a package's dependencies from the entry file's location — walking up to the nearest `node_modules` — so a package with its own dependencies (or one nix-symlinked into place with its deps alongside) loads the same way as a dependency-less directory; the loader only has to hand Node the entry path.
 *
 * A module with no plugin, more than one, or a plugin of the wrong shape throws, naming the entry — the same startup-failure tone as a malformed config (see {@link "./config.js"}).
 * A directory entry with no resolvable entry also throws.
 * A plugin name that already appeared in an earlier entry or directory is skipped (first wins), so a later directory can't silently shadow a core plugin.
 *
 * Source `.ts` plugins are loaded directly: at dev time `tsx` handles them, and in production Node 26's type stripping loads them with no build step.
 * For that to work a plugin must stay within erasable syntax (no enums, namespaces, parameter properties, …) — enforced for the in-tree `plugins/` project by its `erasableSyntaxOnly`.
 * Every boop import in a plugin is `import type`, so the boop contract never has to be resolvable at runtime.
 */
export async function loadPlugins(dirs: string[]): Promise<Plugin[]> {
  const out: Plugin[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = await resolveEntry(dir, entry);
      if (entryPath === undefined) continue;
      const url = pathToFileURL(entryPath).href;
      const mod = (await import(url)) as Record<string, unknown>;
      const plugin = pickPlugin(mod, entry.name);
      if (seen.has(plugin.name)) continue;
      seen.add(plugin.name);
      out.push(plugin);
    }
  }
  return out;
}

/**
 * Resolves a top-level entry in a plugin directory to a file path to `import()`.
 * A loadable file entry (`.ts`/`.js`/`.mjs`, excluding `.d.ts`) is used directly; a directory entry is resolved through its `package.json` or an `index.{ts,js,mjs}` fallback.
 * Non-loadable files and non-regular entries (symlinks to dirs are followed by `isDirectory`) return `undefined` (skipped); a directory with no resolvable entry throws.
 */
async function resolveEntry(
  dir: string,
  entry: { name: string; isDirectory(): boolean; isFile(): boolean },
): Promise<string | undefined> {
  if (entry.isDirectory()) {
    return resolvePackageEntry(join(dir, entry.name), entry.name);
  }
  if (!entry.isFile()) return undefined;
  if (!isLoadable(entry.name)) return undefined;
  return join(dir, entry.name);
}

function isLoadable(name: string): boolean {
  if (name.endsWith(".d.ts")) return false;
  return name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".mjs");
}

/**
 * Resolves a package directory's entry file: from `package.json` (`exports["."]` → `"main"` → `"module"`), else `index.{ts,js,mjs}`.
 * Throws if no entry is found, naming the directory.
 */
async function resolvePackageEntry(
  pkgDir: string,
  label: string,
): Promise<string> {
  let fromPackageJson: string | undefined;
  try {
    const raw = await readFile(join(pkgDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    fromPackageJson =
      resolveExports(pkg.exports) ??
      (typeof pkg.main === "string" ? pkg.main : undefined) ??
      (typeof pkg.module === "string" ? pkg.module : undefined);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") throw err;
  }
  if (fromPackageJson) return join(pkgDir, fromPackageJson);
  for (const index of ["index.ts", "index.js", "index.mjs"]) {
    const candidate = join(pkgDir, index);
    try {
      await readFile(candidate);
      return candidate;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT") throw err;
    }
  }
  throw new Error(
    `${label}: no plugin entry found (no package.json exports/main/module, no index.{ts,js,mjs})`,
  );
}

/**
 * Resolves the entry path from a `package.json` `exports` field: the top-level string shorthand, `exports["."]` as a string, or `exports["."]` as a condition map (`import` → `default`).
 */
function resolveExports(exportsField: unknown): string | undefined {
  if (typeof exportsField === "string") return exportsField;
  if (exportsField && typeof exportsField === "object") {
    const obj = exportsField as Record<string, unknown>;
    const dot = obj["."];
    if (typeof dot === "string") return dot;
    if (dot && typeof dot === "object") {
      const cond = dot as Record<string, unknown>;
      if (typeof cond.import === "string") return cond.import;
      if (typeof cond.default === "string") return cond.default;
    }
  }
  return undefined;
}

/**
 * Extracts the {@link Plugin} from a loaded module: a `default` export that looks like a plugin, or the single named export that does.
 * Throws if the module has no plugin, more than one, or a candidate with the wrong shape.
 * A `default` export that re-exports a named one is deduped by reference.
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
