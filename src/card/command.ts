import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { paint } from "../output.ts";
import type { Result } from "../output.ts";
import { readCard } from "./data.ts";
import { previewText } from "./preview.ts";
import { CARD_HEIGHT, CARD_WIDTH, renderBadge, renderCard } from "./svg.ts";
import { isStyle, STYLES } from "./words.ts";
import type { Style } from "./words.ts";

export type CardOptions = {
  /** Where the file is written. */
  dir: string;
  style: string | undefined;
  names: boolean;
  badge: boolean;
  color: boolean;
  home: string;
  /** For tests. */
  now?: Date;
};

const invalid = (message: string): Result => ({ code: "invalid", messages: [`fleet: ${message}`] });

export const CARD_FILE = "fleet-card.svg";
export const BADGE_FILE = "fleet-badge.svg";

/**
 * `fleet card`: an image of this fleet to share, read from what fleet already holds locally (the config, the bridge's last
 * answer from each host, the config repo's git log, this host's push journal). It asks no host. Before it writes the file
 * it prints what is on it, so a person sees what they are about to publish.
 */
export function card(configDir: string, o: CardOptions): Result {
  if (o.style !== undefined && !isStyle(o.style)) return invalid(`--style is ${STYLES.join(" or ")}`);
  if (o.badge && (o.style !== undefined || o.names)) return invalid("--badge makes a badge, which has no style and shows no names");
  const style: Style = o.style === undefined ? "machines" : (o.style as Style);
  const data = readCard(configDir, o.home, o.now);
  const file = o.badge ? BADGE_FILE : CARD_FILE;
  const svg = o.badge ? renderBadge(data) : renderCard(data, style, o.names);
  try {
    writeFileSync(join(o.dir, file), svg);
  } catch (error) {
    return { code: "error", messages: [`fleet: cannot write ${file}: ${(error as Error).message}`] };
  }
  const size = o.badge ? `${/width="(\d+)"/.exec(svg)![1]} x 20` : `${CARD_WIDTH} x ${CARD_HEIGHT}`;
  const text = [previewText(data, o.names, o.color), "", `${paint(o.color, "green", "wrote")} ${file} ${paint(o.color, "dim", `(${size})`)}`].join("\n");
  return {
    code: "ok",
    text,
    fields: { file, style: o.badge ? "badge" : style, names: o.names, machines: data.hosts.length, agents: data.agents, skills: data.skills, mcpServers: data.servers, changes: data.changes, pushes: data.pushes.count, since: data.since, grid: data.activity !== null },
  };
}
