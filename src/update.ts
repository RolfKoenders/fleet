import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGit, UnreachableError } from "./git.ts";
import type { Result } from "./output.ts";
import { describeChanges, pinChanges } from "./pinchanges.ts";
import { replaceCommit } from "./pinedit.ts";
import { PIN_FILE, readPin } from "./pin.ts";

const invalid = (...messages: string[]): Result => ({ code: "invalid", messages: messages.map((m) => `fleet: ${m}`) });
const short = (sha: string) => sha.slice(0, 7);

/**
 * `fleet update`: move the pinned tool commit in `fleet.yaml` to the head of the branch it tracks, and change
 * nothing else. The head is read with `git ls-remote`, so no clone moves. Nothing is committed, pushed or applied:
 * the change is reviewed and published like any other, and hosts pick it up at their next apply. What changed
 * between the two commits is printed after the pin line, for the person who reads it before pushing.
 */
export function update(configDir: string): Result {
  const problems: string[] = [];
  const pin = readPin(configDir, problems);
  if (pin === null) return invalid(...problems);

  const remote = runGit(configDir, "ls-remote", "--", pin.repo, `refs/heads/${pin.track}`);
  if (!remote.ok) throw new UnreachableError(`cannot read ${pin.repo}: ${remote.stderr.split("\n")[0]}`);
  const head = /^([0-9a-f]{40})\t/.exec(remote.stdout)?.[1];
  if (head === undefined) return invalid(`branch ${pin.track} is not in ${pin.repo}`);

  const fields = { repo: pin.repo, track: pin.track, from: pin.commit, to: head };
  if (head === pin.commit) return { code: "ok", text: `tool: up to date (${short(head)})`, fields: { ...fields, updated: false } };

  const file = join(configDir, PIN_FILE);
  const next = replaceCommit(readFileSync(file, "utf8"), "tool", null, pin.commit, head);
  if (next === null) return invalid(`cannot find the 'commit:' line under 'tool:' in ${PIN_FILE}; change it by hand to ${head}`);
  const changes = pinChanges(pin.repo, pin.track, pin.commit, head);
  writeFileSync(file, next);
  return {
    code: "ok",
    text: `tool: ${short(pin.commit)} -> ${short(head)} (${pin.track})\n\n${describeChanges(changes)}`,
    messages: [`fleet: ${PIN_FILE} updated. Review it with 'git diff', then 'fleet push' publishes it and applies it on every host. Nothing was committed or applied.`],
    fields: { ...fields, updated: true, changes },
  };
}
