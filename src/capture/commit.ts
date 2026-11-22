import { takeOver } from "../adopt.ts";
import type { TakenOver } from "../adopt.ts";
import type { EditOp } from "../edit/index.ts";
import { NeedsSecretError } from "../sops.ts";
import { outsideChanges, writeAndCommit } from "../ui/edits.ts";
import type { StagedSkills } from "../ui/edits.ts";

/** An item capture put in the config, which this machine then holds as it stands. */
export type Taken = { kind: "mcp" | "skill"; name: string };

export type Committed = { files: string[]; commit: string | null; taken: TakenOver };

/** What stops capture before it writes: the config repo has changes capture did not make. Null when it is clean. */
export function outsideProblem(configDir: string): string | null {
  const found = outsideChanges(configDir);
  return found.length === 0 ? null : "the config repo has changes of its own: commit or discard them first";
}

/**
 * Writes the edits, commits them with `message`, and then takes over what they gave this host, so the next apply has nothing to
 * do. The caller holds the push lock and has checked `outsideProblem`. Throws `WriteRefused` as `writeAndCommit` does, writing nothing.
 * With no edits (an item only to take over) nothing is committed.
 */
export function commitCapture(configDir: string, home: string, host: string, ops: readonly EditOp[], staged: StagedSkills, items: readonly Taken[], message: string): Committed {
  const written = ops.length === 0 ? { files: [], commit: null } : writeAndCommit(configDir, ops, message, { home, staged });
  let taken: TakenOver;
  try {
    taken = takeOver(configDir, home, host, [...items]);
  } catch (error) {
    // A secret this machine cannot read now, or an apply that is running: the files are committed, and apply takes it from here.
    const why = error instanceof NeedsSecretError ? error.message.replace(/^fleet: /, "") : (error as Error).message.split("\n")[0]!;
    taken = { adopted: [], rewrites: [], problems: [`not taken over: ${why}`] };
  }
  return { ...written, taken };
}
