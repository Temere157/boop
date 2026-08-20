import type { Event } from "./event.js";
import { EventQueue, QueueClosedError } from "./queue.js";

/**
 * Handles a single dequeued event.
 *
 * The executor is responsible for spinning up a transient session, loading
 * relevant context from memory, running the LLM with its tools, flushing
 * anything worth remembering back to memory, and tearing the session down.
 * It is the whole "do the work" half of the main loop; the loop itself
 * only pulls and dispatches.
 *
 * TODO: implement. This is the session/memory/LLM side of the agent and is
 * the largest remaining piece.
 */
export type EventExecutor = (event: Event) => Promise<void>;

/**
 * The boop main loop: a thin spine that pulls events from the queue one at
 * a time and hands each to {@link execute}. Everything interesting —
 * sessions, memory, the LLM, tools — lives behind {@link execute}; this
 * function only owns the pull/dispatch cycle.
 *
 * The loop runs until the queue is closed (graceful shutdown) or
 * {@link execute} throws (an unexpected failure in event handling). A
 * {@link QueueClosedError} raised by {@link pull} is treated as a normal
 * stop and does not propagate.
 */
export async function mainLoop(
  queue: EventQueue,
  execute: EventExecutor,
): Promise<void> {
  try {
    while (true) {
      const event = await queue.pull();
      await execute(event);
    }
  } catch (error) {
    if (error instanceof QueueClosedError) return;
    throw error;
  }
}
