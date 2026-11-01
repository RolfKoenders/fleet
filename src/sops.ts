import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findTool } from "./tools.ts";

export class NeedsSecretError extends Error {}

/** The first sops with `set --value-stdin`, which keeps a secret out of argv. */
const MIN_SOPS = [3, 11, 0];

/**
 * `sops --version` asks GitHub whether it is the latest, unless told not to. `--disable-version-check` is what
 * tells it; `--check-for-updates=false` does not (sops 3.13.3 still connects).
 */
export const SOPS_VERSION_ARGS = ["--version", "--disable-version-check"];

export const ageKeyPath = (home: string): string => join(home, ".config/fleet/age.key");

const atLeast = (version: number[], floor: number[]): boolean => {
  for (let i = 0; i < floor.length; i++) {
    if (version[i] !== floor[i]) return (version[i] ?? 0) > floor[i]!;
  }
  return true;
};

/** The version in the output of `sops --version`, or null when it has none. */
export function parseSopsVersion(output: string): number[] | null {
  const match = /\bsops (\d+)\.(\d+)\.(\d+)/.exec(output);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Why a sops version is not good enough for fleet, or null when it is. */
export function sopsVersionProblem(version: number[] | null): string | null {
  if (version === null) return "its version could not be read";
  if (!atLeast(version, MIN_SOPS)) return `sops ${version.join(".")} is too old; fleet needs ${MIN_SOPS.join(".")} or newer`;
  return null;
}

/** The path of a sops new enough for fleet. Does not contact GitHub. */
export function findSops(home: string): string {
  const path = findTool("sops", process.env, home);
  if (path === null) throw new NeedsSecretError("sops is not installed; fleet needs sops 3.11.0 or newer");
  const r = spawnSync(path, SOPS_VERSION_ARGS, { encoding: "utf8" });
  const version = parseSopsVersion(r.stdout ?? "");
  if (r.status !== 0 || version === null) throw new NeedsSecretError(`could not read the version of ${path}; fleet needs sops 3.11.0 or newer`);
  const problem = sopsVersionProblem(version);
  if (problem !== null) throw new NeedsSecretError(problem);
  return path;
}

/** Fails unless this host has its age key, which sops reads through SOPS_AGE_KEY_FILE. */
export function requireAgeKey(home: string): void {
  if (!existsSync(ageKeyPath(home))) {
    throw new NeedsSecretError(`no age key at ${ageKeyPath(home)}; \`fleet init\` creates it`);
  }
}

/** sops reads the host's key file only: a key in the caller's environment must not stand in for it. */
export function sopsEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SOPS_AGE_KEY_FILE: ageKeyPath(home) };
  for (const name of ["SOPS_AGE_KEY", "SOPS_AGE_KEY_CMD", "SOPS_AGE_SSH_PRIVATE_KEY_FILE", "SOPS_AGE_SSH_PRIVATE_KEY_CMD"]) delete env[name];
  return env;
}

export type SopsRun = { status: number | null; stdout: string; stderr: string };

/**
 * Runs sops from the config repo with its generated `.sops.yaml` and this host's age key.
 * `input` goes to stdin, which is how a secret reaches sops without being an argument.
 */
export function runSops(sops: string, configDir: string, home: string, args: string[], input?: string): SopsRun {
  const config = join(configDir, ".sops.yaml");
  const r = spawnSync(sops, [...(existsSync(config) ? ["--config", config] : []), ...args], {
    cwd: configDir,
    encoding: "utf8",
    input: input ?? "",
    env: sopsEnv(home),
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export const firstLine = (text: string): string => text.split("\n").find((l) => l.trim() !== "") ?? "no message";
