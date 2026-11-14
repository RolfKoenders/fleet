import { createHash } from "node:crypto";

/**
 * Secrets files as text: what the edit engine and the page's review need to know about one without ever decrypting it.
 * sops leaves a file's names in the clear and encrypts only the values, so a file can be read for its names and its
 * recipients, compared, and checked for holding nothing but ciphertext.
 */

export type SopsFile = {
  /** Clear text keys with their (encrypted) value text and 1-based line. The value is only compared, never shown. */
  entries: Map<string, { line: number; value: string }>;
  recipients: string[];
};

/** The top-level keys of a sops file and the age recipients of its `sops:` block. Ignores `mac` and `lastmodified`. */
export function parseSopsText(text: string): SopsFile {
  const entries = new Map<string, { line: number; value: string }>();
  const recipients: string[] = [];
  let inSops = false;
  text.split("\n").forEach((raw, i) => {
    const top = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/.exec(raw);
    if (top) {
      inSops = top[1] === "sops";
      if (!inSops) entries.set(top[1]!, { line: i + 1, value: top[2] ?? "" });
      return;
    }
    if (inSops) {
      const r = /recipient:\s*(age1[a-z0-9]+)/.exec(raw);
      if (r) recipients.push(r[1]!);
    }
  });
  return { entries, recipients: [...new Set(recipients)].sort() };
}

/** A secret's name, as `fleet secrets set` takes it. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

/** The secrets files by repo-relative path: `secrets/shared.enc.yaml` or `secrets/<host>.enc.yaml`. */
export const SECRETS_PATH = /^secrets\/(shared|[A-Za-z0-9][A-Za-z0-9._-]*)\.enc\.yaml$/;

/** The `shared` or host name in a secrets file's path, or null for any other path. */
export const secretsOwner = (path: string): string | null => SECRETS_PATH.exec(path)?.[1] ?? null;

/** A value as sops writes it: one line, and nothing but ciphertext. */
const CIPHERTEXT = /^ENC\[AES256_GCM,[A-Za-z0-9+/=,:_.-]*\]$/;

export const MAX_SECRETS_TEXT = 100_000;

/**
 * Why `text` is not a sops file that holds only ciphertext, or null. Every top-level entry must be one encrypted line and
 * the `sops:` block must come last, so a plaintext value, a second document or anything else cannot ride along.
 */
export function ciphertextProblem(text: string): string | null {
  if (text.length > MAX_SECRETS_TEXT) return "the secrets file is too big";
  const seen = new Set<string>();
  let inSops = false;
  let sops = false;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    if (/^[ \t]/.test(raw)) {
      if (!inSops) return "the secrets file has an indented line outside its sops block";
      continue;
    }
    if (inSops) return "the secrets file has a line after its sops block";
    const top = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/.exec(raw);
    if (top === null) return "the secrets file has a line that is not a key";
    const key = top[1]!;
    const value = top[2];
    if (seen.has(key)) return `the secrets file has '${key}' twice`;
    seen.add(key);
    if (key === "sops") {
      inSops = true;
      sops = true;
    } else if (value === undefined || !CIPHERTEXT.test(value.trim())) return `'${key}' is not encrypted`;
  }
  return sops ? null : "the secrets file has no sops block";
}

/** What identifies a secrets file's text for staleness: the digest of its text, or `absent` for no file. */
export const fingerprint = (text: string | undefined): string => (text === undefined ? "absent" : createHash("sha256").update(text).digest("hex"));

/**
 * A secrets file as the review shows it: each name with a short mark of its ciphertext, never the ciphertext. A changed
 * value changes its mark, so the diff shows which names changed.
 */
export function reviewText(text: string): string {
  const lines = [...parseSopsText(text).entries].map(([name, { value }]) => `${name}: ENC[...${createHash("sha256").update(value).digest("hex").slice(0, 6)}]`);
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}
