import type { CardData, CardHost } from "./data.ts";

export const STYLES = ["machines", "map"] as const;
export type Style = (typeof STYLES)[number];

export const isStyle = (value: unknown): value is Style => STYLES.includes(value as Style);

/** More machines than this are cut to a "+N more", so a long list never makes the card small. */
export const MAX_SHOWN = 6;

export const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A host as the card names it: `host 1`, `host 2`, ... in name order, unless the person asked for the real names. */
export const labelOf = (index: number, host: CardHost, names: boolean): string => (names ? host.name : `host ${index + 1}`);

export const shown = (data: CardData): CardHost[] => data.hosts.slice(0, MAX_SHOWN);
export const hidden = (data: CardData): number => Math.max(0, data.hosts.length - MAX_SHOWN);

/** `128`, or `20+` when the journal was full: it keeps only the last few, so the real number is not known. */
export const pushesCount = (data: CardData): string => `${data.pushes.count}${data.pushes.atLeast ? "+" : ""}`;
export const pushesWord = (data: CardData): string => (data.pushes.count === 1 && !data.pushes.atLeast ? "push" : "pushes");
export const pushesText = (data: CardData): string => `${pushesCount(data)} ${pushesWord(data)}`;

export const sinceText = (data: CardData): string => (data.since === null ? "" : ` since ${data.since}`);

/** The title and alt text of a card: counts only, never a name. */
export const summaryText = (data: CardData): string => `fleet: ${plural(data.hosts.length, "machine")}, ${plural(data.agents, "agent")}, ${plural(data.skills, "skill")}, ${plural(data.servers, "MCP server")}`;
