import type { AgentId } from "../agents/index.ts";
import { unpinned } from "../ui/static/catalog.js";
import { hideArgs } from "./names.ts";
import { keyRows } from "./plan.ts";
import type { KeyRow } from "./plan.ts";
import type { Differing, Item, ItemState, McpItem, RepoInfo, Scan, SkillItem } from "./scan.ts";

/**
 * A scan as a document for `fleet capture --json` and the page: what was found and what can be done about it, with every value
 * left out. A definition shows its command (a credential flag hidden), its URL, and the NAMES of its env variables and headers;
 * a blocked item shows none of its definition, because what blocked it may be a credential in it.
 */

export type McpView = {
  kind: "mcp";
  name: string;
  state: ItemState;
  message: string | null;
  agents: AgentId[];
  variants: { agents: AgentId[]; command: string[] | null; transport: "http" | "sse" | null; url: string | null; keys: KeyRow[]; /** Why the command is not pinned to a version, the warning `fleet ui` gives on Add. */ warning: string | null }[];
};
export type SkillView = { kind: "skill"; name: string; state: ItemState; message: string | null; path: string; repo: RepoInfo | null; bundle: string | null };
export type ItemView = McpView | SkillView;

export type ScanView = { items: ItemView[]; differs: Differing[]; notes: string[] };

function mcpView(item: McpItem, taken: ReadonlySet<string>): McpView {
  const shown = item.state !== "blocked";
  return {
    kind: "mcp",
    name: item.name,
    state: item.state,
    message: item.message,
    agents: item.agents,
    variants: item.variants.map((v, i) => ({
      agents: v.agents,
      command: shown && v.server.command !== null ? [v.server.command[0]!, ...hideArgs(v.server.command.slice(1))] : null,
      transport: shown ? v.server.transport : null,
      url: shown ? v.server.url : null,
      keys: shown ? keyRows(item, i, taken) : [],
      warning: shown && v.server.command !== null ? unpinned(v.server.command) : null,
    })),
  };
}

const skillView = (item: SkillItem): SkillView => ({ kind: "skill", name: item.name, state: item.state, message: item.message, path: item.path, repo: item.repo, bundle: item.bundle });

export const viewOf = (item: Item, taken: ReadonlySet<string>): ItemView => (item.kind === "mcp" ? mcpView(item, taken) : skillView(item));

export const scanView = (scan: Scan, taken: ReadonlySet<string>): ScanView => ({ items: scan.items.map((i) => viewOf(i, taken)), differs: scan.differs, notes: scan.notes });

/** `2 differ from the catalog: see fleet status --conflicts`, or null when none do. */
export function differsLine(differs: readonly Differing[]): string | null {
  return differs.length === 0 ? null : `${differs.length} ${differs.length === 1 ? "differs" : "differ"} from the catalog: see fleet status --conflicts`;
}
