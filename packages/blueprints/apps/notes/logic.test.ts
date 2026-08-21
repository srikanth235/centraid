// Notes' vault IO, held to the sentences an outcome earns (#839 W2-1).
//
// EVERY WRITE HERE IS OPTIMISTIC, so the thing worth pinning is not "a command
// was sent" but which of the three outcomes the member is shown: `executed`
// clears the banner, `parked` ALSO clears it (a park is a designed state the
// row's own chip carries, never an error), and only a real refusal reaches the
// status line. The friendly-predicate table is the one place this app
// translates the vault's own words, so each mapped predicate is asserted by
// the sentence it produces rather than by "some message appeared".
//
// The two debounced paths (`saveNote`, `runSearch`) are driven on fake timers
// because their whole point is coalescing: a suite that awaited them directly
// would prove nothing about the delay it exists to hold.
//
// NODE, NOT JSDOM, and deliberately so: this file is a mutation seed
// (`stryker.notes.config.mjs`), and Stryker's vitest runner reports "No tests
// were executed" for a jsdom project — a suite under the `@vitest-environment
// jsdom` docblock defends nothing in the mutation lane. The browser surface
// this module actually touches is three properties wide (one `querySelector`,
// `textContent`, `hidden`) plus `window.centraid`, so it is stood up by hand
// below; naming that surface exactly is the point, because anything this
// module reaches for beyond it fails here rather than silently working.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLogic,
  notebookCounts,
  rowsFor,
  tagCounts,
  unfiledCount,
} from "./logic.ts";
import { NOTE, TRASH, notebookShelf } from "./shelves.ts";
import type { AppData, AppState, Note } from "./types.ts";
import { RENAME_REFUSAL } from "./view-copy.ts";

function note(patch: Partial<Note> & { note_id: string }): Note {
  return { title: patch.note_id, ...patch };
}

function state(patch: Partial<AppState> = {}): AppState {
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

function data(patch: Partial<AppData> = {}): AppData {
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

type WriteOpts = { action: string; input?: Record<string, unknown> };
type ReadOpts = { query: string; input?: Record<string, unknown> };

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

interface Harness {
  state: AppState;
  data: AppData;
  logic: ReturnType<typeof createLogic>;
  write: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  go: ReturnType<typeof vi.fn>;
  banner: () => { text: string; hidden: boolean };
}

/** Build the app's logic over a stubbed gateway plus the frame's one banner. */
function harness(
  over: {
    state?: Partial<AppState>;
    data?: Partial<AppData>;
    write?: (opts: WriteOpts) => Promise<unknown>;
    read?: (opts: ReadOpts) => Promise<unknown>;
  } = {}
): Harness {
  const appState = state(over.state);
  const appData = data(over.data);
  const write = vi.fn(
    over.write ?? (async () => ({ status: "executed" }) as VaultOutcome)
  );
  const read = vi.fn(over.read ?? (async () => ({})));
  (globalThis as { window?: unknown }).window = { centraid: { read, write } };
  const render = vi.fn();
  const refresh = vi.fn(async () => {});
  const status = vi.fn();
  const go = vi.fn();
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
    write,
    read,
    render,
    refresh,
    status,
    go,
    banner: () => ({
      text: banner?.textContent ?? "",
      hidden: banner?.hidden ?? true,
    }),
  };
}

beforeEach(() => {
  mountBanner();
  (globalThis as { FileReader?: unknown }).FileReader = StubFileReader;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { FileReader?: unknown }).FileReader;
});

describe("the notice banner is the app's only imperative surface", () => {
  it("shows a sentence and hides itself again on the empty string", () => {
    const app = harness();
    app.logic.notice("Something happened");
    expect(app.banner()).toStrictEqual({
      text: "Something happened",
      hidden: false,
    });
    app.logic.notice("");
    expect(app.banner()).toStrictEqual({ text: "", hidden: true });
  });

  it("is a no-op where the frame did not mount one", () => {
    mountBanner(false);
    const app = harness();
    expect(() => app.logic.notice("nowhere to put this")).not.toThrow();
  });
});

