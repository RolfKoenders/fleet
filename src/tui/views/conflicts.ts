import { drawBox } from "../buffer.ts";
import type { Canvas } from "../buffer.ts";
import type { State } from "../app.ts";
import { spinner, theme } from "../theme.ts";
import { truncate, wrap } from "../width.ts";
import { pad, plural, s, segments } from "./ui.ts";

export function drawConflicts(c: Canvas, state: State): void {
  const { conflicts, model, live, now, motion } = state;
  const others = model.hosts.filter((h) => !h.self);
  if (conflicts.phase === "loading") {
    segments(c, 2, 1, [[`${spinner(now, motion)} `, s.brand], ["planning this host against its config", s.sub]]);
  } else if (conflicts.detail !== null) {
    c.text(2, 1, "Conflicts on this host could not be planned", s.warn);
    wrap(conflicts.detail, c.w - 4).slice(0, 4).forEach((t, i) => c.text(2, 2 + i, t, s.muted));
  } else if (conflicts.items.length === 0) {
    segments(c, 2, 1, [["✓ ", s.ok], ["no conflicts on this host", s.text]]);
  } else {
    segments(c, 2, 1, [[plural(conflicts.items.length, "conflict"), s.bad], [" on this host. Apply stops until each is cleared.", s.muted]]);
  }

  const listTop = 3;
  const remote = others.length;
  const detailH = conflicts.items.length > 0 && c.h >= 18 ? 9 : 0;
  const remoteH = remote > 0 ? Math.min(remote, 4) + 1 : 0;
  const listH = Math.max(0, c.h - listTop - detailH - remoteH);
  const sel = conflicts.selected;
  const first = sel < listH ? 0 : sel - listH + 1;
  conflicts.items.slice(first, first + listH).forEach((item, i) => {
    const here = first + i === sel;
    const y = listTop + i;
    if (here) c.fill(0, y, c.w, 1, { bg: theme.raised });
    const bg = here ? theme.raised : undefined;
    segments(c, 0, y, [
      [here ? "›" : " ", { fg: theme.brandBright, ...(bg === undefined ? {} : { bg }) }],
      [` ${pad(item.kind, 8)}`, { fg: theme.warn, ...(bg === undefined ? {} : { bg }) }],
      [truncate(item.path, c.w - 14), { fg: here ? theme.text : theme.sub, ...(bg === undefined ? {} : { bg }) }],
    ]);
  });

  const item = conflicts.items[sel];
  if (item && detailH > 0) {
    const y = c.h - remoteH - detailH;
    drawBox(c, 1, y, c.w - 2, detailH, "round", { fg: theme.border });
    c.text(3, y, ` ${item.kind} `, { fg: theme.warn });
    const width = c.w - 8;
    const detail = wrap(item.detail, width).slice(0, 3);
    detail.forEach((t, i) => c.text(3, y + 1 + i, t, s.text));
    c.text(3, y + 2 + detail.length, "fix", s.brandBold);
    wrap(item.fix, width - 4).slice(0, detailH - 4 - detail.length).forEach((t, i) => c.text(7, y + 2 + detail.length + i, t, s.sub));
  }

  if (remote > 0) {
    const y = c.h - remoteH;
    c.text(2, y, "OTHER HOSTS", { fg: theme.muted, attr: 1 });
    others.slice(0, 4).forEach((h, i) => {
      const r = live[h.name]?.result;
      const n = r?.status?.conflicts ?? null;
      const what =
        r === null || r === undefined ? ["asking", s.muted] : r.result === "timer" ? ["unknown: no ssh destination", s.muted] : r.result !== "ok" ? ["unknown: no answer", s.muted] : n === null ? ["unknown", s.muted] : n === 0 ? ["none", s.ok] : [`${plural(n, "conflict")}; the detail is local only, run fleet diff on that host`, s.warn];
      segments(c, 2, y + 1 + i, [[pad(h.name, 14), s.sub], [what[0] as string, what[1] as never]], c.w - 4);
    });
  }
}
