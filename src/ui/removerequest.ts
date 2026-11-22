import { isHostName } from "../hostremove.ts";
import type { RemoveRequest } from "../hostremove.ts";
import { BadRequest } from "./request.ts";

/** The name from a request body, checked. */
export function removeFields(body: unknown): RemoveRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("the body must be a JSON object");
  const { name } = body as Record<string, unknown>;
  if (!isHostName(name)) throw new BadRequest("name must be the name of a host");
  return { name };
}

/** The request body for removing a host: its name, and the confirmation. */
export function removeRequest(body: unknown): RemoveRequest {
  const request = removeFields(body);
  // The page asks first, naming what will be deleted and what stays; a call that did not is refused.
  if ((body as Record<string, unknown>).confirm !== true) throw new BadRequest("removing a host deletes its files and commits and pushes the config repo: it must be confirmed");
  return request;
}
