import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { isManagedTool } from "./dirs.ts";
import { InvalidConfigError, loadConfig } from "./config.ts";
import { note, send } from "./events.ts";
import { addServer, ensurePrivate, findClaude, isClaudeServer, removeServer, serverName, shadowWarnings } from "./claudemcp.ts";
import { findTool } from "./tools.ts";
import { MissingToolError, repoState, syncRepo, UnreachableError } from "./git.ts";
import { readHostName } from "./host.ts";
import { emptyKeyPlan, keyName, planKeys, writeKeys } from "./keys.ts";
import type { KeyChange, KeyPlan, KeyRef } from "./keys.ts";
import { acquireLock, LockedError } from "./lock.ts";
import { paint } from "./output.ts";
import type { Relayed, Result } from "./output.ts";
import { readPin } from "./pin.ts";
import { emptyPlan, expandTarget, planLinks } from "./plan.ts";
import type { Conflict, LinkPlan } from "./plan.ts";
import { trimLog } from "./logtrim.ts";
import { relaunch, relaunched } from "./relaunch.ts";
import { renderKeys, resolveSecrets } from "./secrets.ts";
import { SETTINGS_FILE } from "./settings.ts";
import { NeedsSecretError } from "./sops.ts";
import { repoConflict } from "./sources.ts";
import type { SourceMode } from "./sources.ts";
import { readState, writeState } from "./state.ts";
import { placeTool } from "./toolclone.ts";
import type { AppliedState, KeyRecord, LinkRecord } from "./state.ts";

type Plan = { links: LinkPlan; keys: KeyPlan; warnings: string[] };
type Planned = { host: string; plan: Plan; state: AppliedState | null };

const conflictsOf = (plan: Plan) => [...plan.keys.conflicts, ...plan.links.conflicts];

/** The commit the config repo is at, or null when it is not a git repository or git is missing: then nothing is recorded. */
function configCommit(configDir: string): string | null {
  try {
    return repoState(configDir).sha;
  } catch {
    return null;
  }
}

/** The result for a failure every command reports the same way, or null for one it does not know. */
export function failure(error: unknown): Result | null {
  if (error instanceof InvalidConfigError) return { code: "invalid", messages: error.problems.map((p) => `fleet: ${p}`) };
  if (error instanceof NeedsSecretError) return { code: "needs-secret", messages: [`fleet: ${error.message}`] };
  if (error instanceof UnreachableError) return { code: "unreachable", messages: [`fleet: ${error.message}`] };
  if (error instanceof MissingToolError) return { code: "missing-prerequisite", messages: [`fleet: ${error.message}`] };
  return null;
}

/**
 * Validates the config, reads the host and plans. Writes nothing. `repoConflicts` are those already met
 * while syncing the repos, reported together with the sources' own.
 */
function prepare(configDir: string, home: string, sources: SourceMode, repoConflicts: Conflict[] = []): Planned | Result {
  const host = readHostName(home);
  if (host === null) {
    return { code: "invalid", messages: ["fleet: no host name set; `fleet init <host>` writes one"] };
  }
  try {
    const config = loadConfig(configDir, host, { home, sources });
    const state = readState(home);
    // A source that could not be put in place hides its skills, so planning would only invent removals.
    const repos = [...repoConflicts, ...config.conflicts];
    if (repos.length > 0) return { host, plan: { links: { ...emptyPlan(), conflicts: repos }, keys: emptyKeyPlan(), warnings: [] }, state };
    const secrets = resolveSecrets(configDir, host, home, config.secrets);
    const rendered = renderKeys(config.keys, secrets);
    // Only `claude` can write its servers. Without it they wait, and the first apply after it is installed adds them.
    const hasClaude = findTool("claude", process.env, home) !== null;
    const desired = hasClaude ? rendered : rendered.filter((key) => !isClaudeServer(key));
    const keys = planKeys(desired, state?.keys ?? [], home);
    if (!hasClaude) keys.removes = keys.removes.filter((key) => !isClaudeServer(key));
    const left = rendered.length - desired.length;
    const plan = {
      links: planLinks(config.files, state?.links ?? [], home),
      keys,
      warnings: [
        ...(left > 0 ? [`claude is not installed, so ${left} MCP server${left === 1 ? " is" : "s are"} left out of ~/.claude.json until it is`] : []),
        ...shadowWarnings(desired.filter(isClaudeServer).map((key) => serverName(key)), home),
      ],
    };
    return { host, plan, state };
  } catch (error) {
    const result = failure(error);
    if (result === null) throw error;
    return result;
  }
}

const isResult = (value: object): value is Result => "code" in value;

type Verbs = { create: string; update: string; remove: string; forget: string };

