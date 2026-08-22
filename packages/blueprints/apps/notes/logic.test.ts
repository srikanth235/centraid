import { describe, expect, it } from "vitest";

// Notes' vault IO: narration, the raw write path, and the lazy reads
// (#839 W2-1). The commands that ride on top are `logic-commands.test.ts`; the
// panes they feed are `logic-panes.test.ts`; the seat all three drive is
// `logic.test-fixtures.ts`, which says why the gateway and the frame here are
// recording fakes rather than mocks.
//
// EVERY WRITE HERE IS OPTIMISTIC, so the thing worth pinning is not "a command
// was sent" but which of the three outcomes the member is shown: `executed`
// clears the banner, `parked` ALSO clears it (a park is a designed state the
// row's own chip carries, never an error), and only a real refusal reaches the
// status line. The friendly-predicate table is the one place this app
// translates the vault's own words, so each mapped predicate is asserted by
// the sentence it produces rather than by "some message appeared".
import { harness, note } from "./logic.test-fixtures.ts";
import { NOTE, notebookShelf } from "./shelves.ts";
import { RENAME_REFUSAL } from "./view-copy.ts";

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
    const app = harness({ banner: false });
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
    expect(app.statusTexts).toStrictEqual([]);
  });

  it("translates a known refusal predicate into the product's own words", () => {
    const app = harness();
    const landed = app.logic.narrate(
      { status: "failed", predicate: "name_unused_by_owner: name = 'Recipes'" },
      { name_unused_by_owner: RENAME_REFUSAL }
    );
    expect(landed).toBe(false);
    expect(app.statusTexts).toStrictEqual([RENAME_REFUSAL]);
  });

  it("falls back to the element layer's sentence for an unmapped refusal", () => {
    const app = harness();
    app.logic.narrate(
      { status: "failed", predicate: "some_other_rule: x = 1" },
      { name_unused: RENAME_REFUSAL }
    );
    expect(app.statusTexts).toStrictEqual([
      "The vault refused: some_other_rule: x = 1.",
    ]);
  });

  it("says nothing at all when there is no outcome to narrate", () => {
    const app = harness();
    expect(app.logic.narrate(undefined)).toBe(false);
    expect(app.statusTexts).toStrictEqual([]);
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
    expect(app.reloads()).toBe(1);
  });

  it("repaints rather than re-reads when the gateway never answered", async () => {
    const app = harness({
      write: async () => {
        throw new Error("offline");
      },
    });
    await app.logic.write("delete-note", { note_id: "n1" });
    expect(app.reloads()).toBe(0);
    expect(app.paints()).toBe(1);
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
    expect(app.routes).toStrictEqual([NOTE]);
  });

  it("skips the round trip when the body is already in hand", async () => {
    const app = harness({
      data: { notes: [note({ note_id: "n1", body: "already here" })] },
    });
    await app.logic.openNote("n1");
    expect(app.asked).toStrictEqual([]);
  });

  it("fetches the canonical body for a preview-only row", async () => {
    const app = harness({
      data: { notes: [note({ note_id: "n1", preview: "first line" })] },
      read: async () => ({ body: "the whole note" }),
    });
    await app.logic.openNote("n1");
    expect(app.asked).toStrictEqual([
      { query: "note", input: { note_id: "n1" } },
    ]);
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
    expect(app.sent).toStrictEqual([
      {
        action: "create-note",
        input: {
          title: "Buy oat milk",
          body_text: "Buy oat milk\nand bread",
          format: "markdown",
        },
      },
    ]);
  });

  it("names an empty note rather than sending the vault a nameless one", async () => {
    const app = harness({
      write: async () => ({ status: "executed", output: { note_id: "n-new" } }),
    });
    await app.logic.createNote();
    expect(app.sent[0]?.input).toStrictEqual({
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
    expect(app.sent[0]?.input).toMatchObject({ notebook_id: "b1" });
  });

  it("opens what it made, and answers null when nothing was made", async () => {
    const opened = harness({
      write: async () => ({ status: "executed", output: { note_id: "n-new" } }),
    });
    await expect(opened.logic.createNote("x")).resolves.toBe("n-new");
    expect(opened.routes).toStrictEqual([NOTE]);

    const refused = harness({ write: async () => ({ status: "failed" }) });
    await expect(refused.logic.createNote("x")).resolves.toBeNull();
    expect(refused.routes).toStrictEqual([]);
  });
});