describe("three outcomes, three different sentences", () => {
  it("clears the banner and reports the write landed on executed", () => {
    const app = harness();
    app.logic.notice("stale");
    expect(app.logic.narrate({ status: "executed" })).toBe(true);
    expect(app.banner()).toStrictEqual({ text: "", hidden: true });
  });

  it("treats a park as a calm state: banner cleared, nothing on the status line", () => {
    const app = harness();
    app.logic.notice("stale");
    expect(app.logic.narrate({ status: "parked" })).toBe(false);
    expect(app.banner().text).toBe("");
    expect(app.status).not.toHaveBeenCalled();
  });

  it("translates a known refusal predicate into the product's own words", () => {
    const app = harness();
    const landed = app.logic.narrate(
      { status: "failed", predicate: "name_unused_by_owner: name = 'Recipes'" },
      { name_unused_by_owner: RENAME_REFUSAL }
    );
    expect(landed).toBe(false);
    expect(app.status).toHaveBeenCalledWith(RENAME_REFUSAL);
  });

  it("falls back to the element layer's sentence for an unmapped refusal", () => {
    const app = harness();
    app.logic.narrate(
      { status: "failed", predicate: "some_other_rule: x = 1" },
      { name_unused: RENAME_REFUSAL }
    );
    expect(app.status).toHaveBeenCalledWith(
      "The vault refused: some_other_rule: x = 1."
    );
  });

  it("says nothing at all when there is no outcome to narrate", () => {
    const app = harness();
    expect(app.logic.narrate(undefined)).toBe(false);
    expect(app.status).not.toHaveBeenCalled();
  });
});

describe("the raw write path", () => {
  it("turns an unreachable gateway into a banner, not a refusal", async () => {
    const app = harness({
      write: async () => {
        throw new Error("gateway unreachable");
      },
    });
    await expect(app.logic.act("edit-note", {})).resolves.toBeUndefined();
    expect(app.banner().text).toBe("gateway unreachable");
  });

  it("counts a parked write against this device's queue and re-reads", async () => {
    const app = harness({ write: async () => ({ status: "parked" }) });
    await app.logic.write("delete-note", { note_id: "n1" });
    expect(app.state.queued).toBe(1);
    expect(app.refresh).toHaveBeenCalledTimes(1);
  });

  it("repaints rather than re-reads when the gateway never answered", async () => {
    const app = harness({
      write: async () => {
        throw new Error("offline");
      },
    });
    await app.logic.write("delete-note", { note_id: "n1" });
    expect(app.refresh).not.toHaveBeenCalled();
    expect(app.render).toHaveBeenCalledTimes(1);
  });
});

describe("finding a note the member is looking at", () => {
  const app = () =>
    harness({
      data: {
        notes: [note({ note_id: "live" })],
        trash: [note({ note_id: "gone" })],
        journal: [note({ note_id: "day" })],
        notebooks: [{ notebook_id: "b1", name: "Recipes" }],
      },
    });

  it("looks in the library, the trash and the Journal alike", () => {
    const logic = app().logic;
    expect(logic.findNote("live")?.note_id).toBe("live");
    expect(logic.findNote("gone")?.note_id).toBe("gone");
    expect(logic.findNote("day")?.note_id).toBe("day");
  });

  it("answers null rather than undefined for a note not in the window", () => {
    expect(app().logic.findNote("nope")).toBeNull();
  });

  it("names a notebook, and names nothing for an unknown one", () => {
    const logic = app().logic;
    expect(logic.notebookName("b1")).toBe("Recipes");
    expect(logic.notebookName("b9")).toBe("");
  });
});

describe("opening a note pulls the body lazily", () => {
  it("routes to the editor and clears the previous version chain first", async () => {
    const app = harness({
      state: { versions: [] },
      data: { notes: [note({ note_id: "n1", body: "already here" })] },
    });
    await app.logic.openNote("n1");
    expect(app.state.noteId).toBe("n1");
    expect(app.state.versions).toBeNull();
    expect(app.go).toHaveBeenCalledWith(NOTE);
  });

  it("skips the round trip when the body is already in hand", async () => {
    const app = harness({
      data: { notes: [note({ note_id: "n1", body: "already here" })] },
    });
    await app.logic.openNote("n1");
    expect(app.read).not.toHaveBeenCalled();
  });

  it("fetches the canonical body for a preview-only row", async () => {
    const app = harness({
      data: { notes: [note({ note_id: "n1", preview: "first line" })] },
      read: async () => ({ body: "the whole note" }),
    });
    await app.logic.openNote("n1");
    expect(app.read).toHaveBeenCalledWith({
      query: "note",
      input: { note_id: "n1" },
    });
    expect(app.data.notes[0]?.body).toBe("the whole note");
  });

  it("leaves the editor on the preview when the read was denied", async () => {
    const app = harness({
      data: { notes: [note({ note_id: "n1", preview: "first line" })] },
      read: async () => ({ vaultDenied: { code: "VAULT_CONSENT" } }),
    });
    await app.logic.openNote("n1");
    expect(app.data.notes[0]?.body).toBeUndefined();
  });

  it("drops a late answer for a note the member already navigated away from", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = harness({
      data: { notes: [note({ note_id: "n1", preview: "first line" })] },
      read: async () => {
        await gate;
        return { body: "too late" };
      },
    });
    const pending = app.logic.openNote("n1");
    app.state.noteId = "n2";
    release();
    await pending;
    expect(app.data.notes[0]?.body).toBeUndefined();
  });

  it("survives a throwing gateway without clearing what it had", async () => {
    const app = harness({
      data: { notes: [note({ note_id: "n1", preview: "first line" })] },
      read: async () => {
        throw new Error("offline");
      },
    });
    await app.logic.openNote("n1");
    expect(app.data.notes[0]?.preview).toBe("first line");
  });
});

