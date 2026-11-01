import type { Buffer as Frame } from "./buffer.ts";
import { keyFromLabel } from "./input.ts";
import { Runtime } from "./runtime.ts";
import type { App, Core } from "./runtime.ts";

/**
 * The app without a terminal: feed keys and time, read frames back as text. The same runtime runs the
 * real thing, so what a test sees is what the screen would show.
 */
export class Headless<S, M> {
  readonly runtime: Runtime<S, M>;
  private clock = 0;

  constructor(app: App<S, M>, size: { cols: number; rows: number } = { cols: 100, rows: 32 }) {
    this.runtime = new Runtime(app, size);
    this.runtime.send({ type: "tick", now: 0, late: 0 });
  }

  get state(): S {
    return this.runtime.state;
  }

  /** Presses keys named by label: `ctrl+k`, `down`, `enter`, `esc` is `escape`, `a`, `space`. */
  press(...labels: string[]): this {
    for (const label of labels) this.runtime.send({ type: "key", key: keyFromLabel(label) });
    return this;
  }

  type(text: string): this {
    for (const ch of text) this.runtime.send({ type: "key", key: { name: "char", text: ch } });
    return this;
  }

  send(message: Core | M): this {
    this.runtime.send(message);
    return this;
  }

  resize(cols: number, rows: number): this {
    this.runtime.send({ type: "resize", size: { cols, rows } });
    return this;
  }

  /** Moves the clock on, in 33 ms ticks as the real loop would send them. */
  advance(ms: number): this {
    for (let left = ms; left > 0; left -= 33) {
      this.clock += Math.min(33, left);
      this.runtime.send({ type: "tick", now: this.clock, late: 0 });
    }
    return this;
  }

  /** Waits for every background task started so far. */
  async settle(): Promise<this> {
    await this.runtime.idle();
    return this;
  }

  buffer(): Frame {
    return this.runtime.view();
  }

  /** The screen as plain text. */
  frame(): string {
    return this.buffer().toText();
  }
}
