import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { failure } from "./apply.ts";
import { loadConfig } from "./config.ts";
import { repoState, runGit, UnreachableError } from "./git.ts";
import { readHostName } from "./host.ts";
import { paint } from "./output.ts";
import type { Result } from "./output.ts";
import { readPin, urlProblem } from "./pin.ts";
import type { Pin } from "./pin.ts";
import type { Conflict } from "./plan.ts";
import { syncAndPush } from "./push.ts";
import { hostNames } from "./recipients.ts";
import { parseOs, schedulerFor } from "./scheduler.ts";
import type { Os } from "./scheduler.ts";
import { namesIn } from "./secrets.ts";
import { secrets } from "./secretscli.ts";
import { ageKeyPath, parseSopsVersion, SOPS_VERSION_ARGS, sopsVersionProblem } from "./sops.ts";
import { findTool, SHELL_NODE_CANDIDATES, SHELL_PROBE_PATH } from "./tools.ts";
import { parseFile } from "./yamlfile.ts";

/**
 * Every step checks first, so a rerun after a failure at any step does only what is left. What needs
 * access, credentials or sudo is printed, never attempted.
 *
 * Each step that touches the host is one shell script, run by `sh -c` on this machine for the
 * admin's own form and over `ssh` for any other host, so the two forms are one implementation.
 */

type Run = { status: number | null; stdout: string; stderr: string };
/** Runs a script on the host being set up. Throws `UnreachableError` when ssh cannot reach it. */
type Machine = (script: string) => Run;

type Outcome = { stop: Result } | { changed: boolean; detail?: string };
type StepRecord = { step: number; name: string; state: "done" | "unchanged" | "failed"; detail?: string };

type Ctx = {
  /** The admin's config repo, which holds the hosts and secrets this reads and the recipient it commits. */
  configDir: string;
  home: string;
  host: string;
  admin: string;
  local: boolean;
  /** The host's `ssh` destination. Null for the admin's own form. */
  dest: string | null;
  /** The config repo's origin URL, which the new host clones. */
  url: string;
  /** What the config pins; its `repo` is where the tool comes from. */
  pin: Pin;
  /** The config repo on the host, as a shell word. */
  dir: string;
  /** The fleet clone on the host, as a shell word. */
  tool: string;
  machine: Machine;
  /** The host's OS, read from the host by the first step, which no step before it needs. */
  os: Os;
  steps: StepRecord[];
  messages: string[];
  checklist: string[];
  /** The key of the admin's own host, shown once when it was made. */
  backup: { path: string; key: string } | null;
  recipient: string | null;
  missingSecrets: string[];
  conflicts: Conflict[];
};

const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RECIPIENT = /^age1[a-z0-9]+$/;
const KEY_SHOWN = "~/.config/fleet/age.key";
/** Where a new host keeps the config repo. The admin's own form uses the repo it runs from. */
const CONFIG_DEFAULT = '"$HOME/fleet-config"';
/** The fleet clone `~/.local/bin/fleet` points into, on every host. */
const TOOL_CLONE = '"$HOME/.local/share/fleet/fleet"';

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";
const invalid = (...problems: string[]): Result => ({ code: "invalid", messages: problems.map((p) => `fleet: ${p}`) });
const q = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** Tools are found as `findTool` does, but by a shell that may be non-interactive. */
const PRELUDE = `PATH="${SHELL_PROBE_PATH}:$PATH"; export PATH\nGIT_TERMINAL_PROMPT=0; export GIT_TERMINAL_PROMPT\n`;
const script = (step: string, body: string) => `# fleet init: ${step}\n${PRELUDE}${body}`;

