/**
 * An event is a single unit of work produced by an event provider and consumed by the main loop.
 * The shape is intentionally minimal: providers tag where the event came from and carry an opaque payload; whatever the event actually means is for the session that handles it to interpret.
 */
export type Event = {
  /** Stable identifier for tracing/logging. */
  readonly id: string;
  /** Name of the provider that produced this event. */
  readonly source: string;
  /** Provider-specific event data. */
  readonly payload: unknown;
  /** When the event was created, as epoch milliseconds. */
  readonly createdAt: number;
};
