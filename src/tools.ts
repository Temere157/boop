import type {
  RegisteredTool,
  ToolDefinition,
  ToolHandler,
  Tools,
} from "./plugin.js";

/**
 * The core tool registry. This is shared infrastructure, not a plugin: many
 * plugins register tools (call an API, read a file, send a message, …) and
 * they all surface to the same place — the event executor, which hands them
 * to the LLM when a session runs. Plugins register tools via
 * {@link Tools}; the registry holds them until the executor consumes them.
 *
 * Tool definitions are MCP-shaped (see {@link ToolDefinition}) so an
 * executor that exposes them over MCP (e.g. an MCP server bridge) can pass
 * them through unchanged, and the description the LLM sees is exactly what
 * an MCP client would see.
 *
 * Duplicate tool names are rejected on registration; a tool is identified by
 * its name alone, so two plugins must not register the same name.
 */
export class ToolRegistry implements Tools {
  private tools: RegisteredTool[] = [];

  register(definition: ToolDefinition, handler: ToolHandler): void {
    if (this.find(definition.name) !== undefined) {
      throw new Error(`tool already registered: ${definition.name}`);
    }
    this.tools.push({ definition, handler });
  }

  /** Snapshot of every registered tool, for the executor to surface. */
  get all(): readonly RegisteredTool[] {
    return this.tools;
  }

  /** Look up a tool by name. */
  find(name: string): RegisteredTool | undefined {
    return this.tools.find((t) => t.definition.name === name);
  }
}
