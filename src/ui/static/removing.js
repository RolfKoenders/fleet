// What the Remove dialogs need that is not drawing: which held edits a removal makes moot, what a skill source's removal does to each
// bundle, which hosts a removal touches, and the words. Pure: `node --test` runs it. The server checks and writes everything again;
// the words of a refusal are its own (`src/ui/hostremove.ts`), and a test holds them equal.

/** @typedef {import("./adding.js").AddKind} Kind */
/** @typedef {import("./matrix.js").Op} Op */

/** What each Remove dialog is called. */
export const REMOVE = {
  server: "Remove MCP server",
  source: "Remove skill source",
  bundle: "Remove skill bundle",
  host: "Remove host",
};

/** The op each catalog kind's removal is held as. */
export const REMOVES = /** @type {const} */ ({ server: "removeServer", source: "removeSource", bundle: "removeBundle" });

/** Why a host cannot be removed: the page runs on it, or it is the only admin. The server refuses the same, in the same words. @param {string} name */
export const REMOVE_SELF = (name) => `${name} is the host this page runs on. Open fleet ui on another host to remove it.`;
/** @param {string} name */
export const REMOVE_ADMIN = (name) => `${name} is the only admin host (admin: true). Every secrets file is encrypted for its key, so make another host the admin first.`;

/**
 * Why `host` may not be removed from this page, or null.
 * @param {{ name: string, self: boolean, admin?: boolean }} host @param {{ admin?: boolean }[]} hosts
 */
export function hostRefusal(host, hosts) {
  if (host.self) return REMOVE_SELF(host.name);
  if (host.admin === true && hosts.filter((x) => x.admin === true).length === 1) return REMOVE_ADMIN(host.name);
  return null;
}

/** Does a held edit make the removal of this item pointless: an addition or edit of it, or a host's pick of it? @param {Op} o @param {Kind} kind @param {string} name */
export function mentions(o, kind, name) {
  if (kind === "host") return false;
  if (o.op === "add" || o.op === "remove") return o.name === name && o.kind === (kind === "bundle" ? "bundles" : kind === "server" ? "mcp" : "");
  const ops = { server: ["addServer", "editServer", "removeServer"], source: ["addSource", "editSource", "removeSource"], bundle: ["addBundle", "editBundle", "removeBundle"] }[kind];
  return ops.includes(o.op) && "name" in o && o.name === name;
}

/**
 * What removing an item does to the held edits. An item whose addition is still held just loses it, with every edit and pick of it: nothing is
 * staged. Otherwise the removal is added at the end, and the edits and picks of the item that were held go (they would be stale after it).
 * `moot` are the edits that went, for the dialog to say.
 * @param {Op[]} ops @param {"server" | "source" | "bundle"} kind @param {string} name @param {string[]} skills the skills only a source provides
 * @returns {{ mode: "forget" | "stage", ops: Op[], moot: Op[], op: Op | null }}
 */
export function removal(ops, kind, name, skills) {
  const moot = ops.filter((o) => mentions(o, kind, name));
  const unpushed = ops.some((o) => (o.op === "addServer" || o.op === "addSource" || o.op === "addBundle") && mentions(o, kind, name));
  const rest = ops.filter((o) => !moot.includes(o));
  if (unpushed) return { mode: "forget", ops: rest, moot, op: null };
  /** @type {Op} */
  const op = kind === "source" ? { op: "removeSource", name, skills } : kind === "server" ? { op: "removeServer", name } : { op: "removeBundle", name };
  return { mode: "stage", ops: [...rest, op], moot, op };
}

/**
 * The skills that go with a source: those only it provides, as far as the page knows them (the clones here, and what was seen when it was added).
 * @param {string} name @param {{ name: string, source: string }[]} known @param {Record<string, string[]>} staged
 */
export function sourceSkills(name, known, staged) {
  const mine = [...new Set([...known.filter((k) => k.source === name).map((k) => k.name), ...(staged[name] ?? [])])];
  const elsewhere = new Set([...known.filter((k) => k.source !== name).map((k) => k.name), ...Object.entries(staged).filter(([s]) => s !== name).flatMap(([, list]) => list)]);
  return mine.filter((s) => !elsewhere.has(s)).sort();
}