function report(plan: Plan, verbs: Verbs, color: boolean): Result {
  const { links, keys } = plan;
  const conflicts = conflictsOf(plan);
  const lines: string[] = [];
  const green = (verb: string) => paint(color, "green", verb);
  // A key that used a secret shows its value with the secret masked; others show no value.
  const shown = (key: KeyChange) => (key.display === undefined ? keyName(key) : `${keyName(key)} = ${JSON.stringify(key.display)}`);
  for (const c of keys.creates) lines.push(`${green(verbs.create)} ${shown(c)}`);
  for (const u of keys.updates) lines.push(`${green(verbs.update)} ${shown(u)}`);
  for (const r of keys.removes) lines.push(`${green(verbs.remove)} ${keyName(r)}`);
  for (const f of keys.forgets) lines.push(`${green(verbs.forget)} ${keyName(f)} (already gone)`);
  for (const c of links.creates) lines.push(`${green(verbs.create)} ${c.target} -> ${c.source}`);
  for (const r of links.removes) lines.push(`${green(verbs.remove)} ${r.target}`);
  for (const f of links.forgets) lines.push(`${green(verbs.forget)} ${f.target} (already gone)`);
  for (const c of conflicts) lines.push(`${paint(color, "yellow", "conflict")} ${c.path}: ${c.detail}`, `  fix: ${c.fix}`);
  if (lines.length === 0) lines.push("nothing to do");
  for (const warning of plan.warnings) lines.push(`${paint(color, "yellow", "warning")} ${warning}`);

  const conflicted = conflicts.length > 0;
  const ref = ({ file, path }: KeyRef): KeyRef => ({ file, path });
  return {
    code: conflicted ? "conflict" : "ok",
    text: lines.join("\n"),
    messages: conflicted
      ? [`fleet: ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}; nothing was written`]
      : [],
    fields: {
      created: [...keys.creates.map(ref), ...links.creates],
      updated: keys.updates.map(ref),
      removed: [...keys.removes.map(ref), ...links.removes],
      forgotten: [...keys.forgets.map(keyName), ...links.forgets.map((f) => f.target)],
      unchanged: [...keys.noops.map(keyName), ...links.noops.map((n) => n.target)],
      warnings: plan.warnings,
      conflicts,
    },
  };
}

/**
 * What `fleet status` counts: the changes `diff` would list, as `apply` reports them, and its conflicts. A conflicted
 * link or key is not pending. Reads the host and the clones as they are, so it needs no network; a skill source that
 * is not cloned yet is a result with its reason, not a clone.
 */
export function planCounts(configDir: string, home: string): { pending: number; conflicts: number } | Result {
  const planned = prepare(configDir, home, "offline");
  if (isResult(planned)) return planned;
  const { links, keys } = planned.plan;
  const pending = links.creates.length + links.removes.length + keys.creates.length + keys.updates.length + keys.removes.length;
  return { pending, conflicts: conflictsOf(planned.plan).length };
}

/** The conflicts `diff` would list, read the way `status` reads them: offline, writing nothing. */
export function planConflicts(configDir: string, home: string): Conflict[] | Result {
  const planned = prepare(configDir, home, "offline");
  return isResult(planned) ? planned : conflictsOf(planned.plan);
}

export function diff(configDir: string, color: boolean, home: string = homedir()): Result {
  const planned = prepare(configDir, home, "diff");
  if (isResult(planned)) return planned;
  return report(planned.plan, { create: "create", update: "update", remove: "remove", forget: "forget" }, color);
}

/**
 * Brings the config repo level with GitHub, then puts the fleet clone at the commit that config
 * pins. Only the managed fleet clone is ever moved. Any other checkout, such as a development one, runs its
 * own code and is neither fetched nor moved. `moved` is true when the fleet clone's code changed.
 */
function syncRepos(toolDir: string, configDir: string, home: string): { conflicts: Conflict[]; moved: boolean } | Result {
  try {
    let blocked: string | null;
    try {
      blocked = syncRepo(configDir).blocked;
    } catch (error) {
      if (error instanceof UnreachableError) return { code: "unreachable", messages: [`fleet: cannot fetch the config repo at ${configDir}: ${error.message}`] };
      throw error;
    }
    // With local work in the config repo, its pin is not known to be what GitHub has, so the tool stays put.
    if (blocked !== null) return { conflicts: [repoConflict(configDir, blocked)], moved: false };
    if (!isManagedTool(toolDir, home)) {
      note(`fleet: running from ${toolDir}, not the managed fleet clone, so the config's pinned tool commit was not enforced`, readHostName(home));
      return { conflicts: [], moved: false };
    }
    const problems: string[] = [];
    const pin = readPin(configDir, problems);
    if (pin === null) throw new InvalidConfigError(problems);
    const { conflict, moved } = placeTool(toolDir, pin);
    return { conflicts: conflict === null ? [] : [conflict], moved };
  } catch (error) {
    const result = failure(error);
    if (result === null) throw error;
    return result;
  }
}

