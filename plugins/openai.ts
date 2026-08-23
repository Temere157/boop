import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Logger,
  Plugin,
  PreparedSession,
  SessionTranscript,
  ToolCall,
  ToolDefinition,
  ToolResult,
  TranscriptEntry,
} from "@boop/plugin";

/**
 * A builtin session executor that owns its own agentic loop — the LLM ↔ tool-call cycle — against any OpenAI-compatible Chat Completions endpoint, talking the HTTP API directly with Node's global `fetch` and dispatching tool calls in-process through the session's {@link ToolInvocation}.
 *
 * Unlike the `claude` executor, which shells out to the `claude` CLI and lets *it* own the loop, this one is self-contained: it builds the OpenAI message list from the prepared session, posts to `{baseUrl}/chat/completions`, feeds assistant tool calls straight back into `session.tools.call`, and returns a transcript in the same shape as `claude`'s so recordings are uniform.
 * It never asks {@link PreparedSession.mcp} for a socket — the opt-in MCP path is genuinely optional, and this is the proof.
 *
 * The executor reads its own config from its per-plugin config dir (`{boopConfigDir}/plugins/openai-executor/config.json`), separate from boop's `config.json`, so model/endpoint settings live next to the thing they configure.
 * `baseUrl` and `model` have no defaults and must be set (in the file or via `BOOP_OPENAI_*` env); the API key is read from env (never stored in the file), and can be skipped for a local no-auth server with `"apiKeyEnv": null`.
 *
 * The plugin depends only on the {@link Plugin} contract, not on any core implementation, so it could be moved to an external package as-is.
 */
export const openaiExecutorPlugin: Plugin = {
  name: "openai-executor",
  async init(host) {
    const log = host.log("openai");
    const config = loadConfig(host.paths.configDir, log);
    log.info("configured", {
      baseUrl: config.baseUrl,
      model: config.model,
      auth: config.apiKey !== null,
      maxIterations: config.maxIterations,
    });
    host.executors.register("openai", (session) => run(session, config, log));
  },
};

/** A resolved, validated executor config (env overrides already applied). */
interface OpenaiConfig {
  /** OpenAI-compatible API root, no trailing slash. No default — required. */
  readonly baseUrl: string;
  /** Model id. No default — required. */
  readonly model: string;
  /** Bearer token, or `null` to skip the `Authorization` header (no-auth server). */
  readonly apiKey: string | null;
  /**
   * `max_tokens` sent on every request; bounds each turn's generation.
   * A finite default (8192) is what stops a server from looping forever when a model gets stuck emitting empty `...` think-tag pairs — the loop emits only the tag tokens, which still count toward `max_tokens`, so the cap fires and the server returns `finish_reason: "length"` instead of running unbounded (the reasoning-budget sampler itself can't help here: empty blocks consume zero budget tokens, so its forcing exit never triggers).
   */
  readonly maxTokens: number;
  /** Optional `temperature` passed through to the API. */
  readonly temperature: number | undefined;
  /** Loop guard; reaching it ends the session with a note. */
  readonly maxIterations: number;
  /** Per-HTTP-call `AbortController` timeout, in ms. */
  readonly requestTimeoutMs: number;
  /** Extra headers merged into every request (proxies, beta features, …). */
  readonly extraHeaders: Record<string, string>;
  /**
   * Extra keys merged into every request body (server-specific params), applied last so they override boop's core fields.
   * The use case is passing things boop has no first-class knob for — most commonly `chat_template_kwargs.enable_thinking` to turn a reasoning model's thinking on/off per request (llama.cpp/vLLM accept this in the body, OpenAI-compatible).
   * Unlike `extraHeaders`, values may be any JSON type.
   */
  readonly extraBody: Record<string, unknown>;
}

/**
 * Loads and validates the executor config from `{configDir}/config.json`, applying `BOOP_OPENAI_*` env overrides.
 * A missing file is fine (but `baseUrl` and `model` have no defaults, so they must come from env or the file); a malformed file fails init loudly, matching the core's config loader tone.
 */
