// Notes' declared pending-write projection (issue #738): how each
// write-bearing action's input maps onto the rows the library/search queries
// read. Grounded in the real command handlers (packages/vault/src/commands/
// knowledge.ts) so the optimistic row matches what settlement will actually
// produce.
//
// A note's body is never a column on `knowledge.note` — it lives as a
// sha256-deduped `core.content_item` referenced by `body_content_id`
// (contentItemFor in knowledge.ts). `create-note`/an `edit-note` that carries
// `body_text` therefore project TWO rows: the content item under a
// deterministic id derived from the same intent, then the note pointing at
// it — the same "expense plus participant rows" shape pending-overlay.ts
// documents. `create-note`'s notebook filing is a THIRD row
// (`core.collection_entry`) only when a target notebook was given; there is
// no prior placement to reconcile for a brand-new note, unlike `move-note`
// below.
//
// `move-note` cannot honestly project the filing change itself: a note's
// notebook membership is a `core.collection_entry` join row this app never
// mints a stable client-side id for on an EXISTING note (the vault "replaces
// any existing placement", and this device does not know the prior entry's
// id to remove it) — projecting a new entry without removing the old one
// would show the note filed under two notebooks until settlement. So
// `move-note` upserts its `knowledge.note` row with NO field changes: enough
// for `byRowId()` to carry the pending chip, honest about not knowing the
// new notebook_ids yet.
//
// `delete-notebook` is the same shape as `move-note`: a real `delete`
// mutation would vanish the notebook from the sidebar the instant the write
// is queued, losing the "still here, dimmed, pending" affordance
// Sidebar.tsx renders for a parked rename/delete — so it upserts nothing on
// the collection row either, purely to register the pending chip.
//
// `create-notebook`, `attach`/`detach`, `add-tag`/`remove-tag` and `link` are
// deliberately left undeclared (the same online-only set the pre-#738
// `markPending` never covered either — `attach` went through `act()`, which
// never marked anything pending, and a parked `create-notebook` had no
// overlay affordance at all).
import type {
  PendingMutation,
  PendingProjectionDeclaration,
} from "../_shared/pending-overlay.ts";

const MEDIA_TYPE: Record<string, string> = {
  markdown: "text/markdown",
  html: "text/html",
  plain: "text/plain",
};

const NOTE_PURGE_AFTER_DAYS = 30;

function mediaTypeFor(format: unknown): string {
  return (
    MEDIA_TYPE[typeof format === "string" ? format : "plain"] ?? "text/plain"
  );
}

/** A synthesized `core.content_item` row for one write's body text — the
 *  overlay's own dedupe id (`sha256`) is set to the row id itself: nothing
 *  reads it for real dedup client-side, but the column must carry a value
 *  (schema NOT NULL) and this keeps it deterministic in the intent. */
function contentItemMutation(
  rowId: string,
  bodyText: string,
  format: unknown
): PendingMutation {
  const mediaType = mediaTypeFor(format);
  return {
    op: "upsert",
    entity: "core.content_item",
    rowId,
    values: {
      content_id: rowId,
      media_type: mediaType,
      content_uri: `data:${mediaType};charset=utf-8,${encodeURIComponent(bodyText)}`,
      sha256: rowId,
      byte_size: bodyText.length,
      created_at: new Date().toISOString(),
    },
  };
}

export const notesPendingProjection: PendingProjectionDeclaration = {
  appId: "notes",
  actions: {
    "create-note": (input, ctx) => {
      const now = new Date().toISOString();
      const bodyText = String(input.body_text ?? "");
      const contentId = `${ctx.rowId}-body`;
      const mutations: PendingMutation[] = [
        contentItemMutation(contentId, bodyText, input.format),
        {
          op: "upsert",
          entity: "knowledge.note",
          rowId: ctx.rowId,
          values: {
            note_id: ctx.rowId,
            title: String(input.title ?? ""),
            body_content_id: contentId,
            format: typeof input.format === "string" ? input.format : "plain",
            pinned: 0,
            created_at: now,
            updated_at: now,
          },
        },
      ];
      if (typeof input.notebook_id === "string" && input.notebook_id) {
        const entryId = `${ctx.rowId}-entry`;
        mutations.push({
          op: "upsert",
          entity: "core.collection_entry",
          rowId: entryId,
          values: {
            entry_id: entryId,
            collection_id: input.notebook_id,
            target_type: "knowledge.note",
            target_id: ctx.rowId,
            position: 0,
            added_at: now,
          },
        });
      }
      return mutations;
    },

    "edit-note": (input, ctx) => {
      const noteId = String(input.note_id ?? "");
      if (!noteId) return [];
      const values: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (typeof input.title === "string") values.title = input.title;
      if (typeof input.pinned === "number") values.pinned = input.pinned;
      const mutations: PendingMutation[] = [];
      if (typeof input.body_text === "string") {
        const contentId = `${ctx.rowId}-body`;
        mutations.push(
          contentItemMutation(contentId, input.body_text, input.format)
        );
        values.body_content_id = contentId;
        if (typeof input.format === "string") values.format = input.format;
      }
      mutations.push({
        op: "upsert",
        entity: "knowledge.note",
        rowId: noteId,
        values,
      });
      return mutations;
    },

    // See module comment: filing is a join row this device cannot safely
    // reconcile offline. The upsert carries no fields — its only job is
    // registering `noteId` in `byRowId()` for the chip.
    "move-note": (input) => {
      const noteId = String(input.note_id ?? "");
      if (!noteId) return [];
      return [
        { op: "upsert", entity: "knowledge.note", rowId: noteId, values: {} },
      ];
    },

    // Mirrors knowledge.ts's deleteNote: soft-delete, stamped exactly like
    // the real command (30-day purge window) — the row moves buckets
    // (notes → trash) the instant the write is queued, chip included.
    "delete-note": (input) => {
      const noteId = String(input.note_id ?? "");
      if (!noteId) return [];
      const now = new Date();
      const purgeAt = new Date(
        now.getTime() + NOTE_PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000
      ).toISOString();
      return [
        {
          op: "upsert",
          entity: "knowledge.note",
          rowId: noteId,
          values: {
            deleted_at: now.toISOString(),
            purge_at: purgeAt,
            updated_at: now.toISOString(),
          },
        },
      ];
    },

    "rename-notebook": (input) => {
      const notebookId = String(input.notebook_id ?? "");
      if (!notebookId) return [];
      return [
        {
          op: "upsert",
          entity: "core.collection",
          rowId: notebookId,
          values: { name: String(input.name ?? "") },
        },
      ];
    },

    // See module comment: a real delete would vanish the row before the
    // Sidebar can show it dimmed-and-pending, so this registers the chip
    // without touching the row.
    "delete-notebook": (input) => {
      const notebookId = String(input.notebook_id ?? "");
      if (!notebookId) return [];
      return [
        {
          op: "upsert",
          entity: "core.collection",
          rowId: notebookId,
          values: {},
        },
      ];
    },
  },
};
