// @vitest-environment jsdom
//
// Photos' pending-write projection (issue #738) — pure declaration checks,
// same convention as apps/_shared/pending-overlay.test.ts and
// apps/agenda/pending-projection.test.ts — plus the reload-survival tests for
// the durable attention journal at the bottom (jsdom, because those drive the
// real `outcomes.ts` module).
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  act,
  attentionRows,
  restorePending,
  setStatusSink,
} from "./outcomes.ts";
import type { StatusNote } from "./outcomes.ts";
import { photosPendingProjection } from "./pending-projection.ts";

function ctx(intentId: string) {
  return { intentId, rowId: `pending-${intentId}` };
}

describe("Photos' pending-write projection", () => {
  test("update-asset projects only the fields present (favorite/captured_at/archived)", () => {
    expect(
      photosPendingProjection.actions["update-asset"]!(
        { asset_id: "asset-1", favorite: 1 },
        ctx("intent-1")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "media.media_asset",
        rowId: "asset-1",
        values: { favorite: 1 },
      },
    ]);

    expect(
      photosPendingProjection.actions["update-asset"]!(
        { asset_id: "asset-1", archived: 1 },
        ctx("intent-2")
      )
    ).toMatchObject([
      {
        op: "upsert",
        entity: "media.media_asset",
        rowId: "asset-1",
        values: { archived_at: expect.any(String) },
      },
    ]);

    expect(
      photosPendingProjection.actions["update-asset"]!(
        { asset_id: "asset-1", archived: 0 },
        ctx("intent-3")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "media.media_asset",
        rowId: "asset-1",
        values: { archived_at: null },
      },
    ]);

    // title lives on core.content_item, not media.media_asset — undeclared.
    expect(
      photosPendingProjection.actions["update-asset"]!(
        { asset_id: "asset-1", title: "Renamed" },
        ctx("intent-4")
      )
    ).toStrictEqual([]);
  });

  test("delete-asset/restore flip the soft-delete pair", () => {
    expect(
      photosPendingProjection.actions["delete-asset"]!(
        { asset_id: "asset-1" },
        ctx("intent-5")
      )
    ).toMatchObject([
      { op: "upsert", entity: "media.media_asset", rowId: "asset-1" },
    ]);
    expect(
      photosPendingProjection.actions.restore!(
        { asset_id: "asset-1" },
        ctx("intent-6")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "media.media_asset",
        rowId: "asset-1",
        values: { deleted_at: null, purge_at: null },
      },
    ]);
  });

  test("purge-asset and album membership are deliberately undeclared", () => {
    expect(photosPendingProjection.actions["purge-asset"]).toBeUndefined();
    expect(photosPendingProjection.actions["add-to-album"]).toBeUndefined();
    expect(
      photosPendingProjection.actions["remove-from-album"]
    ).toBeUndefined();
  });
});

// ─── the durable attention journal (issue #738 engine H) ────────────────────
//
// `restorePending()` reads TWO durable sources, because a settled write leaves
// the outbox: `pendingWrites()` for what is still in flight, and
// `attentionWrites()` for what came back denied/conflicted/failed. Without the
// second one a denied row lives only in this session's memory and dies on
// reload — the exact "anchored in app memory" failure the issue exists to end.
//
// Photos has no per-row home for a refused write (Tile.tsx's four overlay
// slots are a stated design budget), so what these pin down is the plumbing
// plus the ONE surface it does have: the frame's status line, which names the
// refusal and offers Discard.

/** A stand-in for the client's durable attention journal. */
function attentionJournal(seed: CentraidAttentionWrite[] = []) {
  const rows = [...seed];
  const dismissAttentionWrite = vi.fn<
    NonNullable<typeof window.centraid.dismissAttentionWrite>
  >(async ({ intentId }) => {
    const at = rows.findIndex((row) => row.intentId === intentId);
    if (at < 0) return false;
    rows.splice(at, 1);
    return true;
  });
  return { rows, dismissAttentionWrite };
}

function stubJournal(
  journal: ReturnType<typeof attentionJournal>,
  extra: Record<string, unknown> = {}
) {
  Object.defineProperty(window, "centraid", {
    configurable: true,
    value: {
      pendingWrites: async () => [],
      attentionWrites: async () => journal.rows.map((row) => ({ ...row })),
      dismissAttentionWrite: journal.dismissAttentionWrite,
      ...extra,
    },
  });
}

