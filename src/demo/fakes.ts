import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAUNCHD_LABEL } from "../scheduler.ts";
import { fakeCallsLog, sandboxEnv } from "./sandbox.ts";

/**
 * The demo's stand-ins for the tools fleet would otherwise find on the real system. Run as
 * `node fakes.ts <tool> <args...>` by a wrapper script that sets FLEET_DEMO_ROOT. Every call is logged to the
 * sandbox, so a test can tell the fake was the one that ran.
 */

const [tool = "", ...args] = process.argv.slice(2);
const root = process.env.FLEET_DEMO_ROOT;
const home = process.env.HOME;
if (root === undefined || home === undefined) {
  console.error(`fake ${tool}: only runs inside a fleet demo`);
  process.exit(2);
}
appendFileSync(fakeCallsLog(root), `${JSON.stringify({ tool, home, args })}\n`);

function claude(): number {
  if (args.length === 1 && args[0] === "--version") {
    console.log("2.1.4 (Claude Code)");
    return 0;
  }
  const file = join(home!, ".claude.json");
  const [group, verb, scope, user, name, json] = args;
  if (group !== "mcp" || scope !== "--scope" || user !== "user" || name === undefined) return 2;
  const doc = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  doc.mcpServers ??= {};
  if (verb === "remove") {
    if (!(name in doc.mcpServers)) {
      console.error(`No MCP server found with name: ${name}`);
      return 1;
    }
    delete doc.mcpServers[name];
  } else {
    return 2;
  }
  writeFileSync(file, JSON.stringify(doc, null, 2));
  chmodSync(file, 0o600);
  return 0;
}

/** Runs the command for the host `dest` names, as that host's own user with its own environment. */
function ssh(): number {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o") i++;
    else rest.push(args[i]!);
  }
  const [dest, ...command] = rest;
  const table = JSON.parse(readFileSync(join(root!, "ssh-hosts.json"), "utf8")) as Record<string, string>;
  const target = dest === undefined ? undefined : table[dest];
  if (target === undefined) {
    console.error(`ssh: Could not resolve hostname ${dest?.split("@").at(-1) ?? ""}: Name or service not known`);
    return 255;
  }
  if (command.length === 0) {
    console.error("fake ssh: the demo only runs a command on a host; give one, such as: ssh me@server 'ls ~'");
    return 1;
  }
  const r = spawnSync(join(root!, "bin/sh"), ["-c", command.join(" ")], { env: sandboxEnv(root!, target), stdio: "inherit" });
  return r.status ?? 1;
}

const FAKES: Record<string, () => number> = {
  claude,
  ssh,
  opencode: () => (args[0] === "--version" ? (console.log("1.4.2"), 0) : 2),
  // The demo has no secrets, so it never decrypts anything; status only asks for the version.
  sops: () => (args[0] === "--version" ? (console.log("sops 3.13.3"), 0) : (console.error("fake sops: the demo uses no secrets"), 1)),
  systemctl: () => (args.join(" ") === "--user is-active fleet.timer" ? (console.log("active"), 0) : 2),
  // On a Mac, status asks whether the LaunchAgent is loaded; every demo host has it.
  launchctl: () => (args[0] === "print" && args[1]?.endsWith(`/${LAUNCHD_LABEL}`) ? 0 : 2),
};

process.exit((FAKES[tool] ?? (() => (console.error(`fake ${tool}: unknown tool`), 2)))());
