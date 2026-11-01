import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidConfigError } from "./config.ts";
import { secretsFile } from "./recipients.ts";
import { NeedsSecretError, findSops, requireAgeKey, runSops, firstLine } from "./sops.ts";
import type { DesiredKey } from "./settings.ts";
import { fillSecrets } from "./template.ts";
import { parseFile } from "./yamlfile.ts";

/** The names a secrets file holds as plain values. sops leaves names in the clear and encrypts only values. */
export function namesIn(configDir: string, file: string): Set<string> {
  const path = join(configDir, secretsFile(file));
  if (!existsSync(path)) return new Set();
  const problems: string[] = [];
  const doc = parseFile(path, false, problems);
  if (doc === null || !("sops" in doc)) {
    throw new InvalidConfigError(problems.length > 0 ? problems : [`${path}: not a sops file (no top-level 'sops' key)`]);
  }
  return new Set(Object.keys(doc).filter((k) => k !== "sops" && typeof doc[k] === "string"));
}

/**
 * Decrypts the named secrets for `host`: from `secrets/<host>.enc.yaml` when it has the name,
 * otherwise from `secrets/shared.enc.yaml`. Each name is decrypted alone, so nothing else in
 * either file is read. Throws NeedsSecretError, before anything is written.
 */
export function resolveSecrets(configDir: string, host: string, home: string, names: string[]): Map<string, string> {
  const secrets = new Map<string, string>();
  if (names.length === 0) return secrets;

  const sops = findSops(home);
  requireAgeKey(home);
  const held = new Map([host, "shared"].map((file) => [file, namesIn(configDir, file)]));
  const missing = names.filter((name) => ![...held.values()].some((set) => set.has(name)));
  if (missing.length > 0) {
    throw new NeedsSecretError(`no secret ${missing.join(", ")}: not in ${secretsFile(host)} or ${secretsFile("shared")}; set it with \`fleet secrets set\``);
  }
  for (const name of names) {
    const file = held.get(host)!.has(name) ? host : "shared";
    const r = runSops(sops, configDir, home, ["decrypt", "--extract", JSON.stringify([name]), secretsFile(file)]);
    if (r.status !== 0) throw new NeedsSecretError(`sops could not decrypt ${name} from ${secretsFile(file)}: ${firstLine(r.stderr)}`);
    secrets.set(name, r.stdout);
  }
  return secrets;
}

/** The keys with their secrets filled in. `display` holds the value with each secret masked. */
export function renderKeys(keys: DesiredKey[], secrets: Map<string, string>): DesiredKey[] {
  return keys.map((key) => {
    const { value, display } = fillSecrets(key.value, secrets);
    return display === null ? key : { ...key, value, display };
  });
}
