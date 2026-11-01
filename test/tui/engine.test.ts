import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer as Frame, Canvas, paintDiff } from "../../src/tui/buffer.ts";
import { colorParams, detectLevel, mix } from "../../src/tui/color.ts";
import { InputParser, keyFromLabel, keyLabel } from "../../src/tui/input.ts";
import type { Input } from "../../src/tui/input.ts";
import { stringWidth, truncate, wrap } from "../../src/tui/width.ts";
import { Terminal, SYNC_QUERY } from "../../src/tui/terminal.ts";
import { PassThrough } from "node:stream";

const keys = (inputs: Input[]) => inputs.map((i) => (i.kind === "key" ? keyLabel(i.key) : i.kind));

test("width: wide characters take two cells, combining marks none, text is cut on a cell boundary", () => {
  assert.equal(stringWidth("abc"), 3);
  assert.equal(stringWidth("日本"), 4);
  assert.equal(stringWidth("é"), 1);
  assert.equal(stringWidth("👍"), 2);
  assert.equal(truncate("日本語です", 5), "日本…");
  assert.deepEqual(wrap("one two three", 7), ["one two", "three"]);
});

test("a wide character is drawn whole or not at all, and overwriting half of one blanks the rest", () => {
  const f = new Frame(5, 1);
  const c = new Canvas(f);
  c.text(0, 0, "日本語");
  assert.equal(f.toText(), "日本");
  c.text(1, 0, "x");
  assert.equal(f.toText(), " x本");
});

test("controls and reordering marks are never written into a cell", () => {
  const f = new Frame(40, 1);
  new Canvas(f).text(0, 0, "a\u001b]52;c;ZXZpbA==\u0007b‮c\u009b31m");
  assert.ok(!/[\u0000-\u001f\u007f-\u009f‮]/.test(f.toText()));
  assert.ok(f.chars.every((ch) => !/[\u001b\u0007]/.test(ch)));
});

test("a canvas clips to its window", () => {
  const f = new Frame(10, 3);
  const c = new Canvas(f).sub(2, 1, 4, 1);
  c.text(0, 0, "abcdefgh");
  c.text(0, 1, "never");
  assert.deepEqual(f.lines(), ["", "  abcd", ""]);
});

test("a diff writes only the cells that changed, and nothing when nothing did", () => {
  const a = new Frame(20, 3);
  new Canvas(a).text(0, 0, "hello world");
  const b = new Frame(20, 3);
  new Canvas(b).text(0, 0, "hello world");
  assert.equal(paintDiff(a, b, "truecolor"), "");
  new Canvas(b).text(6, 0, "W");
  const out = paintDiff(a, b, "truecolor");
  assert.ok(out.includes("\u001b[1;7H"));
  assert.ok(out.includes("W"));
  assert.ok(!out.includes("hello") && !out.includes("orld"));
  const whole = paintDiff(null, b, "truecolor");
  assert.ok(whole.startsWith("\u001b[0m\u001b[2J") && whole.includes("hello"));
});

