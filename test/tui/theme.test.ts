import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { repoRoot } from "../helpers.ts";

const textColour = (theme: string | undefined): number => {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (theme !== undefined) env.FLEET_THEME = theme;
  const r = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(join(repoRoot, "src/tui/theme.ts"))}).then((m) => console.log(m.theme.text))`], { env, encoding: "utf8" });
  return Number(r.stdout.trim());
};

test("FLEET_THEME=light picks dark text for a light terminal, anything else keeps the dark theme", () => {
  assert.equal(textColour(undefined), 0xe6edf3);
  assert.equal(textColour("dark"), 0xe6edf3);
  assert.equal(textColour("light"), 0x1f2328);
});
