/*! Browser-JS fixtures intentionally lack TypeScript declarations. (#408) */
// oxlint-disable-next-line typescript/ban-ts-comment -- (#408) these browser-JS fixture imports have no TypeScript declarations
// @ts-nocheck -- the imported query handlers use the ambient runtime HandlerCtx
/*
 * Handler coverage for Locker's #872 reads: the window total and the alias
 * read-back on `items`, and the sidecars and the degradation rule on `item`.
 * The sealed sidecar reveal (#873) and the access history are in
 * `queries-reveal-access.test.ts`, split off at the 625-line hygiene limit
 * (#930); both suites share the recording ctx in `queries.test-fixtures.ts`,
 * which does NOT apply `where` — every assertion about narrowing is made
 * against the RECORDED read requests.
 */
import { describe, expect, it } from "vitest";

import {
  ctxOf,
  LIVE_ITEM,
  OLD_CIPHERTEXT,
  OLDER_CIPHERTEXT,
} from "./queries.test-fixtures.ts";

describe("items: the window total and the alias read-back (#872)", () => {
  it("reports the vault's live count beside the window, so the foot line can say '300 of 312'", async () => {
    const { default: items } = await import("./queries/items.ts");
    const ctx = ctxOf(
      { "locker.item": [LIVE_ITEM] },
      {
        outputs: {
          "locker.counts": {
            live: 312,
            archived: 4,
            trashed: 2,
            by_type: [{ type: "login", n: 312 }],
          },
        },
      }
    );
    const result = await items({ input: {}, ctx });
    expect(result.total).toBe(312);
    expect(result.window).toBe(300);
    expect(result.archivedCount).toBe(4);
    expect(result.trashedCount).toBe(2);
    expect(result.byType).toStrictEqual([{ type: "login", n: 312 }]);
  });

  it("honours a caller's limit up to the 2,000 ceiling", async () => {
    const { default: items } = await import("./queries/items.ts");
    const ctx = ctxOf({ "locker.item": [] });
    await items({ input: { limit: 9000 }, ctx });
    expect(ctx.calls.find((call) => call.entity === "locker.item")?.limit).toBe(
      2000
    );
    const smaller = ctxOf({ "locker.item": [] });
    await items({ input: { limit: 50 }, ctx: smaller });
    expect(
      smaller.calls.find((call) => call.entity === "locker.item")?.limit
    ).toBe(50);
  });

  it("says nothing about a total it could not read, rather than guessing", async () => {
    const { default: items } = await import("./queries/items.ts");
    const ctx = ctxOf({ "locker.item": [LIVE_ITEM] });
    const result = await items({ input: {}, ctx });
    expect(result.total).toBeUndefined();
    expect(result.items).toHaveLength(1);
  });

  it("decorates a row with its connector alias", async () => {
    const { default: items } = await import("./queries/items.ts");
    const ctx = ctxOf({
      "locker.item": [LIVE_ITEM],
      "locker.item_alias": [{ alias: "github", item_id: "item-1" }],
    });
    const result = await items({ input: {}, ctx });
    expect(result.items[0].alias).toBe("github");
  });

  it("excludes archived items from the default window and asks for them explicitly", async () => {
    const { default: items } = await import("./queries/items.ts");
    const plain = ctxOf({ "locker.item": [] });
    await items({ input: {}, ctx: plain });
    expect(
      plain.calls.find((call) => call.entity === "locker.item")?.where
    ).toStrictEqual([
      { column: "deleted_at", op: "is-null" },
      { column: "archived_at", op: "is-null" },
    ]);
    const shelf = ctxOf({ "locker.item": [] });
    await items({ input: { archived: true }, ctx: shelf });
    expect(
      shelf.calls.find((call) => call.entity === "locker.item")?.where
    ).toStrictEqual([
      { column: "deleted_at", op: "is-null" },
      { column: "archived_at", op: "not-null" },
    ]);
  });

  it("never carries a secret column on a list row", async () => {
    const { default: items } = await import("./queries/items.ts");
    const ctx = ctxOf({
      "locker.item": [{ ...LIVE_ITEM, password: "«sealed»", content: "x" }],
    });
    const result = await items({ input: {}, ctx });
    for (const key of ["password", "otp_seed", "card_number", "cvv", "content"])
      expect(result.items[0][key]).toBeUndefined();
  });
});

