import { join } from "node:path";
import { parseSopsText } from "../edit/index.ts";
import type { Files } from "../edit/index.ts";
import { parseMcpCatalog } from "../mcp.ts";
import { secretNames } from "../template.ts";
import type { Model } from "../tui/model.ts";
import { parseFile } from "../yamlfile.ts";

/**
 * The Secrets screen's table: each secret name against each host, by name only. Built from the files as text (the
 * config files and the clear keys of the secrets files), so a value is never read, and nothing is decrypted.
 *
 *   set      the host's own file has the name, or `shared` has it and the host can read `shared`
 *   missing  a server the host picks, or the host's settings, use the name and neither file has it
 *   unused   nothing the host gets needs it (and it is not set)
 */

export type CellState = "set" | "missing" | "unused";

export type SecretCell = {
  state: CellState;
  /** Where the value is, when it is set. */
  from: "host" | "shared" | null;
};

export type SecretRow = {
  name: string;
  /** Catalog servers that refer to the name, and `settings` when a host's or the defaults' settings do. */
  usedBy: string[];
  cells: Record<string, SecretCell>;
  /** The hosts a value would go to by default: the ones that need it and lack it, or when none do, the ones that hold it in their own file (a replacement). */
  targets: string[];
};

export type SecretsTable = {
  /** `age`: the host has a recipient, so a file can be encrypted for it. */
  hosts: { name: string; age: boolean }[];
  names: SecretRow[];
  /** Whether `secrets/shared.enc.yaml` holds each name, and who can read it. */
  problems: string[];
};

export function secretsTable(configDir: string, model: Model, files: Files): SecretsTable {
  const problems: string[] = [];
  const overlay = { root: configDir, files };
  const doc = (name: string, optional: boolean) => parseFile(join(configDir, "hosts", `${name}.yaml`), optional, problems, overlay);
  const defaults = doc("_defaults", true);
  const catalog = parseMcpCatalog(configDir, problems, overlay);

  const serverNames = new Map(catalog.entries().map(([name, s]) => [name, secretNames({ env: s.env, headers: s.headers, url: s.url })]));
  const usedBy = new Map<string, Set<string>>();
  const use = (secret: string, by: string) => usedBy.set(secret, (usedBy.get(secret) ?? new Set()).add(by));
  for (const [server, names] of serverNames) for (const n of names) use(n, server);

  const hosts = model.hosts.map((h) => h.name);
  const ages = new Map<string, string>();
  const needs = new Map<string, Set<string>>();
  const need = (host: string, secret: string) => needs.set(secret, (needs.get(secret) ?? new Set()).add(host));
  const settingsOf = (d: ReturnType<typeof doc>) => secretNames(d?.settings ?? {});
  for (const name of hosts) {
    const own = doc(name, false);
    if (typeof own?.age === "string" && own.age !== "") ages.set(name, own.age);
    for (const n of [...settingsOf(defaults), ...settingsOf(own)]) {
      use(n, "settings");
      need(name, n);
    }
    for (const row of model.servers) if (row.cells[name]?.on) for (const n of serverNames.get(row.name) ?? []) need(name, n);
  }

  const file = (owner: string) => parseSopsText(files[`secrets/${owner}.enc.yaml`] ?? "");
  const own = new Map(hosts.map((h) => [h, new Set(file(h).entries.keys())]));
  const shared = file("shared");
  const sharedNames = new Set(shared.entries.keys());
  const sharedReaders = new Set(hosts.filter((h) => ages.has(h) && shared.recipients.includes(ages.get(h)!)));

  const names = new Set([...usedBy.keys(), ...sharedNames, ...[...own.values()].flatMap((s) => [...s])]);
  const rows = [...names].sort().map((name): SecretRow => {
    const cells: Record<string, SecretCell> = {};
    for (const h of hosts) {
      const from = own.get(h)!.has(name) ? "host" : sharedNames.has(name) && sharedReaders.has(h) ? "shared" : null;
      cells[h] = { state: from !== null ? "set" : needs.get(name)?.has(h) ? "missing" : "unused", from };
    }
    const canHold = (h: string) => ages.has(h);
    const missing = hosts.filter((h) => cells[h]!.state === "missing" && canHold(h));
    const targets = missing.length > 0 ? missing : hosts.filter((h) => cells[h]!.from === "host" && canHold(h));
    return { name, usedBy: [...(usedBy.get(name) ?? [])].sort(), cells, targets };
  });
  return { hosts: hosts.map((name) => ({ name, age: ages.has(name) })), names: rows, problems };
}
