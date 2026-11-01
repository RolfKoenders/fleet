import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { InvalidConfigError } from "./config.ts";
import { hostNames, secretsFile, writeSopsConfig } from "./recipients.ts";
import { NeedsSecretError, findSops, firstLine, requireAgeKey, runSops, sopsEnv } from "./sops.ts";
import type { Result } from "./output.ts";

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

const invalid = (...messages: string[]): Result => ({ code: "invalid", messages: messages.map((m) => `fleet: ${m}`) });

/** `fleet secrets edit|set|rekey`. None of these commits. */
export async function secrets(configDir: string, args: string[], home: string = homedir()): Promise<Result> {
  const [sub, ...rest] = args;
  try {
    if (sub === "edit") return edit(configDir, rest, home);
    if (sub === "rekey") return rekey(configDir, rest, home);
    if (sub === "set") return await set(configDir, rest, home);
    return invalid(`usage: fleet secrets edit <file> | set <file> <NAME> | rekey`);
  } catch (error) {
    if (error instanceof InvalidConfigError) return invalid(...error.problems);
    if (error instanceof NeedsSecretError) return { code: "needs-secret", messages: [`fleet: ${error.message}`] };
    throw error;
  }
}

/** The file argument: `shared` or the name of a host that has a host file. The argument is never echoed: it may be a secret typed in the wrong place. */
function fileArg(configDir: string, name: string | undefined): string | Result {
  if (name !== undefined && (name === "shared" || hostNames(configDir).includes(name))) return name;
  return invalid(`the first argument must be 'shared' or a host with a file in hosts/ (${hostNames(configDir).join(", ") || "none"})`);
}

function promptHidden(label: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(label);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (settle: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      settle();
    };
    const onData = (chunk: string) => {
      if (chunk.startsWith("\u001b")) return; // an arrow key or other escape sequence
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") return finish(() => resolve(value));
        if (char === "\u0003") return finish(() => reject(new Error("cancelled")));
        if (char === "\u007f" || char === "\b") value = [...value].slice(0, -1).join("");
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

/** Writes `.sops.yaml`. A result when `file` has no recipients, so nothing could be encrypted for it. */
function writeConfigFor(configDir: string, file: string): Result | null {
  if (writeSopsConfig(configDir).some((rule) => rule.file === file)) return null;
  return invalid(`hosts/${file}.yaml has no age recipient, so ${secretsFile(file)} cannot be encrypted for it`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

const ROTATE = "fleet: rekey does not rotate tokens: after a leaked key or a retired host, rotate the real tokens too";

function rekey(configDir: string, args: string[], home: string): Result {
  if (args.length > 0) return invalid("secrets rekey takes no arguments");
  const rules = writeSopsConfig(configDir);
  let files: string[] = [];
  try {
    files = readdirSync(join(configDir, "secrets")).filter((f) => f.endsWith(".enc.yaml")).sort();
  } catch {
    // no secrets yet
  }
  // A file nobody can read has no rule to rekey it by. The others still get updated, so a retired host loses access.
  const covered = (f: string) => rules.some((r) => secretsFile(r.file) === `secrets/${f}`);
  const orphans = files.filter((f) => !covered(f));
  files = files.filter(covered);
  const warnings = orphans.map((f) => `fleet: secrets/${f} has no recipients (its host has no age recipient or no host file); delete it or set 'age'`);

  const rekeyed: string[] = [];
  if (files.length > 0) {
    const sops = findSops(home);
    requireAgeKey(home);
    for (const f of files) {
      const r = runSops(sops, configDir, home, ["updatekeys", "-y", `secrets/${f}`]);
      if (r.status !== 0) {
        return { code: "error", messages: [`fleet: sops could not update secrets/${f}: ${firstLine(r.stderr)}`, ...(rekeyed.length > 0 ? [`fleet: already updated: ${rekeyed.join(", ")}`] : [])] };
      }
      rekeyed.push(`secrets/${f}`);
    }
  }
  const text = rekeyed.length === 0 ? "wrote .sops.yaml; no secrets files to update" : `wrote .sops.yaml\n${rekeyed.map((f) => `updated ${f}`).join("\n")}`;
  return { code: "ok", text, messages: [...warnings, ROTATE], fields: { rekeyed } };
}

/** `sops edit` on a terminal. It opens the user's editor, so without a TTY there is nothing to do. */
function edit(configDir: string, args: string[], home: string): Result {
  if (args.length > 1) return invalid("secrets edit takes one file: `shared` or a host name");
  const file = fileArg(configDir, args[0]);
  if (typeof file !== "string") return file;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return invalid("secrets edit opens an editor and needs a terminal; use `fleet secrets set` from a script");

  const sops = findSops(home);
  requireAgeKey(home);
  const missing = writeConfigFor(configDir, file);
  if (missing !== null) return missing;
  const r = spawnSync(sops, ["--config", join(configDir, ".sops.yaml"), "edit", secretsFile(file)], {
    cwd: configDir,
    stdio: "inherit",
    env: sopsEnv(home),
  });
  if (r.status !== 0) return { code: "error", messages: [`fleet: sops edit exited with ${r.status}`] };
  return { code: "ok", messages: [`fleet: edited ${secretsFile(file)}; \`fleet push\` commits it`] };
}

async function set(configDir: string, args: string[], home: string): Promise<Result> {
  if (args.length > 2) {
    return invalid("secrets set takes a file and a name only: the value comes from stdin, never an argument");
  }
  const file = fileArg(configDir, args[0]);
  if (typeof file !== "string") return file;
  const name = args[1];
  if (name === undefined || !SECRET_NAME.test(name)) return invalid("a secret name matches [A-Z][A-Z0-9_]*, for example TRACKER_API_KEY");

  const sops = findSops(home);
  requireAgeKey(home);
  const missing = writeConfigFor(configDir, file);
  if (missing !== null) return missing;

  const value = process.stdin.isTTY ? await promptHidden(`Value for ${name} (hidden): `) : await readStdin();
  if (value === "") return invalid("the value is empty; pipe it on stdin");

  const path = join(configDir, secretsFile(file));
  if (!existsSync(path)) {
    const created = runSops(sops, configDir, home, ["encrypt", "--filename-override", secretsFile(file), "--input-type", "yaml", "--output-type", "yaml"], "{}\n");
    if (created.status !== 0) return { code: "error", messages: [`fleet: sops could not create ${secretsFile(file)}: ${firstLine(created.stderr)}`] };
    mkdirSync(join(configDir, "secrets"), { recursive: true });
    writeFileSync(path, created.stdout);
  }
  // sops reads this as JSON, so the value is quoted. It travels on stdin, never in argv.
  const written = runSops(sops, configDir, home, ["set", "--value-stdin", secretsFile(file), JSON.stringify([name])], JSON.stringify(value));
  if (written.status !== 0) return { code: "error", messages: [`fleet: sops could not set ${name}: ${firstLine(written.stderr)}`] };
  return { code: "ok", text: `set ${name} in ${secretsFile(file)}` };
}