function loadConfig(configDir: string, log: Logger): OpenaiConfig {
  const path = join(configDir, "config.json");
  let file: Record<string, unknown> = {};
  try {
    const raw = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`malformed JSON in ${path}: ${message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${path} must contain a JSON object`);
    }
    file = parsed as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT") throw error;
    // missing file: defaults apply (but baseUrl/model have none)
    log.info("no config file; using env + defaults", { path });
  }

  const baseUrlRaw = process.env.BOOP_OPENAI_BASE_URL ?? file.baseUrl;
  if (typeof baseUrlRaw !== "string" || baseUrlRaw.trim().length === 0) {
    throw new Error(
      `${path}: "baseUrl" is required (set it in ${path} or via BOOP_OPENAI_BASE_URL)`,
    );
  }
  const baseUrl = baseUrlRaw.replace(/\/+$/, "");

  const model = process.env.BOOP_OPENAI_MODEL ?? file.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new Error(
      `${path}: "model" is required (set it in ${path} or via BOOP_OPENAI_MODEL)`,
    );
  }

  const apiKey = resolveApiKey(file, path);

  const maxIterationsRaw =
    process.env.BOOP_OPENAI_MAX_ITERATIONS ?? file.maxIterations;
  const maxIterations =
    maxIterationsRaw !== undefined ? Number(maxIterationsRaw) : 25;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(`${path}: "maxIterations" must be a positive integer`);
  }

  const requestTimeoutMs =
    typeof file.requestTimeoutMs === "number" ? file.requestTimeoutMs : 120000;
  if (requestTimeoutMs <= 0) {
    throw new Error(`${path}: "requestTimeoutMs" must be positive`);
  }

  const maxTokens =
    file.maxTokens === undefined ? 8192 : Number(file.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`${path}: "maxTokens" must be a positive integer`);
  }

  const temperature =
    file.temperature === undefined ? undefined : Number(file.temperature);

  if (
    file.extraHeaders !== undefined &&
    (file.extraHeaders === null ||
      typeof file.extraHeaders !== "object" ||
      Array.isArray(file.extraHeaders))
  ) {
    throw new Error(`${path}: "extraHeaders" must be an object`);
  }
  const extraHeaders = (file.extraHeaders ?? {}) as Record<string, string>;

  if (
    file.extraBody !== undefined &&
    (file.extraBody === null ||
      typeof file.extraBody !== "object" ||
      Array.isArray(file.extraBody))
  ) {
    throw new Error(`${path}: "extraBody" must be an object`);
  }
  const extraBody = (file.extraBody ?? {}) as Record<string, unknown>;

  return {
    baseUrl,
    model,
    apiKey,
    maxTokens,
    temperature,
    maxIterations,
    requestTimeoutMs,
    extraHeaders,
    extraBody,
  };
}

/**
 * Resolves the API key, never stored in the config file:
 *
 * 1. `BOOP_OPENAI_API_KEY` env, if set → used directly (overrides everything).
 * 2. `"apiKeyEnv": null` in the file → no auth; skip the `Authorization` header (for local no-auth servers like Ollama / llama.cpp).
 * 3. `"apiKeyEnv": "<NAME>"` (default `OPENAI_API_KEY`) → read that env var; unset → init fails naming the variable and how to disable auth.
 */
function resolveApiKey(
  file: Record<string, unknown>,
  path: string,
): string | null {
  if (process.env.BOOP_OPENAI_API_KEY !== undefined) {
    return process.env.BOOP_OPENAI_API_KEY;
  }
  if (file.apiKeyEnv === null) {
    return null;
  }
  const apiKeyEnv =
    typeof file.apiKeyEnv === "string" ? file.apiKeyEnv : "OPENAI_API_KEY";
  const key = process.env[apiKeyEnv];
  if (key === undefined) {
    throw new Error(
      `${path}: no API key found. Set $${apiKeyEnv} (or BOOP_OPENAI_API_KEY),` +
        ` or set "apiKeyEnv": null in ${path} to skip auth for a no-auth server.`,
    );
  }
  return key;
}

/** Maximum retries on transient errors (429 / 5xx / timeout / network). */
const MAX_RETRIES = 3;

/**
 * Runs the prepared session's agentic loop: build the OpenAI message list from the system prompt + prepared messages, then loop — post a completion, record the assistant turn, dispatch any tool calls in-process, feed the results back, repeat — until the model stops with no tool calls or the iteration cap is hit.
 * Always returns a transcript; a request failure or the iteration cap produces a final assistant entry rather than throwing, so the loop never crashes the session.
 */
