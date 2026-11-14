// The page's connection to `fleet ui`, and what it says about it. Pure: `node --test` runs it.

/**
 * `connecting`: the first answer has not come. `live`: the stream is open. `reconnecting`: the server does not answer (it
 * stopped, was restarted, or this machine slept). `invalid`: it answers, but this page's token is not the one it has now, which
 * means it was started again; that never gets better by waiting.
 * @typedef {"connecting" | "live" | "reconnecting" | "invalid"} Link
 */

/** Whether a button that changes something may be used. Not while the server cannot be reached. @param {Link} link */
export const linkUsable = (link) => link === "connecting" || link === "live";

/** The word in the header. @param {Link} link */
export const linkWord = (link) => (link === "reconnecting" ? "not answering" : link === "invalid" ? "token no longer valid" : link);

/**
 * The banner for a link that is down, or null. It says what happened and what to do.
 * @param {Link} link
 * @param {{ held: number, working: boolean }} state how many edits are on To push, and whether a push or a host set-up was running
 * @returns {{ title: string, lines: string[] } | null}
 */
export function linkBanner(link, { held, working }) {
  if (linkUsable(link)) return null;
  const keep = held > 0 ? `Your ${held} edit${held === 1 ? "" : "s"} to push ${held === 1 ? "is" : "are"} kept in this tab: open the new URL in this tab, not a new one, and ${held === 1 ? "it comes" : "they come"} back.` : "";
  const ran = working ? "A push or a host set-up that was running does not need the page: it finishes on its own. See how it went with fleet status in a terminal." : "";
  if (link === "invalid") {
    return {
      title: "This page's token is no longer valid.",
      lines: ["fleet ui was stopped and started again, so this page can no longer talk to it. Run fleet ui again if it is not running, and open the new URL it prints in this tab.", keep, ran].filter((l) => l !== ""),
    };
  }
  return {
    title: "fleet ui is not answering.",
    lines: ["It was stopped or restarted, or this machine went to sleep. Run fleet ui again in a terminal and open the new URL it prints. This page keeps trying, and becomes usable again if the same server comes back.", keep, ran].filter((l) => l !== ""),
  };
}
