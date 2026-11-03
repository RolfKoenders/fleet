// Renders the real TUI into frame data for the landing page: node site/export.ts [out.js]
// Run it with a throwaway HOME (npm run site does). Every frame is drawn by the same code the terminal runs.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Buffer, Canvas } from "../src/tui/buffer.ts";
import { drawBoot } from "../src/tui/views/boot.ts";
import { bridgeFor, makeConfig, ok } from "../test/tui/fixture.ts";
import { fakePusher, ok as pushOk, pushBridge, tick } from "../test/tui/pushfixture.ts";
import type { Headless } from "../src/tui/headless.ts";

type Span = [text: string, fg: number, bg: number, attr: number];
type Frame = { cols: number; rows: number; lines: Span[][] };

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

// The boot animation in slow motion: sampled every 20 ms and played at 30 frames a second, so it takes about
// 2.5 s instead of the terminal's 1.5 s. On a page it has to catch an eye that is still landing.
const boot: Frame[] = [];
for (let t = 0; t <= 1500; t += 20) {
  const buf = new Buffer(39, 10);
  drawBoot(new Canvas(buf), t);
  boot.push(encode(buf));
}

const SIZE = { cols: 104, rows: 27 };
const snap = (h: Headless<any, any>) => encode(h.buffer());

// Bridge screens, on the same made-up hosts the tests use.
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
      { kind: "link" as const, path: "~/.claude/CLAUDE.md", detail: "~/.claude/CLAUDE.md is a file, not a link to ~/fleet-config/config/AGENTS.md", fix: "Move or delete it (rm ~/.claude/CLAUDE.md), then run 'fleet apply'. To keep its content, copy it to ~/fleet-config/config/AGENTS.md first." },
      { kind: "key" as const, path: "~/.claude.json mcpServers.docs", detail: "mcpServers.docs was changed outside fleet, or by a tool", fix: "claude mcp remove --scope user docs" },
    ],
  },
};
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

// A push, played at 30 frames a second from the review to the last host. The fake pusher answers at once, so
// the pauses here are paced for someone watching a web page, a little slower than a real push.
const f = fakePusher();
const p = await pushBridge(f.pusher, SIZE);
const push: Frame[] = [];
const play = (ms: number) => {
  for (let left = ms; left > 0; left -= 33) {
    p.advance(33);
    push.push(snap(p));
  }
};
p.press("P");
await p.settle();
play(2200);
const typing = (text: string) => {
  for (const ch of text) {
    p.type(ch);
    play(90);
  }
  play(700);
};
p.press("tab");
typing("Add the triage skill");
p.press("tab");
typing("push");
p.press("enter");
await tick();
f.emit({ event: "stage", host: null, stage: "validate" });
play(800);
f.emit({ event: "hosts", hosts: [{ host: "laptop", via: "local" }, { host: "box", via: "ssh" }, { host: "edge", via: "timer" }, { host: "server", via: "ssh" }] });
f.emit({ event: "stage", host: null, stage: "publish", of: 2 });
f.emit({ event: "step", host: null, step: "publish", target: "~/fleet-config", n: 1, of: 2 });
play(700);
f.emit({ event: "step", host: null, step: "publish", target: "~/fleet-config", n: 2, of: 2 });
f.emit({ event: "stage", host: null, stage: "apply", of: 4 });
play(500);
const apply = (host: string, steps: number, result = "ok") => {
  f.emit({ event: "host", host, state: "start" });
  play(400);
  if (steps > 0) f.emit({ event: "stage", host, stage: "write", of: steps });
  for (let n = 1; n <= steps; n++) {
    f.emit({ event: "step", host, step: "write-link", target: "~/.claude/skills/triage", n, of: steps });
    play(260);
  }
  f.emit({ event: "host", host, state: "done", result, changes: steps });
  play(500);
};
apply("laptop", 3);
apply("box", 2);
apply("edge", 0, "timer");
apply("server", 4);
f.end(pushOk([["laptop", 3], ["box", 2], ["edge", 0], ["server", 4]]));
await p.settle();
play(1000);

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
const data = { boot: boot.map(pack), screens: Object.fromEntries(Object.entries(screens).map(([k, v]) => [k, pack(v)])), push: push.map(pack), rows };
const out = process.argv[2] ?? join(import.meta.dirname, "frames.js");
writeFileSync(out, `// Generated by site/export.ts from the real TUI. Do not edit.\nwindow.FLEET_FRAMES = ${JSON.stringify(data)};\n`);
console.log(`wrote ${out}: ${boot.length} boot frames, ${Object.keys(screens).length} screens, ${push.length} push frames, ${rows.length} distinct rows`);
