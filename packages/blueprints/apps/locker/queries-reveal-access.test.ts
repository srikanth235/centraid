/*! Browser-JS fixtures intentionally lack TypeScript declarations. (#408) */
// oxlint-disable-next-line typescript/ban-ts-comment -- (#408) these browser-JS fixture imports have no TypeScript declarations
// @ts-nocheck -- the imported query handlers use the ambient runtime HandlerCtx
/*
 * Handler coverage for what the Locker boundary hands out and what it records:
 * the sealed sidecar reveal on `item` (#873) and the access history on
 * `access` (#872). Split out of `queries.test.ts` at the 625-line hygiene
 * limit (#930); the `items` window and the `item` detail stay there, and both
 * suites share the recording ctx in `queries.test-fixtures.ts`.
 */
import { describe, expect, it } from "vitest";

import { ctxOf, LIVE_ITEM } from "./queries.test-fixtures.ts";

// ---------------------------------------------------------------------------
// The sidecar reveal (#873)
// ---------------------------------------------------------------------------

/*
 * ONE PERMIT BUYS ONE REVEAL. The gateway DELETES the item token before
 * plaintext leaves it (`locker-auth.consumeItemPermit`), so the item's own
 * sealed columns and a sealed sidecar row cannot both be bought with one
 * confirmation. That is the whole reason `sidecar` is a MODE: the assertions
 * below are about WHICH reveal the handler made, because a handler that
 * revealed the item first would burn the token and hand back a null.
 */
describe("item: a sealed sidecar row spends the item's permit (#873)", () => {
  const sidecarCtx = (values: Record<string, string | null>) =>
    ctxOf(
      {
        "locker.item": [LIVE_ITEM],
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
        ],
      },
      { revealValues: values }
    );

  const auth = { auth_session: "sess", item_token: "tok" };

  it("reveals the FIELD and never the item's own columns", async () => {
    const { default: item } = await import("./queries/item.ts");
    const ctx = sidecarCtx({ value_sealed: "r3c0very-c0de" });
    const result = await item({
      input: {
        item_id: "item-1",
        ...auth,
        sidecar: {
          entity: "locker.item_field",
          entityId: "field-1",
          column: "value_sealed",
        },
      },
      ctx,
    });
    expect(ctx.reveals).toHaveLength(1);
    expect(ctx.reveals[0]).toMatchObject({
      entity: "locker.item_field",
      entityId: "field-1",
      columns: ["value_sealed"],
      authentication: { sessionToken: "sess", itemToken: "tok" },
    });
    expect(result.sidecar).toStrictEqual({ value: "r3c0very-c0de" });
    // The row's own shape is untouched: presence, never the value.
    expect(result.item.fields[0]).toMatchObject({ value: null, sealed: true });
  });

  it("reveals the passkey's key material", async () => {
    const { default: item } = await import("./queries/item.ts");
    const cases = [
      ["locker.item_passkey", "item-1", "private_key", "MHcCAQEE-key"],
    ] as const;
    const runs = cases.map(async ([entity, entityId, column, value]) => {
      const ctx = sidecarCtx({ [column]: value });
      const result = await item({
        input: {
          item_id: "item-1",
          ...auth,
          sidecar: { entity, entityId, column },
        },
        ctx,
      });
      return { ctx, result };
    });
    const settled = await Promise.all(runs);
    settled.forEach(({ ctx, result }, index) => {
      const [entity, entityId, column, value] = cases[index];
      expect(ctx.reveals[0]).toMatchObject({
        entity,
        entityId,
        columns: [column],
      });
      expect(result.sidecar).toStrictEqual({ value });
    });
  });

  it("refuses an entity or column it does not itself name", async () => {
    const { default: item } = await import("./queries/item.ts");
    const settled = await Promise.all(
      [
        { entity: "core.party", entityId: "p-1", column: "secret" },
        // THE DEAD ENTITY IS ONE OF THEM (#916, D2). `locker.item_history` was
        // a sealed sidecar until the table was dropped; the gateway refuses it
        // now, so the handler must not carry a caller's word for it into a
        // reveal. Naming it here is what fails if `SIDECAR_COLUMNS` ever grows
        // the row back.
        {
          entity: "locker.item_history",
          entityId: "rev-1",
          column: "password",
        },
        {
          entity: "locker.item_field",
          entityId: "field-1",
          column: "password",
        },
        { entity: "locker.item_field", entityId: "", column: "value_sealed" },
      ].map(async (bad) => {
        const ctx = sidecarCtx({});
        const result = await item({
          input: { item_id: "item-1", ...auth, sidecar: bad },
          ctx,
        });
        return { ctx, result };
      })
    );
    for (const { ctx, result } of settled) {
      // It falls back to the item's OWN reveal rather than passing an
      // unrecognised row to the vault on the caller's word.
      expect(ctx.reveals[0].entity).toBe("locker.item");
      expect(result.sidecar).toBeUndefined();
    }
  });

  it("a denial on the sidecar reveal is the app's denied state, not a blank pane", async () => {
    const { default: item } = await import("./queries/item.ts");
    const ctx = sidecarCtx({});
    ctx.vault.reveal = async () => {
      throw Object.assign(new Error("deny (receipt r-9): no reveal consent"), {
        code: "consent",
      });
    };
    const result = await item({
      input: {
        item_id: "item-1",
        ...auth,
        sidecar: {
          entity: "locker.item_field",
          entityId: "field-1",
          column: "value_sealed",
        },
      },
      ctx,
    });
    expect(result.item).toBeNull();
    expect(result.vaultDenied.message).toContain("no reveal consent");
  });
});

