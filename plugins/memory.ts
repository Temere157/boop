import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin, ToolResult } from "@boop/plugin";

/** Soft cap; writes above this are logged but not blocked. */
const SOFT_CAP_BYTES = 8192;

/**
 * A builtin short-term memory plugin — the first concrete memory store.
 * It keeps a single small file in the plugin's state directory whose contents are injected into every session as a user message (via a session preparer) and that the agent overwrites with an `update_short_term_memory` tool before finishing.
 * This is the agent's cross-session continuity: each transient session reads it on the way in and refreshes it on the way out.
 *
 * The memory message is *prepended* to the session's message list, ahead of the event, so the event arrives as the final thing for the agent to act on — context first, task last.
 *
 * The plugin depends only on the {@link Plugin} contract (it gets its state directory from the host), not on any core implementation, so it could be moved to an external package as-is.
 *
 * Tool: `update_short_term_memory`
 *   args : { content: string }   (full new contents, replaces the file)
 *   ->   { content: [{ text }] } (confirmation + byte count; warns if large)
 */
export const shortTermMemoryPlugin: Plugin = {
  name: "short-term-memory",
  async init(host) {
    const mem = host.log("memory");
    const memoryPath = join(host.paths.stateDir, "short-term-memory.md");
    // Ensure the file exists from startup so it's inspectable and the preparer never has to create it mid-session.
    // `open(..., "a")` creates without truncating; the state dir already exists.
    await open(memoryPath, "a").then((f) => f.close());
    mem.info("short-term memory", { path: memoryPath });

    // Inject current contents into every session as a user message, ahead of the event message so the agent sees context first.
    host.prepare.register(async (session) => {
      let contents = "";
      try {
        contents = (await readFile(memoryPath, "utf8")).trim();
      } catch {
        // open() above should prevent this, but be defensive.
      }
      session.messages.unshift({
        role: "user",
        content: injectMessage(contents),
      });
    });

    // The tool the agent uses to refresh memory before finishing.
    host.tools.register(
      {
        name: "update_short_term_memory",
        description:
          "Replace the short-term memory file — the small note that persists across sessions and is injected into every session. " +
          "Call this before finishing the session to refresh it with what is current: what is in progress, what you just did, what to pick up next, any facts worth remembering. " +
          "Keep it concise (a few hundred to a couple thousand characters); it is a scratchpad of current state, not a full history.",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description:
                "The full new contents of the short-term memory, " +
                "replacing what was there.",
            },
          },
          required: ["content"],
        },
      },
      async (args): Promise<ToolResult> => {
        const content = String(args.content ?? "");
        await writeFile(memoryPath, content, "utf8");
        const bytes = Buffer.byteLength(content, "utf8");
        const large = bytes > SOFT_CAP_BYTES;
        if (large) mem.warn("large write", { bytes, path: memoryPath });
        return {
          content: [
            {
              type: "text",
              text:
                `Updated short-term memory (${bytes} bytes) at ${memoryPath}.` +
                (large
                  ? " That is larger than the soft cap; consider trimming it to current state."
                  : ""),
            },
          ],
        };
      },
    );
  },
};

/**
 * The user message that carries current short-term memory into a session, with the standing instruction to refresh it before finishing.
 */
function injectMessage(contents: string): string {
  const body =
    contents.length > 0
      ? contents
      : "(empty — this is the first session, or it was cleared. " +
        "Initialize it with `update_short_term_memory` before finishing.)";
  return [
    "Short-term memory — your continuity across sessions.",
    "This is the current state you carry forward: what is in progress, what you just did, what to pick up next, facts worth remembering.",
    "",
    "Before you finish this session, call `update_short_term_memory` with the refreshed contents so the next session picks up where you left off.",
    "Treat updating it as the last step of every session, even if the event was minor — at least confirm nothing changed.",
    "",
    "Current short-term memory:",
    "---",
    body,
    "---",
  ].join("\n");
}
