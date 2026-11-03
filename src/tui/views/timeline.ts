import { drawBox } from "../buffer.ts";
import type { Canvas, Style } from "../buffer.ts";
import type { State } from "../app.ts";
import type { Commit, CommitDiff } from "../reads.ts";
import { firstVisible } from "../layout.ts";
import { spinner, theme } from "../theme.ts";
import { truncate, wrap } from "../width.ts";
import { pad, plural, s, segments } from "./ui.ts";

/** Where a host last applied the config: a commit in the history shown, or unknown with the reason. */
export type Applied = { host: string; at: number | null; why: string };

export function appliedAt(state: State, commits: Commit[]): Applied[] {
  return state.model.hosts.map((h): Applied => {
    const live = state.live[h.name];
    const r = live?.result;
    if (!live || (r === null && live.phase === "loading")) return { host: h.name, at: null, why: "asking" };
    if (r?.result === "timer") return { host: h.name, at: null, why: "timer, no ssh destination" };
    if (!r || r.status === null) return { host: h.name, at: null, why: "no answer" };
    const sha = r.status.applied.config;
    if (r.status.applied.at === null) return { host: h.name, at: null, why: "never applied" };
    if (sha === null || sha === "") return { host: h.name, at: null, why: "older apply, commit not recorded" };
    const i = sha.length >= 7 ? commits.findIndex((c) => c.sha === sha || c.sha.startsWith(sha)) : -1;
    return i < 0 ? { host: h.name, at: null, why: "not in the commits shown" } : { host: h.name, at: i, why: "" };
  });
}

type Line = [text: string, style: Style];

const day = (iso: string): string => iso.slice(0, 10);

export function diffLines(diff: CommitDiff | "loading" | undefined, now: number, motion: boolean): Line[] {
  if (diff === undefined || diff === "loading") return [[`${spinner(now, motion)} reading this commit`, s.muted]];
  if (!diff.ok) return [[diff.detail, s.warn]];
  const out: Line[] = [];
  if (diff.secrets.length > 0) {
    out.push(["secrets changed (names only; the encrypted values are not shown)", s.warn]);
    for (const c of diff.secrets) {
      const parts = [
        c.added.length > 0 ? `added ${c.added.join(", ")}` : "",
        c.changed.length > 0 ? `changed ${c.changed.join(", ")}` : "",
        c.removed.length > 0 ? `removed ${c.removed.join(", ")}` : "",
        c.recipients ? "recipients changed" : "",
      ].filter((p) => p !== "");
      out.push([`  ${c.file}: ${parts.join("; ") || "re-encrypted, no name changed"}`, s.text]);
    }
    out.push(["", s.text]);
  }
  const plain = diff.files.filter((f) => !f.path.startsWith("secrets/") || !f.path.endsWith(".enc.yaml"));
  if (plain.length > 0) {
    out.push([plural(plain.length, "file") + " changed", s.muted]);
    for (const f of plain.slice(0, 12)) out.push([`  ${f.status} ${f.path}`, s.sub]);
    if (plain.length > 12) out.push([`  and ${plain.length - 12} more`, s.muted]);
    out.push(["", s.text]);
  }
  for (const text of diff.patch) {
    const style = text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("index ") ? s.muted : text.startsWith("+") ? s.ok : text.startsWith("-") ? s.bad : text.startsWith("@@") ? s.info : s.sub;
    out.push([text, style]);
  }
  if (diff.cut) out.push(["... the rest of this diff is not shown", s.muted]);
  if (diff.files.length === 0) out.push(["this commit changes no file", s.muted]);
  return out;
}

export function drawTimeline(c: Canvas, state: State): void {
  const { timeline: t, now, motion } = state;
  const h = t.history;
  if (h === null) return void segments(c, 2, 1, [[`${spinner(now, motion)} `, s.brand], ["reading the config repo's history", s.sub]]);
  if (!h.ok) {
    c.text(2, 1, "The config repo's history could not be read", s.warn);
    c.text(2, 2, truncate(h.detail, c.w - 4), s.muted);
    return;
  }
  const commits = h.commits;
  const applied = appliedAt(state, commits);
  segments(c, 2, 1, [[plural(commits.length, "commit"), s.text], [h.more ? " shown, older ones left out" : " in the config repo", s.muted], ["   ◆ ", s.brandBold], ["where a host last applied", s.muted]], c.w - 4);
  const unknown = applied.filter((a) => a.at === null);
  const said = unknown.length === 0 ? [] : wrap(`unknown: ${unknown.map((a) => `${a.host} (${a.why})`).join(", ")}`, c.w - 4).slice(0, 2);
  said.forEach((t, i) => c.text(2, 2 + i, t, s.muted));

  const top = 3 + Math.max(0, said.length - 1);
  const listH = Math.max(3, Math.min(commits.length, Math.floor((c.h - top) * 0.4)));
  const sel = Math.min(t.selected, Math.max(0, commits.length - 1));
  const first = firstVisible(sel, listH);
  commits.slice(first, first + listH).forEach((commit, i) => {
    const idx = first + i;
    const here = idx === sel;
    const y = top + i;
    const bg = here ? { bg: theme.raised } : {};
    if (here) c.fill(0, y, c.w, 1, { bg: theme.raised });
    const marks = applied.filter((a) => a.at === idx).map((a) => a.host);
    const mark = marks.length > 0 ? `◆ ${marks.join(", ")}` : "";
    const markW = Math.min(mark.length, Math.floor(c.w / 3));
    segments(
      c,
      0,
      y,
      [
        [here ? "›" : " ", { fg: theme.brandBright, ...bg }],
        [` ${commit.sha.slice(0, 7)} `, { fg: theme.faint, ...bg }],
        [`${day(commit.at)}  `, { fg: theme.muted, ...bg }],
        [pad(commit.subject, Math.max(4, c.w - 22 - markW - 1)), { fg: here ? theme.text : theme.sub, ...bg }],
      ],
      c.w,
    );
    if (mark) c.text(c.w - markW - 1, y, truncate(mark, markW), { fg: theme.brandBright, ...bg });
  });
  if (commits.length === 0) c.text(2, top, "no commits yet", s.muted);

  const py = top + listH + (commits.length === 0 ? 1 : 0);
  const ph = c.h - py;
  const commit = commits[sel];
  if (!commit || ph < 4) return;
  drawBox(c, 0, py, c.w, ph, "round", { fg: theme.border });
  c.text(2, py, truncate(` ${commit.sha.slice(0, 7)}  ${commit.subject} `, c.w - 4), s.bold);
  const lines = diffLines(t.diffs[commit.sha], now, motion);
  const inner = ph - 2;
  const scroll = Math.min(t.scroll, Math.max(0, lines.length - inner));
  lines.slice(scroll, scroll + inner).forEach(([text, style], i) => c.text(2, py + 1 + i, text, style, c.w - 4));
  if (lines.length > inner) c.textRight(c.w - 2, py + ph - 1, ` ${scroll + 1}-${Math.min(lines.length, scroll + inner)} of ${lines.length} `, s.faint);
}
