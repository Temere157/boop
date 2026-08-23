import type { Event } from "./event.js";

/**
 * Thrown by {@link EventQueue.pull} when the queue has been closed and no buffered events remain.
 * The main loop treats this as a normal stop signal.
 */
export class QueueClosedError extends Error {
  constructor() {
    super("event queue is closed");
    this.name = "QueueClosedError";
  }
}

/**
 * A FIFO queue of pending {@link Event}s.
 *
 * This is the single handoff point between the asynchronous outside world (providers pushing events) and the main loop's one-thing-at-a-time processing.
 * Providers call {@link push}; the loop calls {@link pull}.
 *
 * {@link pull} resolves as soon as an event is available, and blocks (awaits) when the queue is empty until either a new event arrives or the queue is closed.
 */
export class EventQueue {
  private buffer: Event[] = [];
  private waiters: Array<{
    resolve: (event: Event) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;

  /** Number of events buffered but not yet pulled. */
  get size(): number {
    return this.buffer.length;
  }

  /** True once {@link close} has been called. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Push an event onto the queue.
   * If a pull is already waiting, the event is handed straight to it; otherwise it is buffered.
   *
   * @throws if the queue has been closed.
   */
  push(event: Event): void {
    if (this.closed) {
      throw new QueueClosedError();
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(event);
    } else {
      this.buffer.push(event);
    }
  }

  /**
   * Pull the next event from the queue, waiting if necessary.
   * Resolves immediately when an event is buffered; otherwise awaits until a provider pushes one or the queue is closed.
   *
   * Buffered events are always drained before {@link QueueClosedError} is raised, so a close does not lose work that was already queued.
   */
  async pull(): Promise<Event> {
    if (this.buffer.length > 0) {
      // Non-null assertion is safe: length > 0 implies an element exists.
      return this.buffer.shift() as Event;
    }
    if (this.closed) {
      throw new QueueClosedError();
    }
    return new Promise<Event>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * Close the queue.
   * Pending pulls reject with {@link QueueClosedError}; future {@link push} calls throw.
   * Buffered events can still be drained by subsequent {@link pull} calls until the buffer is empty.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      w.reject(new QueueClosedError());
    }
  }
}
