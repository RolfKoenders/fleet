import type { Canvas } from "../buffer.ts";
import type { State } from "../app.ts";
import type { JournalEntry } from "../../journal.ts";
import { truncate } from "../width.ts";
import { clock } from "./push.ts";
import { pad, plural, s, segments } from "./ui.ts";
import type { Seg } from "./ui.ts";

/** A local `2026-11-13 09:41`. */
export function when(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const resultOf = (e: JournalEntry): [string, Seg[1]] => (e.header.interrupted ? ["interrupted", s.warn] : e.header.result === "ok" ? ["ok", s.ok] : [e.header.result ?? "no result", s.bad]);

/** The history of pushes this host recorded, newest first. Only called while the list is open. */
export function drawHistory(c: Canvas, state: State): void {
  const j = state.journal;
  if (j.phase !== "list") return;
  c.text(2, 0, "Push history", s.bold);
  c.text(2, 1, truncate("The last pushes this host ran, kept on this host only. enter replays one.", c.w - 4), s.muted);
  if (j.entries === null) return void c.text(2, 3, "reading the journal", s.sub);
  if (j.entries.length === 0) return void c.text(2, 3, truncate("No pushes recorded yet. Each push writes its journal here.", c.w - 4), s.muted);
  const room = Math.max(1, c.h - 3);
  const top = Math.max(0, Math.min(j.selected - Math.floor(room / 2), j.entries.length - room));
  j.entries.slice(top, top + room).forEach((e, i) => {
    const y = 3 + i;
    const at = top + i;
    const [result, style] = resultOf(e);
    const scope = e.header.only === null ? "all hosts" : e.header.only;
    const chosen = at === j.selected;
    if (chosen) c.text(0, y, "›", s.brandBold);
    segments(c, 2, y, [[pad(when(e.header.time), 17), chosen ? s.bold : s.text], [pad(result, 12), style], [pad(clock(e.header.ms), 8), s.sub], [pad(scope, 12), s.sub], [plural(e.header.hosts.length, "host"), s.muted]], c.w - 4);
  });
  if (j.entries.length > room) c.textRight(c.w - 2, 0, `${j.selected + 1}/${j.entries.length}`, s.faint);
}
