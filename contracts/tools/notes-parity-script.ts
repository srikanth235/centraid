// THE SCRIPTED COMMAND SET OF THE NOTES PARITY CORPUS (#1020, wave 4 slot 4c).
//
// Split out of `export-notes-parity.ts` at the repository's 625-line ceiling
// (`oxlint.config.ts`'s `max-lines`, exempted only by a ledger row that has to
// survive a down-only budget — so a split is the honest answer and a row is
// not). This half is the SCRIPT: every command Notes invokes at least once, in
// an order whose ids each come from the step before it, plus the refusals a port
// has to reproduce.
//
// **A script of only happy paths cannot tell a port that reproduces the gates
// from one that has none**, which is why a third of the steps below are
// refusals: a name already taken, a notebook with children, a version already
// current, a version belonging to another note, a relation the vault does not
// know, an anchor on an ended link, a detach of something gone, a body over the
// inline budget, an edit of a trashed note, and a restore of a live one.

import type { openVaultDb } from "../../packages/vault/src/db.js";

/** What `export-notes-parity.ts` hands in: one recorded, replayable step. */
export type Execute = <T extends Record<string, unknown>>(
  command: string,
  input: Record<string, unknown>,
  outputKeys?: string[],
  expect?: "executed" | "any",
  pending?: string
) => T;

/**
 * Run the script. The seed's own ids arrive as `noteIds`/`notebookIds`, read off
 * the rows rather than recorded as steps — a seed recorded as steps would make
 * the script a copy of the seed.
 */
