import { redactUrl } from "./redact.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGit, UnreachableError } from "./git.ts";
import type { Result } from "./output.ts";
import { changesBetween, describeChanges, pinChanges, withClone } from "./pinchanges.ts";
import { replaceCommit } from "./pinedit.ts";
import { PIN_FILE, readPin, TRACK_RELEASES } from "./pin.ts";
import type { Pin } from "./pin.ts";
import { isAncestor, majorOf, newestRelease } from "./release.ts";

const invalid = (...messages: string[]): Result => ({ code: "invalid", messages: messages.map((m) => `fleet: ${m}`) });
const short = (sha: string) => sha.slice(0, 7);

/**
 * `fleet update`: move the pinned tool commit in `fleet.yaml` to the head of the branch it tracks, or to the newest
 * release when `track` is `releases`, and change nothing else. The target is read with `git ls-remote`, so no clone
 * moves. Nothing is committed, pushed or applied: the change is reviewed and published like any other, and hosts
 * pick it up at their next apply. What changed between the two commits is printed after the pin line, for the
 * person who reads it before pushing.
 */
export function update(configDir: string): Result {
  const problems: string[] = [];
  const pin = readPin(configDir, problems);
  if (pin === null) return invalid(...problems);
  if (pin.track === TRACK_RELEASES) return updateToRelease(configDir, pin);

  const remote = runGit(configDir, "ls-remote", "--", pin.repo, `refs/heads/${pin.track}`);
  if (!remote.ok) throw new UnreachableError(`cannot read ${redactUrl(pin.repo)}: ${redactUrl(remote.stderr.split("\n")[0] ?? "")}`);
  const head = /^([0-9a-f]{40})\t/.exec(remote.stdout)?.[1];
  if (head === undefined) return invalid(`branch ${pin.track} is not in ${redactUrl(pin.repo)}`);

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

/**
 * `fleet update` for `track: releases`. The newest release is the highest `vX.Y.Z` tag, whatever the tag dates.
 * A pin that already holds the release's commit needs no history. Any other pin is compared with it in one
 * throwaway clone, which also supplies the changes: a pin the release is an ancestor of is past it and stays
 * put until the next release; anything else (an older release, or a line that never met it) moves to it.
 */
function updateToRelease(configDir: string, pin: Pin): Result {
  const remote = runGit(configDir, "ls-remote", "--tags", "--", pin.repo);
  if (!remote.ok) throw new UnreachableError(`cannot read ${redactUrl(pin.repo)}: ${redactUrl(remote.stderr.split("\n")[0] ?? "")}`);
  const release = newestRelease(remote.stdout);
  if (release === null) return invalid(`no release tags (vX.Y.Z) in ${redactUrl(pin.repo)}`);

  const fields = { repo: pin.repo, track: pin.track, from: pin.commit, to: release.commit, release: release.tag };
  if (release.commit === pin.commit) return { code: "ok", text: `tool: up to date (${release.tag})`, fields: { ...fields, updated: false } };

  const { past, changes, major } = withClone(pin.repo, { tags: true }, (clone) => {
    const known = clone !== null && clone.has(pin.commit) && clone.has(release.commit);
    return {
      past: known && isAncestor(clone.dir, release.commit, pin.commit),
      changes: changesBetween(clone, pin.commit, release.commit),
      major: known && majorOf(clone.dir, pin.commit) < release.version[0],
    };
  });
  if (past) {
    return {
      code: "ok",
      text: `tool: ${short(pin.commit)} is past ${release.tag}; up to date until the next release`,
      fields: { ...fields, to: pin.commit, updated: false },
    };
  }

  const file = join(configDir, PIN_FILE);
  const next = replaceCommit(readFileSync(file, "utf8"), "tool", null, pin.commit, release.commit);
  if (next === null) return invalid(`cannot find the 'commit:' line under 'tool:' in ${PIN_FILE}; change it by hand to ${release.commit}`);
  writeFileSync(file, next);
  const warning = major ? `\nthis is a new major version: read "You need to do" before you push\n` : "";
  return {
    code: "ok",
    text: `tool: ${short(pin.commit)} -> ${release.tag} (${short(release.commit)})\n${warning}\n${describeChanges(changes)}`,
    messages: [`fleet: ${PIN_FILE} updated. Review it with 'git diff', then 'fleet push' publishes it and applies it on every host. Nothing was committed or applied.`],
    fields: { ...fields, updated: true, changes },
  };
}