const run = async (
  session: PreparedSession,
  config: OpenaiConfig,
  log: Logger,
): Promise<SessionTranscript> => {
  // Seed the transcript exactly like the claude executor: the system prompt and the prepared user/assistant turns, then the loop appends.
  const entries: TranscriptEntry[] = [
    { role: "system", content: session.systemPrompt },
    ...session.messages.map((m): TranscriptEntry => ({
      role: m.role,
      content: m.content,
    })),
  ];

  // The running conversation sent to the API, seeded the same way.
  // Tool turns are appended as the loop runs.
  const messages: ChatMessage[] = [
    { role: "system", content: session.systemPrompt },
    ...session.messages.map((m): ChatMessage => ({
      role: m.role,
      content: m.content,
    })),
  ];

  const tools = session.tools.definitions.map(toOpenaiTool);

  for (let iteration = 0; iteration < config.maxIterations; iteration++) {
    const resp = await chatCompletion(config, messages, tools, log);
    if (resp.error !== undefined) {
      const message = resp.error.message ?? "unknown error";
      log.error("chat completion failed", { message });
      entries.push({
        role: "assistant",
        content: `openai request failed: ${message}`,
      });
      return { entries };
    }

    const choice = resp.choices?.[0];
    const msg = choice?.message;
    if (choice === undefined || msg === undefined) {
      log.warn("response had no choices", { resp });
      entries.push({
        role: "assistant",
        content: "openai response had no choices",
      });
      return { entries };
    }

    const toolCalls = msg.tool_calls ?? [];
    const rawText = msg.content ?? "";
    const capped = choice.finish_reason === "length";

    // If the model hit the token cap without producing a tool call or any text, say so in the transcript rather than recording a silent empty turn — this is the signature of the llama.cpp empty-`...`-tag loop (or a legit reasoning turn that ran out of budget); either way the recording should make it visible.
    // The cap itself is what bounds the runaway: the loop emits only the think-tag tokens, which count toward `max_tokens`, so a finite cap turns an infinite hang into a bounded one.
    const assistantText =
      capped && toolCalls.length === 0 && rawText.length === 0
        ? "(hit max_tokens without producing a tool call or text)"
        : rawText;

    // Record the assistant turn (text, thinking, tool calls) and echo it back into the running conversation.
    // Built with spreads because TranscriptEntry fields are readonly; `thinking` rides the index signature, matching how the claude executor records it.
    // The message sent back to the API carries `rawText`, not the annotated note — the note only applies when there are no tool calls, in which case we return below and the message is never sent.
    const thinking = extractThinking(msg);
    const assistantEntry: TranscriptEntry = {
      role: "assistant",
      content: assistantText,
      ...(thinking !== undefined ? { thinking } : {}),
      ...(toolCalls.length > 0
        ? { toolCalls: toolCalls.map(toToolCall) }
        : {}),
    };
    entries.push(assistantEntry);

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: rawText,
    };
    if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
    messages.push(assistantMessage);

    if (capped) {
      log.warn("model hit token cap (finish_reason=length)", {
        maxTokens: config.maxTokens,
        toolCalls: toolCalls.length,
      });
    }

    // No tool calls → the model is done.
    // (`tool_calls` finish_reason, or a server that sends `stop` with tool_calls present, falls through and continues.)
    // A capped empty turn ends the session here rather than looping forever.
    if (toolCalls.length === 0) {
      log.info("session complete", { iterations: iteration + 1, capped });
      return { entries };
    }

    // Dispatch each tool call in-process and feed the results back.
    for (const tc of toolCalls) {
      const name = tc.function.name;
      const args = tryParseArgs(tc.function.arguments, tc.id, log);
      let result: ToolResult;
      if (args === undefined) {
        result = {
          content: [
            {
              type: "text",
              text: `malformed JSON arguments: ${tc.function.arguments}`,
            },
          ],
          isError: true,
        };
      } else {
        result = await session.tools.call(name, args);
      }
      const toolText = result.content.map((b) => b.text ?? "").join("");
      const isError = result.isError === true;
      // OpenAI's `tool` role has no error flag; signal failure with a `[error]` prefix in the content (the conventional textual cue).
      const feedback = isError ? `[error] ${toolText}` : toolText;
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: feedback,
      });
      entries.push({
        role: "tool",
        content: toolText,
        toolCallId: tc.id,
        toolName: name,
        result: {
          content: result.content,
          ...(isError ? { isError: true } : {}),
        },
      });
    }
  }

  // Ran out of iterations without a stopping turn.
  log.warn("hit iteration cap", { maxIterations: config.maxIterations });
  entries.push({
    role: "assistant",
    content: `Reached the maxIterations cap (${config.maxIterations}) without finishing; stopping.`,
  });
  return { entries };
};

/**
 * One non-streaming Chat Completions request with bounded retry on transient errors (429 / 5xx / timeout / network).
 * A transient error that exhausts retries, or any non-transient HTTP status, comes back as a `{ error }` response rather than throwing — the loop turns that into a final assistant entry.
 */
