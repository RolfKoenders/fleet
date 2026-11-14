/**
 * Messages that echo a URL must not carry credentials in it. `https://user:pw@host/x` is shown as `https://host/x`. A
 * user alone in an ssh or scp-style address (`git@host:path`) is how those addresses are written, not a secret, and stays.
 */
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@]*)@/gi;

export const redactUrl = (text: string): string => text.replace(USERINFO, (all, scheme: string, info: string) => (/^https?:\/\/$/i.test(scheme) || info.includes(":") ? scheme : all));

/** Credentials in a URL: any userinfo in an http(s) URL, or a password in the userinfo of any other. */
export const urlHoldsCredentials = (url: string): boolean => {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)@/i.exec(url);
  if (m === null) return false;
  return /^https?$/i.test(m[1]!) || m[2]!.includes(":");
};

/** The words of the refusals below. The page has the same ones (`src/ui/static/catalog.js`), and a test holds them equal. */
export const URL_SPACE = "the URL must not hold a space or a control character";
export const MCP_URL_CREDENTIALS = "the URL must not hold credentials (user:password@): put them in 'headers' as secret:NAME";
export const REPO_CREDENTIALS = "the repo must not hold credentials (user:password@): use a git credential helper or an ssh key, never the URL";
