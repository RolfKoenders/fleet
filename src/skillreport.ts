import { paint } from "./output.ts";
import type { Review } from "./skillreview.ts";

const COMMITS_SHOWN = 10;
const URL_SHOWN = 60;

const short = (sha: string) => sha.slice(0, 7);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (text: string) => text.replace(/https?:\/\/\S+/g, (url) => (url.length > URL_SHOWN ? `${url.slice(0, URL_SHOWN - 1)}…` : url));

/** The report for one source whose pin would move: the header, the commits, the changed skills, then the flags. */
export function renderReview(source: string, from: string, to: string, review: Review, color: boolean): string {
  const { commits, changed, flags } = review;
  const header = `${source}  ${short(from)} → ${short(to)}, ${plural(commits.length, "commit")}, ${changed.length} of your ${plural(review.yours, "skill")} changed (${plural(review.others, "other")})`;

  const shown = commits.slice(0, COMMITS_SHOWN).map((c) => paint(color, "dim", `  ${short(c.sha)} ${c.subject}`));
  if (commits.length > shown.length) shown.push(paint(color, "dim", `  … and ${commits.length - shown.length} more`));

  const rank = (severity: string) => (severity === "warning" ? 0 : 1);
  const ordered = [...flags].sort((a, b) => rank(a.severity) - rank(b.severity) || a.skill.localeCompare(b.skill) || a.file.localeCompare(b.file));
  // One line per skill and file, however many reasons it has.
  const rows = [
    ...changed.map((c) => ({ mark: "~", skill: c.skill, where: `+${c.added} −${c.removed}`, severity: "" })),
    ...ordered
      .filter((f, i) => ordered.findIndex((g) => g.skill === f.skill && g.file === f.file && g.severity === f.severity) === i)
      .map((f) => ({
        mark: f.severity === "warning" ? "!" : "i",
        skill: f.skill,
        where: f.file,
        severity: f.severity,
        why: ordered.filter((g) => g.skill === f.skill && g.file === f.file && g.severity === f.severity).map((g) => clip(g.detail)).join("; "),
      })),
  ];
  const skillWidth = Math.max(0, ...rows.map((r) => r.skill.length));
  const whereWidth = Math.max(0, ...rows.filter((r) => "why" in r).map((r) => r.where.length));
  const lines = rows.map((r) => {
    const why = "why" in r ? `  ${r.where.padEnd(whereWidth)}  ${r.why}` : `  ${r.where}`;
    const line = `  ${r.mark} ${r.skill.padEnd(skillWidth)}${why}`.trimEnd();
    return r.severity === "warning" ? paint(color, "yellow", line) : r.severity === "info" ? paint(color, "dim", line) : line;
  });
  return [header, ...(shown.length > 0 ? ["", ...shown] : []), ...(lines.length > 0 ? ["", ...lines] : [])].join("\n");
}

/** The line under a report on a terminal. */
export const reviewFooter = (from: string) => `d full diff   y move the pin   n keep ${short(from)}`;
