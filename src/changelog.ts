export type Section = { heading: string; body: string };

/** The `## ` sections of a changelog, in file order. A section runs to the next `## ` line, and text above the first is not one. */
export function sections(changelog: string): Section[] {
  const found: Section[] = [];
  let lines: string[] | null = null;
  const close = () => {
    const last = found[found.length - 1];
    if (last !== undefined && lines !== null) last.body = lines.join("\n").trim();
  };
  for (const line of changelog.split("\n")) {
    if (line.startsWith("## ")) {
      close();
      found.push({ heading: line.slice(3).trim(), body: "" });
      lines = [];
    } else lines?.push(line);
  }
  close();
  return found;
}

const UNRELEASED = "Unreleased";

/**
 * The sections `next` has that `previous` does not, matched by heading, so a version both have is left out
 * even if its text changed. `Unreleased` is the exception: it is a heading that always exists, so it is
 * included when its text changed and is not empty.
 */
export function addedSections(previous: string, next: string): Section[] {
  const before = new Map(sections(previous).map((s) => [s.heading, s.body]));
  return sections(next).filter((s) => {
    if (s.heading === UNRELEASED) return s.body !== "" && before.get(s.heading) !== s.body;
    return !before.has(s.heading);
  });
}
