/*! Browser-JS fixtures intentionally lack TypeScript declarations. (#408) */
// oxlint-disable-next-line typescript/ban-ts-comment -- (#408) these browser-JS fixture imports have no TypeScript declarations
// @ts-nocheck -- the imported query handlers use the ambient runtime HandlerCtx
/*
 * Handler coverage for Locker's #872 reads: the window total and the alias
 * read-back on `items`, the sidecars and the degradation rule on `item`, and
 * the access history on `access`.
 *
 * The mock ctx deliberately does NOT apply `where` — every assertion about
 * narrowing is made against the RECORDED read requests, so a handler that
 * silently stopped filtering fails here rather than passing because the mock
 * was obliging.
 */
import { describe, expect, it } from "vitest";

interface ReadCall {
  entity: string;
  where?: Array<{ column: string; op: string; value?: unknown }>;
  orderBy?: { column: string; dir?: string };
  limit?: number;
}

function ctxOf(
  rowsByEntity: Record<string, unknown[]>,
  options: {
    calls?: ReadCall[];
    invoked?: Record<string, unknown>[];
    reveals?: Record<string, unknown>[];
    revealValues?: Record<string, string | null>;
    outputs?: Record<string, unknown>;
    authenticated?: boolean;
  } = {}
) {
  const calls = options.calls ?? [];
  const invoked = options.invoked ?? [];
  // Reveals are RECORDED, not just answered: #873's whole rule is that one
  // permit buys exactly one reveal, which is a claim about which call was made
  // and not only about what came back.
  const reveals = options.reveals ?? [];
  return {
    calls,
    invoked,
    reveals,
    vault: {
      read: async (request: ReadCall) => {
        calls.push(request);
        return { rows: rowsByEntity[request.entity] ?? [] };
      },
      reveal: async (request: Record<string, unknown>) => {
        reveals.push(request);
        return { values: options.revealValues ?? {} };
      },
      authenticate: async () => ({
        authenticated: options.authenticated !== false,
        configured: true,
      }),
      invoke: async (request: { command: string }) => {
        invoked.push(request);
        return {
          status: "executed",
          output: options.outputs?.[request.command] ?? {},
        };
      },
    },
  };
}

const LIVE_ITEM = {
  item_id: "item-1",
  type: "login",
  title: "Email",
  username: "alex@example.test",
  url: "https://example.test",
  updated_at: "2026-08-01T00:00:00.000Z",
  password_set_at: "2026-01-01T00:00:00.000Z",
};

/*
 * A revision's snapshot carries the item's SEALED cells exactly as the row held
 * them — ciphertext under the item's own additional data, not the `«sealed»`
 * placeholder a read shows. These stand in for it, so an assertion can say the
 * payload never carries one.
 */
const OLD_CIPHERTEXT = "ct:v1:GdE9-old-password-ciphertext";
const OLDER_CIPHERTEXT = "ct:v1:Qq70-older-password-ciphertext";

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