describe("Photos attention rows survive a reload (issue #738)", () => {
  afterEach(() => {
    setStatusSink(null);
  });

  test("a denied favorite this process never issued comes back from the durable journal, and the status line offers Discard", async () => {
    // The row is seeded straight into the durable journal, under an intent id
    // this module's model has never seen: `restoreAttention()` is therefore
    // the ONLY thing that can produce it, which is exactly the reload journey
    // (the client's outbox drops a settled intent, so `restore()` cannot).
    const journal = attentionJournal([
      {
        intentId: "intent-denied",
        action: "update-asset",
        status: "denied",
        reason: "This audience is read-only for you.",
        input: { asset_id: "asset-1", favorite: 1 },
        mutations: [],
        settledAt: "2026-08-11T10:00:00.000Z",
      },
    ]);
    stubJournal(journal);
    expect(attentionRows()).toStrictEqual([]);

    const notes: (StatusNote | null)[] = [];
    setStatusSink((note) => notes.push(note));
    await restorePending();

    // Row CONTENT, never a count.
    expect(attentionRows()).toMatchObject([
      {
        intentId: "intent-denied",
        action: "update-asset",
        status: "denied",
        reason: "This audience is read-only for you.",
        input: { asset_id: "asset-1", favorite: 1 },
      },
    ]);
    // …projected onto the asset row it was about, from the declaration alone —
    // the journal carried no mutations for it.
    expect(attentionRows()[0]!.rowIds).toStrictEqual(["asset-1"]);

    // The one surface Photos has says what happened, and offers the one
    // answer that has no other route — the tile's own heart is still there to
    // tap again, but only this can clear the durable record.
    const announced = notes.at(-1);
    expect(announced?.text).toContain("This audience is read-only for you.");
    expect(announced?.action?.label).toBe("Discard");

    announced!.action!.run();
    expect(journal.dismissAttentionWrite).toHaveBeenCalledWith({
      intentId: "intent-denied",
    });
    expect(journal.rows).toStrictEqual([]);
    expect(attentionRows()).toStrictEqual([]);
    expect(notes.at(-1)).toBeNull();

    // …and it stays discarded across the next reload, even if a stale read
    // races the clear and still reports it.
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: {
        pendingWrites: async () => [],
        attentionWrites: async () => [
          {
            intentId: "intent-denied",
            action: "update-asset",
            status: "denied" as const,
            reason: "This audience is read-only for you.",
            input: { asset_id: "asset-1", favorite: 1 },
            mutations: [],
            settledAt: "2026-08-11T10:00:00.000Z",
          },
        ],
      },
    });
    await restorePending();
    expect(attentionRows()).toStrictEqual([]);
  });

  test("an asset write carries the row version it was composed against, in the scope it lands in, and a conflict states both", async () => {
    const rowVersion = vi.fn<NonNullable<typeof window.centraid.rowVersion>>(
      async () => 6
    );
    const write = vi.fn<typeof window.centraid.write>(
      async () =>
        ({
          status: "conflict",
          reason: "Someone else changed this first.",
          conflict: {
            entity: "media.media_asset",
            rowId: "asset-1",
            expectedVersion: 6,
            actualVersion: 7,
          },
        }) as never
    );
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: {
        write,
        rowVersion,
        pendingWrites: async () => [],
        attentionWrites: async () => [],
      },
    });

    await act("delete-asset", { asset_id: "asset-1" }, "scope-shared");
    expect(rowVersion).toHaveBeenCalledWith({
      entity: "media.media_asset",
      rowId: "asset-1",
      scope: "scope-shared",
    });
    expect(write.mock.calls[0]![0].baseVersions).toStrictEqual([
      { entity: "media.media_asset", rowId: "asset-1", version: 6 },
    ]);
    // A conflict says WHICH versions disagreed — degrading it to a generic
    // error would waste the entire precondition.
    expect(attentionRows()).toMatchObject([
      {
        action: "delete-asset",
        status: "conflict",
        conflict: {
          entity: "media.media_asset",
          rowId: "asset-1",
          expectedVersion: 6,
          actualVersion: 7,
        },
      },
    ]);

    // An undeclared action projects nothing and carries no precondition —
    // `purge-asset` is permanent and reads honestly only as a live round trip.
    await act("purge-asset", { asset_id: "asset-1" });
    expect(write.mock.calls[1]![0].baseVersions).toBeUndefined();
  });

  test("restorePending() is a safe no-op on a host with neither durable surface (the visual-harness mock)", async () => {
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: {},
    });
    await expect(restorePending()).resolves.toBeUndefined();
  });
});