const here = (home: string): Machine => (body) => {
  const r = spawnSync("sh", ["-c", body], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home } });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const there = (ssh: string, dest: string): Machine => (body) => {
  // The remote login shell may be anything, so the script is handed to sh in one quoted word.
  const r = spawnSync(ssh, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", dest, `sh -c ${q(body)}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || r.status === 255) throw new UnreachableError(`${dest} is unreachable over ssh (${r.error?.message ?? (firstLine(r.stderr) || "no reason given")})`);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

type Prepared = Omit<Ctx, "os" | "steps" | "messages" | "checklist" | "backup" | "recipient" | "missingSecrets" | "conflicts">;

function prepare(configDir: string, name: string | undefined, home: string): Prepared | Result {
  if (name === undefined) return invalid("usage: fleet init <host>");
  const names = hostNames(configDir);
  if (!HOST_NAME.test(name) || !names.includes(name)) {
    return invalid(`'${name}' has no host file in hosts/ (${names.join(", ") || "none"}); write hosts/${name}.yaml first`);
  }
  const problems: string[] = [];
  const docs = new Map(names.map((n) => [n, parseFile(join(configDir, "hosts", `${n}.yaml`), false, problems)]));
  if (problems.length > 0) return invalid(...problems);
  const admin = names.find((n) => docs.get(n)?.admin === true);
  if (admin === undefined) return invalid("exactly one host file needs 'admin: true', found none");

  const local = name === admin;
  const named = readHostName(home);
  let dest: string | null = null;
  if (local) {
    if (named !== null && named !== name) return invalid(`this machine is already the host '${named}'; 'fleet init ${name}' sets up the admin host itself`);
  } else {
    if (named === null) return invalid(`this machine has no host name yet; run 'fleet init ${admin}' on the admin host first, then init other hosts from it`);
    if (named !== admin) return invalid(`'fleet init ${name}' runs from the admin host (${admin}); this machine is '${named}'`);
    const ssh = docs.get(name)?.ssh;
    if (typeof ssh !== "string" || ssh === "" || ssh.startsWith("-")) return invalid(`hosts/${name}.yaml needs 'ssh: user@host', because init reaches the host over SSH`);
    dest = ssh;
  }

  const origin = runGit(configDir, "remote", "get-url", "origin");
  if (!origin.ok || origin.stdout === "") return invalid("the config repo has no 'origin' remote for the host to clone from");
  // The URLs travel in another machine's argv, where `ps` shows them.
  const pinProblems: string[] = [];
  const pin = readPin(configDir, pinProblems);
  if (pin === null) return invalid(...pinProblems);
  for (const [what, url] of [["config repo's origin", origin.stdout], ["tool's", pin.repo]] as const) {
    const problem = urlProblem(url);
    if (problem !== null) return invalid(`the ${what} URL ${problem}`);
  }
  if (repoState(configDir).branch === null) return invalid("the config repo is not on a branch");

  let machine: Machine = here(home);
  if (dest !== null) {
    const ssh = findTool("ssh", process.env, home);
    if (ssh === null) return { code: "missing-prerequisite", messages: ["fleet: ssh is not installed, and 'fleet init' reaches the host over it"] };
    machine = there(ssh, dest);
  }
  return { configDir, home, host: name, admin, local, dest, url: origin.stdout, pin, dir: local ? q(configDir) : CONFIG_DEFAULT, tool: TOOL_CLONE, machine };
}

// Step 1

const CHECKLIST = {
  ssh: (dest: string) => `SSH as the agent user: add this machine's SSH key to ~/.ssh/authorized_keys of ${dest} (ssh-copy-id ${dest}), then check that 'ssh ${dest} true' works without a prompt`,
  node: (os: Os) => `Node 22.18 or newer: ${os === "darwin" ? "'brew install node', or " : ""}with fnm 'fnm install 22 && fnm default 22', or a Node at ~/.local/bin/node`,
  git: (os: Os) => `git: install it (${os === "darwin" ? "xcode-select --install, or brew install git" : "sudo pacman -S git, sudo apt install git"})`,
  toolRepo: (url: string) => `git must read the tool at ${url}: it is the \`tool.repo\` in the config's fleet.yaml, so check that URL and your access to it`,
  repo: (url: string) => `git and GitHub: git must read and push ${url}. With an SSH key: git config --global url."git@github.com:".insteadOf "https://github.com/". With a token: gh auth setup-git`,
  sops: (os: Os) => `sops 3.11 or newer: ${os === "darwin" ? "brew install sops age" : "sudo pacman -S sops age"}, or the static binary from the release page in ~/.local/bin, its sha256 checked`,
  age: (os: Os) => `age-keygen: ${os === "darwin" ? "brew install age" : "sudo pacman -S age, sudo apt install age"}, or the static tarball in ~/.local/bin`,
  os: (name: string) => `an OS fleet supports: it runs on Linux and macOS, and this host reports '${name}'`,
};

function prerequisites(ctx: Ctx): Outcome {
  // Mirrors the probe in bin/fleet, which is not on a new host yet.
  const body = `
have() { command -v "$1" >/dev/null 2>&1; }
echo "os=$(uname -s 2>/dev/null)"
node=
for c in "\${FLEET_NODE:-}" "$HOME/.local/share/fnm/aliases/default/bin/node" "$HOME/.local/bin/node" "$(command -v node 2>/dev/null || true)" ${SHELL_NODE_CANDIDATES.join(" ")}; do
  if [ -n "$c" ] && [ -x "$c" ] && "$c" -e 'process.exit(process.features.typescript ? 0 : 1)' 2>/dev/null; then node=$c; break; fi
done
[ -n "$node" ] && echo node=ok
if have git; then
  echo git=ok
  git ls-remote --quiet -- ${q(ctx.url)} HEAD >/dev/null 2>&1 && echo repo=ok
  git ls-remote --quiet -- ${q(ctx.pin.repo)} HEAD >/dev/null 2>&1 && echo tool_repo=ok
fi
if have sops; then
  echo sops=found
  echo "sops_version=$(sops ${SOPS_VERSION_ARGS.join(" ")} 2>/dev/null | head -n 1)"
fi
have age-keygen && echo age-keygen=ok
have claude && echo claude=ok
have opencode && echo opencode=ok
exit 0
`;
  let facts: Map<string, string>;
  try {
    const r = ctx.machine(script("prerequisites", body));
    if (r.status !== 0) return { stop: { code: "error", messages: [`fleet: ${ctx.host}: the prerequisite check failed (exit ${r.status ?? "none"}): ${firstLine(r.stderr)}`] } };
    facts = new Map(r.stdout.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  } catch (error) {
    if (!(error instanceof UnreachableError)) throw error;
    ctx.checklist.push(CHECKLIST.ssh(ctx.dest ?? ctx.host));
    return { stop: { code: "unreachable", messages: [`fleet: ${error.message}`] } };
  }

  const os = parseOs(facts.get("os") ?? "");
  if (os === null) {
    ctx.checklist.push(CHECKLIST.os(facts.get("os") || "unknown"));
    return { stop: { code: "missing-prerequisite", messages: [`fleet: ${ctx.host} is not Linux or macOS; nothing was changed there`] } };
  }
  ctx.os = os;

  const items: string[] = [];
  if (!facts.has("node")) items.push(CHECKLIST.node(os));
  if (!facts.has("git")) items.push(CHECKLIST.git(os));
  else {
    if (!facts.has("repo")) items.push(CHECKLIST.repo(ctx.url));
    if (!facts.has("tool_repo")) items.push(CHECKLIST.toolRepo(ctx.pin.repo));
  }
  if (!facts.has("sops")) items.push(CHECKLIST.sops(os));
  else {
    const problem = sopsVersionProblem(parseSopsVersion(facts.get("sops_version") ?? ""));
    if (problem !== null) items.push(`${CHECKLIST.sops(os)} (${problem})`);
  }
  if (!facts.has("age-keygen")) items.push(CHECKLIST.age(os));
  if (items.length === 0) {
    if (!facts.has("claude") && !facts.has("opencode")) ctx.messages.push(`fleet: ${ctx.host} has neither Claude Code nor opencode yet; fleet sets up their files, so install one to use them`);
    return { changed: false };
  }
  ctx.checklist.push(...items);
  return { stop: { code: "missing-prerequisite", messages: [`fleet: ${ctx.host} is missing ${items.length} prerequisite${items.length === 1 ? "" : "s"}; nothing was changed there`] } };
}

// Step 2

function clone(ctx: Ctx): Outcome {
  // The push check sends the tip GitHub already has back to it as a dry run: it authenticates for a push and changes nothing.
  // It is made for the config repo only. The fleet clone is never pushed from, so it only has to be readable.
  const body = `
dir=${ctx.dir}
tool=${ctx.tool}
state=present
if [ ! -d "$dir/.git" ]; then
  if [ -e "$dir" ] || [ -L "$dir" ]; then echo "$dir exists and is not a git clone; move it away, then run fleet init again" >&2; exit 21; fi
  git clone --quiet -- ${q(ctx.url)} "$dir" || exit 22
  state=cloned
fi
if [ ! -d "$tool/.git" ]; then
  if [ -e "$tool" ] || [ -L "$tool" ]; then echo "$tool exists and is not a git clone; move it away, then run fleet init again" >&2; exit 21; fi
  mkdir -p "$(dirname "$tool")"
  git clone --quiet -- ${q(ctx.pin.repo)} "$tool" || exit 24
  state=cloned
fi
echo "$state"
git -C "$dir" fetch --quiet origin || exit 22
branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD)
git -C "$dir" push --dry-run --quiet origin "refs/remotes/origin/$branch:refs/heads/$branch" >/dev/null 2>&1 || exit 23
`;
  const r = ctx.machine(script("clone", body));
  if (r.status === 21) return { stop: { code: "error", messages: [`fleet: ${ctx.host}: ${firstLine(r.stderr)}`] } };
  if (r.status === 22) return { stop: { code: "unreachable", messages: [`fleet: ${ctx.host} cannot clone or fetch ${ctx.url}`] } };
  if (r.status === 24) return { stop: { code: "unreachable", messages: [`fleet: ${ctx.host} cannot clone the tool from ${ctx.pin.repo}`] } };
  if (r.status === 23) {
    ctx.checklist.push(CHECKLIST.repo(ctx.url));
    return { stop: { code: "missing-prerequisite", messages: [`fleet: ${ctx.host} can read the repository but not push to it`] } };
  }
  if (r.status !== 0) return { stop: { code: "error", messages: [`fleet: ${ctx.host}: cloning failed (exit ${r.status ?? "none"}): ${firstLine(r.stderr)}`] } };
  return { changed: r.stdout.startsWith("cloned") };
}

// Step 3

function key(ctx: Ctx): Outcome {
  // A new key is made beside the real name and linked into it, so there is never an empty or half-written age.key,
  // and an existing key is never replaced: `ln` fails if the name is taken. The key itself is never printed here.
  const body = `
set -e
umask 077
d="$HOME/.config/fleet"; k="$d/age.key"
mkdir -p "$d"
if [ -e "$k" ] || [ -L "$k" ]; then
  echo existing
else
  t=$(mktemp -d "$d/.keygen.XXXXXX")
  trap 'rm -rf "$t"' EXIT
  out=$(age-keygen -o "$t/key" 2>&1) || { echo "age-keygen could not make a key: $out" >&2; exit 30; }
  ln "$t/key" "$k"
  echo generated
fi
echo "mode=$(stat -c %a "$k" 2>/dev/null || stat -f %Lp "$k")"
r=$(age-keygen -y "$k" 2>&1) || { echo "$r" >&2; exit 31; }
echo "recipient=$r"
`;
  const r = ctx.machine(script("key", body));
  if (r.status === 31) return { stop: { code: "error", messages: [`fleet: ${ctx.host}: ${KEY_SHOWN} is not a usable age key (${firstLine(r.stderr)}); fleet leaves it as it is. Move it away to have a new one made`] } };
  if (r.status !== 0) return { stop: { code: "error", messages: [`fleet: ${ctx.host}: ${firstLine(r.stderr) || `the key step failed (exit ${r.status ?? "none"})`}`] } };
  const fact = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(r.stdout)?.[1] ?? "";
  const recipient = fact("recipient");
  if (!RECIPIENT.test(recipient)) return { stop: { code: "error", messages: [`fleet: ${ctx.host}: age-keygen -y did not print a recipient`] } };
  ctx.recipient = recipient;

  const generated = r.stdout.startsWith("generated");
  if (fact("mode") !== "600") ctx.messages.push(`fleet: ${ctx.host}: ${KEY_SHOWN} is mode ${fact("mode")}, not 600; fleet leaves an existing key alone, so tighten it with chmod 600`);
  if (ctx.local) {
    if (generated) ctx.backup = { path: KEY_SHOWN, key: readFileSync(ageKeyPath(ctx.home), "utf8").trim() };
    else ctx.messages.push(`fleet: the admin's age key is at ${KEY_SHOWN}; it is shown once, when made, so check that it is backed up`);
  }
  return { changed: generated };
}

// Step 4

/** Sets the top-level `age:` line in place, keeping any comment after it, or adds one. */
function setAge(text: string, recipient: string): string {
  const line = /^age:[ \t]*(?:"[^"\n]*"|'[^'\n]*'|[^\s#]*)/m;
  if (line.test(text)) return text.replace(line, `age: ${recipient}`);
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}age: ${recipient}\n`;
}

async function recipient(ctx: Ctx): Promise<Outcome> {
  const { configDir, host, home } = ctx;
  const age = ctx.recipient!;
  const rel = `hosts/${host}.yaml`;
  const path = join(configDir, rel);
  const problems: string[] = [];
  const current = parseFile(path, false, problems)?.age;

  let changed = false;
  if (current !== age) {
    const before = readFileSync(path, "utf8");
    writeFileSync(path, setAge(before, age));
    if (parseFile(path, false, [])?.age !== age) {
      writeFileSync(path, before);
      return { stop: invalid(`${rel}: cannot set 'age' in place; write 'age: ${age}' as a line of its own at the top level`) };
    }
    if (typeof current === "string" && current !== "") ctx.messages.push(`fleet: ${rel}: replaced recipient ${current} with the one for the key on ${host}, which fleet never replaces`);
    changed = true;
  }

  // Always: rekey is a no-op when nothing moved, and a rerun after a failed rekey must finish it.
  const rekey = await secrets(configDir, ["rekey"], home);
  if (rekey.code !== "ok") return { stop: rekey };
  if (changed) ctx.messages.push(...(rekey.messages ?? []));

  // Only init's own files: the admin's other work in the clone is not init's to publish.
  const paths = [rel, ".sops.yaml", ...(existsSync(join(configDir, "secrets")) ? ["secrets"] : [])];
  const dirty = runGit(configDir, "status", "--porcelain", "--", ...paths).stdout !== "";
  if (dirty) {
    const added = runGit(configDir, "add", "--", ...paths);
    const committed = added.ok ? runGit(configDir, "commit", "--quiet", "-m", `fleet init ${host}: record its age recipient`, "--", ...paths) : added;
    if (!committed.ok) return { stop: { code: "error", messages: [`fleet: cannot commit ${paths.join(", ")}: ${firstLine(committed.stderr)}`] } };
  }
  const notes: string[] = [];
  const conflict = syncAndPush({ dir: configDir, shown: configDir }, notes);
  if (conflict !== null) {
    ctx.conflicts.push(conflict);
    return { stop: { code: "conflict", text: `${conflict.path}: ${conflict.detail}\n  fix: ${conflict.fix}`, messages: [`fleet: ${conflict.path} has diverged; nothing was pushed, so ${host} is not set up further`] } };
  }
  return { changed: changed || dirty || notes.length > 0 };
}

// Step 5

function pullAndLink(ctx: Ctx): Outcome {
  // The admin's own config repo was brought level with GitHub by step 4.
  const pull = ctx.local
    ? ""
    : `old=$(git -C "$dir" rev-parse HEAD)
git -C "$dir" fetch --quiet origin || exit 22
git -C "$dir" merge --quiet --ff-only '@{upstream}' >&2 || exit 23
[ "$old" = "$(git -C "$dir" rev-parse HEAD)" ] || echo pulled
`;
  // The fleet clone is put at the pin, detached. The first apply moves it again if the pushed config pins another commit.
  const pin = q(ctx.pin.commit);
  const body = `
dir=${ctx.dir}
tool=${ctx.tool}
name=${q(ctx.host)}
${pull}if [ "$(git -C "$tool" rev-parse HEAD)" != ${pin} ]; then
  [ -z "$(git -C "$tool" status --porcelain)" ] || { echo "$tool has uncommitted changes, so fleet cannot move it" >&2; exit 25; }
  n=$(git -C "$tool" rev-list --count HEAD --not --remotes)
  [ "$n" = 0 ] || { echo "$tool has $n local commit(s) not on any remote branch, so fleet cannot move it" >&2; exit 25; }
  git -C "$tool" cat-file -e ${pin}'^{commit}' 2>/dev/null || git -C "$tool" fetch --quiet origin || exit 22
  git -C "$tool" cat-file -e ${pin}'^{commit}' 2>/dev/null || { echo ${q(`the pinned tool commit ${ctx.pin.commit} is not in ${ctx.pin.repo}`)} >&2; exit 26; }
  git -C "$tool" -c advice.detachedHead=false checkout --quiet --detach ${pin} >&2 || exit 25
  echo moved
fi
f="$HOME/.config/fleet/host"
mkdir -p "$HOME/.config/fleet"
if [ -e "$f" ]; then
  [ "$(cat "$f")" = "$name" ] || { echo "~/.config/fleet/host names another host ($(cat "$f")), not $name; fleet leaves it as it is" >&2; exit 30; }
else
  printf '%s\\n' "$name" > "$f"; echo named
fi
d="$HOME/.config/fleet/config"
if [ -e "$d" ]; then
  [ "$(readlink -f "$(cat "$d")")" = "$(readlink -f "$dir")" ] || { echo "~/.config/fleet/config names another config repo ($(cat "$d")), not $dir; fleet leaves it as it is" >&2; exit 32; }
else
  printf '%s\\n' "$(readlink -f "$dir")" > "$d"; echo "config set"
fi
l="$HOME/.local/bin/fleet"; t="$tool/bin/fleet"
mkdir -p "$HOME/.local/bin"
if [ -L "$l" ] || [ -e "$l" ]; then
  [ "$(readlink -f "$l")" = "$(readlink -f "$t")" ] || { echo "~/.local/bin/fleet is not a link to $t; move it away, then run fleet init again" >&2; exit 31; }
else
  ln -s "$t" "$l"; echo linked
fi
`;
  const r = ctx.machine(script("pull-and-link", body));
  if (r.status === 22) return { stop: { code: "unreachable", messages: [`fleet: ${ctx.host} cannot fetch the config repo or the tool`] } };
  if (r.status === 23) return { stop: { code: "conflict", messages: [`fleet: the config repo on ${ctx.host} cannot be fast-forwarded: ${firstLine(r.stderr)}`] } };
  if (r.status === 25) return { stop: { code: "conflict", messages: [`fleet: the fleet clone on ${ctx.host} cannot be moved to the pinned commit: ${firstLine(r.stderr)}`] } };
  if (r.status === 26) return { stop: { code: "invalid", messages: [`fleet: ${firstLine(r.stderr)}; run 'fleet update' or fix fleet.yaml`] } };
  if (r.status === 30 || r.status === 32) return { stop: { code: "error", messages: [`fleet: ${ctx.host}: ${firstLine(r.stderr)}`] } };
  if (r.status === 31) return { stop: { code: "conflict", messages: [`fleet: ${ctx.host}: ${firstLine(r.stderr)}`] } };
  if (r.status !== 0) return { stop: { code: "error", messages: [`fleet: ${ctx.host}: pull, host name or link failed (exit ${r.status ?? "none"}): ${firstLine(r.stderr)}`] } };
  return { changed: r.stdout.trim() !== "", detail: r.stdout.trim().split("\n").filter((l) => l !== "").join(", ") || undefined };
}

// Step 6

function missing(ctx: Ctx): Outcome {
  const { configDir, host, home } = ctx;
  // Only the names are looked at, so no skill source is cloned and no value is decrypted.
  const needed = loadConfig(configDir, host, { home, sources: "none" }).secrets;
  const held = new Set([...namesIn(configDir, host), ...namesIn(configDir, "shared")]);
  const names = needed.filter((name) => !held.has(name));
  if (names.length === 0) return { changed: false };
  ctx.missingSecrets = names;
  return {
    stop: {
      code: "needs-secret",
      text: `${host} needs ${names.length} secret${names.length === 1 ? "" : "s"} that ${names.length === 1 ? "is" : "are"} not set:\n${names.map((n) => `  ${n}`).join("\n")}\nSet each with 'fleet secrets set ${host} <NAME>' (or 'shared' for one several hosts use) on ${ctx.admin}, run 'fleet push', then run 'fleet init ${host}' again.`,
      messages: [`fleet: ${host} has no value for ${names.join(", ")}; the first apply was not run`],
    },
  };
}

// Step 7

const EXIT_NAMES = new Set(["ok", "error", "invalid", "conflict", "unreachable", "needs-secret", "missing-prerequisite", "locked"]);

function firstApply(ctx: Ctx): Outcome {
  const r = ctx.machine(script("apply", '"$HOME/.local/bin/fleet" apply --json\n'));
  let doc: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    doc = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    // not a document
  }
  if (doc === null) return { stop: { code: "error", messages: [`fleet: ${ctx.host}: the first apply printed no fleet document (exit ${r.status ?? "none"}): ${firstLine(r.stderr)}`] } };
  const list = (name: string): unknown[] => (Array.isArray(doc[name]) ? (doc[name] as unknown[]) : []);
  const code = typeof doc.code === "string" && EXIT_NAMES.has(doc.code) ? (doc.code as Result["code"]) : "error";
  if (code === "ok" && r.status === 0) return { changed: list("created").length + list("updated").length + list("removed").length > 0 };

  const conflicts = list("conflicts") as Conflict[];
  ctx.conflicts.push(...conflicts);
  const said = list("messages").filter((m): m is string => typeof m === "string").map((m) => `fleet: ${ctx.host}: ${m.replace(/^fleet: /, "")}`);
  return {
    stop: {
      code,
      text: conflicts.map((c) => `${c.path}: ${c.detail}\n  fix: ${c.fix}`).join("\n") || undefined,
      messages: [...said, ...(code === "conflict" ? [`fleet: the first apply on ${ctx.host} found ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}; the timer was not installed. Clear them, then run 'fleet init ${ctx.host}' again`] : [])],
    },
  };
}

// Step 8

function timer(ctx: Ctx): Outcome {
  const scheduler = schedulerFor(ctx.os);
  const r = ctx.machine(script("timer", scheduler.install(q)));
  const said = scheduler.explain(ctx.host, r.status, firstLine(r.stderr));
  if (said !== null) return { stop: { code: "error", messages: [said] } };
  if (r.status !== 0) return { stop: { code: "error", messages: [`fleet: ${ctx.host}: installing the timer failed (exit ${r.status ?? "none"}): ${firstLine(r.stderr)}`] } };
  return { changed: r.stdout.trim() !== "" };
}

const STEPS: { name: string; run: (ctx: Ctx) => Outcome | Promise<Outcome> }[] = [
  { name: "prerequisites", run: prerequisites },
  { name: "clone", run: clone },
  { name: "key", run: key },
  { name: "recipient", run: recipient },
  { name: "pull-and-link", run: pullAndLink },
  { name: "secrets", run: missing },
  { name: "apply", run: firstApply },
  { name: "timer", run: timer },
];

function finish(ctx: Ctx, color: boolean, result: Result): Result {
  const shown = (s: StepRecord) => (s.state === "done" ? paint(color, "green", s.state) : s.state === "failed" ? paint(color, "yellow", s.state) : s.state);
  const lines = ctx.steps.map((s) => `${s.step}. ${s.name}: ${shown(s)}${s.detail ? ` (${s.detail})` : ""}`);
  const blocks = [lines.join("\n")];
  if (result.text) blocks.push(result.text);
  if (ctx.checklist.length > 0) {
    blocks.push(`Do these by hand on ${ctx.host}, then run 'fleet init ${ctx.host}' again:\n${ctx.checklist.map((i) => `  [ ] ${i}`).join("\n")}`);
  }
  if (ctx.backup !== null) {
    blocks.push(
      `Back up this key in your password manager now. It is shown only this once. It is ${ctx.host}'s key and opens every secret fleet holds; if it is lost, the secrets cannot be read again.\n\n${ctx.backup.key}\n\n(${ctx.backup.path})`,
    );
  }
  return {
    code: result.code,
    text: blocks.join("\n\n"),
    messages: [...ctx.messages, ...(result.messages ?? [])],
    fields: {
      ...result.fields,
      steps: ctx.steps,
      checklist: ctx.checklist,
      missingSecrets: ctx.missingSecrets,
      conflicts: ctx.conflicts,
      recipient: ctx.recipient,
      ...(ctx.backup === null ? {} : { backup: ctx.backup }),
    },
  };
}

