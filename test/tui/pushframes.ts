// Prints frames of the push screen as plain text: node test/tui/pushframes.ts [WxH]
import { fakePusher, ok, playToMiddle, pushBridge } from "./pushfixture.ts";

const [w, h] = (process.argv[2] ?? "100x30").split("x").map(Number) as [number, number];
const f = fakePusher();
const b = await pushBridge(f.pusher, { cols: w, rows: h });
b.press("P");
await b.settle();
b.advance(33);
console.log(`\n=== review ===\n${b.frame()}`);
b.press("escape");
await playToMiddle(b, f);
console.log(`\n=== mid-run ===\n${b.frame()}`);
b.advance(200);
console.log(`\n=== mid-run, 200 ms later ===\n${b.frame()}`);
f.emit({ event: "host", host: "server", state: "done", result: "ok", changes: 4 });
f.end(ok([["laptop", 3], ["box", 2], ["edge", 0], ["server", 4]]));
await b.settle();
b.advance(100);
console.log(`\n=== end ===\n${b.frame()}`);
