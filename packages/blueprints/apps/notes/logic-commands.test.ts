import { describe, expect, it } from "vitest";

// The commands Notes sends, and the sentence each one earns (#839 W2-1) —
// split out of `logic.test.ts`, which holds narration and the lazy reads; the
// seat they all drive is `logic.test-fixtures.ts`, which says why the gateway
// and the frame here are recording fakes rather than mocks.
//
// EVERY WRITE HERE IS OPTIMISTIC, so what is pinned is the shape of the typed
// command that reached the gateway and what the member is left looking at —
// the row patched in place, the undo beside "Moved to trash", the composer
// still open on a refused name. A park never reaches the status line: the
// row's own chip carries it.
//
// The editor's save runs on the fake clock because coalescing is its whole
// point: a suite that awaited it directly would prove nothing about the delay
// it exists to hold, and a re-read per keystroke would repaint the reading
// room under a member who is typing into it.
import { useFakeClock } from "@centraid/test-kit/fake-clock";

import { harness, note } from "./logic.test-fixtures.ts";
import { notebookShelf } from "./shelves.ts";
import { RENAME_REFUSAL } from "./view-copy.ts";

describe("the editor's continuous save", () => {
  it("coalesces a burst of keystrokes into one write", async () => {
    const clock = useFakeClock();
    const app = harness({
      data: { notes: [note({ note_id: "n1", body: "a" })] },
    });
    app.logic.saveNote("n1", { body_text: "ab" });
    app.logic.saveNote("n1", { body_text: "abc" });
    await clock.advance(599);
    expect(app.sent).toStrictEqual([]);
    await clock.advance(1);
    expect(app.sent).toStrictEqual([
      { action: "edit-note", input: { note_id: "n1", body_text: "abc" } },
    ]);
  });

  it("patches the row it already has instead of re-reading the library", async () => {
    const clock = useFakeClock();
    const row = note({ note_id: "n1", body: "old", preview: "old" });
    const app = harness({ data: { notes: [row] } });
    app.logic.saveNote("n1", { body_text: "# Fresh\n- [x] done\n- [ ] todo" });
    await clock.advance(600);
    expect(app.reloads()).toBe(0);
    expect(row.body).toBe("# Fresh\n- [x] done\n- [ ] todo");
    expect(row.check).toStrictEqual({ total: 2, done: 1 });
    expect(row.updated_at).toBeTypeOf("string");
  });

  it("applies a title-only save without touching the body", async () => {
    const clock = useFakeClock();
    const row = note({ note_id: "n1", body: "body", title: "old" });
    const app = harness({ data: { notes: [row] } });
    app.logic.saveNote("n1", { title: "new" });
    await clock.advance(600);
    expect(row.title).toBe("new");
    expect(row.body).toBe("body");
  });

  it("counts a parked save on the queue and keeps the banner clear", async () => {
    const clock = useFakeClock();
    const app = harness({ write: async () => ({ status: "parked" }) });
    app.logic.notice("stale");
    app.logic.saveNote("n1", { body_text: "x" });
    await clock.advance(600);
    expect(app.state.queued).toBe(1);
    expect(app.banner().text).toBe("");
  });

  it("narrates a refused save on the status line", async () => {
    const clock = useFakeClock();
    const app = harness({
      write: async () => ({ status: "denied", reason: "no grant" }),
    });
    app.logic.saveNote("n1", { body_text: "x" });
    await clock.advance(600);
    expect(app.statusTexts).toStrictEqual(["Denied by consent: no grant"]);
  });
});

