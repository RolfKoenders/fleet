import { isObject } from "./yamlfile.ts";

/** What replaces a secret wherever a plan or report shows a rendered value. */
export const MASK = "***";

// Fresh each call: a global regex keeps its position between uses.
const secretRef = () => /(?<![A-Za-z0-9_])secret:([A-Z][A-Z0-9_]*)/g;
const varRef = () => /\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Applies `change` to every string in a JSON-shaped value, keys left alone. */
function mapStrings(value: unknown, change: (text: string) => string): unknown {
  if (typeof value === "string") return change(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, change)]));
  return value;
}

function eachString(value: unknown, visit: (text: string) => void): void {
  mapStrings(value, (text) => {
    visit(text);
    return text;
  });
}

export const hasSecretRef = (text: string): boolean => secretRef().test(text);

/** The distinct secret names a value refers to, in order of first use. */
export function secretNames(value: unknown): string[] {
  const names = new Set<string>();
  eachString(value, (text) => {
    for (const match of text.matchAll(secretRef())) names.add(match[1]!);
  });
  return [...names];
}

/** Replaces `{{ vars.NAME }}` in every string. Names with no value are returned in `unknown`. */
export function fillVars(value: unknown, vars: Record<string, string>): { value: unknown; unknown: string[] } {
  const unknown = new Set<string>();
  const filled = mapStrings(value, (text) =>
    text.replace(varRef(), (whole, name: string) => {
      if (Object.hasOwn(vars, name)) return vars[name]!;
      unknown.add(name);
      return whole;
    }),
  );
  return { value: filled, unknown: [...unknown] };
}

/**
 * Replaces `secret:NAME` in every string, in one pass, so a secret that looks like a reference is
 * never expanded again. `display` is the same value with each secret shown as `***`, or null when
 * the value used none.
 */
export function fillSecrets(value: unknown, secrets: Map<string, string>): { value: unknown; display: unknown | null } {
  let used = false;
  const fill = (show: boolean) => (text: string) =>
    text.replace(secretRef(), (_whole, name: string) => {
      used = true;
      return show ? MASK : secrets.get(name)!;
    });
  const filled = mapStrings(value, fill(false));
  return { value: filled, display: used ? mapStrings(value, fill(true)) : null };
}
