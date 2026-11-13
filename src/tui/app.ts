import type { App, Cmd, Core } from "./runtime.ts";
import type { Conflict } from "../plan.ts";
import type { ConflictsResult, HostResult, Probe, RemoteConflicts } from "./probe.ts";
import type { FleetEvent } from "../events.ts";
import type { StatusFields } from "../status.ts";
import type { ContextReport } from "../context.ts";
import type { HostContext } from "../contextall.ts";
import type { PreviewResult, Pusher } from "./pusher.ts";
import { finish, reduce, startRun } from "../pushrun.ts";
import type { PushEnd, PushRun } from "../pushrun.ts";
import { CONFIRM_WORD, MESSAGE_MAX, pushBlock } from "./views/push.ts";
import { homeLayout } from "./layout.ts";
import { items, search } from "./palette.ts";
import type { Action, Screen } from "./palette.ts";
import { SCREENS } from "./palette.ts";
import type { Key } from "./input.ts";
import type { Model } from "./model.ts";
import { visibleRows } from "./model.ts";
import type { Size } from "./terminal.ts";
import type { CachedContext, CachedHost } from "./cache.ts";
import { shown } from "./contextshown.ts";
import type { DoctorResult } from "./doctorread.ts";
import type { CatalogView, CommitDiff, History, SecretsView } from "./reads.ts";
import { drawApp } from "./views/index.ts";
import { catalogItems } from "./views/catalog.ts";
import { diffLines } from "./views/timeline.ts";
import { conflictEntries } from "./views/conflicts.ts";

export type HostLive = {
  phase: "loading" | "done";
  /** Bumped at each refresh, so an answer to an old question is ignored. */
  gen: number;
  since: number;
  /** When the answer arrived, on the runtime's clock. */
  at: number | null;
  result: HostResult | null;
  /** Set while `result` is what an earlier run of the bridge saw and no answer to this run has come: how long ago, and when it was loaded. It is not live. */
  seen: { agoSeconds: number; since: number } | null;
};

/**
 * One host's startup context. `report` is the last good one, cut to what the screen shows (see `contextshown.ts`); it is
 * what an earlier run saw while `seen` is set. `failure` is why the latest question gave no new report: a host on an
 * older pin has none and shows nothing, one that cannot be reached keeps the remembered report, marked as old.
 */
export type ContextLive = {
  phase: "loading" | "done";
  /** Bumped at each question, so an answer to an old one is ignored. */
  gen: number;
  report: ContextReport | null;
  seen: { agoSeconds: number; since: number } | null;
  failure: { result: Exclude<HostContext["result"], "ok">; detail: string } | null;
};

export type RemoteLive = { phase: "loading" | "done"; gen: number; result: RemoteConflicts | null };

/** `selected` runs over this host's conflicts, then the other hosts', in host order, except that `first` (the host the bridge was opened on) comes first (see `conflictEntries`). */
export type ConflictsLive = { phase: "loading" | "done"; items: Conflict[]; detail: string | null; selected: number; remote: Record<string, RemoteLive>; first: string | null };

/** Where a push is: not started, being reviewed (nothing runs until the word is typed), running, or over. */
export type PushState =
  | { phase: "idle" }
  | { phase: "review"; gen: number; preview: PreviewResult | null; typed: string; message: string; focus: "confirm" | "message" }
  | { phase: "running" | "finished"; run: PushRun };

export type TimelineLive = {
  phase: "loading" | "done";
  history: History | null;
  selected: number;
  /** The diff of each commit asked for, by sha; `loading` while it is being read. */
  diffs: Record<string, CommitDiff | "loading">;
  scroll: number;
};

export type SecretsLive = { phase: "loading" | "done"; view: SecretsView | null; mode: "names" | "hosts"; selected: number };

export type CatalogLive = { phase: "loading" | "done"; view: CatalogView | null; query: string; typing: boolean; selected: number; scroll: number };

/** Doctor is only ever asked for through a confirmation. `scope` is what was asked: this host or every host. */
export type DoctorLive = { phase: "idle" | "running" | "done"; gen: number; scope: "this" | "all"; result: DoctorResult | null };

export type Overlay = null | { kind: "help" } | { kind: "leave" } | { kind: "doctor"; off: string | null } | { kind: "palette"; query: string; selected: number };

