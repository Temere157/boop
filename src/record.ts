import { appendFile, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { boopStateDir } from "./paths.js";
import type { Event } from "./event.js";
import { log } from "./log.js";
import type { SessionTranscript } from "./plugin.js";

const recordLog = log("record");

/**
 * Directory session recordings live in: `$XDG_STATE_HOME/boop/sessions`, falling back to `~/.local/state/boop/sessions` (per the XDG Base Directory spec).
 * Created lazily on the first recording.
 */
function sessionsDir(): string {
  return join(boopStateDir(), "sessions");
}

/**
 * A durable, append-only record of one session's transcript.
 *
 * The file is created (with a header line naming the event) when the session starts and appended to as the session progresses, so a crash mid-session still leaves everything recorded so far on disk.
 * Each line is one self-contained JSON object (JSONL), making recordings stream-parseable without loading the whole file.
 *
 * Currently only the finished transcript is recorded (the session runner executes in one shot); the type is shaped for incremental appends so streaming recording can be added without changing the format.
 */
export interface SessionRecording {
  /** Append a completed transcript (entries plus the finish timestamp). */
  finish(transcript: SessionTranscript): Promise<void>;
}

/**
 * Opens a new recording file for the session handling `event`, named with the session start timestamp: `<iso>.jsonl`, where the ISO timestamp has `:` and `.` replaced by `-` so it is a safe filename on any filesystem.
 * The first line records the event the session is for.
 */
export async function startRecording(event: Event): Promise<SessionRecording> {
  const startedAt = new Date();
  const name = startedAt.toISOString().replace(/[:.]/g, "-");
  const dir = sessionsDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  // Exclusive create: a same-millisecond collision fails loudly rather than clobbering an existing recording.
  const file = await open(path, "wx");
  await file.close();
  await appendFile(
    path,
    JSON.stringify({
      type: "session",
      event,
      startedAt: startedAt.toISOString(),
    }) + "\n",
  );
  recordLog.info("recording", { path, id: event.id });
  return {
    async finish(transcript) {
      for (const entry of transcript.entries) {
        await appendFile(path, JSON.stringify({ type: "entry", ...entry }) + "\n");
      }
      await appendFile(
        path,
        JSON.stringify({ type: "end", endedAt: new Date().toISOString() }) + "\n",
      );
      recordLog.info("recorded", { path, id: event.id });
    },
  };
}
