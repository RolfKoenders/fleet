/**
 * The jobs `fleet ui` runs for the page: what they are, and what a page that joins late needs to catch up.
 *
 * A job is a push (also the write before it), setting up a host (`init`), cloning a skill source, checking an MCP server,
 * or encrypting a secret. The page is told which ones run (`hello`, then a `jobs` event whenever the list changes), so
 * it can label them and clear them on the matching end. While a push or an init runs, the events it sends are kept
 * (bounded) and replayed to a stream that opens meanwhile, so a second tab or a reload sees the progress so far.
 */

export type Job = { kind: "push" | "init" | "clone" | "check" | "secret"; name?: string };

/** The most events kept for one run. The `hosts` event, which draws a push's lanes, is never the one dropped. */
export const REPLAY_MAX = 400;

/** Events that belong to a push or an init: the ones worth replaying. */
const STREAMED = new Set(["push", "pushend", "init", "initend"]);

export class Jobs {
  #running: Job[] = [];
  #events: { event: string; data: unknown }[] = [];
  #changed: (jobs: Job[]) => void;

  constructor(changed: (jobs: Job[]) => void) {
    this.#changed = changed;
  }

  /** Marks a job as running. Returns the call that says it ended. */
  start(job: Job): () => void {
    if ((job.kind === "push" || job.kind === "init") && !this.#running.some(streams)) this.#events = [];
    const mine = { ...job };
    this.#running.push(mine);
    this.#changed(this.list());
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#running.splice(this.#running.indexOf(mine), 1);
      if (!this.#running.some(streams)) this.#events = [];
      this.#changed(this.list());
    };
  }

  list(): Job[] {
    return this.#running.map((j) => ({ ...j }));
  }

  get count(): number {
    return this.#running.length;
  }

  /** Keeps an event of the running push or init, for a stream that opens later. Anything else, or no such job, is ignored. */
  record(event: string, data: unknown): void {
    if (!STREAMED.has(event) || !this.#running.some(streams)) return;
    this.#events.push({ event, data });
    if (this.#events.length > REPLAY_MAX) {
      const drop = this.#events.findIndex((e) => !(e.event === "push" && (e.data as { event?: unknown } | null)?.event === "hosts"));
      this.#events.splice(drop < 0 ? 0 : drop, 1);
    }
  }

  /** What a new stream is sent after `hello`. */
  replay(): { event: string; data: unknown }[] {
    return [...this.#events];
  }
}

const streams = (j: Job) => j.kind === "push" || j.kind === "init";
