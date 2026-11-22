import { SECRET_NAME } from "../edit/index.ts";

/** The words a name is made of: `Api-Key` and `API_KEY` are both `API_KEY`. */
const words = (text: string): string => text.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Whether an env variable or a header is named the way a credential is: `*_TOKEN`, `*_KEY`, `*SECRET*`, `*PASSWORD*`, `Authorization`. */
export function looksSecret(key: string): boolean {
  const name = words(key);
  return /(^|_)(TOKEN|KEY)$/.test(name) || name.includes("SECRET") || name.includes("PASSWORD") || /^(PROXY_)?AUTHORIZATION$/.test(name);
}

/** `TRACKER_API_KEY` for the server `tracker` and the key `API_KEY` (or `Api-Key`), `TRACKER_AUTHORIZATION` for its header. */
export function secretNameFor(server: string, key: string): string {
  const prefix = words(server);
  const name = words(key);
  return name.startsWith(`${prefix}_`) ? name : `${prefix}_${name}`;
}

/**
 * The name for a key's secret that nothing else uses. An env key (`keepOwn`; a header never is) that already is a secret name is kept when nobody has it; any
 * other is built from the server and the key. A name somebody has gets a number.
 */
export function freeSecretName(server: string, key: string, taken: ReadonlySet<string>, keepOwn = true): string {
  const own = words(key);
  if (keepOwn && SECRET_NAME.test(own) && looksSecret(key) && !taken.has(own)) return own;
  const base = secretNameFor(server, key);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

/** Why a name cannot be a secret's, or null. */
export function secretNameProblem(name: string, taken: ReadonlySet<string>): string | null {
  if (!SECRET_NAME.test(name) || name.length > 100) return "a secret name is capital letters, digits and '_', and starts with a letter, such as TRACKER_API_KEY";
  if (taken.has(name)) return `'${name}' is already a secret, and capture never replaces one`;
  return null;
}

const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A source name from the last part of its repo address: `git@example.com:me/skill-box.git` is `skill-box`. */
export function sourceNameOf(repo: string): string {
  const last = repo.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() ?? "";
  const clean = last.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return SOURCE_NAME.test(clean) ? clean.slice(0, 64) : "skills";
}

/** Two addresses of one repo are the same when they differ only by a trailing `.git` or slash. */
export const sameRepo = (a: string, b: string): boolean => {
  const bare = (r: string) => r.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  return bare(a) === bare(b);
};

/** A command's arguments with the value of a credential flag hidden: `--token abc` and `--api-key=abc` show `***`. */
export function hideArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let hideNext = false;
  for (const arg of args) {
    if (hideNext) {
      out.push("***");
      hideNext = false;
      continue;
    }
    const flag = /^(--?[A-Za-z][\w-]*)(=(.*))?$/.exec(arg);
    if (flag !== null && looksSecret(flag[1]!.replace(/^-+/, ""))) {
      if (flag[2] !== undefined) out.push(`${flag[1]}=***`);
      else {
        out.push(arg);
        hideNext = true;
      }
    } else out.push(arg);
  }
  return out;
}

/** Whether a command line carries a credential in a flag. Capture does not copy one into the catalog: a command line cannot refer to a secret. */
export const holdsCredentialArg = (args: readonly string[]): boolean => hideArgs(args).some((arg, i) => arg !== args[i]);

/** Whether a URL carries a credential in a query parameter (`?api_key=...`). The catalog takes a header for it instead. */
export function holdsCredentialQuery(url: string): boolean {
  const query = url.split("#")[0]!.split("?")[1];
  return query !== undefined && query.split("&").some((pair) => looksSecret(decodeSafe(pair.split("=")[0]!)));
}

const decodeSafe = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};
