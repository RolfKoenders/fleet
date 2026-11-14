import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG_FILES } from "../edit/index.ts";
import { hostNames } from "../recipients.ts";
import { BadRequest } from "./request.ts";

/**
 * The file an item is written in, for the page's YAML toggle: asked for by the kind of item and its name, never by a path, so
 * the page cannot read any other file. A catalog file is the same for every item in it; a host's is `hosts/<name>.yaml`.
 * A secret's value is never in these files, only `secret:NAME`.
 */

const KINDS = { server: CATALOG_FILES.servers, source: CATALOG_FILES.sources, bundle: CATALOG_FILES.bundles } as const;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type YamlRequest = { kind: keyof typeof KINDS | "host"; name: string };

export function yamlRequest(body: unknown): YamlRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("the body must be a JSON object");
  const { kind, name } = body as Record<string, unknown>;
  if (kind !== "server" && kind !== "source" && kind !== "bundle" && kind !== "host") throw new BadRequest("kind must be server, source, bundle or host");
  if (typeof name !== "string" || !NAME.test(name)) throw new BadRequest("name must be the name of an item: letters, digits, dot, dash and underscore");
  return { kind, name };
}

/** The path and text of the item's file as it is on disk, or null for a host that does not exist. A catalog file that is missing is empty. */
export function yamlOf(configDir: string, request: YamlRequest): { path: string; text: string } | null {
  if (request.kind === "host" && !hostNames(configDir).includes(request.name)) return null;
  const path = request.kind === "host" ? `hosts/${request.name}.yaml` : KINDS[request.kind];
  try {
    return { path, text: readFileSync(join(configDir, path), "utf8") };
  } catch {
    return { path, text: "" };
  }
}
