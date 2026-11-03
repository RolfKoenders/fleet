import { BOLD, drawBox } from "../buffer.ts";
import type { Canvas, Style } from "../buffer.ts";
import type { State } from "../app.ts";
import { explain, visibleRows } from "../model.ts";
import type { Cell, Row } from "../model.ts";
import { theme } from "../theme.ts";
import { stringWidth, truncate } from "../width.ts";
import { pad, plural, s, segments } from "./ui.ts";
import { spinner } from "../theme.ts";
import type { Health, ServerHealth } from "../doctorread.ts";
import type { Seg } from "./ui.ts";

/** One glyph per state, so the table reads without colour too. */
export function glyph(cell: Cell | undefined): [string, Style] {
  if (!cell) return ["?", s.muted];
  if (cell.excluded) return ["✕", s.warn];
  if (!cell.on) return ["·", s.faint];
  return cell.picked === "host" ? ["◆", { fg: theme.host }] : cell.picked === "both" ? ["◉", s.ok] : ["●", s.ok];
}

const HEALTH: Record<Health, [string, Style]> = { ok: ["✓", s.ok], neutral: ["◇", s.muted], bad: ["✕", s.bad], unknown: ["?", s.muted] };

/** What doctor found for a server on a host, or null when doctor has not been asked or the server is not on that host. */
export function healthOf(state: State, server: string, host: string): { health: Health; why: ServerHealth | null; note: string | null } | null {
  const r = state.doctor.result;
  if (r === null || !r.ok) return null;
  const h = r.hosts[host];
  // Doctor ran, but not for this host (this host only, or it was not in the answer): unknown, not fine.
  if (h === undefined) return state.doctor.scope === "all" ? { health: "unknown", why: null, note: "doctor gave no answer for this host" } : null;
  const why = h.servers[server];
  if (why === undefined) return { health: "unknown", why: null, note: h.note ?? "doctor did not list this server on this host" };
  return { health: why.health, why, note: null };
}

type Line = { head: string } | { row: number };

function lines(rows: Row[]): Line[] {
  const out: Line[] = [];
  let section = "";
  rows.forEach((r, i) => {
    const want = r.kind === "server" ? "MCP SERVERS" : "SKILL BUNDLES";
    if (want !== section) {
      section = want;
      out.push({ head: want });
    }
    out.push({ row: i });
  });
  return out;
}

const labelOf = (r: Row, expanded: Set<string>): string =>
  r.kind === "bundle" ? `${expanded.has(r.name) ? "▾" : "▸"} ${r.name} (${r.skills.length})` : r.kind === "skill" ? `   └ ${r.name}` : `  ${r.name}`;