test("colour levels: truecolor, 256 and 16 differ, none writes no colour at all", () => {
  const green = 0x3fb950;
  assert.equal(colorParams(green, "truecolor", false), "38;2;63;185;80");
  assert.match(colorParams(green, "256", false), /^38;5;\d+$/);
  assert.match(colorParams(green, "16", false), /^(3[0-7]|9[0-7])$/);
  assert.equal(colorParams(green, "none", false), "");
  const f = new Frame(3, 1);
  new Canvas(f).text(0, 0, "ab", { fg: green, bg: 0x161b22, attr: 1 });
  const none = paintDiff(null, f, "none");
  assert.ok(!/\u001b\[[0-9;]*(38|48|3[0-7]|9[0-7]|4[0-7])[;m]/.test(none.replace("\u001b[0m", "").replace(/\u001b\[0;1m/, "")), JSON.stringify(none));
  assert.ok(none.includes("\u001b[0;1m"), "attributes survive NO_COLOR");
  assert.notEqual(mix(0, 0xffffff, 0.5), 0);
});

test("detectLevel: NO_COLOR wins, COLORTERM gives truecolor, a dumb terminal gets none", () => {
  assert.equal(detectLevel({ NO_COLOR: "1", COLORTERM: "truecolor", TERM: "xterm" }, true), "none");
  assert.equal(detectLevel({ COLORTERM: "truecolor", TERM: "xterm" }, true), "truecolor");
  assert.equal(detectLevel({ TERM: "xterm-256color" }, true), "256");
  assert.equal(detectLevel({ TERM: "xterm" }, true), "16");
  assert.equal(detectLevel({ TERM: "dumb" }, true), "none");
  assert.equal(detectLevel({ TERM: "xterm-256color" }, false), "none");
});

test("input: arrows, ctrl keys, alt keys, tab, enter, text", () => {
  const p = new InputParser();
  assert.deepEqual(keys(p.feed("\u001b[A\u001b[B\u001b[C\u001b[D\u001bOA")), ["up", "down", "right", "left", "up"]);
  assert.deepEqual(keys(p.feed("\u000b\u0003\r\t\u007fq日")), ["ctrl+k", "ctrl+c", "enter", "tab", "backspace", "q", "日"]);
  assert.deepEqual(keys(p.feed("\u001b[1;5C\u001b[Z\u001b[3~\u001b[5~")), ["ctrl+right", "backtab", "delete", "pageup"]);
  assert.deepEqual(keys(p.feed("\u001bx")), ["alt+x"]);
});

test("input: a lone escape waits, then is the escape key; a sequence split in two is one key", () => {
  const p = new InputParser();
  assert.deepEqual(p.feed("\u001b"), []);
  assert.ok(p.waiting);
  assert.deepEqual(keys(p.flush()), ["escape"]);
  assert.deepEqual(p.feed("\u001b["), []);
  assert.deepEqual(keys(p.feed("A")), ["up"]);
  assert.deepEqual(p.feed("\u001b[9"), []);
  assert.deepEqual(p.flush(), [], "an unfinished sequence is dropped, not typed");
});

test("input: bracketed paste arrives as one paste, and unknown sequences are dropped", () => {
  const p = new InputParser();
  const got = p.feed("\u001b[200~line one\nline two\u001b[201~x");
  assert.deepEqual(got[0], { kind: "paste", text: "line one\nline two" });
  assert.deepEqual(keys(got.slice(1)), ["x"]);
  assert.deepEqual(p.feed("\u001b[999;9~\u001b[?25h"), []);
});

test("input: the answer to the mode query is a mode report, not keys", () => {
  const p = new InputParser();
  assert.deepEqual(p.feed("\u001b[?2026;2$y"), [{ kind: "mode", mode: 2026, state: 2 }]);
  const split = [...p.feed("\u001b[?20"), ...p.feed("26;0$"), ...p.feed("y")];
  assert.deepEqual(split, [{ kind: "mode", mode: 2026, state: 0 }]);
});

test("key labels round trip", () => {
  for (const label of ["ctrl+k", "down", "enter", "q", "?", "space", "escape", "shift+tab"]) assert.equal(keyLabel(keyFromLabel(label)), label);
});

function fakeTerminal(opts: { probeMs?: number } = {}) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const writes: string[] = [];
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  stdout.on("data", (d: Buffer) => writes.push(d.toString()));
  const inputs: Input[] = [];
  const term = new Terminal({ stdin, stdout }, { level: "truecolor", probeMs: opts.probeMs ?? 20, escapeMs: 5, onInput: (i) => inputs.push(i), onResize: () => {} });
  return { term, stdin, writes, inputs, out: () => writes.join("") };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("terminal: asks whether synchronized output is supported, uses it only after a yes, and the reply never reaches the input", async () => {
  const t = fakeTerminal();
  t.term.start();
  await wait(2);
  assert.ok(t.out().includes(SYNC_QUERY));
  assert.ok(t.out().includes("\u001b[?1049h"));
  const frame = new Frame(4, 1);
  new Canvas(frame).text(0, 0, "abc");
  t.term.draw(frame);
  await wait(2);
  assert.ok(!t.out().includes("\u001b[?2026h"), "not before the terminal has said yes");

  t.stdin.write("\u001b[?2026;2$y");
  await wait(10);
  assert.equal(t.term.syncSupported, true);
  assert.deepEqual(t.inputs, []);
  const next = new Frame(4, 1);
  new Canvas(next).text(0, 0, "xyz");
  t.term.draw(next);
  await wait(2);
  assert.ok(t.out().includes("\u001b[?2026h") && t.out().includes("\u001b[?2026l"));
  t.term.stop();
});

test("terminal: a terminal that never answers is treated as not supporting it, and a late answer is still kept out of the input", async () => {
  const t = fakeTerminal({ probeMs: 10 });
  t.term.start();
  await wait(40);
  assert.equal(t.term.syncSupported, false);
  t.stdin.write("\u001b[?2026;1$y");
  t.stdin.write("q");
  await wait(20);
  assert.deepEqual(t.inputs.map((i) => (i.kind === "key" ? i.key.text : i.kind)), ["q"]);
  assert.equal(t.term.syncSupported, true, "a late yes is honoured");
  t.term.stop();
});

test("terminal: stop puts the screen back once, and a second stop writes nothing", async () => {
  const t = fakeTerminal();
  t.term.start();
  t.term.stop();
  await wait(2);
  const after = t.out();
  assert.ok(after.includes("\u001b[?1049l") && after.includes("\u001b[?25h"));
  t.term.stop();
  await wait(2);
  assert.equal(t.out(), after);
});
