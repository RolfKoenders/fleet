import { mix } from "./color.ts";

/** The look of the bridge, taken from the logo: fleet green, a cool grey, near-white text, on ink. */
const dark = {
  brand: 0x3fb950,
  brandBright: 0x7ee787,
  brandDeep: 0x196c2e,
  text: 0xe6edf3,
  sub: 0xb1bac4,
  muted: 0x7d8590,
  faint: 0x484f58,
  border: 0x30363d,
  surface: 0x161b22,
  raised: 0x1f2630,
  selected: 0x16301f,
  ok: 0x3fb950,
  warn: 0xd29922,
  bad: 0xf85149,
  info: 0x58a6ff,
  /** Marks something a host file added itself, against one it took from the defaults. */
  host: 0x79c0ff,
} as const;

/** The same roles for a light terminal, chosen with FLEET_THEME=light. Dark is the design; this is a best effort. */
const light: Record<keyof typeof dark, number> = {
  brand: 0x1a7f37, brandBright: 0x116329, brandDeep: 0xaceebb, text: 0x1f2328, sub: 0x424a53, muted: 0x656d76,
  faint: 0xafb8c1, border: 0xd0d7de, surface: 0xf6f8fa, raised: 0xeaeef2, selected: 0xdafbe1,
  ok: 0x1a7f37, warn: 0x9a6700, bad: 0xcf222e, info: 0x0969da, host: 0x0550ae,
};

export const theme: Record<keyof typeof dark, number> = process.env.FLEET_THEME === "light" ? light : dark;

/** Colour across a wordmark, from fleet green to a cool teal. */
export const wordmark = (i: number, n: number): number => mix(theme.brandBright, theme.info, n <= 1 ? 0 : i / (n - 1) * 0.7);

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** One frame of the spinner at time `now` (ms). Still when there is no motion. */
export const spinner = (now: number, motion: boolean): string => (motion ? SPINNER[Math.floor(now / 80) % SPINNER.length]! : "…");
