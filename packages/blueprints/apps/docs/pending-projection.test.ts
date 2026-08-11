// Docs' pending-write projection (issue #738) — pure declaration checks,
// same convention as apps/_shared/pending-overlay.test.ts and
// apps/agenda/pending-projection.test.ts.
import { describe, expect, test } from "vitest";

import { docsPendingProjection } from "./pending-projection.ts";

function ctx(intentId: string) {
  return { intentId, rowId: `pending-${intentId}` };
}

describe("Docs' pending-write projection", () => {
  test("rename upserts the wrapper's title", () => {
    expect(
      docsPendingProjection.actions.rename!(
        { document_id: "doc-1", title: "Renamed.pdf" },
        ctx("intent-1")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.document",
        rowId: "doc-1",
        values: { title: "Renamed.pdf" },
      },
    ]);
  });

  test("move deletes the old folder tag and upserts a new one under the minted id", () => {
    const mutations = docsPendingProjection.actions.move!(
      {
        document_id: "doc-1",
        folder_id: "folder-2",
        folder_tag_id: "tag-old",
      },
      ctx("intent-2")
    );
    expect(mutations).toStrictEqual([
      { op: "delete", entity: "core.tag", rowId: "tag-old" },
      {
        op: "upsert",
        entity: "core.tag",
        rowId: "pending-intent-2",
        values: {
          tag_id: "pending-intent-2",
          target_type: "core.document",
          target_id: "doc-1",
          concept_id: "folder-2",
          tagged_at: expect.any(String),
        },
      },
    ]);
  });

  test("move without a resolvable folder_id (root before it has ever loaded) still deletes the stale tag", () => {
    expect(
      docsPendingProjection.actions.move!(
        { document_id: "doc-1", folder_tag_id: "tag-old" },
        ctx("intent-3")
      )
    ).toStrictEqual([{ op: "delete", entity: "core.tag", rowId: "tag-old" }]);
  });

  test("trash/restore flip core.document's soft-delete pair", () => {
    expect(
      docsPendingProjection.actions.trash!(
        { document_id: "doc-1" },
        ctx("intent-4")
      )
    ).toMatchObject([
      { op: "upsert", entity: "core.document", rowId: "doc-1" },
    ]);
    expect(
      docsPendingProjection.actions.restore!(
        { document_id: "doc-1" },
        ctx("intent-5")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.document",
        rowId: "doc-1",
        values: { deleted_at: null, purge_at: null },
      },
    ]);
  });

  test("create-folder mints a concept under the real scheme, and projects nothing without one", () => {
    expect(
      docsPendingProjection.actions["create-folder"]!(
        { name: "Taxes", folder_scheme_id: "scheme-1" },
        ctx("intent-6")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.concept",
        rowId: "pending-intent-6",
        values: {
          concept_id: "pending-intent-6",
          scheme_id: "scheme-1",
          notation: "pending-intent-6",
          pref_label: "Taxes",
        },
      },
    ]);
    expect(
      docsPendingProjection.actions["create-folder"]!(
        { name: "Taxes" },
        ctx("intent-7")
      )
    ).toStrictEqual([]);
  });

  test("rename-folder upserts the concept's pref_label", () => {
    expect(
      docsPendingProjection.actions["rename-folder"]!(
        { folder_id: "folder-1", name: "New name" },
        ctx("intent-8")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.concept",
        rowId: "folder-1",
        values: { pref_label: "New name" },
      },
    ]);
  });

  test("star/unstar are deliberately undeclared", () => {
    expect(docsPendingProjection.actions.star).toBeUndefined();
    expect(docsPendingProjection.actions.unstar).toBeUndefined();
  });
});
