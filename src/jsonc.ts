function skipTrivia(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    if (/\s/.test(text[i]!)) i++;
    else if (text.startsWith("//", i)) i = text.indexOf("\n", i) === -1 ? text.length : text.indexOf("\n", i);
    else if (text.startsWith("/*", i)) i = text.indexOf("*/", i) === -1 ? text.length : text.indexOf("*/", i) + 2;
    else break;
  }
  return i;
}

function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (text.startsWith("//", i) || text.startsWith("/*", i)) {
      i = skipTrivia(text, i);
      out += " ";
    } else if (c === ",") {
      const next = text[skipTrivia(text, i + 1)];
      if (next !== "}" && next !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export type Parsed = {
  value: unknown;
  /** False when the text only parsed after comments or trailing commas were ignored. */
  plain: boolean;
};

/** Parses JSON, or JSONC with comments and trailing commas. Throws when it is neither. Blank text is `{}`. */
export function parseJsonc(text: string): Parsed {
  if (text.trim() === "") return { value: {}, plain: true };
  try {
    return { value: JSON.parse(text), plain: true };
  } catch {
    return { value: JSON.parse(stripJsonc(text)), plain: false };
  }
}
