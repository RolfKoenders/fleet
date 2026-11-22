/**
 * Questions on a terminal. The prompts go to `out` (stderr for a command, so its result on stdout stays clean) and the answers
 * come from `stdin` in raw mode, one key at a time: nothing is echoed unless this module writes it, which it never does for
 * `secret`. A fake stream stands in for a terminal in a test.
 */

export type Terminal = {
  stdin: NodeJS.ReadableStream & { setRawMode?: (on: boolean) => unknown };
  out: { write: (text: string) => unknown };
};

/** Raised when the person presses ctrl-c at a question. */
export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export type Prompter = {
  say: (text: string) => void;
  /** One key: `y` is yes, `n` or enter is no (or yes, when `fallback` is true and the answer is enter). */
  confirm: (question: string, fallback?: boolean) => Promise<boolean>;
  /** A line, typed in view. */
  line: (label: string) => Promise<string>;
  /** A line that is never shown, not even as stars. Resolves to what was typed, `""` for just enter. */
  secret: (label: string) => Promise<string>;
};

function keys(terminal: Terminal, onKey: (char: string, stop: () => void) => void): Promise<void> {
  const { stdin } = terminal;
  stdin.setRawMode?.(true);
  stdin.setEncoding?.("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    const finish = (settle: () => void) => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.setRawMode?.(false);
      stdin.pause();
      settle();
    };
    const onEnd = () => finish(() => reject(new Cancelled()));
    const onData = (chunk: string | Buffer) => {
      const text = String(chunk);
      if (text.startsWith("\u001b")) return; // an arrow key or other escape sequence
      for (const char of text) {
        if (char === "\u0003") return finish(() => reject(new Cancelled()));
        let stopped = false;
        onKey(char, () => (stopped = true));
        if (stopped) return finish(resolve);
      }
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
  });
}

/** Reads until enter, backspace editing as it goes. `echo` writes each character back, and is off for a secret. */
async function readLine(terminal: Terminal, label: string, echo: boolean): Promise<string> {
  terminal.out.write(label);
  let value: string[] = [];
  try {
    await keys(terminal, (char, stop) => {
      if (char === "\r" || char === "\n" || char === "\u0004") return stop();
      if (char === "\u007f" || char === "\b") {
        if (echo && value.length > 0) terminal.out.write("\b \b");
        value = value.slice(0, -1);
      } else if (char >= " ") {
        value.push(char);
        if (echo) terminal.out.write(char);
      }
    });
  } finally {
    terminal.out.write("\n");
  }
  return value.join("");
}

export function prompter(terminal: Terminal): Prompter {
  return {
    say: (text) => void terminal.out.write(`${text}\n`),
    async confirm(question, fallback = false) {
      terminal.out.write(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `);
      let answer = fallback;
      try {
        await keys(terminal, (char, stop) => {
          if (char === "y" || char === "Y") answer = true;
          else if (char === "n" || char === "N") answer = false;
          else if (char !== "\r" && char !== "\n") return;
          stop();
        });
      } finally {
        terminal.out.write(`${answer ? "y" : "n"}\n`);
      }
      return answer;
    },
    line: (label) => readLine(terminal, label, true),
    secret: (label) => readLine(terminal, label, false),
  };
}