describe("item: the sidecars and the degradation rule (#872)", () => {
  const detailCtx = () =>
    ctxOf({
      "locker.item": [LIVE_ITEM],
      "locker.item_alias": [{ alias: "github", item_id: "item-1" }],
      "locker.item_field": [
        {
          field_id: "field-1",
          section: "Recovery",
          label: "Recovery code",
          kind: "sealed",
          value_text: null,
          value_sealed: "«sealed»",
          position: 0,
        },
        {
          field_id: "field-2",
          section: "Recovery",
          label: "Where it is",
          kind: "text",
          value_text: "top drawer",
          value_sealed: null,
          position: 1,
        },
      ],
      "locker.item_address": [
        {
          address_id: "addr-1",
          url: "https://login.example.test",
          match_policy: "exact-host",
          position: 0,
        },
      ],
      "locker.item_passkey": [
        {
          item_id: "item-1",
          rp_id: "example.test",
          user_handle: "alex",
          display_name: null,
          credential_id: null,
          algorithm: null,
          private_key: "«sealed»",
          created_at: "2026-08-01T00:00:00.000Z",
        },
      ],
      // THE REAL SHAPE OF `core_entity_revision` (#916, D2): a pre-mutation
      // SNAPSHOT of the item row, sealed cells and all, newest first. There is
      // no `changed_json` and no separate `password` cell — what changed is
      // what the state that superseded the snapshot says differently, and the
      // snapshot's `password` is the item's own ciphertext, which nothing here
      // may forward.
      "core.entity_revision": [
        // Newest first, as the handler's `orderBy` asks for. `rev-2` is the
        // state before the password was rotated: its `password_set_at` is
        // older than the item's, which is how a rotation is named without
        // anything looking at the secret.
        {
          revision_id: "rev-2",
          entity_type: "locker.item",
          entity_id: "item-1",
          operation: "update",
          snapshot_json: JSON.stringify({
            ...LIVE_ITEM,
            password: OLD_CIPHERTEXT,
            password_set_at: "2025-06-01T00:00:00.000Z",
          }),
          recorded_at: "2026-01-01T00:00:00.000Z",
          undo_until: "2026-01-01T00:00:10.000Z",
          undone_at: null,
        },
        // And `rev-1` is a rename that left the password alone — same
        // `password_set_at` as the state that superseded it.
        {
          revision_id: "rev-1",
          entity_type: "locker.item",
          entity_id: "item-1",
          operation: "update",
          snapshot_json: JSON.stringify({
            ...LIVE_ITEM,
            username: "old@example.test",
            password: OLDER_CIPHERTEXT,
            password_set_at: "2025-06-01T00:00:00.000Z",
          }),
          recorded_at: "2025-09-01T00:00:00.000Z",
          undo_until: "2025-09-01T00:00:10.000Z",
          undone_at: null,
        },
      ],
    });

  it("reads the alias back so the form can show, clear and reassign it", async () => {
    const { default: item } = await import("./queries/item.ts");
    const result = await item({
      input: { item_id: "item-1" },
      ctx: detailCtx(),
    });
    expect(result.item.alias).toBe("github");
  });

  it("reports a sealed custom value as PRESENT and never returns it", async () => {
    const { default: item } = await import("./queries/item.ts");
    const result = await item({
      input: { item_id: "item-1" },
      ctx: detailCtx(),
    });
    const sealed = result.item.fields.find((f) => f.label === "Recovery code");
    expect(sealed).toMatchObject({ kind: "sealed", value: null, sealed: true });
    const plain = result.item.fields.find((f) => f.label === "Where it is");
    expect(plain).toMatchObject({ kind: "text", value: "top drawer" });
  });

  it("carries the extra addresses with their own match policies", async () => {
    const { default: item } = await import("./queries/item.ts");
    const result = await item({
      input: { item_id: "item-1" },
      ctx: detailCtx(),
    });
    expect(result.item.addresses).toStrictEqual([
      {
        address_id: "addr-1",
        url: "https://login.example.test",
        match_policy: "exact-host",
      },
    ]);
    // The primary address stays on the item itself.
    expect(result.item.url).toBe("https://example.test");
  });

  it("shows the passkey slot's metadata and never its key material", async () => {
    const { default: item } = await import("./queries/item.ts");
    const result = await item({
      input: { item_id: "item-1" },
      ctx: detailCtx(),
    });
    expect(result.item.passkey).toMatchObject({
      rp_id: "example.test",
      user_handle: "alex",
      has_private_key: true,
    });
    expect(result.item.passkey.private_key).toBeUndefined();
  });

  /*
   * HISTORY IS REVISIONS (#916, D2). `locker_item_history` is gone and the
   * gateway REFUSES `locker.item_history` as an unknown entity, so the read
   * itself is the assertion: the mock answers `[]` for any entity it was not
   * given, and a handler that went back to the dead table would hand back an
   * empty pane AND fail the recorded-call assertions below.
   */
  it("reads the item's revisions, narrowed by entity type and id, newest first", async () => {
    const { default: item } = await import("./queries/item.ts");
    const ctx = detailCtx();
    await item({ input: { item_id: "item-1" }, ctx });
    const entities = ctx.calls.map((call) => call.entity);
    expect(entities).toContain("core.entity_revision");
    expect(entities).not.toContain("locker.item_history");
    const read = ctx.calls.find(
      (call) => call.entity === "core.entity_revision"
    );
    expect(read.where).toStrictEqual([
      { column: "entity_type", op: "eq", value: "locker.item" },
      { column: "entity_id", op: "eq", value: "item-1" },
    ]);
    expect(read.orderBy).toStrictEqual({ column: "recorded_at", dir: "desc" });
    expect(read.limit).toBe(50);
  });

  it("names what changed, and never what it changed from", async () => {
    const { default: item } = await import("./queries/item.ts");
    const result = await item({
      input: { item_id: "item-1" },
      ctx: detailCtx(),
    });
    expect(result.item.history).toStrictEqual([
      // The rotation, read off `password_set_at` — a PLAIN column the vault
      // re-stamps only when a password is set.
      {
        revision_id: "rev-2",
        operation: "update",
        changed: { password: true },
        recorded_at: "2026-01-01T00:00:00.000Z",
      },
      // The rename, which left the password alone.
      {
        revision_id: "rev-1",
        operation: "update",
        changed: { username: true },
        recorded_at: "2025-09-01T00:00:00.000Z",
      },
    ]);
  });

  it("opens the snapshot and never forwards it", async () => {
    const { default: item } = await import("./queries/item.ts");
    const result = await item({
      input: { item_id: "item-1" },
      ctx: detailCtx(),
    });
    // The snapshot's sealed cells are the item's own ciphertext, not the read
    // placeholder. Neither the ciphertext nor the raw snapshot may ride out.
    const payload = JSON.stringify(result);
    expect(payload).not.toContain(OLD_CIPHERTEXT);
    expect(payload).not.toContain(OLDER_CIPHERTEXT);
    expect(payload).not.toContain("snapshot");
  });

  it("degrades a type this build does not know to a note that keeps its fields", async () => {
    const { default: item } = await import("./queries/item.ts");
    const ctx = ctxOf({
      "locker.item": [{ ...LIVE_ITEM, type: "quantum_key" }],
      "locker.item_field": [
        {
          field_id: "field-9",
          section: "",
          label: "Entanglement id",
          kind: "text",
          value_text: "e-1",
          value_sealed: null,
          position: 0,
        },
      ],
    });
    const result = await item({ input: { item_id: "item-1" }, ctx });
    expect(result.item.type).toBe("note");
    expect(result.item.degraded_from).toBe("quantum_key");
    expect(result.item.fields).toHaveLength(1);
  });
});
