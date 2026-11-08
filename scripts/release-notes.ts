// Prints the notes of one version from CHANGELOG.md, for `gh release create`.
// Usage: node scripts/release-notes.ts <version> [<changelog>]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sections } from "../src/changelog.ts";

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The body of the `## <version>` section, trimmed. Throws when the section is missing or empty. */
export function releaseNotes(changelog: string, version: string): string {
  if (!VERSION.test(version)) throw new Error(`'${version}' is not a version like 1.2.3`);
  const section = sections(changelog).find((s) => s.heading === version || s.heading.startsWith(`${version} - `));
  if (section === undefined) throw new Error(`CHANGELOG.md has no section for ${version}`);
  if (section.body === "") throw new Error(`the CHANGELOG.md section for ${version} is empty`);
  return section.body;
}

if (import.meta.main) {
  const [arg, path = join(import.meta.dirname, "../CHANGELOG.md")] = process.argv.slice(2);
  if (arg === undefined) {
    console.error("usage: release-notes.ts <version> [<changelog>]");
    process.exit(2);
  }
  try {
    console.log(releaseNotes(readFileSync(path, "utf8"), arg.replace(/^v/, "")));
  } catch (error) {
    console.error(`release-notes: ${(error as Error).message}`);
    process.exit(1);
  }
}
