import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Plugin,
  PreparedSession,
  SessionExecutor,
  SessionTranscript,
  TranscriptEntry,
} from "../plugin.js";

/**
 * A stdio-bridge shim, written to each session's tempdir and launched by
 * claude as a command-based MCP server. It connects to the unix socket at
 * `$BOOP_MCP_SOCKET` and pipes stdin ↔ stdout through it, so claude's MCP
 * stdio client ends up talking to boop's in-process MCP server over the
 * socket — with no out-of-process hop back into boop.
 *
 * It is a standalone `.mjs` (no imports from boop) because it runs in its
 * own node process, spawned by claude.
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
 * A builtin session executor that runs `claude` in `--print` (non-interactive)
 * mode as the agentic runtime, with boop's tools exposed over MCP via a
 * per-session unix socket.
 *
 * The flow: bind a fresh MCP socket serving the session's tools, write the
 * stdio-bridge shim into a tempdir, spawn `claude` there with an MCP config
 * pointing at the shim (so claude's tool calls route back through the socket
 * to boop's in-process handlers), capture `--print`'s stdout as the
 * assistant's final turn, then tear down the socket and tempdir.
 *
 * The plugin depends only on the {@link Plugin} contract, not on any core
 * implementation, so it could be moved to an external package as-is.
 */
export const claudeExecutorPlugin: Plugin = {
  name: "claude-executor",
  init(host) {
    host.executors.register(run);
  },
};

const run: SessionExecutor = async (
  session: PreparedSession,
): Promise<SessionTranscript> => {
  const socket = await session.mcp.serve(session.tools);
  const dir = await mkdtemp(join(tmpdir(), "boop-claude-"));
  const shimPath = join(dir, "mcp-shim.mjs");
  await writeFile(shimPath, SHIM, { mode: 0o755 });
  console.log(`claude: socket=${socket.path} shim=${shimPath} cwd=${dir}`);
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
    console.log(`claude: mcp-config=${mcpConfigJson}`);
    const message = JSON.stringify(session.event.payload, null, 2);
    const outcome = await runClaude({
      cwd: dir,
      mcpConfigJson,
      systemPrompt: session.systemPrompt,
      message,
      socketPath: socket.path,
    });
    const entries: TranscriptEntry[] = [
      { role: "system", content: session.systemPrompt },
      { role: "user", content: message },
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
      entries.push({ role: "assistant", content: outcome.stdout });
    }
    return { entries };
  } finally {
    await rm(dir, { recursive: true, force: true });
    await socket.close();
  }
};

interface ClaudeResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly error?: string;
}

/**
 * Spawns `claude --print` with the given MCP config and captures its output.
 * The MCP config points at a stdio server (the shim) that bridges to boop's
 * socket, so tool calls during the session route back through boop's
 * in-process MCP server.
 */
function runClaude(opts: {
  cwd: string;
  mcpConfigJson: string;
  systemPrompt: string;
  message: string;
  socketPath: string;
}): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ClaudeResult): void => {
      if (settled) return;
      settled = true;
      console.log(`claude: exit code=${result.code} error=${result.error ?? "-"}`);
      if (stdout) console.log(`claude: stdout:\n${stdout}`);
      if (stderr) console.log(`claude: stderr:\n${stderr}`);
      resolve(result);
    };
    const args = [
      // Isolate from the user's own claude config without `--safe-mode`,
      // which disables MCP servers entirely; an empty `--setting-sources`
      // loads nothing from the user's config dirs while still honoring
      // `--mcp-config`.
      "--setting-sources",
      "",
      "--no-session-persistence",
      "--mcp-config",
      opts.mcpConfigJson,
      "--strict-mcp-config",
      // Pre-approve every tool from the `boop` MCP server. In `--print`
      // mode there is no interactive prompt to grant permission, so without
      // this claude reports the tool as needing approval and never calls
      // it. MCP tools are named `mcp__<server>__<tool>`.
      "--allowedTools",
      "mcp__boop__*",
      "--tools",
      "",
      "--system-prompt",
      opts.systemPrompt,
      "--print",
      opts.message,
    ];
    console.log(`claude: spawn claude ${args.map((a) => JSON.stringify(a)).join(" ")}`);
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      // `--print` takes the prompt as an arg, not stdin; ignore stdin so
      // claude doesn't wait 3s for piped data it will never read.
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
