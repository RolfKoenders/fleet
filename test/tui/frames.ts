// Prints frames of the bridge as plain text: node test/tui/frames.ts [WxH]
import { bridgeFor, cloneSource, makeConfig, makeRepo, ok } from "./fixture.ts";

const [w, h] = (process.argv[2] ?? "100x32").split("x").map(Number) as [number, number];
const canned = {
  hosts: {
    laptop: ok({ pending: 2, tools: { claude: "2.1.4", opencode: null, sops: "3.13.3", node: "22.18.0", t3: null } }),
    server: ok({ conflicts: 2, pending: 1, applied: { at: "x", ageSeconds: 86400 * 3, config: null }, timer: "inactive" }),
    box: { result: "unreachable" as const, status: null, detail: "ssh: connect to host box port 22: Connection timed out" },
    edge: { result: "timer" as const, status: null },
  },
  conflicts: { ok: true as const, items: [{ kind: "link" as const, path: "~/.claude/CLAUDE.md", detail: "~/.claude/CLAUDE.md is a file, not a link to /repo/config/AGENTS.md", fix: "Move or delete it (rm ~/.claude/CLAUDE.md), then run 'fleet apply'. To keep its content, copy it to /repo/config/AGENTS.md first." }, { kind: "key" as const, path: "~/.claude.json mcpServers.docs", detail: "mcpServers.docs was changed outside fleet, or by a tool", fix: "claude mcp remove --scope user docs" }] },
};
const b = await bridgeFor(makeConfig(), canned, { size: { cols: w, rows: h } });
const show = (title: string) => console.log(`\n=== ${title} ===\n${b.frame()}`);
show("home");
b.press("2", "down", "right");
show("matrix");
b.press("enter");
show("matrix expanded");
b.press("3");
show("conflicts");
b.press("ctrl+k");
b.type("se");
show("palette");
b.press("escape", "?");
show("help");

// The browsing screens, on a repo with a history and one cloned skill source.
const r = makeRepo();
cloneSource(r.home);
const applied = (config: string) => ok({ applied: { at: "x", ageSeconds: 5, config } });
const hosts = {
  laptop: applied(r.shas[4]!),
  server: applied(r.shas[2]!.slice(0, 12)),
  box: { result: "unreachable" as const, status: null, detail: "x" },
  edge: { result: "timer" as const, status: null },
};
const repo = await bridgeFor(r.dir, { hosts }, { home: r.home, size: { cols: w, rows: h } });
const showRepo = (title: string) => console.log(`\n=== ${title} ===\n${repo.frame()}`);
repo.press("4");
await repo.settle();
repo.advance(100);
showRepo("timeline");
repo.press("down", "down");
await repo.settle();
repo.advance(100);
showRepo("timeline, a secrets commit");
repo.press("5");
showRepo("secrets");
repo.press("v", "down", "down");
showRepo("secrets by host");
repo.press("6", "f");
repo.type("rev");
showRepo("catalog filtered");
