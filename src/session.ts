import type { Event } from "./event.js";
import { log } from "./log.js";
import { startRecording } from "./record.js";
import type {
  McpServer,
  PreparedSession,
  ResponseChannel,
  SessionMessage,
  ToolInvocation,
  ToolResult,
  TranscriptEntry,
} from "./plugin.js";
import type { ExecutorRegistry } from "./executors.js";
import type { PreparerRegistry } from "./preparers.js";
import type { ResponseChannelRegistry } from "./responses.js";
import type { ToolRegistry } from "./tools.js";

const sessionLog = log("session");

/**
 * The core's per-event handler. This is the bridge between the main loop
 * and a plugin-supplied low-level {@link SessionExecutor}: for each event
 * it prepares a {@link PreparedSession} (event + system prompt + first
 * user message + tools with a safe invocation wrapper), hands it to the
 * configured executor, and persists the returned transcript as a JSONL
 * recording (see {@link startRecording}) in addition to logging it.
 *
 * Preparation is entirely on the core side so the executor receives
 * something it can run directly: the system prompt and the first user
 * message (carrying the event) are built here, and the
 * raw {@link ToolRegistry} is wrapped so a crashing or unknown tool comes
 * back as a semantic {@link ToolResult} (with `isError`) rather than an
 * exception — an executor's agentic loop can keep going on a tool error.
 */
export class SessionRunner {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly executors: ExecutorRegistry,
    private readonly mcp: McpServer,
    private readonly responses: ResponseChannelRegistry,
    private readonly preparers: PreparerRegistry,
    private readonly executorId: string | undefined,
  ) {}

  /** Per-event entry point; matches the {@link EventExecutor} signature. */
  async run(event: Event): Promise<void> {
    const executor =
      this.executorId === undefined
        ? undefined
        : this.executors.get(this.executorId);
    if (executor === undefined) {
      sessionLog.warn("no session executor registered; skipping event", {
        id: event.id,
        source: event.source,
        executorId: this.executorId ?? null,
        available: this.executors.ids(),
      });
      return;
    }
    const session = await this.prepare(event);
    const recording = await startRecording(event);
    const transcript = await executor(session);
    await recording.finish(transcript);
    this.log(event, transcript);
  }

  /**
   * Builds a {@link PreparedSession} for `event`: the system prompt, the
   * event rendered as the first user message, and the tools (wrapped so a
   * crashing or unknown tool comes back as a semantic result). Then runs
   * every registered session preparer in registration order, letting each
   * mutate `session.messages` (e.g. inject memory context) before the
   * executor runs. No preparer ordering is guaranteed.
   */
  private async prepare(event: Event): Promise<PreparedSession> {
    const tools: ToolInvocation = {
      definitions: this.tools.all.map((t) => t.definition),
      call: (name, args) => this.callTool(name, args),
    };
    const session: PreparedSession = {
      event,
      systemPrompt: buildSystemPrompt(),
      messages: [
        { role: "user", content: buildFirstUserMessage(event, this.responses.all) },
      ],
      tools,
      mcp: this.mcp,
    };
    for (const prepare of this.preparers.all) {
      await prepare(session);
    }
    return session;
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
    sessionLog.debug("transcript", { id: event.id, source: event.source });
    for (const entry of transcript.entries) {
      this.logEntry(entry);
    }
  }

  private logEntry(entry: TranscriptEntry): void {
    const tag = entry.role.toUpperCase();
    const suffix = [entry.toolName, entry.toolCallId]
      .filter((s) => s !== undefined)
      .map((s) => ` ${s}`)
      .join("");
    sessionLog.trace(`${tag}${suffix}: ${entry.content}`);
    if (typeof entry.thinking === "string" && entry.thinking.length > 0) {
      sessionLog.trace(`  thinking: ${entry.thinking}`);
    }
    if (entry.toolCalls !== undefined) {
      for (const call of entry.toolCalls) {
        sessionLog.trace(`  -> ${call.name}(${JSON.stringify(call.args)}) [${call.id}]`);
      }
    }
    if (entry.result !== undefined) {
      const text = entry.result.content
        .map((b) => b.text ?? "")
        .join("");
      sessionLog.trace(
        `  result isError=${entry.result.isError ?? false}: ${text}`,
      );
    }
  }
}

/**
 * Builds the system prompt for a session. The prompt is fixed role text —
 * the event itself is delivered as the first user message (see
 * {@link buildFirstUserMessage}) and richer context is added by registered
 * {@link SessionPreparer}s adjusting {@link PreparedSession.messages}, not
 * by extending this prompt.
 */
function buildSystemPrompt(): string {
  return [
    "You are boop, a persistent, single-user AI agent. You handle a single",
    "event in a transient session: decide what to do, use the available",
    "tools to act, then finish. Anything worth remembering across sessions",
    "should be written to memory when a memory tool is available.",
    "",
    "Your direct textual output (assistant messages that are not tool",
    "calls) is only logged; the user will not generally see it. To reach a",
    "user, use the `respond` tool against an open response channel, and to",
    "persist anything, write it to memory with the memory tools.",
    "",
    "Finish every session with a final plain-text assistant message (no",
    "tool calls): a one-line summary of the outcome — what you did and what",
    "changed. Once you have acted and have nothing left to do, write that",
    "summary and stop — do not call further tools looking for more work.",
    "This summary is what a later review of the session reads first, so",
    "make it a useful, specific recap, not a greeting or a restatement of",
    "the event.",
  ].join("\n");
}

/**
 * Renders the event as the session's first user message (the seed entry of
 * {@link PreparedSession.messages}), so the event arrives as a normal user
 * turn rather than being baked into the system prompt. The message also
 * enumerates every currently-open response channel — not just one tied to
 * this event, since channels are independent of events: an eternal SMS
 * channel is listed in every session message while a transient webui or
 * HTTP ingest channel appears only while its owner is holding it open.
 * This is a snapshot taken at `prepare()` time as a hint; the `respond`
 * tool queries the registry live, so a channel listed here may already be
 * gone by call time. Registered {@link SessionPreparer}s may add further
 * user/assistant messages after this seed.
 */
function buildFirstUserMessage(
  event: Event,
  channels: readonly ResponseChannel[],
): string {
  const lines = [
    `Event source: ${event.source}`,
    "Event payload:",
    JSON.stringify(event.payload, null, 2),
  ];
  if (channels.length > 0) {
    lines.push(
      "",
      "Open response channels (send via the `respond` tool; each is open only",
      "while its owner is willing to deliver, so one may close before you",
      "send — that returns an error):",
    );
    for (const c of channels) {
      lines.push(`- ${c.id}${c.description ? `: ${c.description}` : ""}`);
    }
  } else {
    lines.push(
      "",
      "No response channels are currently open; no originator is awaiting a reply.",
    );
  }
  return lines.join("\n");
}
