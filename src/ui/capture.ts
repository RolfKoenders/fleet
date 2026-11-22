import { takeOver } from "../adopt.ts";
import type { TakenOver } from "../adopt.ts";
import { agentsOnHost } from "../hostagents.ts";
import { readHostName } from "../host.ts";
import { build, takenSecrets } from "../capture/plan.ts";
import type { Decision, Scope, SecretPick } from "../capture/plan.ts";
import { scanMachine } from "../capture/scan.ts";
import type { Item } from "../capture/scan.ts";
import { scanView } from "../capture/view.ts";
import type { ScanView } from "../capture/view.ts";
import { SECRET_NAME } from "../edit/index.ts";
import type { EditOp } from "../edit/index.ts";
import { BadRequest } from "./request.ts";
import type { StagedSkills } from "./edits.ts";

/**
 * The Capture screen's side of the page: what this machine has that is not from config (names and shapes, never a value), and the
 * edits one answer about one item turns into. A secret's value is read from this machine's agent file here, encrypted by the code
 * the page's Set uses, and gone: the answer holds ciphertext and `secret:NAME`. The page never sends a value and never gets one.
 */

export type CaptureDoc = ScanView & { host: string | null };

/** What this machine has, for the host the page runs on. Clones a skill source it is missing, as `fleet diff` does. */
export function captureDoc(configDir: string, home: string): CaptureDoc {
  const host = readHostName(home);
  if (host === null) return { host: null, items: [], differs: [], notes: ["no host name is set on this machine"] };
  const scan = scanMachine(configDir, host, home, agentsOnHost(configDir, host, home));
  return { host, ...scanView(scan, takenSecrets(configDir, host, [])) };
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KEY = /^[^\u0000-\u001f]{1,200}$/;

export type CaptureAnswer = { kind: "mcp" | "skill"; name: string; action: "add" | "takeover" | "ignore"; scope: Scope; variant: number; onlyHad: boolean; secrets: SecretPick[]; bundle: string };

/** The body of a build request, checked. A message names the field and never repeats what it held. */
export function answerOf(body: unknown): CaptureAnswer {
  const o = typeof body === "object" && body !== null && !Array.isArray(body) ? ((body as Record<string, unknown>).decision as Record<string, unknown> | undefined) : undefined;
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new BadRequest("decision must be an object");
  if (o.kind !== "mcp" && o.kind !== "skill") throw new BadRequest("decision.kind must be mcp or skill");
  if (typeof o.name !== "string" || !NAME.test(o.name) || o.name.length > 100) throw new BadRequest("decision.name must be a name");
  if (o.action !== "add" && o.action !== "takeover" && o.action !== "ignore") throw new BadRequest("decision.action must be add, takeover or ignore");
  const scope = o.scope ?? "host";
  if (scope !== "host" && scope !== "all") throw new BadRequest("decision.scope must be host or all");
  const variant = o.variant ?? 0;
  if (typeof variant !== "number" || !Number.isInteger(variant) || variant < 0 || variant > 50) throw new BadRequest("decision.variant must be a small whole number");
  if (o.onlyHad !== undefined && typeof o.onlyHad !== "boolean") throw new BadRequest("decision.onlyHad must be true or false");
  const secrets = o.secrets ?? [];
  const okSecrets = Array.isArray(secrets) && secrets.length <= 100 && secrets.every((s) => typeof s === "object" && s !== null && (s.where === "env" || s.where === "headers") && typeof s.key === "string" && KEY.test(s.key) && typeof s.name === "string" && SECRET_NAME.test(s.name) && s.name.length <= 100);
  if (!okSecrets) throw new BadRequest("decision.secrets must be a list of { where, key, name }");
  const bundle = o.bundle ?? "";
  if (typeof bundle !== "string" || (bundle !== "" && (!NAME.test(bundle) || bundle.length > 64))) throw new BadRequest("decision.bundle must be a bundle name");
  return { kind: o.kind, name: o.name, action: o.action, scope, variant, onlyHad: o.onlyHad === true, secrets: (secrets as SecretPick[]).map(({ where, key, name }) => ({ where, key, name })), bundle };
}

export type BuildOutcome = { refused: { status: number; code: string; message: string } } | { ops: EditOp[]; staged: StagedSkills; takeover: boolean; secrets: string[] };

/** The edits for one answer, after the ones the page holds. Nothing is written. */
export function buildAnswer(configDir: string, home: string, held: readonly EditOp[], staged: StagedSkills, answer: CaptureAnswer): BuildOutcome {
  const host = readHostName(home);
  if (host === null) return { refused: { status: 409, code: "no-host", message: "no host name is set on this machine" } };
  const scan = scanMachine(configDir, host, home, agentsOnHost(configDir, host, home));
  const item: Item | undefined = scan.items.find((i) => i.kind === answer.kind && i.name === answer.name);
  if (item === undefined) return { refused: { status: 404, code: "gone", message: `${answer.kind}:${answer.name} is no longer on this machine, or is from config now: read the screen again` } };
  let decision: Decision;
  if (answer.action === "ignore") decision = { item, action: "ignore" };
  else if (answer.action === "takeover") decision = { item, action: "takeover" };
  else if (item.kind === "mcp") decision = { item, action: "add", choice: { scope: answer.scope, variant: answer.variant, onlyHad: answer.onlyHad, secrets: answer.secrets } };
  else decision = { item, action: "add", choice: { scope: answer.scope, bundle: answer.bundle === "" ? (item.bundle ?? item.repo?.source ?? item.name) : answer.bundle } };
  const built = build(configDir, home, host, held, decision);
  if ("refused" in built) return { refused: { status: 422, code: "refused", message: built.refused } };
  return { ops: built.ops, staged: { ...staged, ...built.staged }, takeover: built.takeover, secrets: built.secrets };
}

/** `{kind, name}` pairs of a body, checked. */
export function itemsOf(body: unknown): { kind: "mcp" | "skill"; name: string }[] {
  const list = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).items : undefined;
  const ok = Array.isArray(list) && list.length <= 200 && list.every((i) => typeof i === "object" && i !== null && (i.kind === "mcp" || i.kind === "skill") && typeof i.name === "string" && NAME.test(i.name) && i.name.length <= 100);
  if (!ok) throw new BadRequest("items must be a list of { kind: mcp | skill, name }");
  return (list as { kind: "mcp" | "skill"; name: string }[]).map(({ kind, name }) => ({ kind, name }));
}

export function takeOverHere(configDir: string, home: string, items: { kind: "mcp" | "skill"; name: string }[]): TakenOver | { problem: string } {
  const host = readHostName(home);
  if (host === null) return { problem: "no host name is set on this machine" };
  try {
    return takeOver(configDir, home, host, items);
  } catch (error) {
    // A fixed word: what went wrong here may be about a secret.
    return { problem: (error as Error).name === "NeedsSecretError" ? "a secret of this entry cannot be read on this machine, so it was not taken over" : "it could not be taken over" };
  }
}
