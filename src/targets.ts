import { join } from "node:path";
import { hostNames } from "./recipients.ts";
import { parseFile } from "./yamlfile.ts";

/** A host and the destination `ssh` reaches it at. Null means it is reached by its timer only. */
export type Target = { host: string; ssh: string | null };

/**
 * The hosts in `hosts/`, in name order, other than `except`. A destination that is not a plain string, or that
 * starts with `-` and so would be read by `ssh` as an option, is added to `problems`.
 */
export function hostTargets(configDir: string, except: string | null, problems: string[]): Target[] {
  const targets: Target[] = [];
  for (const name of hostNames(configDir).filter((n) => n !== except)) {
    const path = join(configDir, "hosts", `${name}.yaml`);
    const ssh = parseFile(path, false, problems)?.ssh;
    if (ssh === undefined) targets.push({ host: name, ssh: null });
    else if (typeof ssh !== "string" || ssh === "" || ssh.startsWith("-")) problems.push(`${path}: 'ssh' must be a destination such as user@host`);
    else targets.push({ host: name, ssh });
  }
  return targets;
}
