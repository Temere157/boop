import type { Event } from "./event.js";
import { mainLoop } from "./main.js";
import { EventQueue } from "./queue.js";

const queue = new EventQueue();

// TODO: event executor. This is where a transient session is spawned per
// event: load relevant context from memory, run the LLM with its tools,
// flush anything worth remembering back to memory, then end the session.
const execute = async (_event: Event): Promise<void> => {
  // TODO: implement the event executor (sessions + memory + LLM + tools).
};

// Graceful shutdown: close the queue so a pending pull rejects and the loop
// exits cleanly.
const stop = (signal: string) => {
  console.log(`received ${signal}, shutting down`);
  queue.close();
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

await mainLoop(queue, execute);
