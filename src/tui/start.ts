import type { Result } from "../output.ts";
import type { Model } from "./model.ts";
import { SCREENS } from "./palette.ts";
import type { Screen } from "./palette.ts";

/** Where the bridge opens: the screen, and the host to have selected on it (null for the default). */
export type Start = { view: Screen; host: string | null };

/** The names `--view` takes: the bridge's tabs, in tab order, so a new tab is a new view. */
export const viewNames = (): Screen[] => SCREENS.map((s) => s.id);

const refuse = (what: string, name: string, valid: string): Result => ({ code: "invalid", messages: [`fleet: unknown ${what} '${name}'. ${valid}`] });

/** Null when `view` is absent or a tab's name. */
export function checkView(view: string | undefined): Result | null {
  const views = viewNames();
  return view === undefined || (views as string[]).includes(view) ? null : refuse("view", view, `The views are: ${views.join(", ")}`);
}

/** Null when `host` is absent or one of the config's hosts. */
export function checkHost(model: Model, host: string | undefined): Result | null {
  const names = model.hosts.map((h) => h.name);
  if (host === undefined || names.includes(host)) return null;
  return refuse("host", host, names.length === 0 ? "The config has no hosts" : `The hosts are: ${names.join(", ")}`);
}

/** Checks `--view` and `--host` against the tabs and the config's hosts, before the screen is taken over. */
export function resolveStart(model: Model, view: string | undefined, host: string | undefined): Start | Result {
  return checkView(view) ?? checkHost(model, host) ?? { view: (view as Screen | undefined) ?? "home", host: host ?? null };
}
