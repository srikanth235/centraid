// Recording fake for Notes vault-IO suites (#839). Node, not jsdom: Stryker's vitest runner executes nothing under a jsdom docblock.
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

export interface StatusLine {
  text: string;
  undo: (() => void) | null;
}

export interface Harness {
  state: AppState;
  data: AppData;
  logic: ReturnType<typeof createLogic>;
  status: () => StatusLine | null;
  statusTexts: string[];
  sent: WriteOpts[];
  asked: ReadOpts[];
  routes: ShelfId[];
  paints: () => number;
  reloads: () => number;
  banner: () => { text: string; hidden: boolean };
}

export interface HarnessOver {
  state?: Partial<AppState>;
  data?: Partial<AppData>;
  write?: WriteFn;
  read?: ReadFn;
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
