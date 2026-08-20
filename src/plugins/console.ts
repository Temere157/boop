import type { Plugin, ToolResult } from "../plugin.js";

/**
 * A builtin console plugin. It registers a single tool — `log` — that lets
 * the agent write a message to the console (stdout) during a session, and
 * returns the logged text back as an MCP-shaped result so the executor (and
 * the LLM) can see what was written.
 *
 * The plugin depends only on the {@link Plugin} contract, not on any core
 * implementation, so it could be moved to an external package as-is.
 *
 * Tool: `log`
 *   args : { message: string }
 *   ->   writes `message` to stdout, returns `{ content: [{ text }] }`
 */
export const consolePlugin: Plugin = {
  name: "console",
  init(host) {
    const log = host.log("console");
    log.info("registering log tool");
    host.tools.register(
      {
        name: "log",
        description: "Write a message to the console (stdout).",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The message to write to the console.",
            },
          },
          required: ["message"],
        },
      },
      (args): ToolResult => {
        const message = String(args.message ?? "");
        console.log(message);
        return { content: [{ type: "text", text: message }] };
      },
    );
  },
};
