/** Can `s` be written as a plain YAML scalar and read back as the same string? Conservative: false when unsure. */
export function plainSafe(s: string): boolean {
  if (s === "" || s !== s.trim() || /[\n\t\r]/.test(s)) return false;
  if (/^[,[\]{}#&*!|>'"%@`]/.test(s)) return false;
  if (/^[-?:](\s|$)/.test(s)) return false;
  if (/\s#|:\s|:$/.test(s)) return false;
  if (/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(s)) return false;
  if (/^[-+]?(\d|\.\d)/.test(s) && (!Number.isNaN(Number(s)) || /^0[xo]/i.test(s))) return false;
  return true;
}

export type Quote = "plain" | "double" | "single";

/** A string as YAML text in the quoting style the neighbours use. Text that cannot be plain is quoted whatever the style. */
export function stringText(s: string, quote: Quote): string {
  if (quote === "plain" && plainSafe(s)) return s;
  if (quote === "single" && !/[\n\r\t]/.test(s)) return `'${s.replaceAll("'", "''")}'`;
  return JSON.stringify(s);
}