/**
 * What each bundle loses when `skills` go: the skills it loses and how many it keeps. Bundles that lose nothing are left out.
 * @param {{ name: string, skills: string[] }[]} bundles @param {string[]} skills
 */
export const bundleLosses = (bundles, skills) =>
  bundles.flatMap((b) => {
    const lost = b.skills.filter((s) => skills.includes(s));
    return lost.length === 0 ? [] : [{ bundle: b.name, lost, left: b.skills.length - lost.length }];
  });

/** `core loses 3 skills`, or `core loses its only skill`: the dialog's words for one bundle. @param {{ bundle: string, lost: string[], left: number }} l */
export const lossLine = (l) => `${l.bundle} loses ${l.lost.length === 1 && l.left === 0 ? "its only skill" : `${l.lost.length} skill${l.lost.length === 1 ? "" : "s"}`} (${l.lost.join(", ")})`;

/** Said of a bundle that has no skill left, in the dialog and on its card. */
export const EMPTY_BUNDLE = "no skills left: the bundle is kept, and hosts that pick it get nothing from it";

/** What the dialog says when the page cannot tell which skills a source provides. */
export const NO_SKILLS_KNOWN = "Fleet has no copy of this source on this machine, so it cannot tell which skills come from it. Bundles keep the skills they list. If they list some of this source's, push will refuse until you take them out (Edit a bundle).";

/**
 * The files of a preview that a removal changes, by who they belong to: the catalog file and each host file (`the defaults` for the defaults). Secrets
 * and `.sops.yaml` are left out.
 * @param {{ path: string }[]} files
 * @returns {{ catalog: string[], hosts: string[] }}
 */
export function touched(files) {
  const catalog = files.filter((f) => f.path.startsWith("catalog/")).map((f) => f.path);
  const hosts = files.flatMap((f) => (f.path === "hosts/_defaults.yaml" ? ["the defaults"] : /^hosts\/(.+)\.yaml$/.test(f.path) ? [/** @type {string} */ (/^hosts\/(.+)\.yaml$/.exec(f.path)?.[1])] : []));
  return { catalog, hosts };
}

/**
 * The held edits that a host's removal drops: its picks and ssh edit, a secret set for its own file, and one set for `shared`, which the
 * rekey rewrites so that it is stale anyway.
 * @param {Op[]} ops @param {string} host
 */
export const heldForHost = (ops, host) =>
  ops.filter((o) => ((o.op === "add" || o.op === "remove") && o.host === host) || (o.op === "editHost" && o.host === host) || (o.op === "setSecret" && (o.file === `secrets/${host}.enc.yaml` || o.file === "secrets/shared.enc.yaml")));

/**
 * What removing a host runs, in the words of the dialog: the files it deletes and, only when the fleet keeps secrets, the rekey.
 * @param {string} name @param {{ files: { path: string }[], rekey: boolean }} doc the server's preview
 */
export function hostRuns(name, doc) {
  const deleted = doc.files.filter((f) => f.path.startsWith("hosts/") || f.path.startsWith("secrets/")).map((f) => f.path);
  return {
    head: doc.rekey ? "runs now: rekeys, commits and pushes" : "runs now: commits and pushes",
    lead: `Removes the host ${name} now, not through To push: it deletes ${deleted.join(" and ")}${doc.rekey ? ", runs fleet secrets rekey so no secrets file names its key" : ""}, then commits and pushes this repo.`,
  };
}

/** What the dialog says of a host's removal that the page cannot compute: what stays behind. @param {string} name */
export const hostKeeps = (name) => `The machine keeps its files, and its timer will report errors until fleet is turned off on ${name}.`;

/** The secrets a removed host could read stay valid: rekeying changes who can read the files, not the values. */
export const ROTATE = "Rekeying does not change a secret's value. This host has read these, so change them where they come from, then set the new values.";

/** The words of the button that goes ahead. @param {"forget" | "stage" | "run"} mode */
export const goLabel = (mode) => (mode === "forget" ? "Drop the addition" : mode === "stage" ? "Remove, to push" : "Remove the host and push");
