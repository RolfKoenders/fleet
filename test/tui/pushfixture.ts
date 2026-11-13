import { createApp } from "../../src/tui/app.ts";
import type { Msg, State } from "../../src/tui/app.ts";
import { Headless } from "../../src/tui/headless.ts";
import { loadModel } from "../../src/tui/model.ts";
import type { FleetEvent } from "../../src/events.ts";
import type { PreviewResult, Pusher } from "../../src/tui/pusher.ts";
import type { PushEnd } from "../../src/pushrun.ts";
import { cannedProbe, makeConfig, SIZE } from "./fixture.ts";

const repos = (files: { status: string; path: string }[], flagged: string[]) => [
  { shown: "~/.local/share/fleet/sources/mine", branch: "main", ahead: 0, behind: 0, files: [], flagged: [] },
  { shown: "/home/me/config", branch: "main", ahead: 1, behind: 0, files, flagged },
];
const CLEAN_FILES = [{ status: "M", path: "catalog/skills.yaml" }, { status: "??", path: "notes.md" }];
const plan = ["create ~/.claude/skills/triage -> /cfg/skills/triage", "update mcpServers.docs"];

export const PREVIEW: PreviewResult = { ok: true, preview: { code: "ok", plan, repos: repos(CLEAN_FILES, []) } };

/** The same, with a file that looks like a plaintext secret among the changes. */
export const PREVIEW_SECRET: PreviewResult = { ok: true, preview: { code: "ok", plan, repos: repos([...CLEAN_FILES, { status: "??", path: ".env.local" }], [".env.local"]) } };

/** A pusher the test drives: `emit` sends an event as the child would, `end` finishes the push. */
export type FakePusher = { runs: number; messages: (string | undefined)[]; hosts: (string | undefined)[]; previews: number; emit: (e: FleetEvent) => void; end: (e: PushEnd) => void; pusher: Pusher };

export function fakePusher(preview: PreviewResult = PREVIEW): FakePusher {
  const f: FakePusher = {
    runs: 0,
    messages: [],
    hosts: [],
    previews: 0,
    emit: (_: FleetEvent): void => {},
    end: (_: PushEnd): void => {},
    pusher: {
      async preview() {
        f.previews++;
        return preview;
      },
      run(onEvent: (e: FleetEvent) => void, message?: string, host?: string) {
        f.runs++;
        f.messages.push(message);
        f.hosts.push(host);
        f.emit = onEvent;
        return new Promise<PushEnd>((resolve) => (f.end = resolve));
      },
      running: () => (f.runs > 0 ? "applying" : null),
      whenDone: () => null,
    } as Pusher,
  };
  return f;
}

export const tick = () => new Promise((r) => setImmediate(r));

export async function pushBridge(pusher: Pusher | undefined, size = SIZE): Promise<Headless<State, Msg>> {
  const model = loadModel(makeConfig(), "laptop");
  const h = new Headless(createApp({ model, probe: cannedProbe(), ...(pusher ? { pusher } : {}), motion: true, boot: false }), size);
  await h.settle();
  h.advance(100);
  return h;
}

export const ok = (hosts: [string, number][], over: Partial<PushEnd> = {}): PushEnd => ({
  exit: 0,
  code: "ok",
  conflicts: {},
  messages: [],
  hosts: hosts.map(([host, changes]) => ({ host, result: host === "edge" ? "timer" : "ok", changes })),
  ...over,
});

/** Plays a push up to the point where server is writing. */
export async function playToMiddle(h: Headless<State, Msg>, f: FakePusher): Promise<void> {
  h.press("P");
  await h.settle();
  h.advance(33);
  h.type("push").press("enter");
  await tick();
  f.emit({ event: "stage", host: null, stage: "validate" });
  f.emit({ event: "hosts", hosts: [{ host: "laptop", via: "local" }, { host: "box", via: "ssh" }, { host: "edge", via: "timer" }, { host: "server", via: "ssh" }] });
  f.emit({ event: "stage", host: null, stage: "publish", of: 2 });
  f.emit({ event: "step", host: null, step: "publish", target: "/home/me/config", n: 2, of: 2 });
  f.emit({ event: "stage", host: null, stage: "apply", of: 4 });
  f.emit({ event: "host", host: "laptop", state: "start" });
  f.emit({ event: "host", host: "laptop", state: "done", result: "ok", changes: 3 });
  f.emit({ event: "host", host: "box", state: "start" });
  f.emit({ event: "host", host: "box", state: "done", result: "ok", changes: 2 });
  f.emit({ event: "host", host: "edge", state: "start" });
  f.emit({ event: "host", host: "edge", state: "done", result: "timer", changes: 0 });
  f.emit({ event: "host", host: "server", state: "start" });
  f.emit({ event: "stage", host: "server", stage: "write", of: 12 });
  f.emit({ event: "step", host: "server", step: "write-link", target: "~/.claude/skills/triage", n: 5, of: 12 });
  h.advance(100);
}