async function chatCompletion(
  config: OpenaiConfig,
  messages: ChatMessage[],
  tools: OpenaiToolSpec[],
  log: Logger,
): Promise<ChatCompletionResponse> {
  const url = `${config.baseUrl}/chat/completions`;
  const body: Record<string, unknown> = { model: config.model, messages };
  if (tools.length > 0) body.tools = tools;
  body.max_tokens = config.maxTokens;
  if (config.temperature !== undefined && Number.isFinite(config.temperature)) {
    body.temperature = config.temperature;
  }
  // `extraBody` wins over the core fields above: applied last so a user can override boop's defaults (or add server-specific ones like `chat_template_kwargs`) without boop knowing about them.
  Object.assign(body, config.extraBody);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...config.extraHeaders,
  };
  if (config.apiKey !== null) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }

  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      config.requestTimeoutMs,
    );
    try {
      log.debug("request", {
        url,
        attempt,
        messages: messages.length,
        tools: tools.length,
      });
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal,
      });
      const text = await resp.text();
      if (resp.ok) {
        try {
          return JSON.parse(text) as ChatCompletionResponse;
        } catch {
          return {
            error: {
              message: `unparseable response body: ${text.slice(0, 200)}`,
            },
          };
        }
      }
      const isTransient =
        resp.status === 429 || (resp.status >= 500 && resp.status < 600);
      if (isTransient && attempt < MAX_RETRIES) {
        const delay = backoff(attempt);
        log.warn("transient error, retrying", {
          status: resp.status,
          attempt,
          delayMs: delay,
          body: text.slice(0, 200),
        });
        await sleep(delay);
        continue;
      }
      return { error: { message: `HTTP ${resp.status}: ${text.slice(0, 500)}` } };
    } catch (error) {
      const aborted =
        error instanceof Error && error.name === "AbortError";
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < MAX_RETRIES) {
        log.warn(aborted ? "request timed out, retrying" : "fetch error, retrying", {
          attempt,
          message,
        });
        await sleep(backoff(attempt));
        continue;
      }
      return {
        error: {
          message: aborted
            ? `request timed out after ${config.requestTimeoutMs}ms`
            : `network error: ${message}`,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Exponential backoff with jitter: 500ms, 1s, 2s, … plus up to 250ms. */
function backoff(attempt: number): number {
  return Math.round(500 * 2 ** attempt + Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Maps a {@link ToolDefinition} onto an OpenAI `tools` entry. */
function toOpenaiTool(def: ToolDefinition): OpenaiToolSpec {
  const fn: Record<string, unknown> = {
    name: def.name,
    parameters: def.inputSchema,
  };
  if (def.description !== undefined) fn.description = def.description;
  return { type: "function", function: fn };
}

/** Maps an OpenAI tool call onto a boop {@link ToolCall}, parsing args. */
function toToolCall(tc: OpenaiToolCall): ToolCall {
  return {
    id: tc.id,
    name: tc.function.name,
    args: tryParseArgs(tc.function.arguments, tc.id, undefined) ?? {},
  };
}

/**
 * Parses an OpenAI tool-call's `arguments` JSON string.
 * Returns `undefined` for unparseable or non-object input (the loop turns that into an `isError` tool result rather than crashing).
 * The `log` is optional so {@link toToolCall} can reuse this for transcript recording without a logger in scope.
 */
function tryParseArgs(
  raw: string,
  id: string,
  log: Logger | undefined,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      log?.warn("tool arguments not an object", { id, raw });
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    log?.warn("tool arguments unparseable", { id, raw });
    return undefined;
  }
}

/**
 * Pulls a reasoning/thinking summary out of an assistant message.
 * Servers disagree on the field name (`reasoning`, `reasoning_content`, `thinking`); check the common ones and return whichever is present, or `undefined`.
 */
function extractThinking(msg: {
  reasoning?: string;
  reasoning_content?: string;
  thinking?: string;
}): string | undefined {
  const candidate = msg.reasoning ?? msg.reasoning_content ?? msg.thinking;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

// --- OpenAI wire types (only the fields the loop reads) -----------------

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OpenaiToolCall[];
  tool_call_id?: string;
}

interface OpenaiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenaiToolSpec {
  type: "function";
  function: Record<string, unknown>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenaiToolCall[];
      reasoning?: string;
      reasoning_content?: string;
      thinking?: string;
    };
    finish_reason?: string;
  }>;
  error?: { message?: string };
}