describe("the small note commands", () => {
  it("flips a pin both ways", async () => {
    const app = harness();
    await app.logic.togglePin(note({ note_id: "n1" }));
    expect(app.sent[0]?.input).toStrictEqual({ note_id: "n1", pinned: 1 });
    await app.logic.togglePin(note({ note_id: "n1", pinned: 1 }));
    expect(app.sent[1]?.input).toStrictEqual({ note_id: "n1", pinned: 0 });
  });

  it("says unfiled by omitting the notebook rather than by naming null", async () => {
    const app = harness();
    await app.logic.moveNote("n1", null);
    expect(app.sent[0]?.input).toStrictEqual({ note_id: "n1" });
    await app.logic.moveNote("n1", "b1");
    expect(app.sent[1]?.input).toStrictEqual({
      note_id: "n1",
      notebook_id: "b1",
    });
  });

  it("closes the editor on the note it just trashed, and offers the undo", async () => {
    const app = harness({ state: { noteId: "n1" } });
    await app.logic.deleteNote(note({ note_id: "n1" }));
    expect(app.state.noteId).toBeNull();
    expect(app.status()).toStrictEqual({
      text: "Moved to trash",
      undo: expect.any(Function),
    });
  });

  it("leaves a different open note alone", async () => {
    const app = harness({ state: { noteId: "other" } });
    await app.logic.deleteNote(note({ note_id: "n1" }));
    expect(app.state.noteId).toBe("other");
  });

  it("offers no undo where the delete did not land", async () => {
    const app = harness({ write: async () => ({ status: "parked" }) });
    await app.logic.deleteNote(note({ note_id: "n1" }));
    expect(app.status()).toBeNull();
  });

  it("says a restore landed in place", async () => {
    const app = harness();
    await app.logic.restoreNote("n1");
    expect(app.status()).toStrictEqual({
      text: "Restored in place",
      undo: null,
    });
  });

  it("restores a version by APPENDING, then re-reads the chain and the body", async () => {
    const row = note({ note_id: "n1", body: "current" });
    const app = harness({
      data: { notes: [row] },
      read: async (opts) =>
        opts.query === "history" ? { versions: [] } : { body: "older text" },
    });
    await app.logic.restoreVersion("n1", "c1");
    expect(app.sent).toStrictEqual([
      {
        action: "restore-note-version",
        input: { note_id: "n1", content_id: "c1" },
      },
    ]);
    expect(app.asked.map((ask) => ask.query)).toStrictEqual([
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
    expect(app.sent).toStrictEqual([]);
  });

  it("trims the name and closes the composer once it lands", async () => {
    const app = harness({ state: { creatingNotebook: true } });
    await app.logic.createNotebook("  Recipes  ");
    expect(app.sent[0]?.input).toStrictEqual({ name: "Recipes" });
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
    expect(app.statusTexts).toStrictEqual([RENAME_REFUSAL]);
  });

  it("closes the rename only when the rename landed", async () => {
    const ok = harness({ state: { renamingNotebookId: "b1" } });
    await ok.logic.renameNotebook("b1", " Recipes ");
    expect(ok.sent[0]?.input).toStrictEqual({
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
    expect(app.statusTexts).toStrictEqual([
      "Notebook deleted · 7 notes are now unfiled",
    ]);
  });

  it("leaves the shelf a member is standing on when it disappears", async () => {
    const app = harness({
      state: { shelf: notebookShelf("b1") },
      write: async () => ({ status: "executed", output: {} }),
    });
    await app.logic.deleteNotebook("b1");
    expect(app.routes).toStrictEqual([null]);
  });

  it("stays put when some other notebook was deleted", async () => {
    const app = harness({
      state: { shelf: notebookShelf("b2") },
      write: async () => ({ status: "executed", output: {} }),
    });
    await app.logic.deleteNotebook("b1");
    expect(app.routes).toStrictEqual([]);
  });

  it("surfaces the vault's non-empty-notebook refusal in the product's words", async () => {
    const app = harness({
      write: async () => ({
        status: "failed",
        predicate: "notebook_has_no_children: count = 2",
      }),
    });
    await app.logic.deleteNotebook("b1");
    expect(app.statusTexts).toStrictEqual([
      "Delete or move the notebooks inside this one first",
    ]);
  });
});

describe("tags, links and files", () => {
  it("never sends a blank tag", async () => {
    const app = harness();
    await app.logic.addTag("n1", "  ");
    expect(app.sent).toStrictEqual([]);
  });

  it("trims a tag before it becomes a concept", async () => {
    const app = harness();
    await app.logic.addTag("n1", "  recipes ");
    expect(app.sent).toStrictEqual([
      { action: "add-tag", input: { note_id: "n1", label: "recipes" } },
    ]);
  });

  it("removes a tag by its edge id", async () => {
    const app = harness();
    await app.logic.removeTag("t1");
    expect(app.sent).toStrictEqual([
      { action: "remove-tag", input: { tag_id: "t1" } },
    ]);
  });

  it("sends a bare typed reference when no passage was selected", async () => {
    const app = harness();
    await app.logic.linkNote(
      "n1",
      { type: "task", id: "t9", title: "Oat milk", app: "tasks" },
      null
    );
    expect(app.sent[0]?.input).toStrictEqual({
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
    expect(app.sent[0]?.input).toStrictEqual({
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
    expect(app.sent[0]?.input).toStrictEqual({
      note_id: "n1",
      target_type: "task",
      target_id: "t9",
    });
  });

  it("pins a readable file to the note as an embedded data URI", async () => {
    const app = harness();
    await app.logic.attachFile("n1", { name: "note.txt" } as unknown as File);
    const input = app.sent[0]?.input as Record<string, unknown>;
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
    expect(app.statusTexts).toStrictEqual([
      "That file could not be read on this device",
    ]);
    expect(app.sent).toStrictEqual([]);
  });

  it("detaches by attachment id", async () => {
    const app = harness();
    await app.logic.removeAttachment("a1");
    expect(app.sent).toStrictEqual([
      { action: "detach", input: { attachment_id: "a1" } },
    ]);
  });
});

describe("a checkbox is a character in the body", () => {
  it("ticks an unchecked box and re-tallies from the same text", async () => {
    const clock = useFakeClock();
    const row = note({ note_id: "n1", body: "- [ ] milk\n- [x] bread" });
    const app = harness({ data: { notes: [row] } });
    await app.logic.toggleCheck("n1", 0);
    expect(row.body).toBe("- [x] milk\n- [x] bread");
    expect(row.check).toStrictEqual({ total: 2, done: 2 });
    await clock.advance(600);
    expect(app.sent[0]?.input).toStrictEqual({
      note_id: "n1",
      body_text: "- [x] milk\n- [x] bread",
    });
  });

  it("unticks a ticked box, case-insensitively", async () => {
    useFakeClock();
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
    expect(app.paints()).toBe(0);
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
    expect(app.sent).toStrictEqual([
      {
        action: "send-to-tasks",
        input: {
          title: "call Ravi on 2026-09-01",
          due_at: "2026-09-01",
          note_id: "n1",
          exact: "call [[Ravi]] on 2026-09-01",
        },
      },
    ]);
    expect(app.statusTexts).toStrictEqual([
      expect.stringContaining("call Ravi on 2026-09-01"),
    ]);
  });
});
