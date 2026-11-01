/**
 * Progress events: one JSON object per line on stderr, only when `FLEET_EVENTS=1`. A variable and not a flag, so a
 * host that runs an older pinned fleet ignores it (an unknown flag would make that fleet exit 2). Events never
 * carry a secret value: they name targets and keys, never what they hold.
 */

/** The version of the event lines. A reader ignores a line with a version it does not know. */
export const EVENT_VERSION = 1;

export type Env = Record<string, string | undefined>;

export const eventsOn = (env: Env = process.env): boolean => env.FLEET_EVENTS === "1";

/** What a reader may rely on. Anything else on a line is dropped when push forwards it. */
export type FleetEvent =
  /** A line of human text: what stderr would have carried without events. */
  | { event: "message"; host?: string | null; text: string }
  /** A stage began. In apply: `sync`, `plan`, `write` (with `of` steps to come). In push: `validate`, `publish`, `apply`. */
  | { event: "stage"; host?: string | null; stage: string; of?: number }
  /** A step finished: step `n` of `of`, naming what it did to `target`. */
  | { event: "step"; host?: string | null; step: string; target: string; n: number; of: number }
  /** Push only: the hosts it will visit, in order, and how each is reached (`local`, `ssh` or `timer`). */
  | { event: "hosts"; hosts: { host: string; via: "local" | "ssh" | "timer" }[] }
  /** Push only: a host started, finished (with its result and change count) or was skipped. */
  | { event: "host"; host: string; state: "start" | "done" | "skip"; result?: string; changes?: number };

export type Line = FleetEvent & { v: number };

let pipeBroken = false;

/** Writes `event` as a line on stderr when events are on. A reader that went away never fails the command. */
export function send(event: FleetEvent, env: Env = process.env): void {
  if (!eventsOn(env) || pipeBroken) return;
  try {
    process.stderr.write(`${JSON.stringify({ v: EVENT_VERSION, ...event })}\n`);
  } catch {
    pipeBroken = true;
  }
}

let guarded = false;

/** Ends the run of a command whose stderr reader has gone away without an error: stderr is only a view. */
export function ignoreBrokenStderr(): void {
  if (guarded) return;
  guarded = true;
  process.stderr.on("error", () => {
    pipeBroken = true;
  });
}

/** A line of human text: on stderr as it is, or as a `message` event when events are on. */
export function note(text: string, host: string | null = null, env: Env = process.env): void {
  if (eventsOn(env)) send({ event: "message", host, text: text.replace(/\n+$/, "") }, env);
  else process.stderr.write(`${text}\n`);
}

const printable = (text: string): string => text.replace(/[^\x20-\x7e]/g, "?").slice(0, 300);

/**
 * Reads one line of a child's stderr. A line that is a known event of this version comes back as that event,
 * with `host` set to the lane it belongs to whatever the child claimed; anything else is a message, cut down to
 * printable text, because it came from another machine.
 */
export function readLine(line: string, host: string): FleetEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = null;
  }
  const o = parsed as Record<string, unknown> | null;
  const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? printable(v) : fallback);
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e6 ? Math.floor(v) : 0);
  if (o !== null && typeof o === "object" && o.v === EVENT_VERSION) {
    if (o.event === "message") return { event: "message", host, text: str(o.text) };
    if (o.event === "stage") return { event: "stage", host, stage: str(o.stage), ...(o.of === undefined ? {} : { of: num(o.of) }) };
    if (o.event === "step") return { event: "step", host, step: str(o.step), target: str(o.target), n: num(o.n), of: num(o.of) };
  }
  return { event: "message", host, text: printable(line) };
}
