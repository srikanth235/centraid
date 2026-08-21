// The seat Notes' vault-IO suites drive, shared by `logic.test.ts`,
// `logic-commands.test.ts` and `logic-panes.test.ts` (#839 W2-1).
//
// A RECORDING FAKE, NOT A MOCK. The frame's status line, the gateway, the
// router and the repaint entry point are small objects that accumulate what a
// member would actually experience — the sentence now on the one status line
// and every sentence before it, the undo it offers beside that sentence, the
// commands and reads that reached the gateway, the routes the app moved to,
// and how many times the pane repainted or the window was re-read. Suites
// assert that accumulated state, so a case fails when the OUTCOME is wrong
// (the wrong sentence, an undo that is not offered, a library re-read on the
// typing path) rather than when the call that produced it is spelled
// differently.
//
// NODE, NOT JSDOM, and deliberately so: these suites are a mutation seed
// (`stryker.notes.config.mjs`), and Stryker's vitest runner reports "No tests
// were executed" for a jsdom project — a suite under the `@vitest-environment
// jsdom` docblock defends nothing in the mutation lane. The browser surface
// this module actually touches is three properties wide (one `querySelector`,
// `textContent`, `hidden`) plus `window.centraid` and `FileReader`, so it is
// stood up by hand here; naming that surface exactly is the point, because
// anything the module reaches for beyond it fails rather than silently
// working.
import { onTestFinished } from "vitest";

import { createLogic } from "./logic.ts";
import type { ShelfId } from "./shelves.ts";
import type { AppData, AppState, Note } from "./types.ts";

export function note(patch: Partial<Note> & { note_id: string }): Note {
  return { title: patch.note_id, ...patch };
}

export function state(patch: Partial<AppState> = {}): AppState {
  return {
    shelf: null,
    view: "cards",
    noteId: null,
    conceptId: null,
    unfiledOnly: false,
    search: "",
    searchScope: "everywhere",
    scopeNotebookId: null,
    searchResults: null,
    searchStatus: "resting",
    searchSeq: 0,
    powerbox: {
      open: false,
      term: "",
      targets: [],
      anchor: { exact: "", prefix: "", suffix: "", start: 0 },
    },
    versions: null,
    libraryWindow: 200,
    creatingNotebook: false,
    renamingNotebookId: null,
    queued: 0,
    ...patch,
  };
}

export function data(patch: Partial<AppData> = {}): AppData {
  return {
    notes: [],
    trash: [],
    journal: [],
    notebooks: [],
    tags: [],
    truncated: false,
    window: 200,
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

/** Stand up (or withhold) the frame's notice banner and the vault client. */
function mountBanner(present = true): void {
  banner = present ? { textContent: "", hidden: true } : null;
  (globalThis as { document?: unknown }).document = {
    querySelector: (selector: string) =>
      selector === "#noticeBanner" ? banner : null,
  };
}

/**
 * A `FileReader` stand-in — Node has `File`/`Blob` but no `FileReader`. The
 * two outcomes are what the app branches on: bytes in hand, or a device that
 * could not read them.
 */
class StubFileReader {
  result: string | null = null;
  #handlers: Record<string, Array<() => void>> = { load: [], error: [] };

  addEventListener(type: string, handler: () => void): void {
    this.#handlers[type]?.push(handler);
  }

  readAsDataURL(file: { name?: string; unreadable?: boolean }): void {
    queueMicrotask(() => {
      if (file?.unreadable) {
        for (const handler of this.#handlers.error ?? []) handler();
        return;
      }
      this.result = `data:text/plain;base64,${btoa(String(file?.name ?? ""))}`;
      for (const handler of this.#handlers.load ?? []) handler();
    });
  }
}

export type WriteFn = (opts: WriteOpts) => Promise<unknown>;
export type ReadFn = (opts: ReadOpts) => Promise<unknown>;

/** What the frame's ONE status line reads, and the undo it offers beside it. */
export interface StatusLine {
  text: string;
  undo: (() => void) | null;
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
  /** Every route the app moved to, in order. */
  routes: ShelfId[];
  /** How many times the pane repainted from the window already in hand. */
  paints: () => number;
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

/** Build the app's logic over a stubbed gateway plus the frame's one banner. */
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
  (globalThis as { FileReader?: unknown }).FileReader = StubFileReader;
  onTestFinished(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { FileReader?: unknown }).FileReader;
  });
  let paints = 0;
  const render = (): void => {
    paints += 1;
  };
  let reloads = 0;
  const refresh = async (): Promise<void> => {
    reloads += 1;
  };
  let line: StatusLine | null = null;
  const statusTexts: string[] = [];
  const status = (text: string, undo?: () => void): void => {
    line = { text, undo: undo ?? null };
    statusTexts.push(text);
  };
  const routes: ShelfId[] = [];
  const go = (shelf: ShelfId): void => {
    routes.push(shelf);
  };
  return {
    state: appState,
    data: appData,
    logic: createLogic({
      state: appState,
      data: appData,
      render,
      refresh,
      status,
      go,
    }),
    status: (): StatusLine | null => line,
    statusTexts,
    sent,
    asked,
    routes,
    paints: (): number => paints,
    reloads: (): number => reloads,
    banner: () => ({
      text: banner?.textContent ?? "",
      hidden: banner?.hidden ?? true,
    }),
  };
}
