// A tiny program for the pty tests: it takes the terminal the way the bridge does, then misbehaves as asked.
import { Terminal, restoreOnExit } from "../../src/tui/terminal.ts";

const mode = process.argv[2] ?? "idle";
const term = new Terminal({ stdin: process.stdin, stdout: process.stdout }, { level: "none", onInput: () => {}, onResize: () => {} });
restoreOnExit(term);
term.start();
process.stdout.write("READY\n");
if (mode === "throw") setTimeout(() => { throw new Error("kaboom"); }, 100);
if (mode === "reject") setTimeout(() => void Promise.reject(new Error("rejected")), 100);
setInterval(() => {}, 1000);
