// What the Card screen needs that is not drawing. Pure: `node --test` runs it. The server draws the card (`src/card/`, the same code
// as `fleet card`); the page only turns that SVG into a PNG.

/** The two styles the server draws, as `[id, label]`. */
export const STYLES = /** @type {const} */ ([["machines", "Machines"], ["map", "Map"]]);

/** The card is 1200 x 630; the PNG is drawn at twice that, so it is sharp on a phone. */
export const CARD_SIZE = { width: 1200, height: 630, scale: 2 };

/** The bundled faces, relative to the page: JetBrains Mono (the card's font) as the page already serves it. */
export const FONT_FILES = { regular: "fonts/JetBrainsMono-Regular.woff2", bold: "fonts/JetBrainsMono-Bold.woff2" };

/**
 * The card names JetBrains Mono first and then monospace faces every system has, so the file on disk reads anywhere. The picture
 * on this page and the PNG carry the real font inside them (a data: URL, so nothing is fetched when they are drawn).
 * @param {string} svg @param {{ regular: string, bold: string }} fonts base64 of the two woff2 files
 */
export function embedFonts(svg, fonts) {
  const face = (/** @type {string} */ weight, /** @type {string} */ data) => `@font-face{font-family:'JetBrains Mono';font-weight:${weight};src:url(data:font/woff2;base64,${data}) format('woff2')}`;
  return svg.replace("<defs>", `<defs><style>${face("400", fonts.regular)}${face("500 800", fonts.bold)}</style>`);
}

/** The file a download is called. @param {string} style @param {"png" | "svg"} kind */
export const fileName = (style, kind) => (kind === "svg" ? "fleet-card.svg" : style === "machines" ? "fleet-card.png" : `fleet-card-${style}.png`);

/**
 * The address that opens a new Show and tell discussion with the text filled in. The server makes it from the counts; this is a
 * guard that the page only ever opens that one place.
 * @param {any} share
 */
export function discussionUrl(share) {
  const url = typeof share?.url === "string" ? share.url : "";
  return url.startsWith("https://github.com/RolfKoenders/fleet/discussions/new?category=show-and-tell") ? url : null;
}

/**
 * What to tell a person whose browser refused to put the image on the clipboard. It is never an error screen: Save PNG is the way
 * round it.
 * @param {unknown} error
 */
export function clipboardProblem(error) {
  const name = error instanceof Error ? error.name : "";
  const why = name === "NotAllowedError" ? "it did not allow it here" : name === "TypeError" || name === "" ? "it cannot copy images" : "it failed";
  return `Your browser would not copy the image (${why}). Use Save PNG and attach the file.`;
}

/** Whether this browser has an image clipboard to ask. @param {{ clipboard?: { write?: unknown } } | undefined} nav @param {unknown} clipboardItem */
export const canCopyImage = (nav, clipboardItem) => typeof nav?.clipboard?.write === "function" && typeof clipboardItem === "function";

/**
 * The line under the picture about hosts the bridge never saw: the card is made from what it last saw, and a host it never saw is
 * left without agents and OS. Counts only, never a name.
 * @param {number} unseen
 */
export const unseenNote = (unseen) =>
  unseen === 0 ? null : `${unseen === 1 ? "1 host has" : `${unseen} hosts have`} never been seen by the bridge, so ${unseen === 1 ? "it is" : "they are"} shown without agents and OS. The card is made from what fleet last saw and asks no host: open fleet bridge to read ${unseen === 1 ? "it" : "them"}.`;