export function runNotesScript(
  execute: Execute,
  noteIds: readonly string[],
  notebookIds: readonly string[],
  vault: ReturnType<typeof openVaultDb>["vault"]
): void {
  // THE SCRIPT. Every command Notes invokes at least once, in an order whose
  // ids each come from the step before it — plus the refusals a port has to
  // reproduce.
  const notebook = execute<{ notebook_id: string }>(
    "knowledge.create_notebook",
    { name: "Projects" },
    ["notebook_id"]
  );
  // A sibling name already taken: refused, and the port must refuse it too.
  execute("knowledge.create_notebook", { name: "Travel" }, [], "any");
  const note = execute<{ note_id: string; body_content_id: string }>(
    "knowledge.create_note",
    {
      title: "Cabin shortlist",
      body_text:
        "## Stays\n- [ ] South Lake\n- [x] Truckee\n\n*Book by Thursday.*",
      format: "markdown",
      notebook_id: { $from: "0.notebook_id" },
    },
    ["note_id", "body_content_id"]
  );
  // A NOTEBOOK THAT STILL HOLDS A NOTE deletes anyway — members are unfiled,
  // never destroyed — but one with a CHILD notebook does not.
  const child = execute<{ notebook_id: string }>(
    "knowledge.create_notebook",
    { name: "Cabins", parent_notebook_id: { $from: "0.notebook_id" } },
    ["notebook_id"]
  );
  execute(
    "knowledge.delete_notebook",
    { notebook_id: { $from: "0.notebook_id" } },
    [],
    "any"
  );
  execute("knowledge.delete_notebook", { notebook_id: child.notebook_id }, [
    "notebook_id",
    "notes_unfiled",
  ]);
  execute(
    "knowledge.rename_notebook",
    { notebook_id: { $from: "0.notebook_id" }, name: "Trips" },
    ["notebook_id"]
  );
  // Its own name: an idempotent no-op, not a refusal.
  execute(
    "knowledge.rename_notebook",
    { notebook_id: { $from: "0.notebook_id" }, name: "Trips" },
    ["notebook_id"]
  );
  // A name another notebook already has: refused.
  execute(
    "knowledge.rename_notebook",
    { notebook_id: { $from: "0.notebook_id" }, name: "Recipes" },
    [],
    "any"
  );
  // An edit mints a second version; a second identical edit mints none.
  execute(
    "knowledge.edit_note",
    {
      note_id: { $from: "2.note_id" },
      body_text: "## Stays\n- [x] South Lake\n- [x] Truckee\n\n*Booked.*",
    },
    ["note_id", "body_content_id"]
  );
  execute(
    "knowledge.edit_note",
    {
      note_id: { $from: "2.note_id" },
      body_text: "## Stays\n- [x] South Lake\n- [x] Truckee\n\n*Booked.*",
    },
    ["note_id", "body_content_id"]
  );
  // Title, format and the pin, which is a FIELD and not a command of its own.
  execute(
    "knowledge.edit_note",
    {
      note_id: { $from: "2.note_id" },
      title: "Cabin shortlist (booked)",
      pinned: 1,
    },
    ["note_id"]
  );
  // Back to the first version: a NEW forward occurrence, never a rewrite.
  execute(
    "knowledge.restore_note_version",
    {
      note_id: { $from: "2.note_id" },
      content_id: { $from: "2.body_content_id" },
    },
    ["note_id", "content_id"]
  );
  // Already current: refused.
  execute(
    "knowledge.restore_note_version",
    {
      note_id: { $from: "2.note_id" },
      content_id: { $from: "2.body_content_id" },
    },
    [],
    "any"
  );
  // A version from ANOTHER note's history: refused by its own gate, which is a
  // different answer from "no such version".
  const foreign = vault
    .prepare(
      "SELECT body_content_id FROM knowledge_note WHERE note_id = ? LIMIT 1"
    )
    .get(noteIds[0]) as { body_content_id: string } | undefined;
  if (!foreign) throw new Error("the seed wrote a note with no body");
  execute(
    "knowledge.restore_note_version",
    { note_id: { $from: "2.note_id" }, content_id: foreign.body_content_id },
    [],
    "any"
  );
  // Refiling, then unfiling: an omitted notebook is an explicit intent.
  execute(
    "knowledge.move_note",
    { note_id: { $from: "2.note_id" }, notebook_id: notebookIds[1] },
    ["note_id"]
  );
  execute("knowledge.move_note", { note_id: { $from: "2.note_id" } }, [
    "note_id",
  ]);
  // Tags: idempotent, and the untag leaves the shared concept alone.
  const tag = execute<{ tag_id: string }>(
    "core.tag_item",
    {
      subject_type: "knowledge.note",
      subject_id: { $from: "2.note_id" },
      label: "Travel",
    },
    ["tag_id", "concept_id", "notation"]
  );
  execute(
    "core.tag_item",
    {
      subject_type: "knowledge.note",
      subject_id: { $from: "2.note_id" },
      label: "Travel",
    },
    ["tag_id", "concept_id", "notation"]
  );
  // A non-ASCII label, so the library's `localeCompare` ordering has something
  // a byte sort would put elsewhere.
  execute(
    "core.tag_item",
    {
      subject_type: "knowledge.note",
      subject_id: noteIds[0],
      label: "Café",
    },
    ["tag_id", "concept_id", "notation"]
  );
  execute("core.untag_item", { tag_id: tag.tag_id }, ["tag_id"]);
  // A tag that is gone: refused.
  execute("core.untag_item", { tag_id: tag.tag_id }, [], "any");
  // A link with an inline standoff anchor, written atomically.
  const link = execute<{ link_id: string }>(
    "core.link_entities",
    {
      from_type: "knowledge.note",
      from_id: { $from: "2.note_id" },
      to_type: "knowledge.note",
      to_id: noteIds[1],
      relation: "references",
      selector: {
        exact: "South Lake",
        prefix: "- [x] ",
        suffix: "\n",
        start: 12,
      },
    },
    ["link_id", "relation_concept_id"]
  );
  // The same relationship again, while the first is live: refused.
  execute(
    "core.link_entities",
    {
      from_type: "knowledge.note",
      from_id: { $from: "2.note_id" },
      to_type: "knowledge.note",
      to_id: noteIds[1],
      relation: "references",
    },
    [],
    "any"
  );
  // A relation the vault does not know: refused.
  execute(
    "core.link_entities",
    {
      from_type: "knowledge.note",
      from_id: { $from: "2.note_id" },
      to_type: "knowledge.note",
      to_id: noteIds[2],
      relation: "smells-like",
    },
    [],
    "any"
  );
  // Re-anchoring UPSERTS, and clearing the anchor is a hard delete.
  execute(
    "core.anchor_link",
    {
      link_id: link.link_id,
      selector: {
        exact: "Truckee",
        prefix: "- [x] ",
        suffix: "\n",
        start: 30,
      },
    },
    ["link_id", "anchor_id"]
  );
  // A SECOND link, ENDED, so `valid_to IS NULL` has something to exclude.
  const ended = execute<{ link_id: string }>(
    "core.link_entities",
    {
      from_type: "knowledge.note",
      from_id: { $from: "2.note_id" },
      to_type: "knowledge.note",
      to_id: noteIds[2],
      relation: "references",
    },
    ["link_id"]
  );
  execute("core.unlink_entities", { link_id: ended.link_id }, ["link_id"]);
  // Ended, so it takes no new anchor.
  execute("core.anchor_link", { link_id: ended.link_id }, [], "any");
  // An attachment, then a second one so `is_primary` has two values, then a
  // detach that releases the bytes nothing else holds.
  const attachment = execute<{ attachment_id: string; content_id: string }>(
    "core.attach",
    {
      subject_type: "knowledge.note",
      subject_id: { $from: "2.note_id" },
      data_uri: `data:text/plain;charset=utf-8,${encodeURIComponent(
        "Booking reference QX-4471"
      )}`,
      role: "receipt",
    },
    ["attachment_id", "content_id", "is_primary"]
  );
  execute(
    "core.attach",
    {
      subject_type: "knowledge.note",
      subject_id: { $from: "2.note_id" },
      data_uri: `data:text/plain;charset=utf-8,${encodeURIComponent(
        "Directions from the highway"
      )}`,
    },
    ["attachment_id", "content_id", "is_primary"]
  );
  execute("core.detach", { attachment_id: attachment.attachment_id }, [
    "attachment_id",
    "content_released",
  ]);
  // An attachment that is gone: refused.
  execute(
    "core.detach",
    { attachment_id: attachment.attachment_id },
    [],
    "any"
  );
  // A body over the inline budget: refused before anything is minted.
  execute(
    "knowledge.create_note",
    { title: "Too long", body_text: "b".repeat(70_000) },
    [],
    "any"
  );
  // THE TRASH: delete, refuse the edit, restore, and leave one note trashed so
  // the trash shelf has something on it.
  execute("knowledge.delete_note", { note_id: { $from: "2.note_id" } }, [
    "note_id",
    "purge_at",
    "body_released",
  ]);
  execute(
    "knowledge.edit_note",
    { note_id: { $from: "2.note_id" }, title: "No" },
    [],
    "any"
  );
  execute("knowledge.restore_note", { note_id: { $from: "2.note_id" } }, [
    "note_id",
  ]);
  // A live note cannot be restored.
  execute(
    "knowledge.restore_note",
    { note_id: { $from: "2.note_id" } },
    [],
    "any"
  );
  execute("knowledge.delete_note", { note_id: noteIds[4] }, [
    "note_id",
    "purge_at",
    "body_released",
  ]);
  // `send-to-tasks`' command, which the Rust build does not carry yet.
  execute(
    "schedule.add_task",
    { title: "Book the cabin" },
    [],
    "any",
    "schedule"
  );
  // The two ids the `$from` references resolve against are the RECORDER's, not
  // these: the locals exist so the script reads like the gestures it is.
  void note;
  void notebook;
}
