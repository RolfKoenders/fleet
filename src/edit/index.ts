/**
 * Edits to the config repo's files that keep every comment, blank line and list style: operations
 * are held in memory, spliced into the text, checked by loading each host with the result as an overlay.
 */
export { applyOps, DEFAULTS_FILE, hostFile, CATALOG_FILES } from "./ops.ts";
export type { Applied, Dropped, EditOp, Files, PickKind } from "./ops.ts";
export { validate } from "./validate.ts";
export type { HostProblems } from "./validate.ts";
export type { Value } from "./entries.ts";
export { ciphertextProblem, fingerprint, parseSopsText, reviewText, SECRET_NAME, SECRETS_PATH, secretsOwner, MAX_SECRETS_TEXT } from "./secretfile.ts";