describe("the version chain", () => {
  it("takes the query's rows as the chain", async () => {
    const rows = [
      {
        content_id: "c2",
        body: "new",
        current: true,
        asserted_at: "2026-08-02",
      },
      {
        content_id: "c1",
        body: "old",
        current: false,
        asserted_at: "2026-08-01",
      },
    ];
    const app = harness({ read: async () => ({ versions: rows }) });
    await app.logic.loadHistory("n1");
    expect(app.state.versions).toStrictEqual(rows);
  });

  it("reads an answer with no versions as an empty chain, not as unknown", async () => {
    const app = harness({ read: async () => ({}) });
    await app.logic.loadHistory("n1");
    expect(app.state.versions).toStrictEqual([]);
  });

  it("says UNKNOWN — not empty — when the gateway threw", async () => {
    const app = harness({
      state: { versions: [] },
      read: async () => {
        throw new Error("offline");
      },
    });
    await app.logic.loadHistory("n1");
    expect(app.state.versions).toBeNull();
  });
});

describe("a new note is untitled, unfiled and writing immediately", () => {
  it("stands the first line in for the name the vault requires", async () => {
    const app = harness({
      write: async () => ({ status: "executed", output: { note_id: "n-new" } }),
    });
    await app.logic.createNote("Buy oat milk\nand bread");
    expect(app.write).toHaveBeenCalledWith({
      action: "create-note",
      input: {
        title: "Buy oat milk",
        body_text: "Buy oat milk\nand bread",
        format: "markdown",
      },
    });
  });

  it("names an empty note rather than sending the vault a nameless one", async () => {
    const app = harness({
      write: async () => ({ status: "executed", output: { note_id: "n-new" } }),
    });
    await app.logic.createNote();
    expect(app.write.mock.calls[0]?.[0].input).toStrictEqual({
      title: "Untitled note",
      body_text: " ",
      format: "markdown",
    });
  });

  it("files it into the notebook the member is standing in", async () => {
    const app = harness({
      state: { shelf: notebookShelf("b1") },
      write: async () => ({ status: "executed", output: { note_id: "n-new" } }),
    });
    await app.logic.createNote("Sourdough");
    expect(app.write.mock.calls[0]?.[0].input).toMatchObject({
      notebook_id: "b1",
    });
  });

  it("opens what it made, and answers null when nothing was made", async () => {
    const opened = harness({
      write: async () => ({ status: "executed", output: { note_id: "n-new" } }),
    });
    await expect(opened.logic.createNote("x")).resolves.toBe("n-new");
    expect(opened.go).toHaveBeenCalledWith(NOTE);

    const refused = harness({ write: async () => ({ status: "failed" }) });
    await expect(refused.logic.createNote("x")).resolves.toBeNull();
    expect(refused.go).not.toHaveBeenCalled();
  });
});

