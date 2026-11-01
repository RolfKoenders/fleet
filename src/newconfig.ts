import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoState, runGit } from "./git.ts";
import type { Result } from "./output.ts";
import { PIN_FILE, readPin, urlProblem } from "./pin.ts";

const invalid = (...messages: string[]): Result => ({ code: "invalid", messages: messages.map((m) => `fleet: ${m}`) });

/** Sets the value of a top-level-indented `key:` line under `tool:` in the example pin, keeping its comments. */
function setPinValue(text: string, key: string, value: string): string | null {
  const line = new RegExp(`^( +${key}:[ \\t]*)[^\\s#]+`, "m");
  return line.test(text) ? text.replace(line, (_, head: string) => `${head}${value}`) : null;
}

/**
 * `fleet new <dir>`: start a config repo from `examples/` in the tool. The directory must not exist or be
 * empty. It is made a git repository and its `fleet.yaml` pins the commit of the tool running this. Creating the
 * repo on GitHub, committing and the first `fleet init` are left to the person, as a checklist.
 */
export function newConfig(toolDir: string, arg: string | undefined): Result {
  if (arg === undefined) return invalid("usage: fleet new <dir>");
  const target = resolve(arg);
  const examples = join(toolDir, "examples");
  if (!existsSync(examples)) return invalid(`${examples} is missing, so there is nothing to start from`);

  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) return invalid(`${target} exists and is not a directory`);
    if (readdirSync(target).length > 0) return invalid(`${target} is not empty; 'fleet new' only starts a config in a new or empty directory`);
  }

  const origin = runGit(toolDir, "remote", "get-url", "origin");
  if (!origin.ok || origin.stdout === "") return invalid("the tool has no 'origin' remote, so there is no URL for hosts to clone it from");
  const problem = urlProblem(origin.stdout);
  if (problem !== null) return invalid(`the tool's origin URL ${problem}`);
  const commit = repoState(toolDir).sha;
  // Hosts clone the pin from the remote, so it has to be there. Only what this clone already knows of the remote is checked.
  if (runGit(toolDir, "branch", "--remotes", "--contains", commit).stdout === "") {
    return invalid(`the tool's commit ${commit.slice(0, 7)} is not on any remote branch, so hosts could not fetch it; push it first`);
  }

  let pin = readFileSync(join(examples, PIN_FILE), "utf8");
  for (const [key, value] of [["repo", origin.stdout], ["commit", commit]] as const) {
    const next = setPinValue(pin, key, value);
    if (next === null) throw new Error(`examples/${PIN_FILE} has no '${key}:' line to set`);
    pin = next;
  }

  // Built beside the target and renamed into place, so a failure leaves no half-made directory.
  mkdirSync(dirname(target), { recursive: true });
  const building = mkdtempSync(join(dirname(target), ".fleet-new-"));
  let written;
  try {
    cpSync(examples, building, { recursive: true });
    writeFileSync(join(building, PIN_FILE), pin);
    const problems: string[] = [];
    written = readPin(building, problems);
    if (written === null) throw new Error(`examples/${PIN_FILE} does not make a valid pin: ${problems.join("; ")}`);
    const init = runGit(building, "init", "--quiet", "--initial-branch=main");
    if (!init.ok) throw new Error(`cannot run git init in ${target}: ${init.stderr.split("\n")[0]}`);
    if (existsSync(target)) rmdirSync(target);
    renameSync(building, target);
  } catch (error) {
    rmSync(building, { recursive: true, force: true });
    throw error;
  }

  const name = target.split("/").at(-1) ?? "my-fleet";
  const checklist = [
    `Make it yours: rename the hosts in ${target}/hosts/ (laptop is the admin, server is reached over ssh) and edit the catalog; every file explains itself`,
    `Commit it: git -C ${target} add -A && git -C ${target} commit -m "Start my fleet config"`,
    `Create the private GitHub repo and push (fleet does not create it): gh repo create ${name} --private --source ${target} --remote origin --push`,
    `On the admin host: cd ${target} && fleet init laptop`,
  ];
  return {
    code: "ok",
    text: `Started a config repo in ${target}, pinned to tool commit ${commit.slice(0, 7)}.\n\nNext, by hand:\n${checklist.map((i) => `  [ ] ${i}`).join("\n")}`,
    fields: { dir: target, pin: written, checklist },
  };
}
