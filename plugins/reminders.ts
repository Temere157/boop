import { randomUUID } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin, ToolResult } from "@boop/plugin";

/**
 * A builtin reminders plugin — the agent's own time-based one-shot and recurring reminders.
 * It is an event provider, not a delivery plugin: when a reminder fires it enqueues a `reminder` event on the core, and the agent handles it like any other event and decides how (if at all) to reach the user via the open response channels.
 * If no channel is open the agent is expected to deal with it itself — typically by writing to short-term memory and/or creating a follow-up reminder so the reminder is not lost.
 *
 * Reminders are created, listed, and cancelled by the agent through tools; there is no HTTP or human-facing management surface, since the agent is the only thing that manages them.
 * All scheduling uses absolute ISO 8601 times (the session seed message already gives the agent the current time) and ISO 8601 durations for recurrence, so the plugin never parses natural language.
 *
 * State lives in a single JSON file in the plugin's state directory, rewritten on every mutation and on every fire, so a crash loses at most the in-flight timer — which is re-armed on the next startup via the catch-up pass.
 * Each armed reminder is a single `setTimeout`; `nextFire` is an absolute time persisted to the file, so timer drift is irrelevant (the delay is recomputed from the stored time, not accumulated).
 *
 * The plugin depends only on the {@link Plugin} contract (it gets its state directory, the event sink, and a scoped logger from the host), not on any core implementation, so it could be moved to an external package as-is.
 *
 *   Event: source "reminder", payload { id, message, recur, fired, count, until }
 *
 * Tools:
 *   reminder_create   args : { message, when, recur?, count?, until? }  -> { id, nextFire }
 *   reminder_list     args : {}                                          -> list of pending reminders
 *   reminder_cancel   args : { id }                                      -> ok / isError if missing
 */

/** Millisecond conversions for the fixed-length duration units. */
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 604_800_000;
// Nominal lengths for the calendar units that have no fixed length; used so a "monthly" reminder is expressible even though it drifts from calendar months.
const MS_PER_YEAR = 365 * MS_PER_DAY;
const MS_PER_MONTH = 30 * MS_PER_DAY;

/**
 * Matches an ISO 8601 duration (`P[n]Y[n]M[n]W[n]DT[n]H[n]M[n]S`).
 * All groups are optional, so the empty `P` or `PT` matches and is rejected later as a zero total.
 */
const DURATION_RE =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** Parses an ISO 8601 duration to milliseconds, or returns null if it is malformed or resolves to zero. */
function parseDurationMs(duration: string): number | null {
  const m = DURATION_RE.exec(duration);
  if (m === null) return null;
  const [y, mo, w, d, h, mi, s] = m.slice(1);
  const total =
    Number(y ?? 0) * MS_PER_YEAR +
    Number(mo ?? 0) * MS_PER_MONTH +
    Number(w ?? 0) * MS_PER_WEEK +
    Number(d ?? 0) * MS_PER_DAY +
    Number(h ?? 0) * MS_PER_HOUR +
    Number(mi ?? 0) * MS_PER_MINUTE +
    Number(s ?? 0) * MS_PER_SECOND;
  return total > 0 ? total : null;
}

/** A single reminder, as persisted to the state file. */
interface Reminder {
  readonly id: string;
  readonly message: string;
  /** ISO 8601 absolute time of the next fire; the authoritative schedule, persisted and re-armed from on restart. */
  nextFire: string;
  /** ISO 8601 duration between fires, or null for a one-shot (deleted after its single fire). */
  readonly recur: string | null;
  /** Max fires for a recurring reminder, or null for unbounded; once `fired` reaches it the reminder is deleted. */
  readonly count: number | null;
  /** ISO 8601 absolute time after which a recurring reminder stops, or null; if a recomputed `nextFire` passes it the reminder is deleted. */
  readonly until: string | null;
  /** How many times this reminder has fired so far. */
  fired: number;
}

/** The shape persisted to the state file. */
interface ReminderFile {
  readonly reminders: readonly Reminder[];
}

