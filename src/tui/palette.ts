import type { Model } from "./model.ts";

export type Screen = "home" | "matrix" | "conflicts";

export const SCREENS: { id: Screen; title: string; key: string }[] = [
  { id: "home", title: "Home", key: "1" },
  { id: "matrix", title: "Matrix", key: "2" },
  { id: "conflicts", title: "Conflicts", key: "3" },
];

export type Action =
  | { do: "screen"; screen: Screen }
  | { do: "host"; name: string }
  | { do: "row"; name: string; kind: "bundle" | "server" }
  | { do: "refresh" }
  | { do: "help" }
  | { do: "quit" };

export type Item = {
  kind: "screen" | "host" | "bundle" | "server" | "action";
  label: string;
  /** The `fleet` command that shows the same thing, or null when only the bridge does. */
  command: string | null;
  /** When there is no command, what the item reads instead. */
  note: string;
  action: Action;
};

const FROM_CONFIG = "reads the config files; no fleet command shows it";

/** Everything the palette can jump to, with the command each one equals. */
export function items(model: Model): Item[] {
  return [
    { kind: "screen", label: "Home", command: "fleet status --all", note: "", action: { do: "screen", screen: "home" } },
    { kind: "screen", label: "Matrix", command: null, note: FROM_CONFIG, action: { do: "screen", screen: "matrix" } },
    { kind: "screen", label: "Conflicts", command: "fleet diff", note: "", action: { do: "screen", screen: "conflicts" } },
    ...model.hosts.map((h): Item => ({ kind: "host", label: h.name, command: h.self ? "fleet status" : "fleet status --all", note: "", action: { do: "host", name: h.name } })),
    ...model.bundles.map((b): Item => ({ kind: "bundle", label: b.name, command: null, note: FROM_CONFIG, action: { do: "row", name: b.name, kind: "bundle" } })),
    ...model.servers.map((s): Item => ({ kind: "server", label: s.name, command: null, note: FROM_CONFIG, action: { do: "row", name: s.name, kind: "server" } })),
    { kind: "action", label: "Refresh hosts", command: "fleet status --all", note: "", action: { do: "refresh" } },
    { kind: "action", label: "Help", command: null, note: "keys and legend", action: { do: "help" } },
    { kind: "action", label: "Quit", command: null, note: "leaves the bridge", action: { do: "quit" } },
  ];
}

export type Match = { item: Item; score: number; at: number[] };

/** Subsequence match, case-blind; runs and word starts score higher. Null when `query` is not in `label`. */
export function fuzzy(query: string, label: string): { score: number; at: number[] } | null {
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  const at: number[] = [];
  let score = 0;
  let from = 0;
  let last = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = l.indexOf(ch, from);
    if (i < 0) return null;
    at.push(i);
    score += 1 + (i === last + 1 ? 3 : 0) + (i === 0 || /[^a-z0-9]/.test(l[i - 1]!) ? 4 : 0) - Math.min(i - from, 3) * 0.2;
    last = i;
    from = i + 1;
  }
  return { score: score - label.length * 0.01, at };
}

const ORDER = ["screen", "host", "bundle", "server", "action"];

/** The items that match, best first; all of them, in the order above, when the query is empty. */
export function search(all: Item[], query: string): Match[] {
  if (query.trim() === "") return all.map((item) => ({ item, score: 0, at: [] }));
  const out: Match[] = [];
  for (const item of all) {
    const m = fuzzy(query, `${item.label}`) ?? null;
    if (m) out.push({ item, ...m });
  }
  return out.sort((a, b) => b.score - a.score || ORDER.indexOf(a.item.kind) - ORDER.indexOf(b.item.kind));
}
