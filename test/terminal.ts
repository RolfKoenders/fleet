import { EventEmitter } from "node:events";
import type { Terminal } from "../src/prompt.ts";

/**
 * A terminal that answers from a script: each time a question starts reading keys, the next answer arrives as if typed.
 * An answer is the keys of one question (`y`, or a line ending in `\r`); `null` is ctrl-c. `shown` is everything the program wrote.
 */
export function scriptedTerminal(answers: (string | null)[]): Terminal & { shown: () => string; asked: () => number } {
  const queue = [...answers];
  let shown = "";
  let asked = 0;
  const stdin = Object.assign(new EventEmitter(), {
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    pause: () => stdin,
    resume: () => {
      asked += 1;
      const next = queue.shift();
      setImmediate(() => {
        if (next === undefined) stdin.emit("end");
        else stdin.emit("data", next === null ? "\u0003" : next);
      });
      return stdin;
    },
  });
  return { stdin: stdin as unknown as Terminal["stdin"], out: { write: (t: string) => void (shown += t) }, shown: () => shown, asked: () => asked };
}
