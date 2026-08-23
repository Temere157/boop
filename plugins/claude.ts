import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Logger,
  Plugin,
  PreparedSession,
  SessionExecutor,
  SessionTranscript,
  TranscriptEntry,
} from "@boop/plugin";

/**
 * A stdio-bridge shim, written to each session's tempdir and launched by claude as a command-based MCP server.
 * It connects to the unix socket at `$BOOP_MCP_SOCKET` and pipes stdin ↔ stdout through it, so claude's MCP stdio client ends up talking to boop's in-process MCP server over the socket — with no out-of-process hop back into boop.
 *
 * It is a standalone `.mjs` (no imports from boop) because it runs in its own node process, spawned by claude.
 */
const SHIM = `#!/usr/bin/env node
import { connect } from "node:net";
const path = process.env.BOOP_MCP_SOCKET;
if (!path) {
  console.error("BOOP_MCP_SOCKET not set");
  process.exit(1);
}
const sock = connect(path);
sock.on("connect", () => {
  process.stdin.pipe(sock);
  sock.pipe(process.stdout);
});
sock.on("error", (err) => {
  console.error("socket error: " + err.message);
  process.exit(1);
});
process.stdin.on("end", () => sock.end());
sock.on("end", () => process.exit(0));
`;

/**
 * A builtin session executor that runs `claude` in `--print` (non-interactive) mode as the agentic runtime, with boop's tools exposed over MCP via a per-session unix socket.
 *
 * The flow: bind a fresh MCP socket serving the session's tools, write the stdio-bridge shim into a tempdir, spawn `claude` there with an MCP config pointing at the shim (so claude's tool calls route back through the socket to boop's in-process handlers), then parse `--output-format stream-json`'s NDJSON stdout into a full transcript of the agentic loop (assistant turns, tool calls, tool results), and tear down the socket and tempdir.
 *
 * The plugin depends only on the {@link Plugin} contract, not on any core implementation, so it could be moved to an external package as-is.
 */
export const claudeExecutorPlugin: Plugin = {
  name: "claude-executor",
  init(host) {
    const claude = host.log("claude");
    host.executors.register("claude", (session) => run(session, claude));
  },
};

const run = async (
  session: PreparedSession,
  claude: Logger,
): Promise<SessionTranscript> => {
  const socket = await session.mcp.serve(session.tools);
  const dir = await mkdtemp(join(tmpdir(), "boop-claude-"));
  const shimPath = join(dir, "mcp-shim.mjs");
  await writeFile(shimPath, SHIM, { mode: 0o755 });
  claude.info("session", { socket: socket.path, shim: shimPath, cwd: dir });
  try {
    const mcpConfig = {
      mcpServers: {
        boop: {
          command: "node",
          args: [shimPath],
          env: { BOOP_MCP_SOCKET: socket.path },
        },
      },
    };
    const mcpConfigJson = JSON.stringify(mcpConfig);
    claude.debug("mcp-config", mcpConfigJson);
    const outcome = await runClaude({
      cwd: dir,
      mcpConfigJson,
      systemPrompt: session.systemPrompt,
      // claude `--print` takes a single prompt; merge the prepared user/assistant turns into one.
      // Today the seed is a single user message, but preparers may add context user messages, so join all of them.
      message: session.messages.map((m) => m.content).join("\n\n"),
      socketPath: socket.path,
      claude,
    });
    const entries: TranscriptEntry[] = [
      { role: "system", content: session.systemPrompt },
      ...session.messages.map((m): TranscriptEntry => ({
        role: m.role,
        content: m.content,
      })),
    ];
    if (outcome.error !== undefined) {
      entries.push({
        role: "assistant",
        content: `claude failed to start: ${outcome.error}`,
      });
    } else if (outcome.code !== 0) {
      entries.push({
        role: "assistant",
        content: `claude exited ${outcome.code}\n${outcome.stderr}`.trimEnd(),
      });
    } else {
      entries.push(...parseStreamJson(outcome.stdout, claude));
    }
    return { entries };
  } finally {
    await rm(dir, { recursive: true, force: true });
    await socket.close();
  }
};

/**
 * Parses claude's `--output-format stream-json` stdout (NDJSON) into transcript entries.
 * Each line is one object:
 *
 * - `{"type":"system","subtype":"init",...}` — session init; logged, not an entry (boop already records the system prompt and first user turn).
 * - `{"type":"assistant","message":{...}}` — an assistant turn; content blocks map to text, thinking, and tool calls.
 *   Turns with none of these (models that emit no thinking summary) are skipped.
 * - `{"type":"user","message":{...}}` — a tool-result turn; each `tool_result` block becomes a `tool` entry.
 * - `{"type":"result",...}` — the final summary; logged (cost/usage).
 *   Its `result` text is not an entry: it restates the last assistant turn.
 *
 * Unparseable lines and unknown types are skipped (logged at debug) so a format change degrades the transcript rather than crashing the session.
 */
