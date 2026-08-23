import type { Logger, LogLevel } from "./plugin.js";

/**
 * A tiny zero-dependency logger: level-filtered, scoped, writing to stderr.
 *
 * The threshold is read once from `BOOP_LOG` at module load (default `info`); anything at or above it is written, anything below is dropped.
 * Levels are `trace` < `debug` < `info` < `warn` < `error`, plus `silent` to suppress everything.
 * Unknown values fall back to `info`.
 *
 * Each call produces a single line of the form
 *   `<iso-date> <level> <scope> <msg> <args...>`
 * where non-string args are JSON-serialised.
 * The scope gives the per-subsystem prefix (`mcp`, `claude`, `http`, …) that grep expects, without callers hand-formatting it.
 *
 * Output goes to stderr so it never collides with anything on stdout (e.g. a future transcript dump) and so logs stay out of the way when boop's output is piped.
 */

export type { LogLevel } from "./plugin.js";

const ORDER: readonly LogLevel[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "silent",
];

let level: LogLevel = "info";

/** Change the active threshold at runtime (rarely needed). */
export function setLevel(l: LogLevel): void {
  level = l;
}

function format(
  l: LogLevel,
  scope: string,
  msg: string,
  args: readonly unknown[],
): string {
  const parts = [
    new Date().toISOString(),
    l,
    scope,
    msg,
    ...args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))),
  ];
  return parts.join(" ");
}

/**
 * Creates a scoped logger.
 * Call once per subsystem and reuse:
 *
 * ```ts
 * import { log } from "./log.js";
 * const mcp = log("mcp");
 * mcp.info("listening", { path });
 * mcp.trace("recv", line);
 * ```
 */
export function log(scope: string): Logger {
  const make =
    (l: LogLevel) =>
    (msg: string, ...args: unknown[]): void => {
      if (ORDER.indexOf(l) >= ORDER.indexOf(level)) {
        process.stderr.write(`${format(l, scope, msg, args)}\n`);
      }
    };
  return {
    scope,
    trace: make("trace"),
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
  };
}
