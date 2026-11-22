// The only place the exit codes' names and numbers are written.
// 127, "no usable Node", belongs to bin/fleet because it happens before this code runs.
export const EXIT = {
  ok: 0,
  error: 1,
  invalid: 2,
  conflict: 3,
  unreachable: 4,
  "needs-secret": 5,
  "missing-prerequisite": 6,
  locked: 7,
  unhealthy: 8,
} as const;

export type ExitName = keyof typeof EXIT;

/** The name of an exit code, `error` for none: a child that could not run has no code. */
export const codeName = (exit: number | null): string => (exit === null ? "error" : (Object.entries(EXIT).find(([, n]) => n === exit)?.[0] ?? "error"));
