import type {
  ResponseChannel,
  ResponseChannels,
  ToolResult,
  Tools,
} from "./plugin.js";

/**
 * The core response-channel registry. This is shared infrastructure, not a
 * plugin: it holds the set of currently-open {@link ResponseChannel}s that
 * providers have registered — the reply paths the agent can send on right
 * now. A channel is in the registry only while its owner is willing to
 * deliver (an HTTP ingest request held open for ≤20s, an eternal SMS
 * gateway, a live webui connection, …); the owner unregisters it the
 * moment it stops being willing.
 *
 * Channels are independent of events. An event may reference a channel by
 * id (carried in its payload), but the registry does not tie a channel's
 * lifetime to any event: a channel is registered and unregistered by
 * whatever owns the reply path, not by the session loop. So an eternal
 * channel lives for the process lifetime, a webui channel lives for a
 * connection, and an HTTP ingest channel lives for a single held request
 * — all just entries here while open.
 *
 * The core's `respond` tool looks a channel up by id at call time (see
 * {@link registerRespondTool}), so a channel that closed between session
 * preparation and a `respond` call surfaces as a semantic `isError` result
 * rather than a silent drop — matching how the tool-invocation wrapper
 * treats crashes and unknown tools.
 */
export class ResponseChannelRegistry implements ResponseChannels {
  private channels: Map<string, ResponseChannel> = new Map();

  register(channel: ResponseChannel): void {
    if (this.channels.has(channel.id)) {
      throw new Error(`response channel already registered: ${channel.id}`);
    }
    this.channels.set(channel.id, channel);
  }

  unregister(id: string): void {
    this.channels.delete(id);
  }

  /** Look up a channel by id (for the `respond` tool). */
  find(id: string): ResponseChannel | undefined {
    return this.channels.get(id);
  }

  /**
   * Snapshot of every open channel, for the session message. Taken at
   * `prepare()` time as a hint to the agent; the `respond` tool queries
   * live, so a channel listed here may already be gone by call time.
   */
  get all(): readonly ResponseChannel[] {
    return [...this.channels.values()];
  }
}

/**
 * Registers the core `respond` tool against the given registries. This is
 * core, not a plugin: the plugin boundary for replies is the channels
 * themselves (a provider registers the channels it can deliver on); the
 * one tool that sends on whatever id the agent picks is a core concept.
 *
 * The tool takes a channel id (the open ids are listed in the session
 * message) and a message. A missing id, a closed channel, or a rejected
 * delivery comes back as an `isError` {@link ToolResult} so the executor's
 * agentic loop keeps going — the same convention the tool-invocation
 * wrapper uses for crashes and unknown tools.
 *
 * Tool: `respond`
 *   args : { channel: string, message: string }
 *   ->   { content: [{ text }] }, isError on missing/closed/rejected
 */
export function registerRespondTool(
  tools: Tools,
  channels: ResponseChannelRegistry,
): void {
  tools.register(
    {
      name: "respond",
      description:
        "Send a message back to the user on a response channel. Open " +
        "channel ids are listed in the event message; each is open only " +
        "while its owner is willing to deliver, so a channel may close " +
        "before you send — that returns an error. Pick the channel that " +
        "matches where the reply should go (its description says what it is).",
      inputSchema: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description:
              "The id of an open response channel (see the event message).",
          },
          message: {
            type: "string",
            description: "The message to send.",
          },
        },
        required: ["channel", "message"],
      },
    },
    async (args): Promise<ToolResult> => {
      const id = String(args.channel ?? "");
      const channel = channels.find(id);
      if (channel === undefined) {
        return {
          content: [{ type: "text", text: `no open response channel "${id}"` }],
          isError: true,
        };
      }
      const message = String(args.message ?? "");
      try {
        await channel.send(message);
        return {
          content: [{ type: "text", text: `sent on channel ${channel.id}` }],
        };
      } catch (error) {
        const m = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text", text: `channel "${channel.id}" rejected: ${m}` },
          ],
          isError: true,
        };
      }
    },
  );
}
