import type { ProbeTarget } from "../mcpprobe.ts";
import type { HistoryRead, HistoryRequest } from "./history.ts";
import type { Obj } from "../yamlfile.ts";

/** A catalog server as an agent renders it: the command already run through `launch`, so `npx` is the one beside Node. */
export type McpServer = {
  name: string;
  /** Stdio: program and arguments. Null for a network server. */
  command: string[] | null;
  env: Record<string, string>;
  /** Network: `http` or `sse`. Null for a stdio server. */
  transport: "http" | "sse" | null;
  url: string | null;
  headers: Record<string, string>;
};

/** What doctor starts or calls for one rendered entry, and the word it reports for the transport. */
export type ProbeEntry = {
  transport: "stdio" | "http" | "sse" | "remote";
  target: ProbeTarget;
  /** The entry holds headers, so an `auth-needed` answer is a failure and not a login still to do. */
  credentials: boolean;
};

/**
 * One coding agent fleet knows how to set up. Everything but the identity is optional: an agent may keep no
 * settings fleet can merge, or have no MCP servers, and config that asks for what it lacks is refused. Paths
 * are in `~/` form. A new agent is one file that exports one of these, and one line in `index.ts`.
 */
export type Agent<Id extends string = string> = {
  id: Id;
  /** What a person calls it: `Claude Code`. */
  name: string;
  /** The program that is on the path when the agent is installed. */
  binary: string;
  /** Directories its installer puts the binary in beyond the usual ones. */
  binDirs: string[];
  /** The arguments that make the binary print its version. */
  version: string[];
  /** Everything under these paths belongs to this agent. */
  homes: string[];

  /** A file the agent also writes, where fleet owns only the keys a host file declares. */
  settings?: {
    file: string;
    /** Dotted paths no host file may own. A declared path is refused when it equals one, sits below one or sits above one. */
    denied: string[];
    /** An older file the agent still loads beside `file`, so the two would disagree. */
    alsoLoaded?: string;
  };

  mcp?: {
    file: string;
    /** The key the servers are under, by name. */
    key: string;
    /** The transports it can take, when not all of them. A server of another one is left out of its file, and is refused when config limits it to this agent. */
    transports?: readonly ("stdio" | "http" | "sse")[];
    /** The entry for `server`, in the shape this agent's file takes. */
    render(server: McpServer): Obj;
    /** What to probe for a rendered entry, or null when it is not of the shape `render` makes. `cwd` is where a stdio server starts. */
    read(entry: Obj, cwd: string): ProbeEntry | null;
    /** An entry the agent does not load, so it costs no context. */
    skip?(entry: unknown): boolean;
    /** Writes go through the agent's own binary (it keeps the file locked), so they wait while it is not installed. */
    needsBinary?: true;
  };

  skills?: {
    /** The directory fleet links the skills into, or null when the agent reads another agent's. */
    target: string | null;
    /** The directories it reads skills from, lowest precedence first. */
    dirs: string[];
    /** The settings file whose `skills` list names more directories, or null. */
    setting: string | null;
    /** Reads `<name>.md` and `SKILL.md` below grouping directories as well as `<name>/SKILL.md`. */
    nested?: true;
    /** A skill with this front matter is never offered to the model. */
    hidden?(meta: Obj): boolean;
  };

  instructions?: {
    /** Files read as they are. */
    files: string[];
    /** Directories whose `*.md` files, at any depth, are instructions too. */
    dirs: string[];
    /** The settings file whose `instructions` list names more instruction files, or null. */
    setting: string | null;
  };

  /** Counts, in the agent's history, how often each MCP server and skill was used (`fleet context --usage`). */
  usage?: {
    read(request: HistoryRequest): Promise<HistoryRead>;
  };
};
