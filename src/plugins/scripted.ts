import type {
  PreparedSession,
  Plugin,
  SessionExecutor,
  SessionTranscript,
  TranscriptEntry,
} from "../plugin.js";

/**
 * A builtin scripted session executor. It is a stand-in for a real
 * LLM-driven executor: with no LLM wired up yet, it runs a fixed little
 * loop that exercises the full handoff — it renders the prepared event as
 * the user turn, calls the `log` tool (if registered) to show tool
 * invocation working end to end, and returns a transcript. It is meant to
 * be replaced by a real provider/runtime executor plugin, not kept.
 *
 * The plugin depends only on the {@link Plugin} contract, not on any core
 * implementation, so it could be moved to an external package as-is.
 */
export const scriptedExecutorPlugin: Plugin = {
  name: "scripted-executor",
  init(host) {
    host.executors.register(run);
  },
};

const run: SessionExecutor = async (
  session: PreparedSession,
): Promise<SessionTranscript> => {
  const entries: TranscriptEntry[] = [
    { role: "system", content: session.systemPrompt },
    { role: "user", content: JSON.stringify(session.event.payload) },
  ];

  const hasLog = session.tools.definitions.some((d) => d.name === "log");
  if (hasLog) {
    const message = `handled ${session.event.source} event ${session.event.id}`;
    const callId = "call_1";
    entries.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id: callId, name: "log", args: { message } }],
    });
    const result = await session.tools.call("log", { message });
    const text = result.content.map((b) => b.text ?? "").join("");
    entries.push({
      role: "tool",
      content: text,
      toolCallId: callId,
      toolName: "log",
      result,
    });
    entries.push({ role: "assistant", content: "done" });
  } else {
    entries.push({
      role: "assistant",
      content: "no tools available; nothing to do",
    });
  }

  return { entries };
};