/**
 * Owns the reminder list, its persistence, and the armed timers.
 * The plugin holds one instance for its life; tools and the catch-up pass call into it.
 */
class Reminders {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  list: Reminder[] = [];
  private readonly path: string;
  private readonly events: { enqueue(source: string, payload: unknown): void };
  private readonly log: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void };

  constructor(
    path: string,
    events: { enqueue(source: string, payload: unknown): void },
    log: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void },
  ) {
    this.path = path;
    this.events = events;
    this.log = log;
  }

  /** Loads the file, enqueues missed one-shots, advances missed recurring fires forward, persists, and arms every remaining reminder. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<ReminderFile>;
      if (parsed !== null && Array.isArray(parsed.reminders)) {
        this.list = parsed.reminders.filter(isReminder);
      }
    } catch {
      // Missing or malformed file is treated as empty so a corrupt state never blocks startup.
    }
    const now = Date.now();
    const drop: string[] = [];
    for (const r of this.list) {
      if (Date.parse(r.nextFire) > now) continue;
      if (r.recur === null) {
        // A one-shot whose time passed while the process was down: enqueue now and delete it.
        this.events.enqueue("reminder", {
          id: r.id,
          message: r.message,
          recur: null,
          fired: r.fired + 1,
          count: null,
          until: null,
        });
        drop.push(r.id);
        continue;
      }
      const ms = parseDurationMs(r.recur);
      if (ms === null) {
        this.log.warn("dropping reminder with bad recurrence", { id: r.id, recur: r.recur });
        drop.push(r.id);
        continue;
      }
      // Skip the occurrences that were missed during downtime by advancing past now, rather than firing a storm of catch-up events.
      let next = Date.parse(r.nextFire);
      while (next <= now) next += ms;
      r.nextFire = new Date(next).toISOString();
      if (r.until !== null && Date.parse(r.nextFire) > Date.parse(r.until)) {
        drop.push(r.id);
      }
    }
    if (drop.length > 0) {
      this.list = this.list.filter((r) => !drop.includes(r.id));
    }
    await this.save();
    this.armAll();
  }

  /** Rewrites the state file from the current list. */
  async save(): Promise<void> {
    const file: ReminderFile = { reminders: this.list };
    await writeFile(this.path, JSON.stringify(file, null, 2), "utf8");
  }

  /** Adds a reminder, persists, and arms its timer. */
  create(input: {
    readonly message: string;
    readonly nextFire: string;
    readonly recur: string | null;
    readonly count: number | null;
    readonly until: string | null;
  }): { id: string; nextFire: string } {
    const r: Reminder = {
      id: randomUUID(),
      message: input.message,
      nextFire: input.nextFire,
      recur: input.recur,
      count: input.count,
      until: input.until,
      fired: 0,
    };
    this.list.push(r);
    void this.save();
    this.arm(r.id);
    return { id: r.id, nextFire: r.nextFire };
  }

  /** Removes a reminder by id and clears its timer; returns false if no such reminder existed. */
  cancel(id: string): boolean {
    const t = this.timers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    const before = this.list.length;
    this.list = this.list.filter((r) => r.id !== id);
    if (this.list.length === before) return false;
    void this.save();
    return true;
  }

  /** Arms a timer for every reminder (snapshot the list first since arming a past-due one mutates it). */
  private armAll(): void {
    for (const r of [...this.list]) this.arm(r.id);
  }

  /** Arms (or re-arms) the timer for one reminder, clearing any existing timer for that id. */
  private arm(id: string): void {
    const r = this.list.find((x) => x.id === id);
    if (r === undefined) return;
    const existing = this.timers.get(id);
    if (existing !== undefined) clearTimeout(existing);
    const delay = Date.parse(r.nextFire) - Date.now();
    if (delay <= 0) {
      this.fire(id);
      return;
    }
    const t = setTimeout(() => this.fire(id), delay);
    // A pending timer never keeps the process alive on its own.
    t.unref();
    this.timers.set(id, t);
  }

  /** Fires a reminder: enqueues its event, then advances or deletes it and re-arms. */
  private fire(id: string): void {
    const r = this.list.find((x) => x.id === id);
    if (r === undefined) return;
    this.timers.delete(id);
    r.fired += 1;
    this.events.enqueue("reminder", {
      id: r.id,
      message: r.message,
      recur: r.recur,
      fired: r.fired,
      count: r.count,
      until: r.until,
    });
    this.advance(r);
  }

  /** Advances a fired recurring reminder to its next fire (skipping any missed while the event was queued), or deletes it if it is done. */
  private advance(r: Reminder): void {
    if (r.recur === null || (r.count !== null && r.fired >= r.count)) {
      this.remove(r.id);
      return;
    }
    const ms = parseDurationMs(r.recur);
    if (ms === null) {
      this.log.warn("dropping reminder with bad recurrence", { id: r.id, recur: r.recur });
      this.remove(r.id);
      return;
    }
    let next = Date.parse(r.nextFire) + ms;
    const now = Date.now();
    // If the event was queued behind a long-running session, the next fire may already be in the past — skip ahead rather than firing a burst.
    while (next <= now) next += ms;
    if (r.until !== null && next > Date.parse(r.until)) {
      this.remove(r.id);
      return;
    }
    r.nextFire = new Date(next).toISOString();
    void this.save();
    this.arm(r.id);
  }

  /** Removes a reminder by id, clears its timer, and persists. */
  private remove(id: string): void {
    const t = this.timers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    this.list = this.list.filter((x) => x.id !== id);
    void this.save();
  }
}

