import type { Review } from "./skillreview.ts";
import { reviewFooter } from "./skillreport.ts";

/** `stop` keeps this pin and every one after it. */
export type Choice = "diff" | "yes" | "no" | "stop";

/** The streams a prompt talks to; a terminal in use, a fake in a test. */
export type PromptIO = {
  stdin: NodeJS.ReadableStream & { setRawMode?: (on: boolean) => unknown };
  stdout: { write: (text: string) => unknown };
};

/**
 * What one keypress means. Only a single, plain key counts, so an arrow key, a paste or keys typed ahead
 * can never move a pin. Ctrl-C, Ctrl-D and q stop, because raw mode turns off the terminal's own Ctrl-C.
 */
export function reviewKey(chunk: string): Choice | null {
  switch (chunk) {
    case "d": case "D": return "diff";
    case "y": case "Y": return "yes";
    case "n": case "N": return "no";
    case "q": case "Q": case "\u0003": case "\u0004": return "stop";
    default: return null;
  }
}

/** Waits for one key that means something. The end of stdin is a stop. */
function readChoice(stdin: PromptIO["stdin"]): Promise<Choice> {
  stdin.setRawMode?.(true);
  stdin.setEncoding?.("utf8");
  stdin.resume();
  return new Promise((resolve) => {
    const done = (choice: Choice) => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.setRawMode?.(false);
      stdin.pause();
      resolve(choice);
    };
    const onData = (chunk: string | Buffer) => {
      const choice = reviewKey(String(chunk));
      if (choice !== null) done(choice);
    };
    const onEnd = () => done("stop");
    stdin.on("data", onData);
    stdin.once("end", onEnd);
  });
}

/** Asks whether one pin moves. `d` shows the full diff and asks again. */
export async function askPin(io: PromptIO, from: string, review: Review): Promise<"yes" | "no" | "stop"> {
  for (;;) {
    io.stdout.write(`\n${reviewFooter(from)}\n`);
    const choice = await readChoice(io.stdin);
    if (choice !== "diff") {
      io.stdout.write(`${choice === "yes" ? "y" : choice === "no" ? "n" : "stopped"}\n`);
      return choice;
    }
    io.stdout.write(`\n${review.diff === "" ? "(the skills you use have no file changes)" : review.diff}\n`);
  }
}
