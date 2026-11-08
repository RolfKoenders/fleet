import { homedir } from "node:os";
import { EXIT } from "./exit.ts";
import type { ExitName } from "./exit.ts";
import type { Result } from "./output.ts";
import { RECIPES, recipesMarkdown } from "./recipes.ts";
import { status } from "./status.ts";

/** A command as the primer lists it. `change` is every command that writes, on this host or on others. */
export type PrimerCommand = { name: string; usage: string; summary: string; effect: "read" | "change" };

/** The glossary in one sentence per term, in the order of GLOSSARY.md. */
const TERMS: [string, string][] = [
  ["Host", "One machine fleet manages, as one agent user on it (`laptop` as `alice`, `server` as `deploy`)."],
  ["Agent user", "The OS user on a host whose agent setup fleet manages; other users there are not fleet's business."],
  ["Config repo", "The private repo a user keeps their catalog, host files, shared instructions and encrypted secrets in."],
  ["Fleet clone", "The copy of the fleet tool a host runs from, kept at the commit its config pins; nobody works in it."],
  ["Catalog", "Where every MCP server and skill source is defined once, independent of host and tool."],
  ["Host file", "What one host gets, picked from the catalog and layered on the defaults."],
  ["Skill source", "A repo, at a pinned commit or on a followed branch, that skills are taken from."],
  ["Bundle", "A named group of skills that a host file picks as a unit."],
  ["Apply", "Making one host match its config, on that host."],
  ["Push", "Publishing a change to GitHub and then applying it on every host."],
  ["Adopt", "Recording something that already exists on a host and matches the catalog in applied state, so fleet owns it without changing it."],
  ["Linked file", "A file fleet places as a symlink into the repo, so the repo copy is the only copy."],
  ["Merged file", "A file that a tool also writes, where fleet sets only its owned keys and leaves the rest alone."],
  ["Owned key", "A path inside a merged file whose whole value fleet controls; everything beside it is left alone."],
  ["Applied state", "The record, per host, of what fleet created there, so removal is possible and everything else is left alone."],
  ["Conflict", "A difference fleet will not resolve by itself during apply, so it stops and reports instead of overwriting."],
  ["Doctor result", "What the last `fleet doctor` on a host found for each MCP server it picks. The only record of a server's tools, since nothing else starts a server."],
  ["Startup context", "What an agent on a host loads before the first prompt: its instructions, the descriptions of its skills, and the MCP tool definitions it is offered, whether fleet put them there or not. A size, estimated in tokens."],
];

/** What each exit code means, written once. A new code in `exit.ts` fails to compile until it is described here. */
const EXIT_MEANING: Record<ExitName, string> = {
  ok: "Done, or nothing to do",
  error: "Unexpected failure",
  invalid: "Bad arguments or config; nothing written",
  conflict: "One or more conflicts; nothing written",
  unreachable: "A host or GitHub could not be reached",
  "needs-secret": "A key, secret or sops is missing or too old",
  "missing-prerequisite": "Node, git, sops, age-keygen, claude or opencode is missing",
  locked: "Another apply is running",
  unhealthy: "`fleet doctor` ran and found a failed check",
};

/** The push rule. The `fleet` skill says the same in its own words. */
const PUSH_RULE = "Never run `fleet push`, `fleet apply`, or a command that changes secrets unless the user asked for that action in this turn.";

const list = (commands: PrimerCommand[]) => commands.map((c) => `- \`fleet ${c.usage}\`: ${c.summary}`).join("\n");

/** This host's status as the primer shows it, or why there is none. Never throws. */
function hostSection(toolDir: string, configDir: string | null, home: string): { markdown: string; fields: unknown } {
  let reason: string;
  try {
    if (configDir === null) throw new Error("there is no config repo to read");
    const result = status(toolDir, configDir, false, home);
    if (result.code === "ok") {
      const notes = (result.messages ?? []).map((m) => `- ${m.replace(/^fleet: /, "")}`);
      const markdown = ["```text", (result.text ?? "").trimEnd(), "```", ...(notes.length > 0 ? ["", "Notes:", ...notes] : [])].join("\n");
      return { markdown, fields: result.fields ?? null };
    }
    reason = (result.messages ?? [result.code]).map((m) => m.replace(/^fleet: /, "")).join("; ");
  } catch (error) {
    reason = (error as Error).message.split("\n")[0] ?? "unknown error";
  }
  return { markdown: `Status could not be computed: ${reason}`, fields: null };
}

/** `fleet agent`: what an agent needs to know about fleet, generated from the code that does the work. */
export function agent(toolDir: string, configDir: string | null, commands: PrimerCommand[], home: string = homedir()): Result {
  const here = hostSection(toolDir, configDir, home);
  const markdown = `# fleet

Fleet makes each host match its config: shared instructions, skills, MCP servers, Claude and opencode settings, and secrets. The config is a repo of its own, ${configDir === null ? "which is not set on this machine yet (\`fleet init\` writes \`~/.config/fleet/config\`)" : `kept here at \`${configDir}\``}. The tool is not in it: this host runs fleet from the fleet clone at \`${toolDir}\`, at the commit the config pins in \`fleet.yaml\`. Fleet changes the host to match the config, never the other way round, so edit agent config through the config repo, not in place, and never edit in the fleet clone.

Pass \`--json\` when you will read the output: one JSON document on stdout, with \`ok\`, \`code\`, \`host\` and \`messages\` beside the command's own fields.

## Terms

${TERMS.map(([term, definition]) => `- **${term}**: ${definition}`).join("\n")}

## Commands

### Read-only

Safe to run at any time. They change nothing.

${list(commands.filter((c) => c.effect === "read"))}

### Changes things

These write to this host, to the config repo or to other hosts, or (\`doctor\`) start the MCP servers the catalog defines, with their real credentials, and write only this host's doctor result. \`bridge\` is a terminal view that reads until a person asks it to push or to run doctor, which is why it is here. Run one only when the user asked for it.

${list(commands.filter((c) => c.effect === "change"))}

## Pushing

${PUSH_RULE} \`fleet push\` commits and publishes the config repo and any followed skill sources, never the tool, then applies on this host and over ssh on every other one. A conflict on this host stops it before any other host is touched.

## The tool version

Hosts run the tool commit the config pins, not the latest. \`fleet update\` moves the pin in \`fleet.yaml\` to the newest release (the highest \`vX.Y.Z\` tag) when \`track\` is \`releases\`, or to the head of the branch \`track\` names, and does nothing else: no commit, no apply. Review the change, then \`fleet push\` publishes it and each host moves its fleet clone to the new commit at its next apply. A run from any other checkout of the tool, such as a development one, uses its own code and says the pin was not enforced.

## Clearing a conflict

A conflict means fleet found something it will not overwrite, and it writes nothing on that host until the conflict is gone. \`fleet diff\` lists each one with a fix line. There is no force flag. Do one of these, then run \`fleet apply\` again, if the user asked for it:

- Change the host to match the config, or the config to match the host.
- Delete the path or the owned key by hand, so apply recreates it. For an MCP entry that holds a token this is the practical route: \`claude mcp remove --scope user <name>\`.
- If the thing is correct but unrecorded, run \`fleet adopt\`.

## Recipes

${recipesMarkdown()}

## Exit codes

| Code | Name | Meaning |
|---|---|---|
${(Object.entries(EXIT) as [ExitName, number][]).map(([name, code]) => `| ${code} | ${name} | ${EXIT_MEANING[name]} |`).join("\n")}

## This host

${here.markdown}
`;
  return { code: "ok", text: markdown, fields: { markdown, recipes: RECIPES, status: here.fields } };
}
