import { isObject } from "./yamlfile.ts";
import type { Obj } from "./yamlfile.ts";

export type Tool = "claude" | "opencode";

/** The merged file each tool's `settings` map is written into. */
export const SETTINGS_FILE: Record<Tool, string> = {
  claude: "~/.claude/settings.json",
  opencode: "~/.config/opencode/opencode.jsonc",
};

/**
 * Paths no host file may own, with everything below them. All are top-level keys.
 * `mcpServers` is listed because Claude keeps its servers in `~/.claude.json`, not here.
 */
const DENIED: Record<Tool, string[]> = {
  claude: [
    "model", "modelSettings", "effortLevel", "advisorModel", "fastMode", "alwaysThinkingEnabled", "tui",
    "remoteControlAtStartup", "agentPushNotifEnabled", "skipDangerousModePermissionPrompt", "theme", "mcpServers",
  ],
  opencode: ["$schema", "mcp"],
};

/** One owned key as a host file declares it: a dotted path and the whole value at it. */
export type Declared = { tool: Tool; path: string; value: unknown };

/**
 * One owned key as the config resolves it, naming the file it lives in. `display` is the
 * value with secrets shown as `***`; only a key that used a secret has one.
 */
export type DesiredKey = { file: string; path: string; value: unknown; display?: unknown };

function notJson(value: unknown): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : "a number JSON cannot hold";
  if (Array.isArray(value)) return value.map(notJson).find((reason) => reason !== null) ?? null;
  if (isObject(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value).map(notJson).find((reason) => reason !== null) ?? null;
  }
  return "a value JSON cannot hold (quote it if it is meant as text)";
}

/** Nested maps become dotted paths. The leaf is any non-map value, and an empty map. Lists are leaves. */
function flatten(map: Obj, prefix: string[], out: [string[], unknown][]): void {
  for (const [key, value] of Object.entries(map)) {
    if (isObject(value) && Object.keys(value).length > 0) flatten(value, [...prefix, key], out);
    else out.push([[...prefix, key], value]);
  }
}

export function declareSettings(map: Obj, tool: Tool, file: string, problems: string[]): Declared[] {
  const leaves: [string[], unknown][] = [];
  flatten(map, [], leaves);
  const declared: Declared[] = [];
  for (const [segments, value] of leaves) {
    const path = segments.join(".");
    const at = `${file}: settings.${tool}.${path}`;
    const badSegment = segments.find((s) => s === "" || s.includes(".") || s === "__proto__");
    if (badSegment !== undefined) {
      problems.push(`${at}: key '${badSegment}' cannot be owned: keys must be non-empty, without '.', and not '__proto__'`);
    } else if (DENIED[tool].includes(segments[0]!)) {
      problems.push(`${at}: not allowed, fleet never owns '${segments[0]}'`);
    } else {
      const reason = notJson(value);
      if (reason !== null) problems.push(`${at}: ${reason}`);
      else declared.push({ tool, path, value });
    }
  }
  return declared;
}

/**
 * The defaults' keys, with the host's replacing the same path. A path that is a parent of another
 * (`a` beside `a.b`) is a problem: it would be unclear which one owns the value.
 */
export function mergeSettings(defaults: Declared[], host: Declared[], problems: string[]): DesiredKey[] {
  const merged = new Map<string, Declared>();
  for (const key of [...defaults, ...host]) merged.set(`${key.tool}\0${key.path}`, key);
  const keys = [...merged.values()];
  for (const a of keys) {
    for (const b of keys) {
      if (a.tool === b.tool && b.path.startsWith(`${a.path}.`)) {
        problems.push(`settings.${a.tool}: '${a.path}' and '${b.path}' overlap; declare the whole value or its members, not both`);
      }
    }
  }
  return keys.map(({ tool, path, value }) => ({ file: SETTINGS_FILE[tool], path, value }));
}