export function drawMatrix(c: Canvas, state: State): void {
  const { model, matrix } = state;
  const expanded = new Set(matrix.expanded);
  const rows = visibleRows(model, expanded);
  const hosts = model.hosts;
  if (hosts.length === 0 || rows.length === 0) {
    c.text(2, 1, hosts.length === 0 ? "No hosts yet." : "The catalog has no bundles or servers yet.", s.text);
    model.problems.slice(0, 4).forEach((p, i) => c.text(2, 3 + i, truncate(p, c.w - 4), s.warn));
    return;
  }
  const row = Math.min(matrix.row, rows.length - 1);
  const col = Math.min(matrix.col, hosts.length - 1);

  const labelW = Math.min(Math.max(16, c.w < 60 ? 14 : 24), Math.max(...rows.map((r) => stringWidth(labelOf(r, expanded)))) + 3);
  const colW = Math.max(7, Math.min(13, Math.max(...hosts.map((h) => stringWidth(h.name))) + 2));
  const room = Math.max(1, Math.floor((c.w - labelW - 2) / colW));
  const firstCol = Math.max(0, Math.min(col - room + 1 > 0 ? col - room + 1 : 0, hosts.length - room));
  const shown = hosts.slice(firstCol, firstCol + room);

  const whyH = c.h >= 18 ? 6 : c.h >= 13 ? 5 : 0;
  const doctor = state.doctor;
  const tableTop = 2 + (model.problems.length > 0 ? 1 : 0) + (doctor.phase !== "idle" ? 1 : 0);
  const tableH = c.h - tableTop - whyH;

  // Legend and, when the config is only partly readable, why.
  segments(c, 1, 0, [["●", s.ok], [" defaults  ", s.muted], ["◆", { fg: theme.host }], [" this host  ", s.muted], ["◉", s.ok], [" both  ", s.muted], ["✕", s.warn], [" excluded  ", s.muted], ["·", s.faint], [" not picked", s.muted]], c.w - 2);
  if (doctor.phase !== "idle") {
    const y = model.problems.length > 0 ? 2 : 1;
    const asked = doctor.scope === "all" && model.hosts.length > 1 ? "every host" : "this host";
    const r = doctor.result;
    if (doctor.phase === "running") segments(c, 1, y, [[`${spinner(state.now, state.motion)} `, s.brand], [`doctor is running on ${asked}: it starts real servers and can take minutes`, s.warn]], c.w - 2);
    else if (r !== null && !r.ok) c.text(1, y, truncate(`doctor could not be read: ${r.detail}`, c.w - 2), s.warn);
    else segments(c, 1, y, [["health ", s.muted], ...(["ok", "neutral", "bad", "unknown"] as const).flatMap((h, i): Seg[] => [[HEALTH[h][0], HEALTH[h][1]], [` ${["healthy", "needs a login", "failing", "unknown"][i]}  `, s.muted]]), [`from the last doctor run on ${asked}`, s.faint]], c.w - 2);
  }
  if (model.problems.length > 0) c.text(1, 1, truncate(`config problem: ${model.problems[0]}${model.problems.length > 1 ? ` (+${model.problems.length - 1})` : ""}`, c.w - 2), s.warn);

  // Column heads.
  const headY = tableTop - 1;
  shown.forEach((h, i) => {
    const active = firstCol + i === col;
    const name = truncate(h.name, colW - 1);
    const x = labelW + 1 + i * colW + Math.floor((colW - stringWidth(name)) / 2);
    c.text(x, headY, name, active ? { fg: theme.brandBright, attr: BOLD } : h.self ? s.text : s.sub);
  });
  if (firstCol > 0) c.text(labelW - 1, headY, "‹", s.brand);
  if (firstCol + room < hosts.length) c.text(labelW + 1 + room * colW, headY, "›", s.brand);
  for (let x = 1; x < c.w - 1; x++) c.cell(x, headY + 1, "─", { fg: theme.border });

  const all = lines(rows);
  const cursorLine = all.findIndex((l) => "row" in l && l.row === row);
  const visible = Math.max(1, tableH - 2);
  const start = Math.max(0, Math.min(cursorLine - Math.floor(visible / 2), all.length - visible));
  all.slice(start, start + visible).forEach((l, i) => {
    const y = headY + 2 + i;
    if ("head" in l) {
      c.text(1, y, l.head, { fg: theme.muted, attr: BOLD });
      return;
    }
    const r = rows[l.row]!;
    const here = l.row === row;
    if (here) c.fill(0, y, c.w, 1, { bg: theme.raised });
    const bg = here ? theme.raised : undefined;
    const on = (st: Style): Style => (bg === undefined ? st : { ...st, bg });
    segments(c, 0, y, [[here ? "›" : " ", on(s.brandBold)], [pad(labelOf(r, expanded), labelW - 1), on(here ? s.bold : r.kind === "skill" ? s.muted : s.text)]]);
    shown.forEach((h, j) => {
      const [g, st] = glyph(r.cells[h.name]);
      const x = labelW + 1 + j * colW + Math.floor(colW / 2);
      const inCol = firstCol + j === col;
      const hl = r.kind === "server" && r.cells[h.name]?.on ? healthOf(state, r.name, h.name) : null;
      if (hl !== null) c.text(x + 2, y, HEALTH[hl.health][0], { ...HEALTH[hl.health][1], ...(bg === undefined ? {} : { bg }) });
      if (here && inCol) {
        c.text(x - 1, y, `[${g}]`, { ...st, bg: theme.brandDeep, attr: BOLD });
      } else {
        c.cell(x, y, g, on(inCol && !here ? { ...st, bg: theme.surface } : st));
        if (inCol && !here) c.cell(x - 1, y, " ", { bg: theme.surface }), c.cell(x + 1, y, " ", { bg: theme.surface });
      }
    });
  });
  if (start > 0) c.text(c.w - 3, headY + 2, "▲", s.muted);
  if (start + visible < all.length) c.text(c.w - 3, headY + 1 + visible, "▼", s.muted);

  // Why the cell under the cursor is on or off.
  if (whyH > 0) {
    const r = rows[row]!;
    const host = hosts[col]!;
    const y = c.h - whyH;
    drawBox(c, 1, y, c.w - 2, whyH, "round", { fg: theme.border });
    const [g, st] = glyph(r.cells[host.name]);
    c.text(3, y, ` ${g} ${r.name} on ${host.name} `, { ...st, attr: BOLD });
    const why = explain(r, host.name);
    const body: Seg[][] = why.slice(1).map((t) => [[t, s.sub]]);
    if (r.kind === "bundle") body.push([[`${plural(r.skills.length, "skill")}: ${r.skills.join(", ")}`, s.muted]]);
    if (r.server) {
      const { kind, only, secrets } = r.server;
      body.push([[`${kind} server for ${only.join(" and ")}${secrets > 0 ? `, uses ${plural(secrets, "secret")}` : ""}`, s.muted]]);
      const hl = r.cells[host.name]?.on ? healthOf(state, r.name, host.name) : null;
      if (hl !== null) {
        const [g, gs] = HEALTH[hl.health];
        const said = hl.why === null ? (hl.note ?? "") : `${hl.why.words}${hl.why.protocol ? `, protocol ${hl.why.protocol}` : ""}${hl.why.detail ? ` (${hl.why.detail})` : ""}`;
        body.push([[`${g} `, gs], [hl.health === "neutral" ? "needs a login: " : hl.health === "unknown" ? "unknown: " : "doctor: ", s.sub], [said, s.sub]]);
      }
    }
    body.slice(0, whyH - 2).forEach((segs, i) => segments(c, 3, y + 1 + i, segs, c.w - 6));
    if (r.kind === "bundle") c.textRight(c.w - 3, y + whyH - 1, " enter: show skills ", s.faint);
  }
}
