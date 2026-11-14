// The jobs fleet ui is running, as the server tells the page (`hello`, then `jobs`), and how they move the push and init state.
// Pure: `node --test` runs it.

import { idlePush } from "./state.js";
import { idleInit } from "./hosts.js";

/** @typedef {{ kind: "push" | "init" | "clone" | "check" | "secret", name?: string }} Job */

/** The jobs in a `hello` or `jobs` document: only well-formed ones. @param {any} doc @returns {Job[]} */
export function jobsOf(doc) {
  const list = Array.isArray(doc?.jobs) ? doc.jobs : [];
  return list.filter((/** @type {any} */ j) => j !== null && typeof j === "object" && ["push", "init", "clone", "check", "secret"].includes(j.kind)).map((/** @type {any} */ j) => (typeof j.name === "string" ? { kind: j.kind, name: j.name } : { kind: j.kind }));
}

/** One job in words. @param {Job} job */
export function jobLabel(job) {
  switch (job.kind) {
    case "push":
      return "a push is running";
    case "init":
      return `fleet init of ${job.name ?? "a host"} is running`;
    case "clone":
      return "a skill source is being cloned";
    case "check":
      return `${job.name ?? "an MCP server"} is being checked`;
    default:
      return `${job.name ?? "a secret"} is being encrypted`;
  }
}

/**
 * The push and init state after the server's list of jobs. `hello` is the whole truth about a connection that just opened: a
 * push or init that runs is started afresh (the server replays its events next, so they are not counted twice), one that does
 * not is over. A later `jobs` event only ends what it saw end (`before` had it, `now` does not), so a run this page just
 * started, which the server has not counted yet, is left alone, and one it is already showing is not started again.
 * @template {{ push: import("./state.js").PushState, init: import("./hosts.js").InitState }} S
 * @param {S} state @param {Job[]} now @param {Job[] | null} before null for a `hello`
 * @returns {S}
 */
export function withJobs(state, now, before) {
  const push = now.some((j) => j.kind === "push");
  const init = now.find((j) => j.kind === "init");
  const was = (/** @type {Job["kind"]} */ kind) => before !== null && before.some((j) => j.kind === kind);
  let next = state;
  if (push && (before === null || !state.push.running)) next = { ...next, push: { ...idlePush(), running: true } };
  else if (!push && state.push.running && (before === null || was("push"))) next = { ...next, push: { ...state.push, running: false } };
  if (init && (before === null || !state.init.running)) next = { ...next, init: { ...idleInit(), running: true, name: init.name ?? null } };
  else if (!init && state.init.running && (before === null || was("init"))) next = { ...next, init: { ...state.init, running: false } };
  return next;
}

/** The jobs that are neither a push nor an init, which have no pane of their own. @param {Job[]} jobs */
export const otherJobs = (jobs) => jobs.filter((j) => j.kind !== "push" && j.kind !== "init");
