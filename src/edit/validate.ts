import { InvalidConfigError, loadConfig } from "../config.ts";
import type { LoadOptions } from "../config.ts";
import { hostNames } from "../recipients.ts";

export type HostProblems = { host: string; problems: string[] };

export type ValidateOptions = LoadOptions & {
  /**
   * Every skill the sources of the catalog provide, as far as this machine knows them. A bundle a host gets that names another skill is a
   * problem, as `fleet push` would find it: without it only the shapes are checked, because `sources: "none"` never looks in a source.
   * `null` when some source's skills are not known, so nothing is said of them.
   */
  skills?: ReadonlySet<string> | null;
};

/**
 * Loads every host's config with `overlay` standing in for the files it holds, as `fleet push` would
 * load it, and returns the hosts that do not load. No copy of the repo is made and nothing is written.
 * Skill sources are left alone unless `options.sources` says otherwise.
 */
export function validate(configDir: string, overlay: Readonly<Record<string, string>>, options: ValidateOptions = {}): HostProblems[] {
  const { skills = null, ...load } = options;
  const failed: HostProblems[] = [];
  for (const host of hostNames(configDir)) {
    try {
      const config = loadConfig(configDir, host, { sources: "none", ...load, overlay });
      const missing = skills === null ? [] : config.skills.filter((s) => !skills.has(s));
      if (missing.length > 0) failed.push({ host, problems: missing.map((s) => `skill '${s}' is in no source: no directory '${s}/' with a SKILL.md under any source path`) });
    } catch (error) {
      if (!(error instanceof InvalidConfigError)) throw error;
      failed.push({ host, problems: error.problems });
    }
  }
  return failed;
}
