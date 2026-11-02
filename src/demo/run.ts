import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "../output.ts";
import { buildSandbox, destroy, sandboxEnv } from "./sandbox.ts";
import type { Sandbox } from "./sandbox.ts";

/** What to try, in order. `exit` is the exit code a correct run gives, which the scripted run checks. */
const STEPS: { command: string; why: string; exit: number }[] = [
  { command: "fleet status --all", why: "every host at a glance: laptop has a change waiting, server has a conflict", exit: 0 },
  { command: "fleet diff", why: "what an apply would change here", exit: 0 },
  { command: 'fleet push -m "Add the triage skill"', why: "publish the change and apply it everywhere; server stops on its conflict", exit: 3 },
  { command: "ssh me@server 'rm ~/.claude/rules/host.md'", why: "clear the conflict: a hand-made file is in the way of fleet's link", exit: 0 },
  { command: "fleet push", why: "publish again; server is now brought level", exit: 0 },
  { command: "fleet status --all", why: "nothing pending and no conflicts", exit: 0 },
];

const out = (text: string): void => {
  writeSync(1, text);
};

function tour(sandbox: Sandbox): string {
  const lines = STEPS.map((s, i) => `  ${i + 1}. ${s.command}\n       ${s.why}`);
  return `fleet demo: a throwaway fleet, made up for you to try.

Three hosts (laptop, server, devbox) live in ${sandbox.root}. This shell is laptop, in its config repo. The other
hosts are reached by a fake ssh, GitHub is a local folder, and nothing outside that folder can be touched.
It is all deleted when you exit.

To try:
${lines.join("\n")}

Also: look around with ls and git log, edit a file in the config, ssh me@devbox 'ls ~/.claude/skills', or run fleet bridge and press P to watch a push live.
Type exit to leave.
`;
}

const environment = (sandbox: Sandbox) => sandboxEnv(sandbox.root, sandbox.admin.home, { config: sandbox.config });

/** Walks the steps like a person would, and reports whether each gave the exit code it should. */
function walk(sandbox: Sandbox, echo: boolean): { command: string; exit: number; expected: number }[] {
  const env = environment(sandbox);
  const results = [];
  for (const step of STEPS) {
    if (echo) out(`\n$ ${step.command}\n`);
    const r = spawnSync(join(sandbox.root, "bin/sh"), ["-c", step.command], { cwd: sandbox.config, env, stdio: echo ? "inherit" : "ignore" });
    results.push({ command: step.command, exit: r.status ?? 1, expected: step.exit });
  }
  return results;
}

async function interactive(sandbox: Sandbox, onChild: (child: ChildProcess) => void): Promise<void> {
  out(tour(sandbox));
  const bash = existsSync(join(sandbox.root, "bin/bash"));
  const env = { ...environment(sandbox), PS1: "(fleet demo) \\w $ " };
  const args = bash ? ["--noprofile", "--norc", "-i"] : ["-i"];
  const child = spawn(join(sandbox.root, "bin", bash ? "bash" : "sh"), args, { cwd: sandbox.config, env, stdio: "inherit" });
  onChild(child);
  await new Promise((resolve) => child.on("close", resolve));
}

/**
 * `fleet demo`: builds the sandbox, then gives the person a shell in it, or, without a terminal (or with
 * `--json`), walks the same steps itself. The sandbox is deleted when the process ends, whichever way it ends.
 */
export async function demo(toolDir: string, json: boolean, _shell = false): Promise<Result> {
  const sandbox = buildSandbox(toolDir);
  process.once("exit", () => destroy(sandbox.root));
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true && !json;
  // The shell is in the terminal's foreground group and gets ^C itself, so the demo only waits for it.
  let shell: ChildProcess | null = null;
  const leave = (code: number) => () => (shell === null ? process.exit(code) : shell.kill("SIGHUP"));
  process.on("SIGINT", tty ? () => {} : leave(130));
  process.on("SIGTERM", leave(143));
  process.on("SIGHUP", leave(129));
  if (tty) {
    await interactive(sandbox, (child) => (shell = child));
    return { code: "ok" };
  }
  if (!json) out(`fleet demo: a throwaway fleet in ${sandbox.root}, deleted when this run ends\n`);
  const steps = walk(sandbox, !json);
  const wrong = steps.filter((s) => s.exit !== s.expected);
  const messages = wrong.map((s) => `fleet: demo step '${s.command}' exited ${s.exit}, not ${s.expected}`);
  if (!json && wrong.length === 0) out("\nfleet demo: every step behaved as expected\n");
  return { code: wrong.length === 0 ? "ok" : "error", messages, fields: { sandbox: sandbox.root, steps } };
}
