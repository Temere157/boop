import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";
import { log } from "../log.js";
import type {
  McpServer,
  McpSocket,
  ToolDefinition,
  ToolInvocation,
  ToolResult,
} from "../plugin.js";

const mcp = log("mcp");

/** MCP protocol version this server advertises on `initialize`. */
const PROTOCOL_VERSION = "2024-11-05";

/** JSON-RPC 2.0 request/notification envelope. */
interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

/** A per-session unix-socket MCP server, handed back to an executor. */
class McpUnixSocket implements McpSocket {
  constructor(
    readonly path: string,
    private readonly server: Server,
  ) {}

  close(): Promise<void> {
    mcp.debug("closing socket", this.path);
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

/**
 * Core MCP server infrastructure.
 * This is shared infrastructure, not a plugin: it serves boop's registered tools to an agent runtime (e.g. claude-code in -p mode, reached via a stdio-bridge shim launched as a command-based MCP server) over the MCP stdio protocol on per-session unix sockets.
 * The server is created once at startup; each call to {@link serve} binds a fresh socket for one session, so sessions never share a listener.
 * Tool dispatch goes through the {@link ToolInvocation} the session carries, so handler crashes and unknown tools come back as a semantic {@link ToolResult} (with `isError`) rather than dropping the connection.
 *
 * The transport is unix sockets carrying newline-delimited JSON-RPC 2.0 — the same framing the MCP stdio transport uses — so a shim that connects a subprocess's stdin/stdout to the socket needs no protocol translation.
 */
export class McpUnixServer implements McpServer {
  private readonly sockets: McpUnixSocket[] = [];
  private readonly dirPromise: Promise<string>;

  constructor(
    private readonly name: string,
    private readonly version: string,
  ) {
    // A private dir for per-session socket files, cleaned up on close.
    this.dirPromise = mkdtemp(join(tmpdir(), "boop-mcp-"));
  }

  async serve(tools: ToolInvocation): Promise<McpSocket> {
    const dir = await this.dirPromise;
    const path = join(dir, `${randomUUID()}.sock`);
    mcp.debug("binding", path);
    const server = createServer((socket) => this.handle(tools, socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.on("error", onError);
      server.listen(path, () => {
        server.off("error", onError);
        mcp.info("listening", path);
        resolve();
      });
    });
    const handle = new McpUnixSocket(path, server);
    this.sockets.push(handle);
    return handle;
  }

  /** Close every session socket and remove the socket directory. */
  async close(): Promise<void> {
    await Promise.allSettled(this.sockets.map((s) => s.close()));
    this.sockets.length = 0;
    try {
      await rm(await this.dirPromise, { recursive: true, force: true });
    } catch {
      // best-effort; the dir may already be gone.
    }
  }

  /** Per-connection JSON-RPC loop. */
  private handle(tools: ToolInvocation, socket: Socket): void {
    mcp.debug("connection accepted");
    socket.on("error", (err: Error) => {
      mcp.warn("socket error", err.message);
    });
    socket.on("close", () => {
      mcp.debug("connection closed");
    });
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
    rl.on("line", (line) => {
      mcp.trace("recv", line);
      if (line.trim() === "") return;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line) as JsonRpcRequest;
      } catch {
        mcp.warn("parse error", line);
        this.send(socket, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        });
        return;
      }
      mcp.trace("dispatch", "method=" + (req.method ?? ""), "id=" + (req.id ?? ""));
      void this.handleMessage(tools, req, socket);
    });
  }

  private async handleMessage(
    tools: ToolInvocation,
    req: JsonRpcRequest,
    socket: Socket,
  ): Promise<void> {
    const { id, method, params } = req;
    // Notifications (no id, or null id) get no response.
    if (id === undefined || id === null) return;
    try {
      let result: unknown;
      switch (method) {
        case "initialize":
          result = {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: this.name, version: this.version },
          };
          break;
        case "tools/list":
          result = { tools: tools.definitions.map(toMcpTool) };
          break;
        case "tools/call": {
          const name = String(params?.name ?? "");
          const args =
            (params?.arguments as Record<string, unknown> | undefined) ??
            {};
          // Tool errors are a result (isError), not a JSON-RPC error — the ToolInvocation wrapper already converts crashes/unknown tools.
          const toolResult = await tools.call(name, args);
          result = toMcpCallResult(toolResult);
          break;
        }
        default:
          this.sendError(
            socket,
            id,
            -32601,
            `method not found: ${method ?? ""}`,
          );
          return;
      }
      this.send(socket, { jsonrpc: "2.0", id, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendError(socket, id, -32603, `internal error: ${message}`);
    }
  }

  private send(socket: Socket, message: unknown): void {
    const line = `${JSON.stringify(message)}\n`;
    mcp.trace("send", line.trimEnd());
    socket.write(line);
  }

  private sendError(
    socket: Socket,
    id: string | number,
    code: number,
    message: string,
  ): void {
    this.send(socket, { jsonrpc: "2.0", id, error: { code, message } });
  }
}

/** Maps a {@link ToolDefinition} onto an MCP `tools/list` entry. */
function toMcpTool(def: ToolDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: def.name,
    inputSchema: def.inputSchema,
  };
  if (def.description !== undefined) out.description = def.description;
  return out;
}

/** Maps a {@link ToolResult} onto an MCP `tools/call` result. */
function toMcpCallResult(result: ToolResult): Record<string, unknown> {
  const out: Record<string, unknown> = { content: result.content };
  if (result.isError !== undefined) out.isError = result.isError;
  return out;
}