function parseStreamJson(stdout: string, claude: Logger): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      claude.debug("stream-json: skipping unparseable line", trimmed);
      continue;
    }
    switch (obj.type) {
      case "system":
        claude.debug("stream-json: init", trimmed);
        break;
      case "assistant": {
        const message = obj.message as { content?: unknown[] } | undefined;
        const blocks = Array.isArray(message?.content) ? message.content : [];
        let text = "";
        let thinking = "";
        const toolCalls = [];
        for (const block of blocks as Record<string, unknown>[]) {
          if (block.type === "text") {
            text += (block.text as string) ?? "";
          } else if (block.type === "thinking") {
            thinking += (block.thinking as string) ?? "";
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: String(block.id),
              name: String(block.name),
              args: (block.input ?? {}) as Record<string, unknown>,
            });
          }
        }
        // Some models emit no thinking summary, leaving turns with no text, thinking, or tool calls — skip those empty entries.
        if (text.length === 0 && thinking.length === 0 && toolCalls.length === 0) {
          break;
        }
        entries.push({
          role: "assistant",
          content: text,
          ...(thinking.length > 0 ? { thinking } : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
        break;
      }
      case "user": {
        const message = obj.message as { content?: unknown[] } | undefined;
        const blocks = Array.isArray(message?.content) ? message.content : [];
        for (const block of blocks as Record<string, unknown>[]) {
          if (block.type !== "tool_result") continue;
          const content = Array.isArray(block.content)
            ? (block.content as Record<string, unknown>[]).map((b) => ({
                type: String(b.type ?? "text"),
                text: typeof b.text === "string" ? b.text : undefined,
              }))
            : [{ type: "text", text: String(block.content ?? "") }];
          entries.push({
            role: "tool",
            content: content.map((b) => b.text ?? "").join(""),
            toolCallId: String(block.tool_use_id ?? ""),
            result: {
              content,
              ...(block.is_error === true ? { isError: true } : {}),
            },
          });
        }
        break;
      }
      case "result":
        claude.info("result", {
          subtype: obj.subtype,
          costUsd: obj.total_cost_usd,
          durationMs: obj.duration_ms,
          numTurns: obj.num_turns,
        });
        break;
      default:
        claude.debug("stream-json: unknown type", trimmed);
    }
  }
  return entries;
}

interface ClaudeResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly error?: string;
}

/**
 * Spawns `claude --print` with the given MCP config and captures its output.
 * The MCP config points at a stdio server (the shim) that bridges to boop's socket, so tool calls during the session route back through boop's in-process MCP server.
 */
function runClaude(opts: {
  cwd: string;
  mcpConfigJson: string;
  systemPrompt: string;
  message: string;
  socketPath: string;
  claude: Logger;
}): Promise<ClaudeResult> {
  const { claude } = opts;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ClaudeResult): void => {
      if (settled) return;
      settled = true;
      claude.info("exit", { code: result.code, error: result.error ?? null });
      if (stdout) claude.debug("stdout", stdout);
      if (stderr) claude.debug("stderr", stderr);
      resolve(result);
    };
    const args = [
      // Isolate from the user's own claude config without `--safe-mode`, which disables MCP servers entirely; an empty `--setting-sources` loads nothing from the user's config dirs while still honoring `--mcp-config`.
      "--setting-sources",
      "",
      "--no-session-persistence",
      "--mcp-config",
      opts.mcpConfigJson,
      "--strict-mcp-config",
      // Pre-approve every tool from the `boop` MCP server.
      // In `--print` mode there is no interactive prompt to grant permission, so without this claude reports the tool as needing approval and never calls it.
      // MCP tools are named `mcp__<server>__<tool>`.
      "--allowedTools",
      "mcp__boop__*",
      "--tools",
      "",
      "--system-prompt",
      opts.systemPrompt,
      // Stream the full transcript as NDJSON (one JSON object per line: init, assistant turns, tool-result user turns, final result) so boop's transcript reflects the whole agentic loop, not just the final text.
      // `--verbose` is required with `--print` for stream-json.
      "--output-format",
      "stream-json",
      "--verbose",
      "--print",
      opts.message,
    ];
    claude.debug("spawn", "claude " + args.map((a) => JSON.stringify(a)).join(" "));
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      // `--print` takes the prompt as an arg, not stdin; ignore stdin so claude doesn't wait 3s for piped data it will never read.
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BOOP_MCP_SOCKET: opts.socketPath },
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err: Error) => {
      finish({ stdout, stderr, code: -1, error: err.message });
    });
    child.on("close", (code: number | null) => {
      finish({ stdout, stderr, code: code ?? 0 });
    });
  });
}
