// Records the landing page's terminal clips from the real bridge: node scripts/site-frames.ts [out.js]
// The site loads only the file this writes. The tests fail when site/frames.js is not what this records now.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { record } from "./site-frames/record.ts";

const out = process.argv[2] ?? join(import.meta.dirname, "../site/frames.js");
const { text, summary } = await record();
writeFileSync(out, text);
console.log(`wrote ${out}: ${summary}`);
