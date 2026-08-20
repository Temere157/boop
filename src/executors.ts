import type { Executors, SessionExecutor } from "./plugin.js";

/**
 * The core session-executor registry. This is shared infrastructure, not a
 * plugin: the main loop needs exactly one low-level executor to hand each
 * prepared session to, and that executor is supplied by a plugin at init
 * time via the {@link Executors} capability.
 *
 * At most one executor may be registered — two would both try to own the
 * per-event agentic loop. {@link get} returns `undefined` until a plugin has
 * registered one; the core's session runner treats that as a no-op skip so
 * the loop still runs (and logs) before any executor plugin is configured.
 */
export class ExecutorRegistry implements Executors {
  private executor: SessionExecutor | null = null;

  register(executor: SessionExecutor): void {
    if (this.executor !== null) {
      throw new Error("session executor already registered");
    }
    this.executor = executor;
  }

  /** The registered executor, or `undefined` if no plugin has set one. */
  get(): SessionExecutor | undefined {
    return this.executor ?? undefined;
  }
}
