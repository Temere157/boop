import type { Event } from "./event.js";
import { EventQueue, QueueClosedError } from "./queue.js";

/**
 * Handles a single dequeued event.
 *
 * In the core, this is the session runner: it prepares a transient session for the event (system prompt, tools, …) and hands it to the registered low-level {@link SessionExecutor}, which owns the actual agentic loop (LLM ↔ tools) and returns a transcript the core logs (and, later, persists).
 * The main loop itself only pulls and dispatches.
 */
export type EventExecutor = (event: Event) => Promise<void>;

/**
 * The boop main loop: a thin spine that pulls events from the queue one at a time and hands each to {@link execute}.
 * Everything interesting — sessions, memory, the LLM, tools — lives behind {@link execute}; this function only owns the pull/dispatch cycle.
 *
 * The loop runs until the queue is closed (graceful shutdown) or {@link execute} throws (an unexpected failure in event handling).
 * A {@link QueueClosedError} raised by {@link pull} is treated as a normal stop and does not propagate.
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