/** `relaunchArgs` is the command line to run when the fleet clone moved to the pinned commit, so that code does the rest. */
export function apply(toolDir: string, configDir: string, color: boolean, home: string = homedir(), relaunchArgs: string[] = ["apply"]): Result | Relayed {
  let release: (() => void) | null;
  try {
    release = acquireLock(home);
  } catch (error) {
    if (error instanceof LockedError) return { code: "locked", messages: [`fleet: ${error.message}`] };
    throw error;
  }
  const unlock = () => {
    release?.();
    release = null;
  };
  const name = readHostName(home);
  try {
    trimLog(home);
    send({ event: "stage", host: name, stage: "sync" });
    const synced = syncRepos(toolDir, configDir, home);
    if (isResult(synced)) return synced;
    if (synced.moved && !relaunched()) {
      // The new run takes the lock itself, so this one lets go first.
      unlock();
      return relaunch(toolDir, relaunchArgs);
    }
    send({ event: "stage", host: name, stage: "plan" });
    const planned = prepare(configDir, home, "apply", synced.conflicts);
    if (isResult(planned)) return planned;
    const { host, plan, state } = planned;
    const result = report(plan, { create: "created", update: "updated", remove: "removed", forget: "forgot" }, color);
    if (conflictsOf(plan).length > 0) return result;

    const links = new Map<string, string>((state?.links ?? []).map((l) => [l.target, l.source]));
    const keys = new Map<string, KeyRecord>((state?.keys ?? []).map((k) => [keyName(k), k]));
    // The config commit is part of what is compared, because state is otherwise saved only when links or keys change.
    const configSha = configCommit(configDir);
    const snapshot = (config: string | null) => JSON.stringify([[...links], [...keys], config]);
    const before = snapshot(state?.repos?.config ?? null);
    for (const noop of plan.links.noops) links.set(noop.target, noop.source);
    for (const forgotten of plan.links.forgets) links.delete(forgotten.target);
    for (const noop of plan.keys.noops) keys.set(keyName(noop), noop);
    for (const forgotten of plan.keys.forgets) keys.delete(keyName(forgotten));

    let fleetSha: string;
    try {
      fleetSha = repoState(toolDir).sha;
    } catch (error) {
      if (error instanceof MissingToolError) return { code: "missing-prerequisite", messages: [`fleet: ${error.message}`] };
      throw error;
    }
    const save = () => {
      const records: LinkRecord[] = [...links].map(([target, source]) => ({ target, source }));
      writeState(
        {
          version: 1,
          host,
          appliedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
          repos: { ...state?.repos, fleet: fleetSha, ...(configSha === null ? {} : { config: configSha }) },
          links: records,
          keys: [...keys.values()],
        },
        home,
      );
    };

    const claudeSets = [...plan.keys.creates, ...plan.keys.updates].filter(isClaudeServer);
    const claudeRemoves = plan.keys.removes.filter(isClaudeServer);
    let claude = "";
    if (claudeSets.length + claudeRemoves.length > 0) {
      try {
        claude = findClaude(home);
      } catch (error) {
        if (error instanceof MissingToolError) return { code: "missing-prerequisite", messages: [`fleet: ${error.message}`] };
        throw error;
      }
    }

    // What the write stage will do, so a reader can show `n of`: one step per settings file, per `claude` call, per link.
    const settingsFiles = Object.values(SETTINGS_FILE).filter((file) => plan.keys.removes.some((k) => k.file === file) || [...plan.keys.creates, ...plan.keys.updates].some((k) => k.file === file));
    const of = settingsFiles.length + claudeRemoves.length + claudeSets.length + plan.links.creates.length + plan.links.removes.length;
    let n = 0;
    const done = (step: string, target: string) => send({ event: "step", host: name, step, target, n: ++n, of });
    send({ event: "stage", host: name, stage: "write", of });

    for (const file of Object.values(SETTINGS_FILE)) {
      const removes = plan.keys.removes.filter((k) => k.file === file);
      const sets = [...plan.keys.creates, ...plan.keys.updates].filter((k) => k.file === file);
      if (removes.length + sets.length === 0) continue;
      const written = writeKeys(file, removes, sets, home);
      for (const remove of removes) keys.delete(keyName(remove));
      for (const record of written) keys.set(keyName(record), record);
      save();
      done("write-keys", file);
    }
    const updating = new Set(plan.keys.updates.map(keyName));
    try {
      for (const remove of claudeRemoves) {
        removeServer(claude, home, remove);
        keys.delete(keyName(remove));
        save();
        done("remove-server", keyName(remove));
      }
      for (const set of claudeSets) {
        if (updating.has(keyName(set))) removeServer(claude, home, set);
        keys.set(keyName(set), addServer(claude, home, set));
        save();
        done("add-server", keyName(set));
      }
    } finally {
      // Whatever mode `claude` left it in, even when a command failed part way.
      if (claudeSets.length + claudeRemoves.length > 0) ensurePrivate(home);
    }
    for (const create of plan.links.creates) {
      const path = expandTarget(create.target, home);
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(create.source, path);
      links.set(create.target, create.source);
      save();
      done("write-link", create.target);
    }
    for (const remove of plan.links.removes) {
      rmSync(expandTarget(remove.target, home));
      links.delete(remove.target);
      save();
      done("remove-link", remove.target);
    }
    if (snapshot(configSha ?? state?.repos?.config ?? null) !== before) save();
    return result;
  } finally {
    unlock();
  }
}
