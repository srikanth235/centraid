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
// The item query hands out no plaintext at all (#996, rulings R13 and W6-D2)
// ---------------------------------------------------------------------------

/*
 * WHAT THESE USED TO PROVE, AND WHAT THEY PROVE NOW. This block held four
 * tests about WHICH reveal the `item` handler made: the gateway deleted the
 * item token before plaintext left it, so an item's own sealed columns and a
 * sealed sidecar row could not both be bought with one confirmation, and
 * `sidecar` was a MODE to keep them apart.
 *
 * There is no token to burn now. The gateway never unseals a Locker row for a
 * client (W6-D2), so the question "which reveal did the handler make" has one
 * answer — none — and that is the property worth pinning, because it is the
 * one a regression would quietly undo. The reveal itself, sidecars included,
 * is proved on the door: `packages/client/src/locker/locker-kit-door.test.ts`.
 */
describe("item: the handler unseals nothing, for any caller (#996, W6-D2)", () => {
  const ctxWithSidecar = () =>
    ctxOf({
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
    });

  it("returns the item's secret columns as the vault stores them", async () => {
    const { default: item } = await import("./queries/item.ts");
    const ctx = ctxWithSidecar();
    const result = await item({ input: { item_id: "item-1" }, ctx });
    // The browsable half is here — that is what lets the pane paint while the
    // Locker is locked, which the permit could never allow.
    expect(result.item).toMatchObject({
      item_id: "item-1",
      title: LIVE_ITEM.title,
    });
    // And the secret half is not plaintext.
    expect(result.item.password).not.toBe("k7Q-vn2-Rme");
    expect(ctx.calls.some((call) => call.kind === "reveal")).toBe(false);
  });

  it("carries the sidecar row as metadata, never as a value", async () => {
    const { default: item } = await import("./queries/item.ts");
    const ctx = ctxWithSidecar();
    const result = await item({ input: { item_id: "item-1" }, ctx });
    const field = (result.item.fields ?? [])[0];
    // The label and the section are how the pane knows there is something to
    // ask for; the value is what the door returns, one receipt at a time.
    expect(field).toMatchObject({ label: "Recovery code", kind: "sealed" });
    expect(JSON.stringify(result)).not.toContain("r3c0very-c0de");
    expect(ctx.calls.some((call) => call.kind === "reveal")).toBe(false);
  });

  it("ignores a caller that asks for a reveal the old way", async () => {
    // A stale client sending `auth_session` / `item_token` / `sidecar` gets
    // metadata, not plaintext and not an error: the inputs name a door that no
    // longer exists, and honouring them would be the gateway unsealing again.
    const { default: item } = await import("./queries/item.ts");
    const ctx = ctxWithSidecar();
    const result = await item({
      input: {
        item_id: "item-1",
        auth_session: "sess",
        item_token: "tok",
        sidecar: {
          entity: "locker.item_field",
          entityId: "field-1",
          column: "value_sealed",
        },
      },
      ctx,
    });
    expect(result.item).toMatchObject({ item_id: "item-1" });
    expect(result.sidecar).toBeUndefined();
    expect(ctx.calls.some((call) => call.kind === "reveal")).toBe(false);
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
    // The narrowing is the statement's own text and binds since #996 wave 4:
    // Locker's two object types, then the one item asked for.
    const statement = ctx.calls.find(
      (call) => call.entity === "access.receipt"
    )?.statement;
    expect(statement?.where).toBe("object_type IN (?, ?) AND object_id = ?");
    expect(statement?.bind).toStrictEqual([
      "locker.item",
      "locker.auth",
      "item-1",
    ]);
  });

  it("is NOT behind the lock, on purpose (#996, W6-D2)", async () => {
    // It used to be, and the inversion is the point. The history carries no
    // secret VALUE — it is the record of who looked — and with the gateway no
    // longer decrypting, that record is the only evidence a reveal happened.
    // Hiding the audit trail behind the boundary it audits would mean a member
    // could not answer "what was read on this device" without first unlocking
    // the thing they are worried about.
    const { default: access } = await import("./queries/access.ts");
    const ctx = ctxOf({ "access.receipt": receipts });
    const result = await access({ input: {}, ctx });
    expect(result.entries).toHaveLength(receipts.length);
    expect(result.authRequired).toBeUndefined();
    // And it asks nothing of an authentication plane that is gone.
    expect(ctx.calls.some((call) => call.kind === "authenticate")).toBe(false);
  });
});
