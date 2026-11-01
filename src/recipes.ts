/** One common job, written for an agent. Every field is rendered; a test checks each `fleet ...` in them against the command table. */
export type Recipe = {
  id: string;
  title: string;
  /** The files to edit, as paths in the config repo. */
  files: string[];
  steps: string[];
  /** What to run to check the work. */
  checks: string[];
  /** Where the agent hands over to the user, and what the user asks for next. */
  stops: string[];
};

/** What every recipe holds to. Shown once, above them. */
export const RECIPE_RULES = [
  "Edit the config repo only, never `~/.claude.json`, `~/.config/opencode` or the fleet clone. Fleet changes the host to match the config.",
  "Never see a secret value. Do not read a file that holds one, do not open a secrets file with `sops` or `fleet secrets edit <file>`, do not pipe a value into `fleet secrets set <host> <NAME>` and do not ask for one in chat. The user runs `fleet secrets set <host> <NAME>` themselves, in their own terminal, where the value is typed hidden.",
  "Never write a secret into the config in plain text. A token, key or password becomes a `secret:NAME` reference (NAME matches `[A-Z][A-Z0-9_]*`), and the user stores the value.",
  "Check with `fleet diff`. It changes nothing. Exit 0 means the config is valid for this host, 3 lists conflicts, 5 means a secret or this host's age key is missing, 2 means the config is invalid or this host has no name yet.",
  "A recipe is the user's request for that job, so its own steps (`fleet adopt mcp <name>`, `fleet adopt skill <name>`, `fleet update`, `fleet new <dir>`) are asked for. `fleet push`, `fleet apply`, `fleet init <host>` and every command that changes secrets are not: run them only when the user asked for that action in this turn. Each recipe ends by telling the user what to ask for, not by running it.",
];

