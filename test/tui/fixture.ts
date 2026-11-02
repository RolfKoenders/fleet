import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../src/tui/app.ts";
import type { Msg, State } from "../../src/tui/app.ts";
import { Headless } from "../../src/tui/headless.ts";
import { loadModel } from "../../src/tui/model.ts";
import type { ConflictsResult, HostResult, Probe } from "../../src/tui/probe.ts";
import type { StatusFields } from "../../src/status.ts";
import { repoRoot, tempDir } from "../helpers.ts";

/** A config repo with four hosts: `laptop` (this one), `server` and `box` over ssh, and `edge` on its own timer. */
export function makeConfig(): string {
  const dir = tempDir("fleet-bridge-config-");
  cpSync(join(repoRoot, "examples"), dir, { recursive: true });
  const host = (name: string, text: string) => writeFileSync(join(dir, "hosts", `${name}.yaml`), text);
  host("server", "ssh: me@server\nexclude: [core]\nmcp:\n  exclude: [docs]\n");
  host("box", "ssh: me@box\nbundles: [extra]\nmcp:\n  include: [tracker-local]\n");
  host("edge", "mcp:\n  include: [tracker]\n");
  mkdirSync(join(dir, "hosts"), { recursive: true });
  return dir;
}

export const status = (over: Partial<StatusFields> = {}): StatusFields => ({
  repos: { fleet: { branch: "main", sha: "3f9a1c2d4e5f60718293a4b5c6d7e8f901234567", clean: true, ahead: 0, behind: 0 } },
  applied: { at: "2026-10-30T10:00:00Z", ageSeconds: 720, config: "c0ffee1" },
  timer: "active",
  pending: 0,
  conflicts: 0,
  tools: { claude: "2.1.4", opencode: "1.4.2", sops: "3.13.3", node: "22.18.0", t3: "0.1.0" },
  ...over,
});

export const ok = (over: Partial<StatusFields> = {}): HostResult => ({ result: "ok", status: status(over) });

export type Canned = { hosts?: Record<string, HostResult | "never">; conflicts?: ConflictsResult };

/** A probe that answers from a table. A host marked "never" is still being asked. */
export function cannedProbe(canned: Canned = {}): Probe {
  return {
    async host(host, signal) {
      const r = canned.hosts?.[host.name];
      if (r === "never") return new Promise<HostResult>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      return r ?? ok();
    },
    async conflicts() {
      return canned.conflicts ?? { ok: true, items: [] };
    },
  };
}

export const SIZE = { cols: 100, rows: 32 };

export async function bridgeFor(configDir: string, canned: Canned = {}, options: { size?: { cols: number; rows: number }; motion?: boolean; boot?: boolean; settle?: boolean } = {}): Promise<Headless<State, Msg>> {
  const model = loadModel(configDir, "laptop");
  const app = createApp({ model, probe: cannedProbe(canned), motion: options.motion ?? true, boot: options.boot ?? false });
  const h = new Headless(app, options.size ?? SIZE);
  if (options.settle !== false) await h.settle();
  h.advance(100);
  return h;
}