describe("access: the history of every auth, reveal and fill (#872)", () => {
  const receipts = [
    {
      receipt_id: "r-1",
      action: "reveal",
      object_type: "locker.item",
      object_id: "item-1",
      decision: "allow",
      occurred_at: "2026-08-03T00:00:00.000Z",
      detail_json: JSON.stringify({
        columns: ["password"],
        context: { kind: "fill", origin: "https://example.test" },
      }),
    },
    {
      receipt_id: "r-2",
      action: "reveal",
      object_type: "locker.item",
      object_id: "item-1",
      decision: "allow",
      occurred_at: "2026-08-02T00:00:00.000Z",
      detail_json: JSON.stringify({ columns: ["password"] }),
    },
    {
      receipt_id: "r-3",
      action: "authenticate locker.unlock",
      object_type: "locker.auth",
      object_id: null,
      decision: "deny",
      occurred_at: "2026-08-01T00:00:00.000Z",
      detail_json: JSON.stringify({ failing: "wrong passphrase" }),
    },
  ];

  it("names the three kinds, newest first, and carries a fill's page origin", async () => {
    const { default: access } = await import("./queries/access.ts");
    const ctx = ctxOf({ "access.receipt": receipts });
    const result = await access({ input: {}, ctx });
    expect(result.entries.map((entry) => entry.kind)).toStrictEqual([
      "fill",
      "reveal",
      "auth",
    ]);
    expect(result.entries[0].origin).toBe("https://example.test");
    // A UI reveal carries no origin — a fill is the only kind that has one.
    expect(result.entries[1].origin).toBeUndefined();
  });

  it("lists a refusal like an allowance — the boundary receipts both", async () => {
    const { default: access } = await import("./queries/access.ts");
    const ctx = ctxOf({ "access.receipt": receipts });
    const result = await access({ input: {}, ctx });
    expect(result.entries[2]).toMatchObject({
      kind: "auth",
      decision: "deny",
      reason: "wrong passphrase",
    });
  });

  it("narrows the read to Locker's own object types, and to one item when asked", async () => {
    const { default: access } = await import("./queries/access.ts");
    const ctx = ctxOf({ "access.receipt": receipts });
    await access({ input: { item_id: "item-1" }, ctx });
    expect(
      ctx.calls.find((call) => call.entity === "access.receipt")?.where
    ).toStrictEqual([
      {
        column: "object_type",
        op: "in",
        value: ["locker.item", "locker.auth"],
      },
      { column: "object_id", op: "eq", value: "item-1" },
    ]);
  });

  it("is behind the lock: a locked session gets no history", async () => {
    const { default: access } = await import("./queries/access.ts");
    const ctx = ctxOf({ "access.receipt": receipts }, { authenticated: false });
    const result = await access({ input: {}, ctx });
    expect(result).toMatchObject({ entries: [], authRequired: true });
    expect(ctx.calls).toStrictEqual([]);
  });
});
