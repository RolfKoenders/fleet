// The keys the config files accept. The loaders read their lists from here, and docs/reference-*.md
// has an entry for every key `referenceKeys` returns (test/reference.test.ts), so a key cannot be
// accepted without being documented or documented without being accepted.

/** `fleet.yaml`: the one top-level key, and what it holds. */
export const FLEET_KEYS = ["tool"];
export const TOOL_KEYS = ["repo", "commit", "track"];

/** Keys of `hosts/_defaults.yaml`, which a host file may also set. */
export const SHARED_KEYS = ["vars", "bundles", "exclude", "mcp", "settings", "files", "agents", "timer"];
/** Keys only a host file may set. */
export const HOST_ONLY_KEYS = ["ssh", "age", "admin", "unmanaged"];
/** What `mcp` holds, and what an entry of `files` holds. */
export const MCP_SELECT_KEYS = ["include", "exclude"];
export const FILE_RECORD_KEYS = ["source", "target"];

/** `catalog/mcp.yaml`: the one top-level key, and what a server holds. */
export const MCP_CATALOG_KEYS = ["servers"];
export const SERVER_KEYS = ["command", "env", "transport", "url", "headers", "only"];

/** `catalog/skills.yaml`: the top-level keys, and what a source holds. */
export const SKILLS_CATALOG_KEYS = ["sources", "bundles"];
export const SOURCE_KEYS = ["repo", "path", "commit", "track", "branch", "review"];

/** The config files the reference has a page for. */
export type ReferenceFile = "fleet.yaml" | "hosts" | "catalog/mcp.yaml" | "catalog/skills.yaml";

/**
 * Every key of each file as a path. A map the user names the entries of reads `<name>` (`servers.<name>.url`)
 * and `<agent>` (`settings.<agent>`), a list reads `[]` (`files[].target`). A key that only holds other
 * keys (`tool`, `mcp`, `servers`) is not listed; the keys inside it are.
 */
export function referenceKeys(): Record<ReferenceFile, string[]> {
  const inside = (parent: string, keys: string[], at = "."): string[] => keys.map((key) => `${parent}${at}${key}`);
  const hostKeys = [...SHARED_KEYS, ...HOST_ONLY_KEYS].flatMap((key) => {
    if (key === "mcp") return inside(key, MCP_SELECT_KEYS);
    if (key === "files") return [key, ...inside(key, FILE_RECORD_KEYS, "[].")];
    if (key === "settings") return [`${key}.<agent>`];
    return [key];
  });
  return {
    "fleet.yaml": FLEET_KEYS.flatMap((key) => inside(key, TOOL_KEYS)),
    hosts: hostKeys,
    "catalog/mcp.yaml": MCP_CATALOG_KEYS.flatMap((key) => inside(`${key}.<name>`, SERVER_KEYS)),
    "catalog/skills.yaml": SKILLS_CATALOG_KEYS.flatMap((key) => (key === "sources" ? inside(`${key}.<name>`, SOURCE_KEYS) : [`${key}.<name>`])),
  };
}
