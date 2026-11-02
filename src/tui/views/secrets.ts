import { drawBox } from "../buffer.ts";
import type { Canvas, Style } from "../buffer.ts";
import type { State } from "../app.ts";
import type { Changed, SecretEntry } from "../reads.ts";
import { firstVisible } from "../layout.ts";
import { spinner, theme } from "../theme.ts";
import { truncate } from "../width.ts";
import { pad, plural, s, segments } from "./ui.ts";

export const changedText = (changed: Changed): string =>
  changed === null ? "unknown (not in git)" : changed === "uncommitted" ? "not committed yet" : `${changed.at.slice(0, 10)}  ${changed.sha.slice(0, 7)}  ${changed.subject}`;

/** What this host can read, which is what to rotate if it is lost. */
export const readableBy = (entries: SecretEntry[], host: string): SecretEntry[] => entries.filter((e) => e.readers.includes(host));

type Line = [text: string, style: Style];

function entryLines(e: SecretEntry): Line[] {
  const lines: Line[] = [[`in ${e.path}`, s.sub]];
  const who = e.readers.length === 0 ? "no host in this config" : e.readers.join(", ");
  lines.push([`hosts that can decrypt it: ${who}${e.strangers > 0 ? `; ${plural(e.strangers, "recipient")} no host file names` : ""}`, s.text]);
  lines.push([`servers: ${e.servers.length > 0 ? e.servers.join(", ") : "none"}`, s.text]);
  lines.push([`settings: ${e.settings.length > 0 ? e.settings.join(", ") : "none"}`, s.text]);
  lines.push([`last changed: ${changedText(e.changed)}`, s.text]);
  return lines;
}

export function drawSecrets(c: Canvas, state: State): void {
  const { secrets: sc, now, motion } = state;
  const view = sc.view;
  if (view === null) return void segments(c, 2, 1, [[`${spinner(now, motion)} `, s.brand], ["reading the secret names", s.sub]]);
  segments(
    c,
    2,
    1,
    [
      [plural(view.entries.length, "secret name"), s.text],
      [" in the encrypted files. Names only: a value is never decrypted or shown here.", s.muted],
    ],
    c.w - 4,
  );
  c.text(2, 2, sc.mode === "names" ? "BY NAME   (v: by host)" : "BY HOST   (v: by name)", { fg: theme.muted, attr: 1 });
  view.problems.slice(0, 1).forEach((p) => c.text(2, 3, truncate(p, c.w - 4), s.warn));

  const top = 4;
  const count = sc.mode === "names" ? view.entries.length : view.hosts.length;
  const listH = Math.max(3, Math.min(count, Math.floor((c.h - top) * 0.45)));
  const first = firstVisible(sc.selected, listH);
  const rowAt = (y: number, here: boolean, segs: [string, Style][]) => {
    if (here) c.fill(0, y, c.w, 1, { bg: theme.raised });
    const bg = here ? { bg: theme.raised } : {};
    segments(c, 0, y, [[here ? "›" : " ", { fg: theme.brandBright, ...bg }], ...segs.map(([t, st]): [string, Style] => [t, { ...st, ...bg }])], c.w);
  };
  if (sc.mode === "names") {
    view.entries.slice(first, first + listH).forEach((e, i) => {
      const here = first + i === sc.selected;
      rowAt(top + i, here, [[` ${pad(e.name, 26)}`, { fg: here ? theme.text : theme.sub }], [pad(e.file, 10), s.muted], [pad(plural(e.readers.length, "host"), 8), s.muted], [e.changed && e.changed !== "uncommitted" ? e.changed.at.slice(0, 10) : "-", s.faint]]);
    });
  } else {
    view.hosts.slice(first, first + listH).forEach((h, i) => {
      const here = first + i === sc.selected;
      rowAt(top + i, here, [[` ${pad(h, 20)}`, { fg: here ? theme.text : theme.sub }], [plural(readableBy(view.entries, h).length, "secret name"), s.muted]]);
    });
  }
  if (count === 0) c.text(2, top, sc.mode === "names" ? "no secrets files hold any name" : "no host files", s.muted);

  const py = top + listH + (count === 0 ? 1 : 0);
  let lines: Line[] = [];
  let title = "";
  if (sc.mode === "names") {
    const e = view.entries[sc.selected];
    if (e) [title, lines] = [e.name, entryLines(e)];
  } else {
    const host = view.hosts[sc.selected];
    if (host) {
      const held = readableBy(view.entries, host);
      title = host;
      lines = [
        [`if you lost ${host}, rotate these ${held.length}: it can decrypt them`, s.warn],
        ...(held.length === 0 ? ([["none: no secrets file lists its age recipient", s.muted]] as Line[]) : held.map((e): Line => [`  ${pad(e.name, 28)}${e.file}`, s.text])),
      ];
    }
  }
  const ph = Math.min(c.h - py, Math.max(4, lines.length + 2));
  if (ph < 4) return;
  drawBox(c, 0, py, c.w, ph, "round", { fg: theme.border });
  if (title) c.text(2, py, truncate(` ${title} `, c.w - 4), s.bold);
  lines.slice(0, ph - 2).forEach(([text, style], i) => c.text(2, py + 1 + i, text, style, c.w - 4));
}
