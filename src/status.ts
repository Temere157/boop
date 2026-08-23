import type { SessionStatus, StatusEvents } from "./plugin.js";

/**
 * The core session-status bus.
 * This is shared infrastructure, not a plugin: the main loop emits a {@link SessionStatus} transition here around every event it handles (`busy` when it starts, `idle` when it finishes), and any plugin that wants to mirror that state to its clients subscribes.
 *
 * It is deliberately a global signal — it fires for every event, whatever its source — so a client can see the agent is busy even when the work was triggered by another channel (an HTTP ingest, another webui tab), not just its own.
 * The bus carries the event source string (a short name like `"webui"` or `"ingest"`) on the `busy` transition so a subscriber can show what is being worked on; it carries `null` on `idle`.
 * It does not carry the event payload, so one client's message text is never leaked to another client through this path.
 *
 * The bus remembers the current status and replays it to a new subscriber immediately on {@link subscribe}, so a client that connects mid-processing gets the right state without waiting for the next transition.
 */
export class StatusBus implements StatusEvents {
  private listeners: Set<(status: SessionStatus, source: string | null) => void> =
    new Set();
  private currentStatus: SessionStatus = "idle";
  private currentSource: string | null = null;

  /** The status most recently reported via {@link notify}. */
  get current(): { status: SessionStatus; source: string | null } {
    return { status: this.currentStatus, source: this.currentSource };
  }

  /**
   * Register a listener and immediately call it with the current status.
   * The listener stays registered for the life of the bus; there is no `unsubscribe` because subscribers (a webui plugin) live as long as the process.
   */
  subscribe(
    listener: (status: SessionStatus, source: string | null) => void,
  ): void {
    this.listeners.add(listener);
    listener(this.currentStatus, this.currentSource);
  }

  /**
   * Update the current status and fan the transition out to every subscriber.
   * Called by the main loop around each event's execution.
   */
  notify(status: SessionStatus, source: string | null): void {
    this.currentStatus = status;
    this.currentSource = source;
    for (const listener of this.listeners) {
      listener(status, source);
    }
  }
}
