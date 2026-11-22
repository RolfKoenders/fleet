import { join } from "node:path";
import { NOTIFY_KEYS } from "./configkeys.ts";
import { hasSecretRef } from "./template.ts";
import { isObject, parseFile } from "./yamlfile.ts";
import type { Obj } from "./yamlfile.ts";

/**
 * The `notify:` key: where a host sends an alert when an apply its timer started stops. In a file it is a map
 * of channels, or the word `off`. Values that name a URL or a token may be `secret:NAME`, which stays unresolved
 * here: only the sender, at the moment it sends, ever holds the value.
 */

export type Channel = "desktop" | "ntfy" | "webhook";

/** What one file says: its fields, or `off`. */
export type NotifyValue = { desktop?: boolean; ntfy?: string; ntfy_token?: string; webhook?: string } | "off";

/** What a host ends up with: the file layers merged. `desktop` is off unless a file turns it on. */
export type NotifyConfig = { desktop: boolean; ntfy: string | null; ntfyToken: string | null; webhook: string | null };

const URL_TEXT = /^https?:\/\/\S+$/;

/** Checks one file's `notify:` value, appending problems. Null when it is absent or has a problem. */
export function checkNotify(path: string, value: unknown, problems: string[]): NotifyValue | null {
  if (value === undefined) return null;
  if (value === "off") return "off";
  if (!isObject(value)) {
    problems.push(`${path}: 'notify' must be a map of channels or off`);
    return null;
  }
  const out: Exclude<NotifyValue, "off"> = {};
  let ok = true;
  for (const [key, field] of Object.entries(value)) {
    if (!NOTIFY_KEYS.includes(key)) {
      problems.push(`${path}: unknown key 'notify.${key}'`);
      ok = false;
    } else if (key === "desktop") {
      if (typeof field === "boolean") out.desktop = field;
      else {
        problems.push(`${path}: 'notify.desktop' must be true or false`);
        ok = false;
      }
    } else if (typeof field !== "string" || field === "") {
      problems.push(`${path}: 'notify.${key}' must be a string`);
      ok = false;
    } else if (key !== "ntfy_token" && !hasSecretRef(field) && !URL_TEXT.test(field)) {
      // The text is not echoed: a webhook URL can carry its own secret.
      problems.push(`${path}: 'notify.${key}' must be an http or https URL, or secret:NAME`);
      ok = false;
    } else {
      out[key as "ntfy" | "ntfy_token" | "webhook"] = field;
    }
  }
  return ok ? out : null;
}

/** A host file's value over the defaults', one field at a time; `off` in the host file turns every alert off. Null when nothing is set or it is off. */
export function mergeNotify(defaults: NotifyValue | null, host: NotifyValue | null): NotifyConfig | null {
  if (host === "off") return null;
  const base = defaults === "off" || defaults === null ? null : defaults;
  if (base === null && host === null) return null;
  const merged = { ...base, ...host };
  return { desktop: merged.desktop === true, ntfy: merged.ntfy ?? null, ntfyToken: merged.ntfy_token ?? null, webhook: merged.webhook ?? null };
}

/** The channels a config uses. */
export function channelsOf(config: NotifyConfig | null): Channel[] {
  if (config === null) return [];
  return [...(config.desktop ? (["desktop"] as const) : []), ...(config.ntfy === null ? [] : (["ntfy"] as const)), ...(config.webhook === null ? [] : (["webhook"] as const))];
}

const valueOf = (doc: Obj | null, path: string, problems: string[]): NotifyValue | null => (doc === null ? null : checkNotify(path, doc.notify, problems));

/**
 * The host's alerts read on their own: the host file's `notify:` over the defaults'. The full loader checks the
 * key with everything else; this is for the apply timer's alerts and for `status`, which need only this key and
 * must work when something else in the config is wrong. Problems are appended; null when the files cannot be
 * read, a value is wrong, or no alerts are set up.
 */
export function readNotify(configDir: string, host: string, problems: string[]): NotifyConfig | null {
  const defaultsPath = join(configDir, "hosts/_defaults.yaml");
  const hostPath = join(configDir, "hosts", `${host}.yaml`);
  const before = problems.length;
  const defaults = parseFile(defaultsPath, true, problems);
  const own = parseFile(hostPath, false, problems);
  const merged = mergeNotify(valueOf(defaults, defaultsPath, problems), valueOf(own, hostPath, problems));
  return problems.length > before ? null : merged;
}
