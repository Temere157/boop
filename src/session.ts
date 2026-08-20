import type { Event } from "./event.js";
import type { McpServer } from "./plugin.js";
import type {
  PreparedSession,
  ToolInvocation,
  ToolResult,
  TranscriptEntry,
} from "./plugin.js";
import type { ExecutorRegistry } from "./executors.js";
import type { ToolRegistry } from "./tools.js";

/**
 * The core's per-event handler. This is the bridge between the main loop
 * and a plugin-supplied low-level {@link SessionExecutor}: for each event
 * it prepares a {@link PreparedSession} (event + system prompt + tools with
 * a safe invocation wrapper), hands it to the registered executor, and logs
 * the returned transcript. Persistence of the transcript is a TODO; for now
 * logging is how each event's handling is recorded.
 *
 * Preparation is entirely on the core side so the executor receives
 * something it can run directly: the system prompt is built here, and the
 * raw {@link ToolRegistry} is wrapped so a crashing or unknown tool comes
 * back as a semantic {@link ToolResult} (with `isError`) rather than an
 * exception — an executor's agentic loop can keep going on a tool error.
 */
export class SessionRunner {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly executors: ExecutorRegistry,
    private readonly mcp: McpServer,
  ) {}

  /** Per-event entry point; matches the {@link EventExecutor} signature. */
  async run(event: Event): Promise<void> {
    const executor = this.executors.get();
    if (executor === undefined) {
      console.log(
        `no session executor registered; skipping event ${event.id} (${event.source})`,
      );
      return;
    }
    const session = this.prepare(event);
    const transcript = await executor(session);
    this.log(event, transcript);
  }

  private prepare(event: Event): PreparedSession {
    const tools: ToolInvocation = {
      definitions: this.tools.all.map((t) => t.definition),
      call: (name, args) => this.callTool(name, args),
    };
    return {
      event,
      systemPrompt: buildSystemPrompt(event),
      tools,
      mcp: this.mcp,
    };
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = this.tools.find(name);
    if (tool === undefined) {
      return {
        content: [{ type: "text", text: `unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      return await tool.handler(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `tool ${name} failed: ${message}` }],
        isError: true,
      };
    }
  }

  private log(event: Event, transcript: { entries: readonly TranscriptEntry[] }): void {
    console.log(
      `--- session transcript ${event.id} source=${event.source} ---`,
    );
    for (const entry of transcript.entries) {
      this.logEntry(entry);
    }
    console.log(`--- end transcript ---`);
  }

  private logEntry(entry: TranscriptEntry): void {
    const tag = entry.role.toUpperCase();
    const suffix = [entry.toolName, entry.toolCallId]
      .filter((s) => s !== undefined)
      .map((s) => ` ${s}`)
      .join("");
    console.log(`${tag}${suffix}: ${entry.content}`);
    if (entry.toolCalls !== undefined) {
      for (const call of entry.toolCalls) {
        console.log(`  -> ${call.name}(${JSON.stringify(call.args)}) [${call.id}]`);
      }
    }
    if (entry.result !== undefined) {
      const text = entry.result.content
        .map((b) => b.text ?? "")
        .join("");
      console.log(
        `  result isError=${entry.result.isError ?? false}: ${text}`,
      );
    }
  }
}

/**
 * Builds the system prompt for a session. The prompt gives the agent its
 * role and the event it is handling; richer context (loaded from memory)
 * will be appended here as memory is built.
 */
function buildSystemPrompt(event: Event): string {
  return [
    "You are boop, a persistent, single-user AI agent. You handle a single",
    "event in a transient session: decide what to do, use the available",
    "tools to act, then finish. Anything worth remembering across sessions",
    "should be written to memory when a memory tool is available.",
    "",
    `Event source: ${event.source}`,
    "Event payload:",
    JSON.stringify(event.payload, null, 2),
  ].join("\n");
}