export type State = {
  size: Size;
  demo: boolean;
  now: number;
  motion: boolean;
  model: Model;
  screen: Screen;
  overlay: Overlay;
  /** Start time of the boot animation on the runtime's clock, or null before the first tick; `done` once over or skipped. */
  boot: { start: number | null; done: boolean };
  live: Record<string, HostLive>;
  /** Each host's startup context, asked with its status. */
  contexts: Record<string, ContextLive>;
  /** The host whose largest items the context screen lists. */
  contextHost: number;
  /** True where colour is off, so the context bars tell their parts apart by character. */
  plain: boolean;
  conflicts: ConflictsLive;
  push: PushState;
  doctor: DoctorLive;
  /** Counts the reviews, so the answer to an old one is ignored. */
  reviews: number;
  timeline: TimelineLive;
  secrets: SecretsLive;
  catalog: CatalogLive;
  home: { selected: number };
  matrix: { row: number; col: number; expanded: string[] };
  fault: string | null;
};

export type Msg =
  | { type: "host"; host: string; gen: number; result: HostResult }
  | { type: "context"; host: string; gen: number; result: HostContext }
  | { type: "conflicts"; result: ConflictsResult }
  | { type: "remoteConflicts"; host: string; gen: number; result: RemoteConflicts }
  | { type: "preview"; gen: number; result: PreviewResult }
  | { type: "doctor"; gen: number; result: DoctorResult }
  | { type: "push"; event: FleetEvent }
  | { type: "pushEnd"; end: PushEnd }
  | { type: "history"; result: History }
  | { type: "commitDiff"; sha: string; result: CommitDiff }
  | { type: "secrets"; view: SecretsView }
  | { type: "catalog"; view: CatalogView }
  | { type: "fault"; text: string };

/** `pusher` is absent where pushing is not offered. */
export type Options = {
  model: Model;
  probe: Probe;
  pusher?: Pusher;
  motion: boolean;
  boot: boolean;
  /** What an earlier run saw of each host, shown (as old) until the host answers. */
  cached?: Record<string, CachedHost>;
  /** Called with each good answer, so it can be remembered for the next run. */
  remember?: (host: string, status: StatusFields) => void;
  /** What an earlier run saw of each other host's startup context, and where to keep what this run sees. */
  cachedContext?: Record<string, CachedContext>;
  rememberContext?: (host: string, report: ContextReport) => void;
  /** Set where there is no colour: the context bars then use a different character for each part. */
  plain?: boolean;
  /** Set where doctor must not run (the demo): the reason, shown when `d` is pressed. */
  noDoctor?: string;
  /** Set by the demo, and only by it: the hosts are made up, and the bridge says so. */
  demo?: boolean;
  /** The screen to open on, and the host to have selected on it. Both are names the caller has already checked. */
  view?: Screen;
  host?: string;
};

