// The recorder: drives the bridge on the test fixture and returns the text of site/frames.js.
//
// To add a clip: write a function that plays the bridge and returns its frames (a list for an animation, one
// frame per name for stills), then add it to `record` below. Everything is fixed, so two runs give the same
// bytes on any machine: the bridge runs on a simulated clock at a fixed size, on made-up hosts and paths.
import { Buffer, Canvas } from "../../src/tui/buffer.ts";
import { CONFIG_DIR } from "../../src/init.ts";
import { drawBoot } from "../../src/tui/views/boot.ts";
import { createApp } from "../../src/tui/app.ts";
import { Headless } from "../../src/tui/headless.ts";
import { loadModel } from "../../src/tui/model.ts";
import type { HostResult } from "../../src/tui/probe.ts";
import { bridgeFor, cannedProbe, makeConfig, ok } from "../../test/tui/fixture.ts";
import type { Canned } from "../../test/tui/fixture.ts";
import { fakePusher, ok as pushOk, pushBridge, tick } from "../../test/tui/pushfixture.ts";

type Span = [text: string, fg: number, bg: number, attr: number];
type Frame = { cols: number; rows: number; lines: Span[][] };

/** Every bridge clip is this size; the page scales it to fit. */
const SIZE = { cols: 104, rows: 27 };
/** The page plays animations at this many frames a second. */
const FRAME_MS = 33;

/** A buffer as rows of styled runs: the smallest shape that still draws every cell as the terminal would. */
function encode(b: Buffer): Frame {
  const lines: Span[][] = [];
  for (let y = 0; y < b.rows; y++) {
    const row: Span[] = [];
    for (let x = 0; x < b.cols; x++) {
      const i = y * b.cols + x;
      const ch = b.chars[i]!;
      if (ch === "") continue;
      const last = row[row.length - 1];
      if (last && last[1] === b.fg[i] && last[2] === b.bg[i] && last[3] === b.attr[i]) last[0] += ch;
      else row.push([ch, b.fg[i]!, b.bg[i]!, b.attr[i]!]);
    }
    const end = row[row.length - 1];
    if (end && end[2] === -1 && end[3] === 0) {
      end[0] = end[0].replace(/ +$/, "");
      if (end[0] === "") row.pop();
    }
    lines.push(row);
  }
  return { cols: b.cols, rows: b.rows, lines };
}

const snap = (h: Headless<any, any>) => encode(h.buffer());

/** Advances the bridge `ms` at the page's frame rate, adding a frame to `into` after each step. */
function play(h: Headless<any, any>, into: Frame[], ms: number): void {
  for (let left = ms; left > 0; left -= FRAME_MS) {
    h.advance(FRAME_MS);
    into.push(snap(h));
  }
}

/** The config repo as `fleet init` clones it by default. */
const config = `~/${CONFIG_DIR}`;

/** The hosts the tests use, with a conflict list that shows both kinds of conflict. */
const canned = {
  hosts: {
    laptop: ok({ pending: 2, tools: { claude: "2.1.4", opencode: null, sops: "3.13.3", node: "22.18.0", t3: null } }),
    server: ok({ conflicts: 2, pending: 1, applied: { at: "x", ageSeconds: 86400 * 3, config: null }, timer: "inactive" }),
    box: { result: "unreachable" as const, status: null, detail: "ssh: connect to host box port 22: Connection timed out" },
    edge: { result: "timer" as const, status: null },
  },
  conflicts: {
    ok: true as const,
    items: [
      { kind: "link" as const, path: "~/.claude/CLAUDE.md", detail: `~/.claude/CLAUDE.md is a file, not a link to ${config}/config/AGENTS.md`, fix: `Move or delete it (rm ~/.claude/CLAUDE.md), then run 'fleet apply'. To keep its content, copy it to ${config}/config/AGENTS.md first.` },
      { kind: "key" as const, path: "~/.claude.json mcpServers.docs", detail: "mcpServers.docs was changed outside fleet, or by a tool", fix: "claude mcp remove --scope user docs" },
    ],
  },
} satisfies Canned;

/** The boot animation in slow motion: sampled every 20 ms and played at 30 frames a second, so it takes about 2.5 s instead of the terminal's 1.5 s. On a page it has to catch an eye that is still landing. */
function recordBoot(): Frame[] {
  const frames: Frame[] = [];
  for (let t = 0; t <= 1500; t += 20) {
    const buf = new Buffer(39, 10);
    drawBoot(new Canvas(buf), t);
    frames.push(encode(buf));
  }
  return frames;
}

/** Still screens, one after another in one session, so a screen is reached by the keys a person would press. */
async function recordScreens(): Promise<Record<string, Frame>> {
  const b = await bridgeFor(makeConfig(), canned, { size: SIZE });
  b.advance(400);
  const screens: Record<string, Frame> = {};
  screens.home = snap(b);
  b.press("2", "down", "right", "enter");
  b.advance(200);
  screens.matrix = snap(b);
  b.press("3");
  b.advance(200);
  screens.conflicts = snap(b);
  b.press("ctrl+k");
  b.type("doc");
  b.advance(200);
  screens.palette = snap(b);
  b.press("escape", "1", "?");
  b.advance(200);
  screens.help = snap(b);
  return screens;
}

