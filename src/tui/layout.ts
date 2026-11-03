import type { Size } from "./terminal.ts";

export const MIN_COLS = 30;
export const MIN_ROWS = 8;
export const CARD_H = 9;
const CARD_MIN_W = 38;
const CARD_MAX_W = 52;
const HEADER = 2;
const FOOTER = 1;

export const tooSmall = (size: Size): boolean => size.cols < MIN_COLS || size.rows < MIN_ROWS;

export type HomeLayout = {
  mode: "cards" | "list";
  /** Cards across, and the width of each. */
  cols: number;
  cardW: number;
  /** Where the grid starts, relative to the body, and how many card rows fit under it. */
  top: number;
  visibleRows: number;
  bodyH: number;
};

export function homeLayout(size: Size): HomeLayout {
  const bodyH = Math.max(0, size.rows - HEADER - FOOTER);
  const top = 2;
  if (size.cols < CARD_MIN_W + 2 || bodyH - top < CARD_H) {
    return { mode: "list", cols: 1, cardW: size.cols, top, visibleRows: Math.max(1, bodyH - top), bodyH };
  }
  const cols = Math.max(1, Math.floor((size.cols - 2 + 1) / (CARD_MIN_W + 1)));
  const cardW = Math.min(CARD_MAX_W, Math.floor((size.cols - 2 - (cols - 1)) / cols));
  return { mode: "cards", cols, cardW, top, visibleRows: Math.max(1, Math.floor((bodyH - top) / CARD_H)), bodyH };
}

export const BODY_TOP = HEADER;
export const bodyHeight = (size: Size): number => Math.max(0, size.rows - HEADER - FOOTER);

/** The first row of a scrolling list that keeps `selected` in view. */
export const firstVisible = (selected: number, visible: number): number => (selected < visible ? 0 : selected - visible + 1);