describe("the editor's continuous save", () => {
  it("coalesces a burst of keystrokes into one write", async () => {
    vi.useFakeTimers();
    const app = harness({
      data: { notes: [note({ note_id: "n1", body: "a" })] },
    });
    app.logic.saveNote("n1", { body_text: "ab" });
    app.logic.saveNote("n1", { body_text: "abc" });
    await vi.advanceTimersByTimeAsync(599);
    expect(app.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(app.write).toHaveBeenCalledTimes(1);
    expect(app.write.mock.calls[0]?.[0].input).toStrictEqual({
      note_id: "n1",
      body_text: "abc",
    });
  });

  it("patches the row it already has instead of re-reading the library", async () => {
    vi.useFakeTimers();
    const row = note({ note_id: "n1", body: "old", preview: "old" });
    const app = harness({ data: { notes: [row] } });
    app.logic.saveNote("n1", { body_text: "# Fresh\n- [x] done\n- [ ] todo" });
    await vi.advanceTimersByTimeAsync(600);
    expect(app.refresh).not.toHaveBeenCalled();
    expect(row.body).toBe("# Fresh\n- [x] done\n- [ ] todo");
    expect(row.check).toStrictEqual({ total: 2, done: 1 });
    expect(row.updated_at).toBeTypeOf("string");
  });

  it("applies a title-only save without touching the body", async () => {
    vi.useFakeTimers();
    const row = note({ note_id: "n1", body: "body", title: "old" });
    const app = harness({ data: { notes: [row] } });
    app.logic.saveNote("n1", { title: "new" });
    await vi.advanceTimersByTimeAsync(600);
    expect(row.title).toBe("new");
    expect(row.body).toBe("body");
  });

  it("counts a parked save on the queue and keeps the banner clear", async () => {
    vi.useFakeTimers();
    const app = harness({ write: async () => ({ status: "parked" }) });
    app.logic.notice("stale");
    app.logic.saveNote("n1", { body_text: "x" });
    await vi.advanceTimersByTimeAsync(600);
    expect(app.state.queued).toBe(1);
    expect(app.banner().text).toBe("");
  });

  it("narrates a refused save on the status line", async () => {
    vi.useFakeTimers();
    const app = harness({
      write: async () => ({ status: "denied", reason: "no grant" }),
    });
    app.logic.saveNote("n1", { body_text: "x" });
    await vi.advanceTimersByTimeAsync(600);
    expect(app.status).toHaveBeenCalledWith("Denied by consent: no grant");
  });
});

describe("the small note commands", () => {
  it("flips a pin both ways", async () => {
    const app = harness();
    await app.logic.togglePin(note({ note_id: "n1" }));
    expect(app.write.mock.calls[0]?.[0].input).toStrictEqual({
      note_id: "n1",
      pinned: 1,
    });
    await app.logic.togglePin(note({ note_id: "n1", pinned: 1 }));
    expect(app.write.mock.calls[1]?.[0].input).toStrictEqual({
      note_id: "n1",
      pinned: 0,
    });
  });

  it("says unfiled by omitting the notebook rather than by naming null", async () => {
    const app = harness();
    await app.logic.moveNote("n1", null);
    expect(app.write.mock.calls[0]?.[0].input).toStrictEqual({
      note_id: "n1",
    });
    await app.logic.moveNote("n1", "b1");
    expect(app.write.mock.calls[1]?.[0].input).toStrictEqual({
      note_id: "n1",
      notebook_id: "b1",
    });
  });

  it("closes the editor on the note it just trashed, and offers the undo", async () => {
    const app = harness({ state: { noteId: "n1" } });
    await app.logic.deleteNote(note({ note_id: "n1" }));
    expect(app.state.noteId).toBeNull();
    expect(app.status).toHaveBeenCalledWith(
      "Moved to trash",
      expect.any(Function)
    );
  });

  it("leaves a different open note alone", async () => {
    const app = harness({ state: { noteId: "other" } });
    await app.logic.deleteNote(note({ note_id: "n1" }));
    expect(app.state.noteId).toBe("other");
  });

  it("offers no undo where the delete did not land", async () => {
    const app = harness({ write: async () => ({ status: "parked" }) });
    await app.logic.deleteNote(note({ note_id: "n1" }));
    expect(app.status).not.toHaveBeenCalled();
  });

  it("says a restore landed in place", async () => {
    const app = harness();
    await app.logic.restoreNote("n1");
    expect(app.status).toHaveBeenCalledWith("Restored in place");
  });

  it("restores a version by APPENDING, then re-reads the chain and the body", async () => {
    const row = note({ note_id: "n1", body: "current" });
    const app = harness({
      data: { notes: [row] },
      read: async (opts) =>
        opts.query === "history" ? { versions: [] } : { body: "older text" },
    });
    await app.logic.restoreVersion("n1", "c1");
    expect(app.write.mock.calls[0]?.[0]).toStrictEqual({
      action: "restore-note-version",
      input: { note_id: "n1", content_id: "c1" },
    });
    expect(app.read.mock.calls.map((call) => call[0].query)).toStrictEqual([
      "history",
      "note",
    ]);
    expect(row.body).toBe("older text");
  });

  it("does not disturb the open note when the restore was refused", async () => {
    const row = note({ note_id: "n1", body: "current" });
    const app = harness({
      data: { notes: [row] },
      write: async () => ({ status: "failed" }),
    });
    await app.logic.restoreVersion("n1", "c1");
    expect(row.body).toBe("current");
  });
});

describe("notebooks", () => {
  it("refuses to send the vault a blank name", async () => {
    const app = harness();
    await app.logic.createNotebook("   ");
    expect(app.write).not.toHaveBeenCalled();
  });

  it("trims the name and closes the composer once it lands", async () => {
    const app = harness({ state: { creatingNotebook: true } });
    await app.logic.createNotebook("  Recipes  ");
    expect(app.write.mock.calls[0]?.[0].input).toStrictEqual({
      name: "Recipes",
    });
    expect(app.state.creatingNotebook).toBe(false);
  });

  it("keeps the composer open on the vault's sibling-name refusal", async () => {
    const app = harness({
      state: { creatingNotebook: true },
      write: async () => ({
        status: "failed",
        predicate: "name_unused_by_owner: name = 'Recipes'",
      }),
    });
    await app.logic.createNotebook("Recipes");
    expect(app.state.creatingNotebook).toBe(true);
    expect(app.status).toHaveBeenCalledWith(RENAME_REFUSAL);
  });

  it("closes the rename only when the rename landed", async () => {
    const ok = harness({ state: { renamingNotebookId: "b1" } });
    await ok.logic.renameNotebook("b1", " Recipes ");
    expect(ok.write.mock.calls[0]?.[0].input).toStrictEqual({
      notebook_id: "b1",
      name: "Recipes",
    });
    expect(ok.state.renamingNotebookId).toBeNull();

    const refused = harness({
      state: { renamingNotebookId: "b1" },
      write: async () => ({ status: "failed", predicate: "name_unused: x" }),
    });
    await refused.logic.renameNotebook("b1", "Recipes");
    expect(refused.state.renamingNotebookId).toBe("b1");
  });

  it("reports the vault's own count of what was unfiled", async () => {
    const app = harness({
      write: async () => ({ status: "executed", output: { notes_unfiled: 7 } }),
    });
    await app.logic.deleteNotebook("b1");
    expect(app.status).toHaveBeenCalledWith(
      "Notebook deleted · 7 notes are now unfiled"
    );
  });

  it("leaves the shelf a member is standing on when it disappears", async () => {
    const app = harness({
      state: { shelf: notebookShelf("b1") },
      write: async () => ({ status: "executed", output: {} }),
    });
    await app.logic.deleteNotebook("b1");
    expect(app.go).toHaveBeenCalledWith(null);
  });

  it("stays put when some other notebook was deleted", async () => {
    const app = harness({
      state: { shelf: notebookShelf("b2") },
      write: async () => ({ status: "executed", output: {} }),
    });
    await app.logic.deleteNotebook("b1");
    expect(app.go).not.toHaveBeenCalled();
  });

  it("surfaces the vault's non-empty-notebook refusal in the product's words", async () => {
    const app = harness({
      write: async () => ({
        status: "failed",
        predicate: "notebook_has_no_children: count = 2",
      }),
    });
    await app.logic.deleteNotebook("b1");
    expect(app.status).toHaveBeenCalledWith(
      "Delete or move the notebooks inside this one first"
    );
  });
});

describe("tags, links and files", () => {
  it("never sends a blank tag", async () => {
    const app = harness();
    await app.logic.addTag("n1", "  ");
    expect(app.write).not.toHaveBeenCalled();
  });

  it("trims a tag before it becomes a concept", async () => {
    const app = harness();
    await app.logic.addTag("n1", "  recipes ");
    expect(app.write.mock.calls[0]?.[0]).toStrictEqual({
      action: "add-tag",
      input: { note_id: "n1", label: "recipes" },
    });
  });

  it("removes a tag by its edge id", async () => {
    const app = harness();
    await app.logic.removeTag("t1");
    expect(app.write.mock.calls[0]?.[0]).toStrictEqual({
      action: "remove-tag",
      input: { tag_id: "t1" },
    });
  });

  it("sends a bare typed reference when no passage was selected", async () => {
    const app = harness();
    await app.logic.linkNote(
      "n1",
      { type: "task", id: "t9", title: "Oat milk", app: "tasks" },
      null
    );
    expect(app.write.mock.calls[0]?.[0].input).toStrictEqual({
      note_id: "n1",
      target_type: "task",
      target_id: "t9",
    });
  });

  it("carries the anchor when the member had a passage selected", async () => {
    const app = harness();
    await app.logic.linkNote(
      "n1",
      { type: "task", id: "t9", title: "Oat milk", app: "tasks" },
      {
        exact: "buy oat milk",
        prefix: "remember to ",
        suffix: " today",
        start: 12,
      }
    );
    expect(app.write.mock.calls[0]?.[0].input).toStrictEqual({
      note_id: "n1",
      target_type: "task",
      target_id: "t9",
      exact: "buy oat milk",
      prefix: "remember to ",
      suffix: " today",
      start: 12,
    });
  });

  it("drops an empty anchor rather than anchoring at nothing", async () => {
    const app = harness();
    await app.logic.linkNote(
      "n1",
      { type: "task", id: "t9", title: "Oat milk", app: "tasks" },
      {
        exact: "",
        prefix: "",
        suffix: "",
        start: 0,
      }
    );
    expect(app.write.mock.calls[0]?.[0].input).toStrictEqual({
      note_id: "n1",
      target_type: "task",
      target_id: "t9",
    });
  });

  it("pins a readable file to the note as an embedded data URI", async () => {
    const app = harness();
    await app.logic.attachFile("n1", { name: "note.txt" } as unknown as File);
    const input = app.write.mock.calls[0]?.[0].input as Record<string, unknown>;
    expect(input.subject_id).toBe("n1");
    expect(input.title).toBe("note.txt");
    expect(input.role).toBe("embed");
    expect(String(input.data_uri)).toMatch(/^data:text\/plain;base64,/u);
  });

  it("says so on the status line when the device could not read the file", async () => {
    const app = harness();
    const unreadable = {
      name: "broken.bin",
      unreadable: true,
    } as unknown as File;
    await app.logic.attachFile("n1", unreadable);
    expect(app.status).toHaveBeenCalledWith(
      "That file could not be read on this device"
    );
    expect(app.write).not.toHaveBeenCalled();
  });

  it("detaches by attachment id", async () => {
    const app = harness();
    await app.logic.removeAttachment("a1");
    expect(app.write.mock.calls[0]?.[0]).toStrictEqual({
      action: "detach",
      input: { attachment_id: "a1" },
    });
  });
});

describe("a checkbox is a character in the body", () => {
  it("ticks an unchecked box and re-tallies from the same text", async () => {
    vi.useFakeTimers();
    const row = note({ note_id: "n1", body: "- [ ] milk\n- [x] bread" });
    const app = harness({ data: { notes: [row] } });
    await app.logic.toggleCheck("n1", 0);
    expect(row.body).toBe("- [x] milk\n- [x] bread");
    expect(row.check).toStrictEqual({ total: 2, done: 2 });
    await vi.advanceTimersByTimeAsync(600);
    expect(app.write.mock.calls[0]?.[0].input).toStrictEqual({
      note_id: "n1",
      body_text: "- [x] milk\n- [x] bread",
    });
  });

  it("unticks a ticked box, case-insensitively", async () => {
    const row = note({ note_id: "n1", body: "  * [X] milk" });
    const app = harness({ data: { notes: [row] } });
    await app.logic.toggleCheck("n1", 0);
    expect(row.body).toBe("  * [ ] milk");
  });

  it("leaves a line that is not a box alone", async () => {
    const row = note({ note_id: "n1", body: "just prose" });
    const app = harness({ data: { notes: [row] } });
    await app.logic.toggleCheck("n1", 0);
    expect(row.body).toBe("just prose");
    expect(app.render).not.toHaveBeenCalled();
  });

  it("does nothing for a line index the body does not have", async () => {
    const row = note({ note_id: "n1", body: "- [ ] milk" });
    const app = harness({ data: { notes: [row] } });
    await app.logic.toggleCheck("n1", 9);
    expect(row.body).toBe("- [ ] milk");
  });

  it("does nothing for a note whose body has not been fetched", async () => {
    const row = note({ note_id: "n1", preview: "- [ ] milk" });
    const app = harness({ data: { notes: [row] } });
    await app.logic.toggleCheck("n1", 0);
    expect(row.body).toBeUndefined();
  });
});

describe("send to Tasks", () => {
  it("hands the line to the task spine and says where it went", async () => {
    const app = harness();
    await app.logic.sendLineToTasks("n1", 3, "  call [[Ravi]] on 2026-09-01  ");
    expect(app.write.mock.calls[0]?.[0]).toStrictEqual({
      action: "send-to-tasks",
      input: {
        title: "call Ravi on 2026-09-01",
        due_at: "2026-09-01",
        note_id: "n1",
        exact: "call [[Ravi]] on 2026-09-01",
      },
    });
    expect(app.status).toHaveBeenCalledWith(
      expect.stringContaining("call Ravi on 2026-09-01")
    );
  });
});

describe("search never claims an empty result it did not verify", () => {
  it("waits out the burst, then asks the vault once", async () => {
    vi.useFakeTimers();
    const app = harness({ read: async () => ({ notes: [] }) });
    app.logic.runSearch("oa");
    app.logic.runSearch("oat");
    await vi.advanceTimersByTimeAsync(150);
    expect(app.read).toHaveBeenCalledTimes(1);
    expect(app.read.mock.calls[0]?.[0]).toStrictEqual({
      query: "search",
      input: { term: "oat" },
    });
  });

  it("goes back to rest on an emptied box without asking anything", async () => {
    vi.useFakeTimers();
    const app = harness({ state: { search: "oat", searchStatus: "ready" } });
    app.logic.runSearch("   ");
    await vi.advanceTimersByTimeAsync(150);
    expect(app.read).not.toHaveBeenCalled();
    expect(app.state.searchResults).toBeNull();
    expect(app.state.searchStatus).toBe("resting");
  });

  it("holds the matches and calls itself ready", async () => {
    vi.useFakeTimers();
    const hit = note({ note_id: "n1" });
    const app = harness({ read: async () => ({ notes: [hit] }) });
    app.logic.runSearch("oat");
    await vi.advanceTimersByTimeAsync(150);
    expect(app.state.searchResults).toStrictEqual([hit]);
    expect(app.state.searchStatus).toBe("ready");
  });

  it("calls a DENIAL unreachable, never 'nothing matches'", async () => {
    vi.useFakeTimers();
    const app = harness({
      read: async () => ({ vaultDenied: { code: "VAULT_CONSENT" } }),
    });
    app.logic.runSearch("oat");
    await vi.advanceTimersByTimeAsync(150);
    expect(app.state.searchResults).toBeNull();
    expect(app.state.searchStatus).toBe("unreachable");
  });

  it("calls a THROW unreachable too", async () => {
    vi.useFakeTimers();
    const app = harness({
      read: async () => {
        throw new Error("offline");
      },
    });
    app.logic.runSearch("oat");
    await vi.advanceTimersByTimeAsync(150);
    expect(app.state.searchStatus).toBe("unreachable");
  });

  it("drops an answer to a query the member has already moved past", async () => {
    vi.useFakeTimers();
    const app: Harness = harness({
      // The member types on while the vault is answering: the sequence moves
      // under the in-flight read, exactly as a second `runSearch` would move it.
      read: async () => {
        app.state.searchSeq += 5;
        return { notes: [note({ note_id: "stale" })] };
      },
    });
    app.logic.runSearch("oat");
    await vi.advanceTimersByTimeAsync(150);
    expect(app.state.searchResults).toBeNull();
  });

  it("clears the box and bumps the sequence so a live read cannot land", () => {
    const app = harness({
      state: { search: "oat", searchStatus: "ready", searchResults: [] },
    });
    app.logic.clearSearch();
    expect(app.state).toMatchObject({
      search: "",
      searchResults: null,
      searchStatus: "resting",
      searchSeq: 1,
    });
  });
});

describe("the [[ powerbox probe", () => {
  it("asks for link targets once the typing settles", async () => {
    vi.useFakeTimers();
    const targets = [
      { type: "task", id: "t1", title: "Oat milk", app: "tasks" },
    ];
    const app = harness({ read: async () => ({ targets }) });
    app.logic.probeTargets("  oat  ");
    await vi.advanceTimersByTimeAsync(120);
    expect(app.read.mock.calls[0]?.[0]).toStrictEqual({
      query: "link-targets",
      input: { term: "oat" },
    });
    expect(app.state.powerbox.targets).toStrictEqual(targets);
    expect(app.state.powerbox.term).toBe("oat");
  });

  it("empties the candidate list on an emptied term, without asking", async () => {
    vi.useFakeTimers();
    const app = harness({
      state: {
        powerbox: {
          open: true,
          term: "oat",
          targets: [{ type: "task", id: "t1", title: "x", app: "tasks" }],
          anchor: { exact: "", prefix: "", suffix: "", start: 0 },
        },
      },
    });
    app.logic.probeTargets("");
    await vi.advanceTimersByTimeAsync(120);
    expect(app.read).not.toHaveBeenCalled();
    expect(app.state.powerbox.targets).toStrictEqual([]);
  });

  it("empties the candidate list rather than keeping stale ones when the read threw", async () => {
    vi.useFakeTimers();
    const app = harness({
      state: {
        powerbox: {
          open: true,
          term: "o",
          targets: [{ type: "task", id: "t1", title: "x", app: "tasks" }],
          anchor: { exact: "", prefix: "", suffix: "", start: 0 },
        },
      },
      read: async () => {
        throw new Error("offline");
      },
    });
    app.logic.probeTargets("oat");
    await vi.advanceTimersByTimeAsync(120);
    expect(app.state.powerbox.targets).toStrictEqual([]);
  });
});

describe("the rows a route paints", () => {
  const rows = [
    note({
      note_id: "a",
      updated_at: "2026-08-01",
      notebook_ids: ["b1"],
      tags: [{ tag_id: "t1", concept_id: "c1", label: "recipes" }],
    }),
    note({ note_id: "b", updated_at: "2026-08-03", notebook_ids: [] }),
    note({
      note_id: "c",
      updated_at: "2026-08-02",
      pinned: 1,
      notebook_ids: ["b1", "b2"],
    }),
  ];
  const appData = data({ notes: rows, trash: [note({ note_id: "gone" })] });

  it("paints the trash on the trash shelf and nothing else", () => {
    expect(
      rowsFor(appData, state(), TRASH).map((r) => r.note_id)
    ).toStrictEqual(["gone"]);
  });

  it("sorts pinned first, then newest edited — and nothing else reorders it", () => {
    expect(rowsFor(appData, state(), null).map((r) => r.note_id)).toStrictEqual(
      ["c", "b", "a"]
    );
  });

  it("narrows to the open notebook", () => {
    const shown = rowsFor(appData, state(), notebookShelf("b2"));
    expect(shown.map((r) => r.note_id)).toStrictEqual(["c"]);
  });

  it("paints the ranked matches while a query is live", () => {
    const shown = rowsFor(
      appData,
      state({ search: "oat", searchResults: [rows[1]!] }),
      null
    );
    expect(shown.map((r) => r.note_id)).toStrictEqual(["b"]);
  });

  it("shows nothing rather than the library when a live query has no answer yet", () => {
    expect(
      rowsFor(appData, state({ search: "oat", searchResults: null }), null)
    ).toStrictEqual([]);
  });

  it("applies the This-notebook scope only where the member came from one", () => {
    const scoped = state({
      search: "oat",
      searchResults: rows,
      searchScope: "notebook",
      scopeNotebookId: "b2",
    });
    expect(rowsFor(appData, scoped, null).map((r) => r.note_id)).toStrictEqual([
      "c",
    ]);
    const unscoped = state({
      search: "oat",
      searchResults: rows,
      searchScope: "notebook",
      scopeNotebookId: null,
    });
    expect(rowsFor(appData, unscoped, null)).toHaveLength(3);
  });

  it("treats Unfiled as a filter over the library window", () => {
    expect(
      rowsFor(appData, state({ unfiledOnly: true }), null).map((r) => r.note_id)
    ).toStrictEqual(["b"]);
  });

  it("treats a tag as a lens, never as a place", () => {
    expect(
      rowsFor(appData, state({ conceptId: "c1" }), null).map((r) => r.note_id)
    ).toStrictEqual(["a"]);
  });

  it("counts the WINDOW, not the vault", () => {
    expect([...notebookCounts(appData).entries()].toSorted()).toStrictEqual([
      ["b1", 2],
      ["b2", 1],
    ]);
    expect(unfiledCount(appData)).toBe(1);
    expect([...tagCounts(appData).entries()]).toStrictEqual([["c1", 1]]);
  });
});
