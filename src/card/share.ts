import type { CardData } from "./data.ts";
import { plural } from "./words.ts";

/** Where a new discussion in the project's Show and tell category starts. */
export const SHOW_AND_TELL = "https://github.com/RolfKoenders/fleet/discussions/new?category=show-and-tell";

/** The prefilled title and body of that discussion: counts only, never a hostname. The person attaches the image. */
export function shareText(data: CardData): { title: string; body: string } {
  const counts = `${plural(data.hosts.length, "machine")}, ${plural(data.agents, "agent")}, ${plural(data.skills, "skill")} and ${plural(data.servers, "MCP server")}`;
  return {
    title: `My fleet: ${plural(data.hosts.length, "machine")}, ${plural(data.agents, "agent")}`,
    body: `This is my fleet, made with \`fleet card\`: ${counts}.\n\n(Attach the card image here: save it as a PNG on the fleet ui Card page, then drag it into this box.)`,
  };
}
