import { InvalidConfigError, loadConfig } from "../config.ts";
import type { LoadOptions } from "../config.ts";
import { hostNames } from "../recipients.ts";

export type HostProblems = { host: string; problems: string[] };

/**
 * Loads every host's config with `overlay` standing in for the files it holds, as `fleet push` would
 * load it, and returns the hosts that do not load. No copy of the repo is made and nothing is written.
 * Skill sources are left alone unless `options.sources` says otherwise.
 */
export function validate(configDir: string, overlay: Readonly<Record<string, string>>, options: LoadOptions = {}): HostProblems[] {
  const failed: HostProblems[] = [];
  for (const host of hostNames(configDir)) {
    try {
      loadConfig(configDir, host, { sources: "none", ...options, overlay });
    } catch (error) {
      if (!(error instanceof InvalidConfigError)) throw error;
      failed.push({ host, problems: error.problems });
    }
  }
  return failed;
}