/** Type guard for a persisted reminder, so a malformed entry is dropped on load rather than crashing the scheduler. */
function isReminder(value: unknown): value is Reminder {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.message === "string" &&
    typeof r.nextFire === "string" &&
    (r.recur === null || typeof r.recur === "string") &&
    (r.count === null || (typeof r.count === "number" && Number.isInteger(r.count))) &&
    (r.until === null || typeof r.until === "string") &&
    typeof r.fired === "number"
  );
}

/** Builds a semantic-error {@link ToolResult} (the agent sees the text and can correct its call). */
function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export const remindersPlugin: Plugin = {
  name: "reminders",
  async init(host) {
    const log = host.log("reminders");
    const path = join(host.paths.stateDir, "reminders.json");
    // Ensure the file exists from startup so it is inspectable and load never has to create it mid-run.
    // `open(..., "a")` creates without truncating; the state dir already exists.
    await open(path, "a").then((f) => f.close());
    const store = new Reminders(path, host.events, log);
    await store.load();
    log.info("reminders loaded", { count: store.list.length });

    // Tool: `reminder_create` — schedule a one-shot or recurring reminder.
    host.tools.register(
      {
        name: "reminder_create",
        description:
          "Schedule a time-based reminder whose target is you, the agent. " +
          "When it fires you receive a `reminder` event carrying the `message`, and you decide what to do with it. " +
          "Most reminders you create are proxies for the user — the user asked you to 'remind me …'. " +
          "When such a reminder fires, relay its `message` to the user with the `respond` tool if a channel is open. " +
          "If no channel is open, do not drop it: write it to memory and/or create a follow-up reminder so it is not lost. " +
          "Reminders can also be for yourself (your own follow-ups, recurring self-checks), in which case act on the `message` directly rather than forwarding it. " +
          "`when` is an absolute ISO 8601 time; the session message gives you the current time, so compute the target from that. " +
          "`recur` is an ISO 8601 duration (`PT30M`, `P1D`, `P1W`, …) for a recurring reminder, or null/omitted for a one-shot. " +
          "`count` bounds a recurring reminder to that many fires; `until` bounds it to a last-allowed ISO 8601 time. " +
          "Recurrence uses nominal month/year lengths (30/365 days), so a monthly reminder drifts from calendar months.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description:
                "The reminder text, which you receive verbatim when it fires. " +
                "Write it for yourself to act on: for a user reminder, state that it is for the user and what to tell them; for your own follow-up, state what you should do.",
            },
            when: {
              type: "string",
              description:
                "Absolute ISO 8601 time of the first fire, e.g. `2025-01-01T09:00:00Z`.",
            },
            recur: {
              type: "string",
              description:
                "ISO 8601 duration between fires for a recurring reminder, e.g. `PT30M` or `P1D`. " +
                "Omit or null for a one-shot.",
            },
            count: {
              type: "integer",
              minimum: 1,
              description: "Maximum number of fires for a recurring reminder.",
            },
            until: {
              type: "string",
              description:
                "Absolute ISO 8601 time after which a recurring reminder stops firing.",
            },
          },
          required: ["message", "when"],
        },
      },
      async (args): Promise<ToolResult> => {
        const message = String(args.message ?? "");
        if (message === "") return toolError("message is required");
        const whenRaw = args.when;
        if (typeof whenRaw !== "string") {
          return toolError("when (an absolute ISO 8601 time) is required");
        }
        const whenMs = Date.parse(whenRaw);
        if (Number.isNaN(whenMs)) {
          return toolError("when is not a valid ISO 8601 time");
        }

        let recur: string | null = null;
        if (args.recur !== undefined && args.recur !== null) {
          if (typeof args.recur !== "string") {
            return toolError("recur must be an ISO 8601 duration string or null");
          }
          if (parseDurationMs(args.recur) === null) {
            return toolError("recur is not a valid ISO 8601 duration");
          }
          recur = args.recur;
        }

        let count: number | null = null;
        if (args.count !== undefined && args.count !== null) {
          const c = Number(args.count);
          if (!Number.isInteger(c) || c <= 0) {
            return toolError("count must be a positive integer");
          }
          count = c;
        }

        let until: string | null = null;
        if (args.until !== undefined && args.until !== null) {
          if (typeof args.until !== "string" || Number.isNaN(Date.parse(args.until))) {
            return toolError("until is not a valid ISO 8601 time");
          }
          until = args.until;
          if (Date.parse(until) <= whenMs) {
            return toolError("until must be later than when");
          }
        }

        if (recur === null && (count !== null || until !== null)) {
          return toolError("count and until only apply to recurring reminders");
        }

        const created = store.create({
          message,
          nextFire: new Date(whenMs).toISOString(),
          recur,
          count,
          until,
        });
        return {
          content: [
            {
              type: "text",
              text: `Reminder ${created.id} created; next fires at ${created.nextFire}.`,
            },
          ],
        };
      },
    );

    // Tool: `reminder_list` — enumerate pending reminders with their next fire and bounds.
    host.tools.register(
      {
        name: "reminder_list",
        description: "List all pending reminders with their next fire time and recurrence.",
        inputSchema: { type: "object", properties: {} },
      },
      (): ToolResult => {
        if (store.list.length === 0) {
          return { content: [{ type: "text", text: "No reminders pending." }] };
        }
        const lines = store.list.map((r) => {
          const recur =
            r.recur === null ? "one-shot" : `every ${r.recur}`;
          const bound =
            r.count !== null
              ? ` (x${r.count})`
              : r.until !== null
                ? ` until ${r.until}`
                : "";
          return `- ${r.id}  next ${r.nextFire}  ${recur}${bound}: ${r.message}`;
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    );

    // Tool: `reminder_cancel` — remove a reminder by id (idempotent miss is an error).
    host.tools.register(
      {
        name: "reminder_cancel",
        description: "Cancel a pending reminder by id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "The reminder id from `reminder_create` or `reminder_list`." },
          },
          required: ["id"],
        },
      },
      async (args): Promise<ToolResult> => {
        const id = String(args.id ?? "");
        if (id === "") return toolError("id is required");
        if (store.cancel(id)) {
          return { content: [{ type: "text", text: `Reminder ${id} cancelled.` }] };
        }
        return toolError(`no reminder with id ${id}`);
      },
    );
  },
};
