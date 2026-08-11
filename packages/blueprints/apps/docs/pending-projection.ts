// Docs' pending-write projection (issue #738) — pure config, scope-kit
// style, consumed by `createPendingOverlayModel` in logic.ts. Record-shaped
// writes only (rename, move, folder create/rename): a document's identity is
// its `core.document` wrapper, never the bytes its `current_content_id`
// points at, so byte-custody actions (upload/edit/replace/restore-version)
// stay out of scope entirely — a projected wrapper with stale bytes would be
// a worse lie than no overlay at all.
//
// `star`/`unstar` are deliberately undeclared, same reasoning as People's
// star: favoriting is a flags-scheme `core.tag` row keyed by a `concept_id`
// the vault mints lazily and never hands to the client.
import type {
  PendingMutation,
  PendingProjectionDeclaration,
} from "../_shared/pending-overlay.ts";

function stringField(
  input: Record<string, unknown>,
  key: string
): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

export const docsPendingProjection: PendingProjectionDeclaration = {
  appId: "docs",
  actions: {
    // core.rename_document's own UPDATE (packages/vault/src/commands/
    // documents.ts): title only.
    rename(input) {
      const documentId = stringField(input, "document_id");
      const title = stringField(input, "title");
      if (!documentId || !title) return [];
      return [
        {
          op: "upsert",
          entity: "core.document",
          rowId: documentId,
          values: { title },
        },
      ];
    },

    // core.move_document's `fileInto`: DELETE the document's one folders-scheme
    // core.tag row, INSERT a fresh one under a new tag_id. The client cannot
    // know that minted id, so it upserts under a rowId the engine controls
    // (ctx.rowId) instead — the delete alone still keeps the document
    // honestly "unfiled" if `folder_id` cannot be resolved (moving to the
    // drive's top level before `root_folder_id` has ever loaded).
    // `folder_tag_id` (the row being replaced) and an always-explicit
    // `folder_id` (root resolved client-side) are logic.ts's job to supply.
    move(input, ctx) {
      const documentId = stringField(input, "document_id");
      if (!documentId) return [];
      const mutations: PendingMutation[] = [];
      const oldTagId = stringField(input, "folder_tag_id");
      if (oldTagId) {
        mutations.push({ op: "delete", entity: "core.tag", rowId: oldTagId });
      }
      const folderId = stringField(input, "folder_id");
      if (folderId) {
        mutations.push({
          op: "upsert",
          entity: "core.tag",
          rowId: ctx.rowId,
          values: {
            tag_id: ctx.rowId,
            target_type: "core.document",
            target_id: documentId,
            concept_id: folderId,
            tagged_at: new Date().toISOString(),
          },
        });
      }
      return mutations;
    },

    // core.trash_document/restore_document flip core.document's soft-delete
    // pair. The real purge_at is a settlement detail (~30 days out); clearing
    // it to null on restore is exact either way.
    trash(input) {
      const documentId = stringField(input, "document_id");
      if (!documentId) return [];
      return [
        {
          op: "upsert",
          entity: "core.document",
          rowId: documentId,
          values: { deleted_at: new Date().toISOString() },
        },
      ];
    },
    restore(input) {
      const documentId = stringField(input, "document_id");
      if (!documentId) return [];
      return [
        {
          op: "upsert",
          entity: "core.document",
          rowId: documentId,
          values: { deleted_at: null, purge_at: null },
        },
      ];
    },

    // core.create_folder mints a core.concept row. `folder_scheme_id` (the
    // real folders scheme, never exposed by the query as a folder field
    // itself — logic.ts reads it off `data.folder_scheme_id`) must ride the
    // write or the pending folder would file under no scheme the drive query
    // recognizes and simply never render.
    "create-folder"(input, ctx) {
      const name = stringField(input, "name");
      const schemeId = stringField(input, "folder_scheme_id");
      if (!name || !schemeId) return [];
      const values: Record<string, unknown> = {
        concept_id: ctx.rowId,
        scheme_id: schemeId,
        notation: ctx.rowId,
        pref_label: name,
      };
      const parentId = stringField(input, "parent_folder_id");
      if (parentId) values.broader_concept_id = parentId;
      return [
        { op: "upsert", entity: "core.concept", rowId: ctx.rowId, values },
      ];
    },

    // core.rename_folder's own UPDATE: pref_label only.
    "rename-folder"(input) {
      const folderId = stringField(input, "folder_id");
      const name = stringField(input, "name");
      if (!folderId || !name) return [];
      return [
        {
          op: "upsert",
          entity: "core.concept",
          rowId: folderId,
          values: { pref_label: name },
        },
      ];
    },
  },
};
