// The seat Agenda's vault-IO suites drive, shared by `logic.test.ts` and
// `logic-search.test.ts` (#839 W2-1).
//
// A RECORDING FAKE, NOT A MOCK. The frame, the gateway and the repaint entry
// point are small objects that accumulate what a member would actually
// experience — the sentence now on the frame's one status line and every
// sentence before it, the typed commands and reads that reached the gateway,
// and one snapshot per repaint of the guest lists and search rows that paint
// would show. Suites assert that accumulated state, so a case fails when the
// OUTCOME is wrong (the wrong sentence, a guest row that never moved, a window
// re-read that should not have happened) rather than when the call that
// produced it is spelled differently.
//
// NODE, NOT JSDOM, and deliberately so: both suites are mutation seeds
// (`stryker.agenda.config.mjs`), and Stryker's vitest runner reports "No tests
// were executed" for a jsdom project — a suite under the `@vitest-environment
// jsdom` docblock defends nothing in the mutation lane. The browser surface
// this module touches is one `querySelector` plus `textContent`/`hidden`, and
// `window.centraid`; both are stood up by hand here, so anything the module
// reaches for beyond them fails in the suite rather than silently working.
import { onTestFinished } from "vitest";

import type { InlineFrame, InlineStatusAction } from "../inline-types.ts";
import { createLogic } from "./logic.ts";
import type { AgEvent, AppData, AppState } from "./types.ts";

export function event(patch: Partial<AgEvent> & { event_id: string }): AgEvent {
  return { dtstart: "2026-08-21T09:00:00Z", ...patch };
}

function state(patch: Partial<AppState> = {}): AppState {
  return {
    view: "week",
    anchorDay: new Date("2026-08-21T00:00:00Z"),
    search: "",
    searchResults: null,
    hiddenCals: new Set<string>(),
    selectedId: null,
    quick: null,
    editorId: null,
    createOpen: false,
    narrow: false,
    ...patch,
  };
}

function data(patch: Partial<AppData> = {}): AppData {
  return {
    events: [],
    miniEvents: [],
    calendars: [],
    calById: new Map(),
    parties: [],
    me: "p-me",
    ...patch,
  };
}

export type WriteOpts = { action: string; input?: Record<string, unknown> };
export type ReadOpts = { query: string; input?: Record<string, unknown> };

/** The one element this app writes to imperatively. */
interface BannerStub {
  textContent: string;
  hidden: boolean;
}

let banner: BannerStub | null = null;

function mountBanner(present = true): void {
  banner = present ? { textContent: "", hidden: true } : null;
  (globalThis as { document?: unknown }).document = {
    querySelector: (selector: string) =>
      selector === "#noticeBanner" ? banner : null,
  };
}

export type WriteFn = (opts: WriteOpts) => Promise<unknown>;
export type ReadFn = (opts: ReadOpts) => Promise<unknown>;

/** What the frame's ONE status line reads, and the door it offers beside it. */
export interface StatusLine {
  text: string;
  action: InlineStatusAction | null;
}

/** What one repaint would put in front of the member. */
export interface Paint {
  /** The answer each guest's row carries, per event in the loaded window. */
  partstats: (string | undefined)[][];
  /** The events the search pane lists, or null while no query is live. */
  results: string[] | null;
}

export interface Harness {
  state: AppState;
  data: AppData;
  logic: ReturnType<typeof createLogic>;
  /** The status line as it reads now, or null while it carries nothing. */
  status: () => StatusLine | null;
  /** Every sentence the status line has carried, oldest first. */
  statusTexts: string[];
  /** Every typed command that reached the gateway, in order. */
  sent: WriteOpts[];
  /** Every read the app asked the gateway for, in order. */
  asked: ReadOpts[];
  /** One entry per repaint, holding what that paint would show. */
  paints: Paint[];
  /** How many times the app re-read its window from the vault. */
  reloads: () => number;
  banner: () => { text: string; hidden: boolean };
}

export interface HarnessOver {
  state?: Partial<AppState>;
  data?: Partial<AppData>;
  write?: WriteFn;
  read?: ReadFn;
  /** Withhold the frame's notice banner, as a served mount does. */
  banner?: boolean;
}

export function harness(over: HarnessOver = {}): Harness {
  const appState = state(over.state);
  const appData = data(over.data);
  const sent: WriteOpts[] = [];
  const asked: ReadOpts[] = [];
  const answerWrite =
    over.write ?? (async () => ({ status: "executed" }) as VaultOutcome);
  const answerRead = over.read ?? (async () => ({}));
  const write: WriteFn = (opts) => {
    sent.push(opts);
    return answerWrite(opts);
  };
  const read: ReadFn = (opts) => {
    asked.push(opts);
    return answerRead(opts);
  };
  mountBanner(over.banner !== false);
  (globalThis as { window?: unknown }).window = { centraid: { read, write } };
  onTestFinished(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  });
  let line: StatusLine | null = null;
  const statusTexts: string[] = [];
  const frame: InlineFrame = {
    setAppBar: () => {},
    setStatus: (text, extra) => {
      line = { text, action: extra?.action ?? null };
      statusTexts.push(text);
    },
    clearStatus: () => {
      line = null;
    },
    claimBand: () => {},
  };
  const paints: Paint[] = [];
  const render = (): void => {
    paints.push({
      partstats: appData.events.map(
        (row) => row.attendees?.map((guest) => guest.partstat) ?? []
      ),
      results: appState.searchResults?.map((row) => row.event_id) ?? null,
    });
  };
  let reloads = 0;
  const refresh = async (): Promise<void> => {
    reloads += 1;
  };
  return {
    state: appState,
    data: appData,
    logic: createLogic({
      state: appState,
      data: appData,
      frame,
      render,
      refresh,
    }),
    status: (): StatusLine | null => line,
    statusTexts,
    sent,
    asked,
    paints,
    reloads: (): number => reloads,
    banner: () => ({
      text: banner?.textContent ?? "",
      hidden: banner?.hidden ?? true,
    }),
  };
}
