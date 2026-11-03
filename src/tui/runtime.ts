import { Buffer as Frame, Canvas } from "./buffer.ts";
import type { Input, Key } from "./input.ts";
import { Terminal, restoreOnExit } from "./terminal.ts";
import type { Size, Streams } from "./terminal.ts";
import type { Level } from "./color.ts";

/** Messages the runtime itself sends. An app's own messages come beside them. */
export type Core =
  | { type: "key"; key: Key }
  | { type: "paste"; text: string }
  | { type: "resize"; size: Size }
  /** `now` is milliseconds on the runtime's clock; `late` is how far behind schedule this tick ran. */
  | { type: "tick"; now: number; late: number };

export type Ctx<M> = {
  send: (message: Core | M) => void;
  /** Aborted when the app quits, so a background task can stop. */
  signal: AbortSignal;
  quit: (code?: number) => void;
};

/** A background task. It may run as long as it likes and report through `send`; it never blocks the UI. */
export type Cmd<M> = (ctx: Ctx<M>) => void | Promise<void>;

export type App<S, M> = {
  init(size: Size): [S, Cmd<M>[]];
  update(state: S, message: Core | M): [S, Cmd<M>[]];
  /** Draws the whole screen. Pure: the same state gives the same frame. */
  view(state: S, canvas: Canvas): void;
  /** Milliseconds between ticks while the state is animating, or null when nothing moves. */
  tick?(state: S): number | null;
};

/** The state, update and view loop, with no terminal in it: the real run and the headless driver both use it. */
export class Runtime<S, M> {
  state: S;
  size: Size;
  quitCode: number | null = null;
  private readonly app: App<S, M>;
  private readonly abort = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  private readonly listeners = new Set<() => void>();

  constructor(app: App<S, M>, size: Size) {
    this.app = app;
    this.size = size;
    const [state, cmds] = app.init(size);
    this.state = state;
    this.run(cmds);
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  send = (message: Core | M): void => {
    if (this.quitCode !== null) return;
    if ((message as Core).type === "resize") this.size = (message as Extract<Core, { type: "resize" }>).size;
    const [state, cmds] = this.app.update(this.state, message);
    this.state = state;
    this.run(cmds);
    for (const listener of this.listeners) listener();
  };

  /** The tick interval the state asks for, or null. */
  tickEvery(): number | null {
    return this.app.tick?.(this.state) ?? null;
  }

  view(): Frame {
    const frame = new Frame(this.size.cols, this.size.rows);
    this.app.view(this.state, new Canvas(frame));
    return frame;
  }

  quit = (code = 0): void => {
    if (this.quitCode !== null) return;
    this.quitCode = code;
    this.abort.abort();
    for (const listener of this.listeners) listener();
  };

  /** Resolves when every background task started so far has finished. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private run(cmds: Cmd<M>[]): void {
    for (const cmd of cmds) {
      const ctx: Ctx<M> = { send: this.send, signal: this.abort.signal, quit: this.quit };
      const done = (async () => cmd(ctx))().catch((error: unknown) => {
        // A task that fails must not take the screen down with it.
        this.send({ type: "fault", text: error instanceof Error ? error.message : String(error) } as M);
      });
      const tracked = done.finally(() => this.pending.delete(tracked));
      this.pending.add(tracked);
    }
  }
}

export type RunOptions = {
  level: Level;
  /** Minimum milliseconds between frames. */
  frameMs?: number;
};

/** Runs `app` on the real terminal until it quits, and resolves with its exit code. The terminal is restored first. */
export function runOnTerminal<S, M>(app: App<S, M>, io: Streams, options: RunOptions): Promise<number> {
  return new Promise((resolve) => {
    const term: Terminal = new Terminal(io, {
      level: options.level,
      onInput: (input: Input) => rt.send(input.kind === "key" ? { type: "key", key: input.key } : { type: "paste", text: (input as { text: string }).text }),
      onResize: (size) => {
        term.invalidate();
        rt.send({ type: "resize", size });
      },
    });
    const rt = new Runtime<S, M>(app, term.size());
    const undo = restoreOnExit(term);
    const started = performance.now();
    const frameMs = options.frameMs ?? 16;
    let lastDraw = 0;
    let drawTimer: NodeJS.Timeout | null = null;
    let ticker: NodeJS.Timeout | null = null;
    let tickMs: number | null = null;
    let expected = 0;

    const draw = () => {
      drawTimer = null;
      lastDraw = performance.now();
      term.draw(rt.view());
    };
    const schedule = () => {
      if (drawTimer || rt.quitCode !== null) return;
      drawTimer = setTimeout(draw, Math.max(0, frameMs - (performance.now() - lastDraw)));
    };
    const retime = () => {
      const want = rt.tickEvery();
      if (want === tickMs) return;
      if (ticker) clearInterval(ticker);
      ticker = null;
      tickMs = want;
      if (want === null) return;
      expected = performance.now() + want;
      ticker = setInterval(() => {
        const now = performance.now();
        // A write the terminal could not take at once means a slow link: as late as a missed tick.
        const late = Math.max(0, now - expected) + (term.congested ? 1000 : 0);
        term.congested = false;
        expected = now + want;
        rt.send({ type: "tick", now: now - started, late });
      }, want);
    };
    rt.onChange(() => {
      retime();
      if (rt.quitCode !== null) {
        if (ticker) clearInterval(ticker);
        if (drawTimer) clearTimeout(drawTimer);
        term.stop();
        undo();
        resolve(rt.quitCode);
        return;
      }
      schedule();
    });
    // A terminal that closes under us (the window went away) ends the run rather than leaving it waiting.
    io.stdin.once("end", () => rt.quit(0));
    term.start();
    rt.send({ type: "tick", now: 0, late: 0 });
    retime();
    draw();
  });
}
