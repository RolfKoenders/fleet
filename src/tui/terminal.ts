import { writeSync } from "node:fs";
import { Buffer as Frame, paintDiff } from "./buffer.ts";
import type { Level } from "./color.ts";
import { InputParser } from "./input.ts";
import type { Input } from "./input.ts";

export type Size = { cols: number; rows: number };

/** The streams the terminal reads and writes; a real tty, or a stand-in in a test. */
export type Streams = {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown };
  stdout: NodeJS.WritableStream & { columns?: number; rows?: number; fd?: number };
};

const ESC = "\u001b";
export const ENTER = `${ESC}[?1049h${ESC}[?25l${ESC}[?7l${ESC}[?2004h${ESC}[2J`;
export const LEAVE = `${ESC}[?2004l${ESC}[?7h${ESC}[?25h${ESC}[0m${ESC}[?1049l`;
/** Asks whether synchronized output (mode 2026) is supported. The answer is `CSI ? 2026 ; Ps $ y`. */
export const SYNC_QUERY = `${ESC}[?2026$p`;
const SYNC_ON = `${ESC}[?2026h`;
const SYNC_OFF = `${ESC}[?2026l`;

export type TerminalOptions = {
  level: Level;
  /** How long to wait for the answer to the synchronized-output query. */
  probeMs?: number;
  /** How long a lone escape waits to see whether it starts a sequence. */
  escapeMs?: number;
  onInput: (input: Input) => void;
  onResize: (size: Size) => void;
};

/**
 * Owns the real terminal: alternate screen, raw mode, resize, and writing frames as diffs. `stop` puts
 * everything back, and runs at most once.
 */
export class Terminal {
  private readonly io: Streams;
  private readonly opts: TerminalOptions;
  private readonly parser = new InputParser();
  private prev: Frame | null = null;
  private started = false;
  private stopped = false;
  private escapeTimer: NodeJS.Timeout | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  /** Null until the terminal answers; synchronized output is only used once it said yes. */
  syncSupported: boolean | null = null;
  /** Set when a write was refused for lack of room, meaning the link is slower than the animation. */
  congested = false;
  private readonly onData = (chunk: Buffer | string) => this.receive(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  private readonly onSize = () => this.opts.onResize(this.size());

  constructor(io: Streams, opts: TerminalOptions) {
    this.io = io;
    this.opts = opts;
  }

  size(): Size {
    return { cols: this.io.stdout.columns ?? 80, rows: this.io.stdout.rows ?? 24 };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.io.stdin.setRawMode?.(true);
    this.io.stdin.setEncoding?.("utf8");
    this.io.stdin.on("data", this.onData);
    this.io.stdin.resume();
    this.io.stdout.on("resize", this.onSize);
    this.io.stdout.write(ENTER);
    this.io.stdout.write(SYNC_QUERY);
    this.probeTimer = setTimeout(() => {
      this.syncSupported ??= false;
    }, this.opts.probeMs ?? 300);
    this.probeTimer.unref();
  }

  private receive(text: string): void {
    this.dispatch(this.parser.feed(text));
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = null;
    if (this.parser.waiting) {
      this.escapeTimer = setTimeout(() => this.dispatch(this.parser.flush()), this.opts.escapeMs ?? 40);
    }
  }

  private dispatch(inputs: Input[]): void {
    for (const input of inputs) {
      // The terminal's answer to our query is not the user's; it may also arrive after the wait ended.
      if (input.kind === "mode") {
        if (input.mode === 2026) this.syncSupported = input.state === 1 || input.state === 2;
        continue;
      }
      this.opts.onInput(input);
    }
  }

  /** Draws `frame`, writing only what changed since the last one. */
  draw(frame: Frame): void {
    if (this.stopped) return;
    const body = paintDiff(this.prev, frame, this.opts.level);
    this.prev = frame;
    if (body === "") return;
    const ok = this.io.stdout.write(this.syncSupported === true ? `${SYNC_ON}${body}${SYNC_OFF}` : body);
    if (!ok) this.congested = true;
  }

  /** Forget what is on screen, so the next frame is drawn whole. */
  invalidate(): void {
    this.prev = null;
  }

  stop(): void {
    if (this.stopped || !this.started) return;
    this.stopped = true;
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.io.stdin.off("data", this.onData);
    this.io.stdout.off("resize", this.onSize);
    try {
      this.io.stdin.setRawMode?.(false);
    } catch {
      // the terminal is already gone
    }
    this.io.stdin.pause();
    this.restoreNow();
  }

  /** The leave sequence, written synchronously where the stream has a file descriptor so it lands before exit. */
  restoreNow(): void {
    const text = `${this.syncSupported ? SYNC_OFF : ""}${LEAVE}`;
    const fd = this.io.stdout.fd;
    try {
      if (typeof fd === "number") writeSync(fd, text);
      else this.io.stdout.write(text);
    } catch {
      // nothing left to write to
    }
  }
}

/**
 * Puts the terminal back on exit, on SIGINT, SIGTERM and SIGHUP, and when the program crashes, and
 * returns a function that removes the handlers. A crash prints its error after the screen is back.
 */
export function restoreOnExit(term: Terminal, proc: NodeJS.Process = process): () => void {
  const back = () => {
    term.stop();
  };
  const crash = (error: unknown) => {
    back();
    proc.stderr.write(`fleet: bridge stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    proc.exit(1);
  };
  const signals: [NodeJS.Signals, number][] = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]];
  const handlers = signals.map(([name, code]) => {
    const handler = () => {
      back();
      proc.exit(code);
    };
    proc.on(name, handler);
    return [name, handler] as const;
  });
  proc.on("exit", back);
  proc.on("uncaughtException", crash);
  proc.on("unhandledRejection", crash);
  return () => {
    for (const [name, handler] of handlers) proc.off(name, handler);
    proc.off("exit", back);
    proc.off("uncaughtException", crash);
    proc.off("unhandledRejection", crash);
  };
}
