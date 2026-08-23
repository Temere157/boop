import type { Executors, SessionExecutor } from "./plugin.js";

/**
 * The core session-executor registry.
 * This is shared infrastructure, not a plugin: the main loop hands each prepared session to one low-level executor, and executors are supplied by plugins at init time via the {@link Executors} capability, registered under a stable id.
 *
 * Several executors may be registered; the id is the selection key, and the core picks which one to run at startup (see {@link SessionRunner}).
 * {@link get} returns `undefined` for an id no plugin has registered; the core's session runner treats a missing executor as a no-op skip so the loop still runs (and logs) before any executor plugin is configured.
 */
export class ExecutorRegistry implements Executors {
  private readonly executors = new Map<string, SessionExecutor>();

  register(id: string, executor: SessionExecutor): void {
    if (this.executors.has(id)) {
      throw new Error(`duplicate executor id: ${id}`);
    }
    this.executors.set(id, executor);
  }

  /** The executor registered under `id`, or `undefined` if none. */
  get(id: string): SessionExecutor | undefined {
    return this.executors.get(id);
  }

  /** The ids of every registered executor, in registration order. */
  ids(): string[] {
    return [...this.executors.keys()];
  }
}