export const RECIPES: Recipe[] = [
  {
    id: "add-mcp",
    title: "Add an MCP server",
    files: ["catalog/mcp.yaml (the server, once)", "hosts/_defaults.yaml (every host) or hosts/<host>.yaml (one host), under `mcp.include`"],
    steps: [
      "Copy the shape of an existing entry in `catalog/mcp.yaml`. A server has either `command` (a list, run on the host) or `transport` (`http` or `sse`) with a `url`. Pin the package version in `command`.",
      "Put a token or key in `env`, `headers` or `url` as `secret:NAME`, never in `command`, because a command line can be read by every user on the host. If the server only takes its token as an argument, stop and tell the user: fleet cannot hold that one safely.",
      "Add the name to `mcp.include` in the defaults or a host file. `only: [claude]` or `only: [opencode]` limits a server to one tool.",
      "If the server uses a secret, follow the recipe for adding a secret next.",
    ],
    checks: ["`fleet diff` lists `create ~/.claude.json mcpServers.<name>` and the same for opencode, with `***` where a secret goes, and no new conflict."],
    stops: [
      "A server that signs in by browser (OAuth) is logged in once by the user with `/mcp` in each tool. Fleet writes only the entry.",
      "Tell the user to review the change in the config repo and ask for `fleet push` (publish and apply on every host) or `fleet apply` (this host only).",
    ],
  },
  {
    id: "add-skill",
    title: "Add a skill",
    files: ["catalog/skills.yaml (a source, if it is new, and the bundle)", "hosts/_defaults.yaml or hosts/<host>.yaml, under `bundles`"],
    steps: [
      "A skill is a directory with a `SKILL.md`, found at any depth below its source's `path`. Fleet links it to `~/.claude/skills/<name>`. The names `fleet`, `synced` and `.trash` are reserved.",
      "From a source that is already in `catalog/skills.yaml`: add the skill's directory name to a bundle under `bundles`. A skill can be in only one bundle, and its name must resolve to exactly one directory in exactly one source.",
      "From a new source: add it under `sources`. For skills other people write, pin it with `repo`, `commit` (the full sha, from `git ls-remote <repo> <branch>`), `track` and `path`. For skills the user writes, follow it with `repo`, `branch` and `path`. Then list its skills in a bundle.",
      "Make sure a host picks the bundle: `bundles: [<bundle>]` in the defaults or the host file. A new bundle is picked nowhere until you do.",
    ],
    checks: ["`fleet diff` lists `create ~/.claude/skills/<name> -> <the source's clone>/...`. A skill that does not resolve, or sits in two bundles, makes it exit 2 and says which."],
    stops: [
      "Tell the user to review the change and ask for `fleet push` or `fleet apply`. Fleet clones a new source at its first diff or apply, so the user's git must be able to read the repo.",
      "To move a pinned source on, the user can ask for `fleet skills update`; it changes only the `commit:` lines.",
    ],
  },
  {
    id: "add-secret",
    title: "Add a secret",
    files: ["catalog/mcp.yaml (the `secret:NAME` reference)", "secrets/shared.enc.yaml or secrets/<host>.enc.yaml (the value, written by the user, never by you)"],
    steps: [
      "Choose the name: capitals, digits and underscores, starting with a capital, for example `TRACKER_API_KEY`. Reference it as `secret:NAME` in the `env`, `headers` or `url` of a catalog entry.",
      "Decide where it lives with the user: `shared` when several hosts use it, or one host's name. A host reads `shared` and its own file.",
      "Run `fleet diff`. It exits 5 and names the secret that is not set, or says this host has no age key yet.",
    ],
    checks: ["`fleet diff` exits 5 with `no secret NAME` until the user has stored the value, then exits 0 or lists only ordinary changes. The value is never printed: `diff` shows `***`."],
    stops: [
      "Stop here and ask the user to run `fleet secrets set <host> <NAME>` themselves, in their own terminal (use `shared` instead of a host name for a shared one). It asks for the value with hidden input. Do not pipe a value in, do not run it for them, and do not ask for the value in chat.",
      "If `fleet diff` says there is no age key, ask the user to run `fleet init <host>`; it makes the key. On a host with no name yet, that is also what writes the name.",
      "When the user says it is done, run `fleet diff` again. The encrypted file is new in the config repo, so tell the user to ask for `fleet push` to publish and apply it.",
    ],
  },
  {
    id: "adopt",
    title: "Adopt what already exists",
    files: ["No file changes: `fleet adopt mcp <name>` and `fleet adopt skill <name>` record an existing MCP server or skill in applied state, without changing it."],
    steps: [
      "Describe the thing in the config first (the add-an-MCP-server or add-a-skill recipe), and pick it for this host. Adopting something the host does not pick exits 2.",
      "Run `fleet diff`. A conflict that says an entry or link \"already has a value that fleet did not write\" is a candidate.",
      "For each one that is right, run `fleet adopt mcp <name>` or `fleet adopt skill <name>`. It needs an exact match with what the config renders, and it writes nothing on a difference: the conflict lists each differing field by name, with a `***` for anything that could be a token.",
      "A stdio server run with `npx` almost never matches an entry made by hand, because fleet writes the absolute `npx` and a `PATH` into the entry. Do not edit `~/.claude.json` to make it match. The way through is to remove the entry and let apply write it: the user runs `claude mcp remove --scope user <name>`. That also discards the token in the old entry, so only after the secret is stored (the add-a-secret recipe).",
      "An instruction file that is a plain file where fleet wants a link (`~/.claude/CLAUDE.md`) is not adoptable. Copy its content into the config's `config/` first, then the user moves the original aside so apply can link it.",
    ],
    checks: ["`fleet adopt mcp <name>` prints `adopted ...` and exits 0, and the next `fleet diff` no longer lists that entry or link as a conflict."],
    stops: [
      "Removing an entry, moving a file aside and anything else on the host itself is the user's choice. Say what is left and why.",
      "Once no conflict is left, tell the user to ask for `fleet apply` (this host) or `fleet push`.",
    ],
  },
  {
    id: "onboard",
    title: "Set up this machine (onboarding)",
    files: [
      "catalog/mcp.yaml, catalog/skills.yaml (what exists on this machine, once each)",
      "hosts/_defaults.yaml and hosts/<host>.yaml (`admin: true` for the machine the user works from, `age: \"\"` until `fleet init <host>`)",
      "config/AGENTS.md and the files it links (the shared instructions)",
    ],
    steps: [
      "No config repo yet (the first paragraph says so)? Run `fleet new <dir>`. It copies the commented `examples/` into `<dir>`, pinned to this tool commit, and writes nothing outside it. Edit the files there.",
      "Read the machine's setup by key names, not values. In `~/.claude.json` list the names under `mcpServers` and, for each, which of `command`, `args`, `url`, `type`, `env` and `headers` it has, and the names inside `env` and `headers`. Do the same for `mcp` in `~/.config/opencode/opencode.jsonc`, and list `~/.claude/settings.json`, `~/.claude/CLAUDE.md`, `~/.config/opencode/AGENTS.md` and `~/.claude/skills/` by name. Do not print `~/.claude.json` or `opencode.jsonc`: they hold tokens.",
      "Draft `catalog/mcp.yaml`: one entry per server, in the shape of the `examples/` entries. Anything secret-looking (an `env` or `headers` value, a token in a `url`) becomes a `secret:NAME` reference, and you never copy the value. List the names you made for the user. A token passed in `command` cannot be a secret reference: leave that server out and tell the user.",
      "Draft `catalog/skills.yaml` from `~/.claude/skills/`. A symlink points into a repo: that repo is a source. A plain directory has no source yet: ask the user where it should live, and leave it out meanwhile.",
      "Draft the host file `hosts/<host>.yaml`, named like the host (`laptop`, `server`). Put in `hosts/_defaults.yaml` what every machine shares, and `settings` only for keys the user wants fleet to own. Copy the shared instructions into `config/AGENTS.md` and link them in `files:` as `examples/hosts/_defaults.yaml` does.",
      "Check what you can. A host with no name (`fleet diff` exits 2 and says so) cannot be checked yet: stop and ask the user to review the draft, commit it, push the config repo, and run `fleet init <host>` with `FLEET_CONFIG` pointing at it. Init writes the host's name, key and clone first, so it may stop at a missing secret (exit 5) or a conflict (exit 3) after it has done that. That is expected.",
      "Once the host has a name, run `fleet diff`. Adopt every server and skill that already matches with `fleet adopt mcp <name>` and `fleet adopt skill <name>`, as in the adopt recipe. Secrets still missing go to the add-a-secret recipe.",
    ],
    checks: ["`fleet diff` exits 0, or lists only creates and conflicts you have explained to the user. No secret value appears in any file you wrote, so `grep` the config repo for the names you made, not for values."],
    stops: [
      "The user reviews the draft in full before anything is pushed. Give them the list of `secret:NAME` references they must set, and the conflicts that are theirs to clear.",
      "Then tell the user to ask for `fleet push`, or `fleet apply` for this machine alone. `fleet init <host>` is theirs to run, and to rerun once the secrets are set.",
    ],
  },
  {
    id: "move-pin",
    title: "Move the tool pin",
    files: ["fleet.yaml (the `commit:` line under `tool:`, and nothing else)"],
    steps: [
      "Run `fleet update`. It moves `commit:` to the head of the branch `track` names and changes no other byte. It commits, pushes and applies nothing, and no clone moves.",
      "Read the change in the config repo with `git diff fleet.yaml`, and the tool's own history between the two commits if you can.",
    ],
    checks: ["`fleet update` prints `tool: <old> -> <new> (<branch>)`, or `up to date`. `fleet diff` still exits as before."],
    stops: [
      "Hosts run the pinned commit, so this change reaches them only once published. Tell the user to review it and ask for `fleet push`; each host moves its fleet clone at its next apply. Do not run it for them.",
    ],
  },
];

/** The Recipes section's body: the rules, then each recipe under a `###` heading. */
export function recipesMarkdown(): string {
  const bullets = (items: string[]) => items.map((s) => `- ${s}`).join("\n");
  const body = RECIPES.map(
    (r) => `### ${r.title}

Edit:

${bullets(r.files)}

Steps:

${r.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Check:

${bullets(r.checks)}

Stop and hand over:

${bullets(r.stops)}`,
  ).join("\n\n");
  return `How to do the common jobs. The rules hold for every recipe.

${bullets(RECIPE_RULES)}

${body}`;
}