export const BOOT_MS = 1700;
/** A tick this far behind means the terminal or the link cannot keep up with the animation. */
const LAG_MS = 150;

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export function createApp(options: Options): App<State, Msg> {
  const { model, probe, pusher } = options;
  const palette = items(model);

  const askHost = (name: string, gen: number): Cmd<Msg> => async ({ send, signal }) => {
    const host = model.hosts.find((h) => h.name === name)!;
    const result = await probe.host(host, signal);
    send({ type: "host", host: name, gen, result });
  };
  const askContext = (name: string, gen: number): Cmd<Msg> => async ({ send, signal }) => {
    const host = model.hosts.find((h) => h.name === name)!;
    const result = probe.context ? await probe.context(host, signal) : ({ host: name, result: "error", context: null, detail: "this view cannot ask for it" } as const);
    send({ type: "context", host: name, gen, result });
  };
  const askConflicts: Cmd<Msg> = async ({ send, signal }) => {
    send({ type: "conflicts", result: await probe.conflicts(signal) });
  };

  const askRemote = (name: string, gen: number): Cmd<Msg> => async ({ send, signal }) => {
    const host = model.hosts.find((h) => h.name === name)!;
    const result = probe.hostConflicts ? await probe.hostConflicts(host, signal) : ({ ok: false, reason: "error", detail: "this view cannot ask other hosts" } as const);
    send({ type: "remoteConflicts", host: name, gen, result });
  };

  const askPreview = (gen: number): Cmd<Msg> => async ({ send, signal }) => {
    send({ type: "preview", gen, result: pusher ? await pusher.preview(signal) : { ok: false, detail: "pushing is not offered in this view" } });
  };
  // The one place a push starts. It is the real `fleet push`; its events come back as messages.
  const startPush = (message: string): Cmd<Msg> => async ({ send }) => {
    const end = await pusher!.run((event) => send({ type: "push", event }), message === "" ? undefined : message);
    send({ type: "pushEnd", end });
  };

  // The one place doctor is asked. It starts real servers, so it is only reached from the confirmation.
  const askDoctor = (gen: number, all: boolean): Cmd<Msg> => async ({ send, signal }) => {
    send({ type: "doctor", gen, result: await probe.doctor!(all, signal) });
  };
  const doctorOff = (): string | null => options.noDoctor ?? (probe.doctor === undefined ? "this view has no way to run it" : null);

  function onDoctorOverlay(state: State, key: Key): [State, Cmd<Msg>[]] {
    const close: State = { ...state, overlay: null };
    if (key.name === "escape" || key.text === "n" || key.text === "q" || (key.ctrl && key.text === "c")) return [close, []];
    if (state.overlay?.kind !== "doctor" || state.overlay.off !== null) return [state, []];
    const scope = key.text === "t" ? "this" : key.name === "enter" || key.text === "y" ? "all" : null;
    if (scope === null) return [state, []];
    const gen = state.doctor.gen + 1;
    return [{ ...close, doctor: { phase: "running", gen, scope, result: null } }, [askDoctor(gen, scope === "all" && model.hosts.length > 1)]];
  }

  /** Opens the review, which reads and changes nothing. A push in flight is watched, not started again. */
  function review(state: State): [State, Cmd<Msg>[]] {
    const closed: State = { ...state, overlay: null, screen: "push" };
    if (state.push.phase === "running") return [closed, []];
    const gen = state.reviews + 1;
    return [{ ...closed, reviews: gen, push: { phase: "review", gen, preview: null, typed: "", message: "", focus: "confirm" } }, [askPreview(gen)]];
  }

  /** Quitting while a push runs asks first; the push is never stopped by it. */
  function leave(state: State): [State, Cmd<Msg>[]] {
    if (state.push.phase === "running" && state.overlay?.kind !== "leave") return [{ ...state, overlay: { kind: "leave" } }, []];
    return [state, [({ quit }) => quit(0)]];
  }

  function onReview(state: State, key: Key): [State, Cmd<Msg>[]] {
    const p = state.push as Extract<PushState, { phase: "review" }>;
    if (key.ctrl && key.text === "c") return [state, [({ quit }) => quit(0)]];
    if (key.name === "escape") return [{ ...state, push: { phase: "idle" } }, []];
    // Read the files again, after a secret was removed or gitignored.
    if (key.ctrl && key.text === "r") {
      const gen = state.reviews + 1;
      return [{ ...state, reviews: gen, push: { ...p, gen, preview: null } }, [askPreview(gen)]];
    }
    const field = p.focus;
    if (key.name === "tab" || key.name === "backtab") return [{ ...state, push: { ...p, focus: field === "confirm" ? "message" : "confirm" } }, []];
    const edit = (text: string, max: number): [State, Cmd<Msg>[]] => [{ ...state, push: { ...p, ...(field === "confirm" ? { typed: text.slice(0, max) } : { message: text.slice(0, max) }) } }, []];
    const text = field === "confirm" ? p.typed : p.message;
    if (key.name === "backspace") return edit([...text].slice(0, -1).join(""), 24);
    if (key.ctrl && key.text === "u") return edit("", 24);
    if (key.name === "char" && !key.ctrl && !key.alt && key.text && !/[\u0000-\u001f\u007f]/.test(key.text)) return edit(text + key.text, field === "confirm" ? 24 : MESSAGE_MAX);
    if (key.name === "enter") {
      // Enter in the message box only moves on to the word. Whatever is typed there is a message, never the word.
      if (field === "message") return [{ ...state, push: { ...p, focus: "confirm" } }, []];
      if (p.typed !== CONFIRM_WORD || pusher === undefined || pushBlock(p) !== null) return [state, []];
      return [{ ...state, push: { phase: "running", run: startRun(model.hosts, state.now) } }, [startPush(p.message.trim())]];
    }
    return [state, []];
  }

  const askHistory: Cmd<Msg> = async ({ send, signal }) => send({ type: "history", result: await probe.history(signal) });
  const askSecrets: Cmd<Msg> = async ({ send, signal }) => send({ type: "secrets", view: await probe.secrets(signal) });
  const askCatalog: Cmd<Msg> = async ({ send, signal }) => send({ type: "catalog", view: await probe.catalog(signal) });
  const askDiff = (sha: string): Cmd<Msg> => async ({ send, signal }) => send({ type: "commitDiff", sha, result: await probe.commitDiff(sha, signal) });

  /** Reads the diff of the selected commit, once. */
  function wantDiff(state: State): [State, Cmd<Msg>[]] {
    const t = state.timeline;
    const commit = t.history?.ok ? t.history.commits[t.selected] : undefined;
    if (!commit || t.diffs[commit.sha] !== undefined) return [state, []];
    return [{ ...state, timeline: { ...t, diffs: { ...t.diffs, [commit.sha]: "loading" } } }, [askDiff(commit.sha)]];
  }

  /** Asks `hosts` for their startup context, which reads files and nothing else; what was known stays until the answer replaces it. */
  function askContexts(state: State, hosts: string[]): [State["contexts"], Cmd<Msg>[]] {
    const contexts = { ...state.contexts };
    const cmds: Cmd<Msg>[] = [];
    for (const name of hosts) {
      const h = model.hosts.find((x) => x.name === name)!;
      const before = contexts[name];
      const gen = (before?.gen ?? 0) + 1;
      if (!h.self && h.ssh === null) {
        contexts[name] = { phase: "done", gen, report: null, seen: null, failure: { result: "timer", detail: "no ssh destination" } };
        continue;
      }
      contexts[name] = { phase: "loading", gen, report: before?.report ?? null, seen: before?.seen ?? null, failure: before?.failure ?? null };
      cmds.push(askContext(name, gen));
    }
    return [contexts, cmds];
  }

  /** Starts asking every host at once; each answers on its own time. */
  function refresh(state: State): [State, Cmd<Msg>[]] {
    const live = { ...state.live };
    const cmds: Cmd<Msg>[] = [];
    const [contexts, contextCmds] = askContexts(state, model.hosts.map((h) => h.name));
    cmds.push(...contextCmds);
    for (const h of model.hosts) {
      const gen = (live[h.name]?.gen ?? 0) + 1;
      // A host with no ssh destination cannot be asked, so there is nothing to wait for.
      if (!h.self && h.ssh === null) {
        live[h.name] = { phase: "done", gen, since: state.now, at: state.now, result: { result: "timer", status: null }, seen: null };
        continue;
      }
      live[h.name] = { phase: "loading", gen, since: state.now, at: live[h.name]?.at ?? null, result: live[h.name]?.result ?? null, seen: live[h.name]?.seen ?? null };
      cmds.push(askHost(h.name, gen));
    }
    const hasSelf = model.self !== null;
    const conflicts: ConflictsLive = { ...state.conflicts, phase: hasSelf ? "loading" : "done", detail: hasSelf ? null : "this host has no name yet, so its own conflicts cannot be planned" };
    if (hasSelf) cmds.push(askConflicts);
    // What was read before stays on screen until the new answer replaces it.
    cmds.push(askHistory, askSecrets, askCatalog);
    return [
      {
        ...state,
        live,
        contexts,
        conflicts,
        timeline: { ...state.timeline, phase: "loading", diffs: {} },
        secrets: { ...state.secrets, phase: "loading" },
        catalog: { ...state.catalog, phase: "loading" },
      },
      cmds,
    ];
  }

  function go(state: State, action: Action): [State, Cmd<Msg>[]] {
    const closed: State = { ...state, overlay: null };
    switch (action.do) {
      case "screen":
        return [{ ...closed, screen: action.screen }, []];
      case "host": {
        const i = model.hosts.findIndex((h) => h.name === action.name);
        return [{ ...closed, screen: "home", home: { selected: Math.max(0, i) } }, []];
      }
      case "row": {
        const rows = visibleRows(model, new Set(state.matrix.expanded));
        const row = Math.max(0, rows.findIndex((r) => r.name === action.name && r.kind === action.kind));
        return [{ ...closed, screen: "matrix", matrix: { ...state.matrix, row } }, []];
      }
      case "refresh":
        return refresh(closed);
      case "help":
        return [{ ...closed, overlay: { kind: "help" } }, []];
      case "doctor":
        return [{ ...closed, overlay: state.doctor.phase === "running" ? null : { kind: "doctor", off: doctorOff() } }, []];
      case "push":
        return review(closed);
      case "quit":
        return leave(state);
    }
  }

  function moveHome(state: State, key: Key): State {
    const n = model.hosts.length;
    if (n === 0) return state;
    const layout = homeLayout(state.size);
    const step = layout.mode === "cards" ? layout.cols : 1;
    const horizontal = layout.mode === "cards" ? 1 : 0;
    const d = key.name === "left" || key.text === "h" ? -horizontal : key.name === "right" || key.text === "l" ? horizontal : key.name === "up" || key.text === "k" ? -step : key.name === "down" || key.text === "j" ? step : 0;
    return { ...state, home: { selected: clamp(state.home.selected + d, 0, n - 1) } };
  }

  function moveMatrix(state: State, key: Key): State {
    const rows = visibleRows(model, new Set(state.matrix.expanded));
    const m = state.matrix;
    const d = (a: string, b: string) => (key.name === a || key.text === b ? 1 : 0);
    const dr = d("down", "j") - d("up", "k") + (key.name === "pagedown" ? 8 : 0) - (key.name === "pageup" ? 8 : 0);
    const dc = d("right", "l") - d("left", "h");
    let { row, col } = m;
    row = clamp(row + dr, 0, Math.max(0, rows.length - 1));
    col = clamp(col + dc, 0, Math.max(0, model.hosts.length - 1));
    if (key.name === "home" || key.text === "g") row = 0;
    if (key.name === "end" || key.text === "G") row = Math.max(0, rows.length - 1);
    let expanded = m.expanded;
    if (key.name === "enter" || key.text === " ") {
      const at = rows[row];
      const bundle = at?.kind === "bundle" ? at.name : at?.kind === "skill" ? at.bundle! : null;
      if (bundle !== null) {
        expanded = expanded.includes(bundle) ? expanded.filter((b) => b !== bundle) : [...expanded, bundle];
        if (at!.kind === "skill") row = visibleRows(model, new Set(expanded)).findIndex((r) => r.kind === "bundle" && r.name === bundle);
      }
    }
    return { ...state, matrix: { row, col, expanded } };
  }

  function moveConflicts(state: State, key: Key): State {
    const n = conflictEntries(state).length;
    const d = key.name === "down" || key.text === "j" ? 1 : key.name === "up" || key.text === "k" ? -1 : 0;
    return { ...state, conflicts: { ...state.conflicts, selected: clamp(state.conflicts.selected + d, 0, Math.max(0, n - 1)) } };
  }

  function moveTimeline(state: State, key: Key): [State, Cmd<Msg>[]] {
    const t = state.timeline;
    const n = t.history?.ok ? t.history.commits.length : 0;
    const d = key.name === "down" || key.text === "j" ? 1 : key.name === "up" || key.text === "k" ? -1 : 0;
    const page = key.name === "pagedown" ? 1 : key.name === "pageup" ? -1 : 0;
    let selected = clamp(t.selected + d, 0, Math.max(0, n - 1));
    if (key.name === "home" || key.text === "g") selected = 0;
    if (key.name === "end" || key.text === "G") selected = Math.max(0, n - 1);
    const commit = t.history?.ok ? t.history.commits[selected] : undefined;
    const longest = commit ? diffLines(t.diffs[commit.sha], 0, false).length : 0;
    const scroll = selected !== t.selected ? 0 : clamp(t.scroll + page * 8, 0, Math.max(0, longest - 1));
    return wantDiff({ ...state, timeline: { ...t, selected, scroll } });
  }

  function moveContext(state: State, key: Key): State {
    const d = key.name === "down" || key.name === "right" || key.text === "j" || key.text === "l" ? 1 : key.name === "up" || key.name === "left" || key.text === "k" || key.text === "h" ? -1 : 0;
    let host = clamp(state.contextHost + d, 0, Math.max(0, model.hosts.length - 1));
    if (key.name === "home" || key.text === "g") host = 0;
    if (key.name === "end" || key.text === "G") host = Math.max(0, model.hosts.length - 1);
    return { ...state, contextHost: host };
  }

  function moveSecrets(state: State, key: Key): State {
    const sc = state.secrets;
    if (key.text === "v") return { ...state, secrets: { ...sc, mode: sc.mode === "names" ? "hosts" : "names", selected: 0 } };
    const n = sc.mode === "names" ? (sc.view?.entries.length ?? 0) : (sc.view?.hosts.length ?? 0);
    const d = key.name === "down" || key.text === "j" ? 1 : key.name === "up" || key.text === "k" ? -1 : 0;
    let selected = clamp(sc.selected + d + (key.name === "pagedown" ? 8 : 0) - (key.name === "pageup" ? 8 : 0), 0, Math.max(0, n - 1));
    if (key.name === "home" || key.text === "g") selected = 0;
    if (key.name === "end" || key.text === "G") selected = Math.max(0, n - 1);
    return { ...state, secrets: { ...sc, selected } };
  }

  function onFilter(state: State, key: Key): State {
    const c = state.catalog;
    const set = (query: string, typing: boolean): State => ({ ...state, catalog: { ...c, query, typing, selected: 0, scroll: 0 } });
    if (key.name === "escape" || (key.ctrl && key.text === "c")) return set("", false);
    if (key.name === "enter") return { ...state, catalog: { ...c, typing: false } };
    if (key.name === "backspace") return set([...c.query].slice(0, -1).join(""), true);
    if (key.ctrl && key.text === "u") return set("", true);
    if (key.name === "down" || key.name === "up") return moveCatalog(state, key);
    if (key.name === "char" && !key.ctrl && !key.alt && key.text) return set(c.query + key.text, true);
    return state;
  }

  function moveCatalog(state: State, key: Key): State {
    const c = state.catalog;
    const n = catalogItems(c.view, c.query).length;
    const d = key.name === "down" || (!c.typing && key.text === "j") ? 1 : key.name === "up" || (!c.typing && key.text === "k") ? -1 : 0;
    const selected = clamp(c.selected + d, 0, Math.max(0, n - 1));
    const page = key.name === "pagedown" ? 1 : key.name === "pageup" ? -1 : 0;
    return { ...state, catalog: { ...c, selected, scroll: selected !== c.selected ? 0 : Math.max(0, c.scroll + page * 8) } };
  }

  function onPalette(state: State, key: Key): [State, Cmd<Msg>[]] {
    const o = state.overlay as Extract<Overlay, { kind: "palette" }>;
    const matches = search(palette, o.query);
    const set = (query: string, selected: number): [State, Cmd<Msg>[]] => [{ ...state, overlay: { kind: "palette", query, selected: clamp(selected, 0, Math.max(0, search(palette, query).length - 1)) } }, []];
    if (key.name === "escape" || (key.ctrl && (key.text === "k" || key.text === "c"))) return [{ ...state, overlay: null }, []];
    if (key.name === "enter") {
      const m = matches[o.selected];
      return m ? go(state, m.item.action) : [{ ...state, overlay: null }, []];
    }
    if (key.name === "down" || key.name === "tab" || (key.ctrl && (key.text === "n" || key.text === "j"))) return set(o.query, (o.selected + 1) % Math.max(1, matches.length));
    if (key.name === "up" || key.name === "backtab" || (key.ctrl && (key.text === "p" || key.text === "k"))) return set(o.query, (o.selected - 1 + matches.length) % Math.max(1, matches.length));
    if (key.name === "backspace") return set([...o.query].slice(0, -1).join(""), 0);
    if (key.ctrl && key.text === "u") return set("", 0);
    if (key.name === "char" && !key.ctrl && !key.alt && key.text) return set(o.query + key.text, 0);
    return [state, []];
  }

  function onKey(state: State, key: Key): [State, Cmd<Msg>[]] {
    if (!state.boot.done) return [{ ...state, boot: { ...state.boot, done: true } }, []];
    if (state.overlay?.kind === "leave") {
      if (key.name === "escape") return [{ ...state, overlay: null }, []];
      if (key.text === "q" || key.name === "enter" || (key.ctrl && key.text === "c")) return [state, [({ quit }) => quit(0)]];
      return [state, []];
    }
    if (state.overlay?.kind === "doctor") return onDoctorOverlay(state, key);
    if (state.overlay === null && state.screen === "catalog" && state.catalog.typing) return [onFilter(state, key), []];
    if (state.overlay?.kind === "palette") return onPalette(state, key);
    if (state.overlay?.kind === "help") {
      if (key.name === "escape" || key.text === "?" || key.text === "q" || key.name === "enter") return [{ ...state, overlay: null }, []];
      return [state, []];
    }
    if (state.screen === "push" && state.push.phase === "review") return onReview(state, key);
    const ch = key.ctrl || key.alt ? undefined : key.text;
    if (key.ctrl && key.text === "c") return leave(state);
    if (key.ctrl && key.text === "k") return [{ ...state, overlay: { kind: "palette", query: "", selected: 0 } }, []];
    if (ch === ":" || ch === "/") return [{ ...state, overlay: { kind: "palette", query: "", selected: 0 } }, []];
    if (ch === "q") return leave(state);
    if (ch === "P") return review(state);
    if (ch === "?") return [{ ...state, overlay: { kind: "help" } }, []];
    if (ch === "r") return refresh(state);
    if (ch === "d") return go(state, { do: "doctor" });
    const tab = SCREENS.find((s) => s.key === ch);
    if (tab) return [{ ...state, screen: tab.id }, []];
    if (key.name === "tab" || key.name === "backtab") {
      const i = SCREENS.findIndex((s) => s.id === state.screen);
      return [{ ...state, screen: SCREENS[(i + (key.name === "tab" ? 1 : SCREENS.length - 1)) % SCREENS.length]!.id }, []];
    }
    if (key.name === "escape") {
      if (state.screen === "catalog" && state.catalog.query !== "") return [{ ...state, catalog: { ...state.catalog, query: "", selected: 0, scroll: 0 } }, []];
      return [{ ...state, screen: "home" }, []];
    }
    if (state.screen === "home") {
      if (key.name === "enter") return [{ ...state, screen: "matrix", matrix: { ...state.matrix, col: state.home.selected } }, []];
      if (ch === "c") return [{ ...state, screen: "conflicts" }, []];
      return [moveHome(state, key), []];
    }
    if (state.screen === "matrix") return [moveMatrix(state, key), []];
    if (state.screen === "push") return [state, []];
    if (state.screen === "timeline") return moveTimeline(state, key);
    if (state.screen === "context") return [moveContext(state, key), []];
    if (state.screen === "secrets") return [moveSecrets(state, key), []];
    if (state.screen === "catalog") {
      if (ch === "f") return [{ ...state, catalog: { ...state.catalog, typing: true } }, []];
      return [moveCatalog(state, key), []];
    }
    return [moveConflicts(state, key), []];
  }

  return {
    init(size) {
      const live: Record<string, HostLive> = {};
      for (const h of model.hosts) {
        const kept = options.cached?.[h.name];
        // This host is read in place and answers at once, so only the others are remembered.
        if (kept && !h.self) live[h.name] = { phase: "loading", gen: 0, since: 0, at: null, result: kept.result, seen: { agoSeconds: kept.agoSeconds, since: 0 } };
      }
      const contexts: Record<string, ContextLive> = {};
      for (const h of model.hosts) {
        const kept = options.cachedContext?.[h.name];
        if (kept && !h.self) contexts[h.name] = { phase: "loading", gen: 0, report: kept.report, seen: { agoSeconds: kept.agoSeconds, since: 0 }, failure: null };
      }
      // The host asked for, or else this one, is the one selected on Home and in the Matrix.
      const asked = options.host === undefined ? -1 : model.hosts.findIndex((h) => h.name === options.host);
      const selected = asked >= 0 ? asked : Math.max(0, model.hosts.findIndex((h) => h.self));
      const state: State = {
        size,
        demo: options.demo === true,
        now: 0,
        motion: options.motion,
        model,
        screen: options.view ?? "home",
        overlay: null,
        boot: { start: null, done: !options.boot },
        live,
        contexts,
        contextHost: selected,
        plain: options.plain === true,
        conflicts: { phase: "loading", items: [], detail: null, selected: 0, remote: {}, first: asked >= 0 ? options.host! : null },
        push: { phase: "idle" },
        doctor: { phase: "idle", gen: 0, scope: "all", result: null },
        reviews: 0,
        timeline: { phase: "loading", history: null, selected: 0, diffs: {}, scroll: 0 },
        secrets: { phase: "loading", view: null, mode: "names", selected: 0 },
        catalog: { phase: "loading", view: null, query: "", typing: false, selected: 0, scroll: 0 },
        home: { selected },
        matrix: { row: 0, col: selected, expanded: [] },
        fault: null,
      };
      return refresh(state);
    },

    update(state, message: Core | Msg) {
      switch (message.type) {
        case "key":
          return onKey(state, message.key);
        case "paste":
          return state.overlay?.kind === "palette" ? [{ ...state, overlay: { kind: "palette", query: state.overlay.query + message.text.replace(/\s+/g, " "), selected: 0 } }, []] : [state, []];
        case "resize":
          return [{ ...state, size: message.size }, []];
        case "tick": {
          const boot = { ...state.boot };
          if (!boot.done) {
            boot.start ??= message.now;
            // Skip the animation when the terminal cannot keep up with it.
            if (message.now - boot.start >= BOOT_MS || message.late > LAG_MS) boot.done = true;
          }
          return [{ ...state, now: message.now, boot }, []];
        }
        case "host": {
          const current = state.live[message.host];
          if (!current || current.gen !== message.gen) return [state, []];
          const remember = options.remember;
          const keep: Cmd<Msg>[] = remember && message.result.result === "ok" && message.result.status && !model.hosts.find((h) => h.name === message.host)?.self ? [() => remember(message.host, message.result.status!)] : [];
          // A host that says it has conflicts is asked for them in full (read-only there too); one that says none has nothing to list.
          const self = model.hosts.find((h) => h.name === message.host)?.self ?? false;
          const n = message.result.status?.conflicts ?? 0;
          const remote = { ...state.conflicts.remote };
          const cmds = [...keep];
          if (!self && n > 0) {
            const rgen = (remote[message.host]?.gen ?? 0) + 1;
            remote[message.host] = { phase: "loading", gen: rgen, result: remote[message.host]?.result ?? null };
            cmds.push(askRemote(message.host, rgen));
          } else delete remote[message.host];
          return [{ ...state, conflicts: { ...state.conflicts, remote }, live: { ...state.live, [message.host]: { ...current, phase: "done", at: state.now, result: message.result, seen: null } } }, cmds];
        }
        case "context": {
          const current = state.contexts[message.host];
          if (!current || current.gen !== message.gen) return [state, []];
          const r = message.result;
          if (r.result === "ok" && r.context !== null) {
            const report = shown(r.context);
            const remember = options.rememberContext;
            const self = model.hosts.find((h) => h.name === message.host)?.self ?? false;
            const keep: Cmd<Msg>[] = remember && !self ? [() => remember(message.host, report)] : [];
            return [{ ...state, contexts: { ...state.contexts, [message.host]: { ...current, phase: "done", report, seen: null, failure: null } } }, keep];
          }
          // A host that cannot be reached keeps what an earlier run saw, marked as old; one on an older pin has nothing to show.
          const failure = { result: r.result === "ok" ? ("error" as const) : r.result, detail: r.detail ?? "" };
          const old = failure.result === "old";
          return [{ ...state, contexts: { ...state.contexts, [message.host]: { ...current, phase: "done", report: old || current.seen === null ? null : current.report, seen: old ? null : current.seen, failure } } }, []];
        }
        case "conflicts": {
          const r = message.result;
          const conflicts: ConflictsLive = r.ok ? { ...state.conflicts, phase: "done", items: r.items, detail: null, selected: clamp(state.conflicts.selected, 0, Math.max(0, r.items.length - 1)) } : { ...state.conflicts, phase: "done", items: [], detail: r.detail, selected: 0 };
          return [{ ...state, conflicts }, []];
        }
        case "remoteConflicts": {
          const cur = state.conflicts.remote[message.host];
          if (!cur || cur.gen !== message.gen) return [state, []];
          const conflicts = { ...state.conflicts, remote: { ...state.conflicts.remote, [message.host]: { ...cur, phase: "done" as const, result: message.result } } };
          return [{ ...state, conflicts: { ...conflicts, selected: clamp(conflicts.selected, 0, Math.max(0, conflictEntries({ ...state, conflicts }).length - 1)) } }, []];
        }
        case "preview": {
          if (state.push.phase !== "review" || state.push.gen !== message.gen) return [state, []];
          return [{ ...state, push: { ...state.push, preview: message.result } }, []];
        }
        case "doctor": {
          if (state.doctor.gen !== message.gen) return [state, []];
          // The sizes of the servers just changed, on this host or on all: ask for the context again.
          const [contexts, cmds] = askContexts(state, state.doctor.scope === "all" ? model.hosts.map((h) => h.name) : model.hosts.filter((h) => h.self).map((h) => h.name));
          return [{ ...state, contexts, doctor: { ...state.doctor, phase: "done", result: message.result } }, cmds];
        }
        case "push": {
          if (state.push.phase !== "running") return [state, []];
          return [{ ...state, push: { phase: "running", run: reduce(state.push.run, message.event) } }, []];
        }
        case "pushEnd": {
          if (state.push.phase !== "running") return [state, []];
          // The hosts' cards are stale now, so ask them again.
          const [next, cmds] = refresh({ ...state, overlay: state.overlay?.kind === "leave" ? null : state.overlay, push: { phase: "finished", run: finish(state.push.run, message.end) } });
          return [next, cmds];
        }
        case "history": {
          const t = state.timeline;
          const n = message.result.ok ? message.result.commits.length : 0;
          return wantDiff({ ...state, timeline: { ...t, phase: "done", history: message.result, selected: clamp(t.selected, 0, Math.max(0, n - 1)) } });
        }
        case "commitDiff":
          return [{ ...state, timeline: { ...state.timeline, diffs: { ...state.timeline.diffs, [message.sha]: message.result } } }, []];
        case "secrets":
          return [{ ...state, secrets: { ...state.secrets, phase: "done", view: message.view, selected: clamp(state.secrets.selected, 0, Math.max(0, (state.secrets.mode === "names" ? message.view.entries.length : message.view.hosts.length) - 1)) } }, []];
        case "catalog":
          return [{ ...state, catalog: { ...state.catalog, phase: "done", view: message.view } }, []];
        case "fault":
          return [{ ...state, fault: message.text }, []];
      }
    },

    view: drawApp,

    tick(state) {
      if (!state.boot.done) return 33;
      const loading = Object.values(state.live).some((l) => l.phase === "loading") || Object.values(state.contexts).some((l) => l.phase === "loading") || state.conflicts.phase === "loading" || state.timeline.phase === "loading" || state.secrets.phase === "loading" || state.catalog.phase === "loading";
      const pushing = state.push.phase === "running" || state.doctor.phase === "running" || (state.push.phase === "review" && state.push.preview === null);
      return (loading || pushing) && state.motion ? 80 : 1000;
    },
  };
}
