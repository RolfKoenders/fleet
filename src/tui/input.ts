/** Turns the bytes a terminal sends into keys. */

export type Key = {
  /** `up`, `enter`, `escape`, `tab`, `backspace`, `f1`..., or `char` for text, which is in `text`. */
  name: string;
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
};

/** What the parser hands on: a key, pasted text, or the terminal's answer to a mode query (never a key). */
export type Input = { kind: "key"; key: Key } | { kind: "paste"; text: string } | { kind: "mode"; mode: number; state: number };

const ARROWS: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "backtab" };
const TILDE: Record<string, string> = { "1": "home", "2": "insert", "3": "delete", "4": "end", "5": "pageup", "6": "pagedown", "7": "home", "8": "end" };
const FUNCTION: Record<string, string> = { "11": "f1", "12": "f2", "13": "f3", "14": "f4", "15": "f5", "17": "f6", "18": "f7", "19": "f8", "20": "f9", "21": "f10" };
const SS3: Record<string, string> = { P: "f1", Q: "f2", R: "f3", S: "f4", ...ARROWS };

/** Modifier parameter of `CSI 1;m X`: 1 plus bits for shift, alt, ctrl. */
function modifiers(param: string | undefined): Pick<Key, "ctrl" | "alt" | "shift"> {
  const n = Number(param ?? "1") - 1;
  if (!Number.isInteger(n) || n <= 0) return {};
  return { ...(n & 1 ? { shift: true } : {}), ...(n & 2 ? { alt: true } : {}), ...(n & 4 ? { ctrl: true } : {}) };
}

const key = (name: string, extra: Partial<Key> = {}): Input => ({ kind: "key", key: { name, ...extra } });

/**
 * A lone escape cannot be told from the start of a sequence until more bytes arrive or time passes, so
 * `feed` keeps it back and `flush` (called after a short wait) turns it into the escape key.
 */
export class InputParser {
  private pending = "";
  private pasting: string | null = null;

  /** Whether bytes are held back that `flush` would turn into keys. */
  get waiting(): boolean {
    return this.pending !== "";
  }

  feed(chunk: string): Input[] {
    this.pending += chunk;
    return this.drain();
  }

  flush(): Input[] {
    if (this.pending === "\u001b") {
      this.pending = "";
      return [key("escape")];
    }
    // An unfinished sequence that never completed is dropped, not typed.
    const stale = this.pending;
    this.pending = "";
    return stale.startsWith("\u001b") ? [] : this.feed(stale);
  }

  private drain(): Input[] {
    const out: Input[] = [];
    for (;;) {
      if (this.pasting !== null) {
        const end = this.pending.indexOf("\u001b[201~");
        if (end < 0) {
          this.pasting += this.pending;
          this.pending = "";
          return out;
        }
        out.push({ kind: "paste", text: this.pasting + this.pending.slice(0, end) });
        this.pending = this.pending.slice(end + 6);
        this.pasting = null;
        continue;
      }
      if (this.pending === "") return out;
      const used = this.one(out);
      if (used === 0) return out; // incomplete
      this.pending = this.pending.slice(used);
    }
  }

  /** Reads one input from the front of `pending` into `out`. Returns the length used, 0 if more bytes are needed. */
  private one(out: Input[]): number {
    const s = this.pending;
    const first = s[0]!;
    if (first !== "\u001b") {
      const ch = String.fromCodePoint(s.codePointAt(0)!);
      out.push(...this.plain(ch));
      return ch.length;
    }
    if (s.length === 1) return 0;
    const second = s[1]!;
    if (second === "[") return this.csi(out);
    if (second === "O") {
      if (s.length < 3) return 0;
      const name = SS3[s[2]!];
      if (name) out.push(key(name));
      return 3;
    }
    if (second === "\u001b") {
      out.push(key("escape"));
      return 1;
    }
    // Alt with a key.
    const ch = String.fromCodePoint(s.codePointAt(1)!);
    for (const input of this.plain(ch)) if (input.kind === "key") out.push({ kind: "key", key: { ...input.key, alt: true } });
    return 1 + ch.length;
  }

  private csi(out: Input[]): number {
    const s = this.pending;
    let i = 2;
    while (i < s.length && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x3f) i++; // parameters
    const paramEnd = i;
    while (i < s.length && s.charCodeAt(i) >= 0x20 && s.charCodeAt(i) <= 0x2f) i++; // intermediates
    if (i >= s.length) return 0;
    const final = s[i]!;
    const params = s.slice(2, paramEnd);
    const inter = s.slice(paramEnd, i);
    const used = i + 1;
    if (s.charCodeAt(i) < 0x40 || s.charCodeAt(i) > 0x7e) return used; // malformed: drop what was read
    if (final === "y" && inter === "$" && params.startsWith("?")) {
      const [mode, state] = params.slice(1).split(";").map(Number);
      if (mode !== undefined && state !== undefined && Number.isInteger(mode) && Number.isInteger(state)) out.push({ kind: "mode", mode, state });
      return used;
    }
    if (final === "~") {
      const [code, mod] = params.split(";");
      if (code === "200") {
        this.pasting = "";
        return used;
      }
      const name = TILDE[code ?? ""] ?? FUNCTION[code ?? ""];
      if (name) out.push(key(name, modifiers(mod)));
      return used;
    }
    if (inter === "" && ARROWS[final]) {
      const mod = params.split(";")[1];
      out.push(final === "Z" ? key("backtab", { shift: true }) : key(ARROWS[final]!, modifiers(mod)));
    }
    return used;
  }

  private plain(ch: string): Input[] {
    const code = ch.codePointAt(0)!;
    if (ch === "\r" || ch === "\n") return [key("enter")];
    if (ch === "\t") return [key("tab")];
    if (code === 0x7f || code === 0x08) return [key("backspace")];
    if (code === 0) return [key("char", { text: " ", ctrl: true })];
    if (code < 0x20) return [key("char", { text: String.fromCharCode(code + 96), ctrl: true })];
    if (code >= 0x80 && code < 0xa0) return [];
    return [key("char", { text: ch })];
  }
}

/** A key as a short label: `ctrl+k`, `shift+tab`, `up`, `q`. */
export function keyLabel(k: Key): string {
  const base = k.name === "char" ? (k.text === " " ? "space" : (k.text ?? "")) : k.name;
  return [k.ctrl ? "ctrl" : "", k.alt ? "alt" : "", k.shift && k.name !== "backtab" ? "shift" : "", base].filter((p) => p !== "").join("+");
}

/** The key a label names, for driving the app from a test: `ctrl+k`, `down`, `space`, `?`. */
export function keyFromLabel(label: string): Key {
  const mods = label.length > 1 ? label.split("+") : [label];
  const base = label.endsWith("++") ? "+" : mods.pop()!;
  const k: Key = { name: "char" };
  for (const m of mods) if (m === "ctrl" || m === "alt" || m === "shift") k[m] = true;
  if (base.length === 1) return { ...k, text: base };
  if (base === "space") return { ...k, text: " " };
  return { ...k, name: base };
}