export async function init(configDir: string, name: string | undefined, color: boolean, home: string = homedir()): Promise<Result> {
  let ctx: Ctx | null = null;
  let current = 0;
  try {
    const prepared = prepare(configDir, name, home);
    if ("code" in prepared) return prepared;
    ctx = { ...prepared, os: "linux", steps: [], messages: [], checklist: [], backup: null, recipient: null, missingSecrets: [], conflicts: [] };

    for (const [i, step] of STEPS.entries()) {
      current = i;
      const outcome = await step.run(ctx);
      if ("stop" in outcome) {
        ctx.steps.push({ step: i + 1, name: step.name, state: "failed" });
        return finish(ctx, color, outcome.stop);
      }
      ctx.steps.push({ step: i + 1, name: step.name, state: outcome.changed ? "done" : "unchanged", ...(outcome.detail ? { detail: outcome.detail } : {}) });
    }
    return finish(ctx, color, { code: "ok", text: schedulerFor(ctx.os).done(ctx.host) });
  } catch (error) {
    const result = failure(error) ?? { code: "error" as const, messages: [`fleet: ${(error as Error).message}`] };
    if (ctx === null) return result;
    ctx.steps.push({ step: current + 1, name: STEPS[current]!.name, state: "failed" });
    return finish(ctx, color, result);
  }
}
