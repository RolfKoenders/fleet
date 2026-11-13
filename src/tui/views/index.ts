import type { Canvas } from "../buffer.ts";
import { DIM } from "../buffer.ts";
import type { State } from "../app.ts";
import { homeLayout, tooSmall, MIN_COLS, MIN_ROWS, BODY_TOP, bodyHeight } from "../layout.ts";
import { theme } from "../theme.ts";
import { drawBoot } from "./boot.ts";
import { drawFooter, drawHeader } from "./chrome.ts";
import type { Hint } from "./chrome.ts";
import { drawCatalog } from "./catalog.ts";
import { drawConflicts } from "./conflicts.ts";
import { drawContext } from "./context.ts";
import { drawHome } from "./home.ts";
import { drawMatrix } from "./matrix.ts";
import { drawPush, pickedLane } from "./push.ts";
import { drawSecrets } from "./secrets.ts";
import { drawTimeline } from "./timeline.ts";
import { drawDoctor, drawHelp, drawLeave, drawPalette } from "./overlays.ts";
import { s } from "./ui.ts";

const COMMON: Hint[] = [["ctrl-k", "palette"], ["?", "help"], ["q", "quit"]];

function hints(state: State): Hint[] {
  const own = baseHints(state);
  // First, so a narrow terminal cuts the others before it.
  const watch = state.demo && state.overlay === null && state.push.phase === "idle" && state.screen !== "push" ? ([["press P", "to watch a push"]] as Hint[]) : [];
  return [...watch, ...own];
}

function baseHints(state: State): Hint[] {
  if (state.overlay?.kind === "leave") return [["q", "leave anyway"], ["esc", "stay"]];
  if (state.screen === "push" && state.push.phase === "review") return state.push.focus === "message" ? [["type", "commit message"], ["enter", "next"], ["tab", "back to push"], ["esc", "cancel"]] : [["type push", "confirm"], ["enter", "go"], ["tab", "commit message"], ["ctrl-r", "read again"], ["esc", "cancel"]];
  if (state.overlay?.kind === "palette") return [["↑↓", "choose"], ["enter", "go"], ["esc", "close"]];
  if (state.overlay?.kind === "help") return [["esc", "close"]];
  if (state.overlay?.kind === "doctor") return state.overlay.off === null ? [["y", "run"], ["t", "this host only"], ["esc", "cancel"]] : [["esc", "close"]];
  switch (state.screen) {
    case "home":
      return [[homeLayout(state.size).mode === "cards" ? "←↑↓→" : "↑↓", "select"], ["enter", "matrix"], ["r", "refresh"], ["d", "doctor"], ["P", "push"], ...COMMON];
    case "push":
      return [...pushHints(state), ["P", state.push.phase === "running" ? "watch" : "review a push"], ["esc", "home"], ...COMMON];
    case "matrix":
      return [["←↑↓→", "move"], ["enter", "skills"], ["d", "doctor"], ["r", "refresh"], ...COMMON];
    case "conflicts":
      return [["↑↓", "select"], ["r", "refresh"], ...COMMON];
    case "timeline":
      return [["↑↓", "commit"], ["pgup/dn", "scroll diff"], ["r", "refresh"], ...COMMON];
    case "secrets":
      return [["↑↓", "select"], ["v", "by name/host"], ["r", "refresh"], ...COMMON];
    case "context":
      return [["↑↓", "host"], ["r", "refresh"], ["d", "doctor"], ...COMMON];
    case "catalog":
      return state.catalog.typing ? [["type", "filter"], ["enter", "keep"], ["esc", "clear"]] : [["↑↓", "select"], ["f", "filter"], ["pgup/dn", "scroll"], ["r", "refresh"], ...COMMON];
  }
}

/** The keys of a push that is running or over: pick a host, run the push on it alone, open its conflicts. */
function pushHints(state: State): Hint[] {
  const p = state.push;
  if (p.phase !== "running" && p.phase !== "finished") return [];
  const lane = p.run.lanes[pickedLane(p)];
  return [["↑↓", "host"], ...(p.phase === "finished" ? ([["r", "push to it alone"]] as Hint[]) : []), ...(lane?.result === "conflict" ? ([["f", "its conflicts"]] as Hint[]) : [])];
}

function tooSmallMessage(c: Canvas, state: State): void {
  const lines = ["fleet bridge", "needs a window of", `${MIN_COLS} x ${MIN_ROWS} or more`, `now ${state.size.cols} x ${state.size.rows}`];
  lines.forEach((t, i) => c.text(Math.max(0, Math.floor((c.w - t.length) / 2)), Math.max(0, Math.floor((c.h - lines.length) / 2)) + i, t, i === 0 ? s.brandBold : s.sub, c.w));
}

/** The whole screen for a state. Pure: tests read it as text. */
export function drawApp(state: State, c: Canvas): void {
  if (tooSmall(state.size)) return tooSmallMessage(c, state);
  if (!state.boot.done) {
    drawBoot(c, state.boot.start === null ? 0 : state.now - state.boot.start);
    c.textRight(c.w - 2, c.h - 1, "any key to skip", s.faint);
    return;
  }
  drawHeader(c.sub(0, 0, c.w, 2), state);
  const body = c.sub(0, BODY_TOP, c.w, bodyHeight(state.size));
  if (state.screen === "home") drawHome(body, state);
  else if (state.screen === "matrix") drawMatrix(body, state);
  else if (state.screen === "push") drawPush(body, state);
  else if (state.screen === "conflicts") drawConflicts(body, state);
  else if (state.screen === "timeline") drawTimeline(body, state);
  else if (state.screen === "secrets") drawSecrets(body, state);
  else if (state.screen === "context") drawContext(body, state);
  else drawCatalog(body, state);
  if (state.overlay) c.paint(0, 0, c.w, c.h - 1, { attr: DIM });
  drawFooter(c, c.h - 1, hints(state));
  if (state.fault !== null) c.text(1, c.h - 2, `a background task failed: ${state.fault}`.slice(0, c.w - 2), { fg: theme.warn });
  if (state.overlay?.kind === "help") drawHelp(c);
  if (state.overlay?.kind === "palette") drawPalette(c, state);
  if (state.overlay?.kind === "leave") drawLeave(c, state);
  if (state.overlay?.kind === "doctor") drawDoctor(c, state);
}