/**
 * Home as a second run finds it: the cards of server and box are what the last run saw, marked as seen 2h ago
 * and not live, until each host answers. The answers come one at a time, server live and box unreachable.
 */
async function recordHomeFill(): Promise<Frame[]> {
  const seen = (pending: number): { result: HostResult; agoSeconds: number } => ({
    result: ok({ pending, applied: { at: "x", ageSeconds: 86400 + 7200, config: null } }),
    agoSeconds: 2 * 3600,
  });
  // A host other than this one answers when its gate is opened, not before.
  const gates = new Map<string, () => void>();
  const answers = cannedProbe(canned);
  const probe = {
    ...answers,
    host: (host: { name: string; self: boolean }, signal: AbortSignal) =>
      host.self ? answers.host(host as never, signal) : new Promise<void>((open) => gates.set(host.name, open)).then(() => answers.host(host as never, signal)),
  };
  const app = createApp({ model: loadModel(makeConfig(), "laptop"), probe, motion: true, boot: false, cached: { server: seen(5), box: seen(0) } });
  const b = new Headless(app, SIZE);
  await tick();
  const frames: Frame[] = [];
  const answer = async (host: string) => {
    gates.get(host)!();
    await tick();
  };
  play(b, frames, 1800);
  await answer("server");
  play(b, frames, 1500);
  await answer("box");
  play(b, frames, 1200);
  return frames;
}

/**
 * A push, played from the review to the last host. The fake pusher answers at once, so the pauses here are
 * paced for someone watching a web page, a little slower than a real push.
 */
async function recordPush(): Promise<Frame[]> {
  const f = fakePusher();
  const p = await pushBridge(f.pusher, SIZE);
  const frames: Frame[] = [];
  p.press("P");
  await p.settle();
  play(p, frames, 2200);
  const typing = (text: string) => {
    for (const ch of text) {
      p.type(ch);
      play(p, frames, 90);
    }
    play(p, frames, 700);
  };
  p.press("tab");
  typing("Add the triage skill");
  p.press("tab");
  typing("push");
  p.press("enter");
  await tick();
  f.emit({ event: "stage", host: null, stage: "validate" });
  play(p, frames, 800);
  f.emit({ event: "hosts", hosts: [{ host: "laptop", via: "local" }, { host: "box", via: "ssh" }, { host: "edge", via: "timer" }, { host: "server", via: "ssh" }] });
  f.emit({ event: "stage", host: null, stage: "publish", of: 2 });
  f.emit({ event: "step", host: null, step: "publish", target: config, n: 1, of: 2 });
  play(p, frames, 700);
  f.emit({ event: "step", host: null, step: "publish", target: config, n: 2, of: 2 });
  f.emit({ event: "stage", host: null, stage: "apply", of: 4 });
  play(p, frames, 500);
  const apply = (host: string, steps: number, result = "ok") => {
    f.emit({ event: "host", host, state: "start" });
    play(p, frames, 400);
    if (steps > 0) f.emit({ event: "stage", host, stage: "write", of: steps });
    for (let n = 1; n <= steps; n++) {
      f.emit({ event: "step", host, step: "write-link", target: "~/.claude/skills/triage", n, of: steps });
      play(p, frames, 260);
    }
    f.emit({ event: "host", host, state: "done", result, changes: steps });
    play(p, frames, 500);
  };
  apply("laptop", 3);
  apply("box", 2);
  apply("edge", 0, "timer");
  apply("server", 4);
  f.end(pushOk([["laptop", 3], ["box", 2], ["edge", 0], ["server", 4]]));
  await p.settle();
  play(p, frames, 1000);
  return frames;
}

/** Records every clip and returns the text of site/frames.js, with a one line summary for the person running it. */
export async function record(): Promise<{ text: string; summary: string }> {
  const boot = recordBoot();
  const screens = await recordScreens();
  const push = await recordPush();
  const homeFill = await recordHomeFill();

  // Rows repeat a great deal from frame to frame, so each frame keeps only indexes into one table of rows.
  const rows: Span[][] = [];
  const seen = new Map<string, number>();
  const pack = (fr: Frame) => ({
    cols: fr.cols,
    rows: fr.rows,
    lines: fr.lines.map((row) => {
      const key = JSON.stringify(row);
      let i = seen.get(key);
      if (i === undefined) seen.set(key, (i = rows.push(row) - 1));
      return i;
    }),
  });
  const data = {
    boot: boot.map(pack),
    screens: Object.fromEntries(Object.entries(screens).map(([name, frame]) => [name, pack(frame)])),
    push: push.map(pack),
    homeFill: homeFill.map(pack),
    rows,
  };
  const text = `// Frames recorded from the fleet bridge by npm run site:frames. Do not edit.\n// Static data: the site never imports TUI code, so the two can change apart.\nwindow.FLEET_FRAMES = ${JSON.stringify(data)};\n`;
  const summary = `${boot.length} boot frames, ${Object.keys(screens).length} screens, ${push.length} push frames, ${homeFill.length} home frames, ${rows.length} distinct rows`;
  return { text, summary };
}
