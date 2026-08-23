import type { SessionPreparer, SessionPreparers } from "./plugin.js";

/**
 * The core session-preparer registry.
 * Preparers are hooks a plugin may register to adjust a prepared session — typically its {@link PreparedSession.messages messages} list — before the low-level executor runs it.
 * The core runs every registered preparer after seeding the session (system prompt + first user message) and before handing it to the executor; memory/context injection is the expected first user.
 *
 * There is no ordering or priority: preparers run in registration order but must not rely on that, and a duplicate function may be registered again.
 * Unlike executors (which register under a stable id and only one runs per session), every registered preparer runs for every session.
 */
export class PreparerRegistry implements SessionPreparers {
  private readonly preparers: SessionPreparer[] = [];

  register(preparer: SessionPreparer): void {
    this.preparers.push(preparer);
  }

  /** Every registered preparer, in registration order. */
  get all(): readonly SessionPreparer[] {
    return this.preparers;
  }
}
