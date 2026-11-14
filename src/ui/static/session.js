// What the page keeps in `sessionStorage`, so a reload of the tab does not kill it. Pure apart from the storage it is
// handed (a fake one in tests): `node --test` runs it.
//
// sessionStorage belongs to this tab alone: it is not sent anywhere, not shared with another tab, and gone when the tab
// closes. It holds two things:
//   - the token, so F5 does not leave a page that cannot do anything. It is never in the URL or the history after the load.
//   - the To push list. That list is edits only: a pick, or an addition to the catalog (names, commands, `secret:NAME`
//     references), or `setSecret`, a secrets file already encrypted by sops. A plain secret value is never in an edit: it
//     goes to the server once, in its own request, and the answer holds ciphertext. So nothing stored here is a secret value.

/** This tab's storage, or null when the browser blocks it. */
export function tabStore() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const TOKEN = "fleet-ui-token";
const OPS = "fleet-ui-to-push";

/** @typedef {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} Store */

/**
 * The token for this page: the one in the address when there is one (a fresh `fleet ui` URL replaces an old one), else the
 * one kept for this tab. Either way it is kept for the next reload.
 * @param {Store | null} store @param {string | null} fromAddress
 * @returns {string | null}
 */
export function pageToken(store, fromAddress) {
  try {
    if (fromAddress !== null) {
      store?.setItem(TOKEN, fromAddress);
      return fromAddress;
    }
    const kept = store?.getItem(TOKEN) ?? null;
    return kept === null || kept === "" ? null : kept;
  } catch {
    return fromAddress;
  }
}

/** Forgets the token: it will never be valid again. @param {Store | null} store */
export function dropToken(store) {
  try {
    store?.removeItem(TOKEN);
  } catch {
    // storage may be blocked; nothing to forget then
  }
}

/** Keeps the To push list. @param {Store | null} store @param {unknown[]} ops */
export function saveOps(store, ops) {
  try {
    if (ops.length === 0) store?.removeItem(OPS);
    else store?.setItem(OPS, JSON.stringify(ops));
  } catch {
    // full or blocked: the page works, it just cannot restore after a reload
  }
}

/**
 * The To push list kept for this tab: only what is shaped like an edit (an object with an `op` name), so damaged storage
 * restores nothing worse than nothing. The server checks every edit again with every preview, and drops any that no longer apply.
 * @param {Store | null} store @returns {any[]}
 */
export function loadOps(store) {
  try {
    const doc = JSON.parse(store?.getItem(OPS) ?? "null");
    return Array.isArray(doc) ? doc.filter((o) => typeof o === "object" && o !== null && !Array.isArray(o) && typeof o.op === "string") : [];
  } catch {
    return [];
  }
}
