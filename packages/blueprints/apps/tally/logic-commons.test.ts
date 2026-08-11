// @vitest-environment jsdom
//
// The Tally half of issue #738's migration to the shared pending-write
// overlay engine. `createLogic` no longer owns any overlay state itself —
// these tests exercise the wiring around `createPendingOverlayModel`
// (packages/blueprints/apps/_shared/pending-overlay.ts, whose own laws are
// covered by pending-overlay.test.ts): reload-rebuild from the durable
// outbox, decorating a query's own row with the pending chip fields, and
// Commons as enrichment-only (never a rebuild).

import { describe, expect, test, vi } from "vitest";

import { pendingRowId } from "../_shared/pending-overlay.ts";
import { createLogic, decorateLedgerRow } from "./logic.ts";
import friendHandler from "./queries/friend.ts";
import type { AppState, Dash, LedgerRow, ViewData } from "./types.ts";

function state(): AppState {
  return {
    view: "dashboard",
    groupId: null,
    friendId: null,
    search: "",
    searchStatus: "resting",
    narrow: false,
    viewData: null,
    detail: null,
    expense: null,
    settle: null,
    newGroup: null,
    addFriend: null,
    expenseUndo: null,
    modalMembers: [],
  };
}

function dash(): Dash {
  return {
    me: "party-bob",
    currency: "USD",
    friends: [],
    groups: [
      {
        group_id: "group-trip",
        name: "Trip",
        member_count: 2,
        owner_net_minor: 0,
      },
    ],
    trash: [],
    recurring: [],
    owe_total_minor: 0,
    owed_total_minor: 0,
  };
}

function stubCentraid(value: Partial<CentraidClient>) {
  Object.defineProperty(window, "centraid", { configurable: true, value });
}

function newLogic() {
  return createLogic({
    state: state(),
    dash: dash(),
    render: vi.fn<() => void>(),
    renderModals: vi.fn<() => void>(),
    loadView: vi.fn<() => Promise<void>>(async () => undefined),
    refreshAll: vi.fn<() => Promise<void>>(async () => undefined),
  });
}

describe("Tally pending-write overlay (issue #738)", () => {
  test("restorePendingWrites rebuilds a parked add-expense row from the durable outbox on reload", async () => {
    stubCentraid({
      pendingWrites: vi.fn<NonNullable<CentraidClient["pendingWrites"]>>(
        async () => [
          {
            intentId: "intent-lunch",
            action: "add-expense",
            state: "parked",
            reason: "waiting for Alice's device",
            input: {
              group_id: "group-trip",
              description: "Lunch",
              amount_minor: 600,
              paid_by: "party-bob",
              category: "food",
              spent_on: "2026-08-10",
            },
            mutations: [],
          },
        ]
      ),
    });
    const logic = newLogic();

    await logic.restorePendingWrites();

    const entry = logic.pendingByRowId().get(pendingRowId("intent-lunch"));
    expect(entry).toMatchObject({
      intentId: "intent-lunch",
      action: "add-expense",
      status: "parked",
      reason: "waiting for Alice's device",
    });
  });

  // Reload survival: the durable outbox alone is enough for the ledger's
  // own pending row to render — no gateway round trip, no app-owned state.
  test("a queued add-expense intent from pendingWrites() decorates the query's own composed ledger row as pending", async () => {
    const rowId = pendingRowId("intent-taxi");
    stubCentraid({
      pendingWrites: vi.fn<NonNullable<CentraidClient["pendingWrites"]>>(
        async () => [
          {
            intentId: "intent-taxi",
            action: "add-expense",
            state: "queued",
            input: {
              group_id: "group-trip",
              description: "Taxi",
              amount_minor: 1200,
              paid_by: "party-bob",
              category: "transport",
              spent_on: "2026-08-10",
            },
            mutations: [
              {
                op: "upsert",
                entity: "tally.expense",
                rowId,
                values: {
                  expense_id: rowId,
                  group_id: "group-trip",
                  description: "Taxi",
                  amount_minor: 1200,
                  paid_by: "party-bob",
                  category: "transport",
                  spent_on: "2026-08-10",
                },
              },
            ],
          },
        ]
      ),
    });
    const logic = newLogic();

    await logic.restorePendingWrites();

    // What the group/friend ledger query would already return, composed
    // from the outbox by the replica's own overlay (packages/client) — the
    // app never rebuilds this row, it only decorates it.
    const fetchedRow: LedgerRow = {
      expense_id: rowId,
      group_id: "group-trip",
      description: "Taxi",
      amount_minor: 1200,
      category: "transport",
      spent_on: "2026-08-10",
      paid_by: "party-bob",
      your_role: "lent",
      your_amount_minor: 1200,
      splits: [],
    };
    const decorated = decorateLedgerRow(
      fetchedRow,
      logic.pendingByRowId(),
      "party-bob"
    );
    expect(decorated.pending).toBe(true);
    expect(decorated.parked).toBe(false);
    expect(decorated.pendingStatus).toBe("queued");
    expect(decorated.commonsIntentId).toBe("intent-taxi");
  });

  // Issue #731 m6: a denied intent never ages out of `commonsIntents()` on
  // its own (unlike an executed write), so without a dismissal it would keep
  // re-appearing in the enrichment on every refresh forever.
  test("dismissCommonsIntent clears a denied commons-enrichment row and keeps it gone across re-enrichment", async () => {
    const deniedIntent = {
      intentId: "intent-taxi",
      grantId: "grant-trip",
      actorPartyId: "party-bob",
      command: "tally.add_expense",
      input: {
        group_id: "group-trip",
        description: "Taxi",
        amount_minor: 1200,
        paid_by: "party-bob",
        category: "transport",
        spent_on: "2026-08-10",
      },
      status: "denied" as const,
      reason: "Alice's device does not allow this split.",
      stewardLabel: "Alice's device",
      createdAt: "2026-08-10T00:00:00.000Z",
    };
    const commonsIntents = vi.fn<NonNullable<CentraidClient["commonsIntents"]>>(
      async () => [deniedIntent]
    );
    stubCentraid({ commonsIntents });
    const render = vi.fn<() => void>();
    const logic = createLogic({
      state: state(),
      dash: dash(),
      render,
      renderModals: vi.fn<() => void>(),
      loadView: vi.fn<() => Promise<void>>(async () => undefined),
      refreshAll: vi.fn<() => Promise<void>>(async () => undefined),
    });

    await logic.enrichCommons();
    // Asserting the row's CONTENT, not just its count: a commons intent names
    // the vault command (`tally.add_expense`), not the app action, so a row
    // that renders empty — or not at all — is the failure mode this test
    // exists to catch.
    const [enriched] = logic.pendingLedgerRows();
    expect(enriched).toMatchObject({
      description: "Taxi",
      amount_minor: 1200,
      commonsIntentId: "intent-taxi",
      stewardLabel: "Alice's device",
      pendingReason: "Alice's device does not allow this split.",
    });

    logic.dismissCommonsIntent("intent-taxi");
    expect(logic.pendingLedgerRows()).toStrictEqual([]);
    expect(render).toHaveBeenCalledWith();

    // The gateway still hands back the same denied intent on the next
    // enrichment (nothing about it changed server-side) — the dismissal
    // must still hold it out of the overlay.
    await logic.enrichCommons();
    expect(logic.pendingLedgerRows()).toStrictEqual([]);
  });

  test("dismissCommonsIntent is a no-op for a parked row — only a settled denial is dismissible", async () => {
    stubCentraid({
      commonsIntents: vi.fn<NonNullable<CentraidClient["commonsIntents"]>>(
        async () => [
          {
            intentId: "intent-lunch",
            grantId: "grant-trip",
            actorPartyId: "party-bob",
            command: "tally.add_expense",
            input: {
              group_id: "group-trip",
              description: "Lunch",
              amount_minor: 600,
              paid_by: "party-bob",
              category: "food",
              spent_on: "2026-08-10",
            },
            status: "parked",
            reason: "waiting for Alice's device",
            stewardLabel: "Alice's device",
            createdAt: "2026-08-10T00:00:00.000Z",
          },
        ]
      ),
    });
    const logic = newLogic();

    await logic.enrichCommons();
    logic.dismissCommonsIntent("intent-lunch");

    expect(logic.pendingLedgerRows()).toHaveLength(1);
  });

  // Issue #738 regression: the solo-vault wipe. `refreshCommonsExpenses`
  // used to rebuild `state.pendingExpenses` wholesale from
  // `commonsIntents()`, so a member with no Commons grant at all — an empty
  // answer, or offline — saw their own just-queued add vanish on every
  // refresh. `enrichCommons()` may only ADD information now, never rebuild.
  test("an empty commonsIntents() answer never clears a locally-queued pending row", async () => {
    stubCentraid({
      write: vi.fn<() => Promise<VaultOutcome>>(
        async () => ({ status: "queued" }) as VaultOutcome
      ) as CentraidClient["write"],
      commonsIntents: vi.fn<NonNullable<CentraidClient["commonsIntents"]>>(
        async () => []
      ),
    });
    const logic = newLogic();

    await logic.act("add-expense", {
      group_id: "group-trip",
      description: "Lunch",
      amount_minor: 600,
      paid_by: "party-bob",
      category: "food",
      spent_on: "2026-08-10",
    });
    expect(logic.pendingByRowId().size).toBe(1);

    await logic.enrichCommons();
    expect(logic.pendingByRowId().size).toBe(1);
  });

  // Issue #738 regression (money). `tally.expense_split` is deliberately not
  // projected, so the query composes the pending expense with NO split rows
  // and `ledgerRow()` concludes the payer lent the whole bill. The row must
  // state the member's own half, and it must agree with the hero total
  // `inflightBalance()` folds into the dashboard — two numbers for the same
  // write in the same view disagreeing is the defect this test pins down.
  test("a queued 50/50 expense states your half, not the whole bill, and agrees with the hero total", async () => {
    stubCentraid({
      write: vi.fn<() => Promise<VaultOutcome>>(
        async () => ({ status: "queued" }) as VaultOutcome
      ) as CentraidClient["write"],
    });
    const logic = newLogic();
    const splits = [
      { party_id: "party-bob", share_minor: 3000 },
      { party_id: "party-ann", share_minor: 3000 },
    ];

    await logic.act("add-expense", {
      group_id: "group-trip",
      description: "Dinner",
      amount_minor: 6000,
      paid_by: "party-bob",
      category: "food",
      spent_on: "2026-08-10",
      splits,
    });

    const byRowId = logic.pendingByRowId();
    const [rowId] = [...byRowId.keys()];
    // Exactly what `queries/dashboard.ts`'s `ledgerRow()` returns for the
    // composed pending expense: the expense row is in the overlay, its split
    // rows are not, so the query believes Bob lent the entire $60.00.
    const composed: LedgerRow = {
      expense_id: rowId!,
      group_id: "group-trip",
      description: "Dinner",
      amount_minor: 6000,
      category: "food",
      spent_on: "2026-08-10",
      paid_by: "party-bob",
      your_role: "lent",
      your_amount_minor: 6000,
      splits: [],
    };

    const decorated = decorateLedgerRow(composed, byRowId, "party-bob");
    expect(decorated.your_role).toBe("lent");
    expect(decorated.your_amount_minor).toBe(3000);
    expect(decorated.splits).toStrictEqual(splits);
    expect(decorated.amount_minor).toBe(6000); // the bill itself is unchanged
    expect(logic.inflightBalance()).toStrictEqual({ owe: 0, owed: 3000 });
    expect(decorated.your_amount_minor).toBe(logic.inflightBalance().owed);
  });

  // Issue #738 regression (the friend ledger). `queries/friend.ts` selects on
  // `splits[friend] != null && splits[me] != null` — unsatisfiable for a
  // pending expense, whose split rows are deliberately unprojected — so the
  // friend view is the one ledger that can never compose its own pending row.
  test("a queued expense with a friend appears in that friend's ledger while pending, with your borrowed half", async () => {
    const rowId = pendingRowId("intent-dinner");
    const vaultRows: Record<string, Array<Record<string, unknown>>> = {
      "core.vault": [{ owner_party_id: "party-bob", base_currency: "USD" }],
      "tally.friend": [{ party_id: "party-ann" }],
      "tally.group": [{ group_id: "group-trip", circle_id: "circle-trip" }],
      "social.circle": [{ circle_id: "circle-trip", name: "Trip" }],
      "social.circle_member": [
        { circle_id: "circle-trip", party_id: "party-bob" },
        { circle_id: "circle-trip", party_id: "party-ann" },
      ],
      // What the replica hands the query: one canonical expense with its
      // splits, plus the composed pending expense — expense row only.
      "tally.expense": [
        {
          expense_id: "expense-lunch",
          group_id: "group-trip",
          paid_by: "party-ann",
          amount_minor: 2000,
          description: "Lunch",
          category: "food",
          spent_on: "2026-08-09",
        },
        {
          expense_id: rowId,
          group_id: "group-trip",
          paid_by: "party-ann",
          amount_minor: 6000,
          description: "Dinner",
          category: "food",
          spent_on: "2026-08-10",
        },
      ],
      "tally.expense_split": [
        {
          expense_id: "expense-lunch",
          party_id: "party-bob",
          share_minor: 1000,
        },
        {
          expense_id: "expense-lunch",
          party_id: "party-ann",
          share_minor: 1000,
        },
      ],
      "core.party": [
        { party_id: "party-bob", display_name: "Bob" },
        { party_id: "party-ann", display_name: "Ann" },
      ],
    };
    const payload = (await friendHandler({
      input: { party_id: "party-ann" },
      ctx: {
        vault: {
          read: vi.fn<
            (request: { entity: string }) => Promise<{
              rows: Array<Record<string, unknown>>;
            }>
          >(async ({ entity }) => ({ rows: vaultRows[entity] ?? [] })),
        },
      },
    } as unknown as HandlerArgs)) as unknown as ViewData;
    // The premise: the query returns the canonical row and drops the pending
    // one. That is not a bug in the query — it is why the client must supply
    // the pending row itself.
    expect((payload.ledger ?? []).map((row) => row.expense_id)).toStrictEqual([
      "expense-lunch",
    ]);

    const friendState = state();
    friendState.view = "friend";
    friendState.friendId = "party-ann";
    friendState.viewData = payload;
    const logic = createLogic({
      state: friendState,
      dash: dash(),
      render: vi.fn<() => void>(),
      renderModals: vi.fn<() => void>(),
      loadView: vi.fn<() => Promise<void>>(async () => undefined),
      refreshAll: vi.fn<() => Promise<void>>(async () => undefined),
    });
    stubCentraid({
      pendingWrites: vi.fn<NonNullable<CentraidClient["pendingWrites"]>>(
        async () => [
          {
            intentId: "intent-dinner",
            action: "add-expense",
            state: "queued",
            input: {
              group_id: "group-trip",
              description: "Dinner",
              amount_minor: 6000,
              paid_by: "party-ann",
              category: "food",
              spent_on: "2026-08-10",
              splits: [
                { party_id: "party-bob", share_minor: 3000 },
                { party_id: "party-ann", share_minor: 3000 },
              ],
            },
            mutations: [],
          },
        ]
      ),
    });

    await logic.restorePendingWrites();

    expect(logic.pendingLedgerRows().map((row) => row.expense_id)).toContain(
      rowId
    );
    const shown = logic.pendingLedgerRowsForView();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      expense_id: rowId,
      description: "Dinner",
      group_id: "group-trip",
      amount_minor: 6000,
      paid_by: "party-ann",
      paid_by_name: "Ann",
      your_role: "borrowed",
      your_amount_minor: 3000,
      pending: true,
      pendingStatus: "queued",
    });
    expect(shown[0]?.splits).toStrictEqual([
      { party_id: "party-bob", share_minor: 3000 },
      { party_id: "party-ann", share_minor: 3000 },
    ]);
  });

  // The same write must not be rendered twice: once the group query composes
  // the pending expense from the outbox, the synthesized copy stands down.
  test("a pending row the fetched ledger already carries is not appended a second time", async () => {
    const rowId = pendingRowId("intent-dinner");
    const groupState = state();
    groupState.view = "group";
    groupState.groupId = "group-trip";
    groupState.viewData = {
      ledger: [
        {
          expense_id: rowId,
          group_id: "group-trip",
          description: "Dinner",
          amount_minor: 6000,
          category: "food",
          spent_on: "2026-08-10",
          paid_by: "party-bob",
          your_role: "lent",
          your_amount_minor: 6000,
          splits: [],
        },
      ],
    };
    const logic = createLogic({
      state: groupState,
      dash: dash(),
      render: vi.fn<() => void>(),
      renderModals: vi.fn<() => void>(),
      loadView: vi.fn<() => Promise<void>>(async () => undefined),
      refreshAll: vi.fn<() => Promise<void>>(async () => undefined),
    });
    stubCentraid({
      pendingWrites: vi.fn<NonNullable<CentraidClient["pendingWrites"]>>(
        async () => [
          {
            intentId: "intent-dinner",
            action: "add-expense",
            state: "queued",
            input: {
              group_id: "group-trip",
              description: "Dinner",
              amount_minor: 6000,
              paid_by: "party-bob",
              category: "food",
              spent_on: "2026-08-10",
              splits: [
                { party_id: "party-bob", share_minor: 3000 },
                { party_id: "party-ann", share_minor: 3000 },
              ],
            },
            mutations: [],
          },
        ]
      ),
    });

    await logic.restorePendingWrites();

    expect(logic.pendingLedgerRowsForView()).toStrictEqual([]);
    // …and the row the query DID compose still gets its money corrected.
    const decorated = decorateLedgerRow(
      groupState.viewData.ledger![0]!,
      logic.pendingByRowId(),
      "party-bob"
    );
    expect(decorated.your_amount_minor).toBe(3000);
  });
});

// ─── the durable attention journal (issue #738 engine H) ─────────────────────
//
// `restorePendingWrites()` reads TWO durable sources, because a settled write
// leaves the outbox: `pendingWrites()` for what is still in flight, and
// `attentionWrites()` for what came back denied/conflicted/failed. Without the
// second one a denied row lives only in this session's memory and dies on
// reload — the exact "anchored in app memory" failure the issue exists to end.

/** A stand-in for the client's durable attention journal: `write()` files a
 *  refused write into it, `dismissAttentionWrite()` forgets one. */
function attentionJournal() {
  const rows: CentraidAttentionWrite[] = [];
  const dismissAttentionWrite = vi.fn<
    NonNullable<CentraidClient["dismissAttentionWrite"]>
  >(async ({ intentId }) => {
    const at = rows.findIndex((row) => row.intentId === intentId);
    if (at < 0) return false;
    rows.splice(at, 1);
    return true;
  });
  return {
    rows,
    dismissAttentionWrite,
    reads: {
      pendingWrites: async () => [],
      attentionWrites: async () => rows.map((row) => ({ ...row })),
      dismissAttentionWrite,
    },
  };
}

describe("Tally attention rows survive a reload (issue #738)", () => {
  test("a denied add-expense persists in the ledger with its reason across a FRESH logic instance, then retries under a new id", async () => {
    const journal = attentionJournal();
    const write = vi.fn<CentraidClient["write"]>(async (opts) => {
      journal.rows.push({
        intentId: opts.intentId!,
        action: opts.action,
        status: "denied",
        reason: "Alice's device does not allow this split.",
        input: opts.input ?? {},
        mutations: (opts.optimistic ?? []) as never,
        settledAt: "2026-08-11T10:00:00.000Z",
      });
      return {
        status: "denied",
        reason: "Alice's device does not allow this split.",
      } as never;
    });
    stubCentraid({ write: write as CentraidClient["write"], ...journal.reads });

    const first = newLogic();
    await first.act("add-expense", {
      group_id: "group-trip",
      description: "Taxi",
      amount_minor: 1200,
      paid_by: "party-bob",
      category: "transport",
      spent_on: "2026-08-10",
      splits: [{ party_id: "party-bob", share_minor: 1200 }],
    });
    const deniedId = write.mock.calls[0]![0].intentId!;
    expect(first.pendingLedgerRows()).toMatchObject([
      {
        description: "Taxi",
        pendingStatus: "denied",
        pendingReason: "Alice's device does not allow this split.",
        pendingRetryable: true,
        pendingEditable: true,
        commonsIntentId: deniedId,
      },
    ]);

    // ---- reload: a brand-new logic instance with no memory whatsoever ----
    const groupState = state();
    groupState.view = "group";
    groupState.groupId = "group-trip";
    const second = createLogic({
      state: groupState,
      dash: dash(),
      render: vi.fn<() => void>(),
      renderModals: vi.fn<() => void>(),
      loadView: vi.fn<() => Promise<void>>(async () => undefined),
      refreshAll: vi.fn<() => Promise<void>>(async () => undefined),
    });
    expect(second.pendingLedgerRows()).toStrictEqual([]);
    await second.restorePendingWrites();

    // Row CONTENT, never a count: the refused expense is back, in the group
    // ledger, still saying what happened and still offering an answer.
    expect(second.pendingLedgerRowsForView()).toMatchObject([
      {
        expense_id: pendingRowId(deniedId),
        group_id: "group-trip",
        description: "Taxi",
        amount_minor: 1200,
        pendingStatus: "denied",
        pendingReason: "Alice's device does not allow this split.",
        pendingRetryable: true,
      },
    ]);

    // ---- retry: same payload, FRESH intent id, old record forgotten ----
    await second.retryPendingWrite(deniedId);
    expect(journal.dismissAttentionWrite).toHaveBeenCalledWith({
      intentId: deniedId,
    });
    const retried = write.mock.calls[1]![0];
    expect(retried.intentId).not.toBe(deniedId);
    expect(retried.input).toMatchObject({
      description: "Taxi",
      amount_minor: 1200,
    });
    // The retry was refused too, so exactly ONE row is answerable — the new
    // attempt — and the old id is not resurrected by the journal.
    expect(second.pendingLedgerRows()).toMatchObject([
      { description: "Taxi", commonsIntentId: retried.intentId },
    ]);
  });

  test("Edit reopens the expense composer prefilled from the refused payload and clears the durable record", async () => {
    const journal = attentionJournal();
    journal.rows.push({
      intentId: "intent-denied",
      action: "add-expense",
      status: "denied",
      reason: "Alice's device does not allow this split.",
      input: {
        group_id: "group-trip",
        description: "Taxi",
        amount_minor: 1200,
        original_amount_minor: 1200,
        original_currency: "USD",
        settlement_currency: "USD",
        rate_scaled: 1_000_000,
        rate_scale: 6,
        paid_by: "party-bob",
        category: "transport",
        spent_on: "2026-08-10",
        splits: [
          { party_id: "party-bob", share_minor: 900 },
          { party_id: "party-ann", share_minor: 300 },
        ],
      },
      mutations: [],
      settledAt: "2026-08-11T10:00:00.000Z",
    });
    stubCentraid({
      ...journal.reads,
      read: (async () => ({ members: [] })) as CentraidClient["read"],
    });
    const composerState = state();
    const logic = createLogic({
      state: composerState,
      dash: dash(),
      render: vi.fn<() => void>(),
      renderModals: vi.fn<() => void>(),
      loadView: vi.fn<() => Promise<void>>(async () => undefined),
      refreshAll: vi.fn<() => Promise<void>>(async () => undefined),
    });
    await logic.restorePendingWrites();

    await logic.editPendingWrite("intent-denied");

    // The refused payload is in the composer, verbatim — an "Edit" that
    // opened an empty modal would be a worse lie than no Edit at all.
    expect(composerState.expense).toMatchObject({
      mode: "new",
      groupId: "group-trip",
      desc: "Taxi",
      amount: "12.00",
      paidBy: "party-bob",
      category: "transport",
      spent_on: "2026-08-10",
      method: "exact",
      exact: { "party-bob": "9.00", "party-ann": "3.00" },
    });
    expect([...composerState.expense!.include]).toStrictEqual([
      "party-bob",
      "party-ann",
    ]);
    // Taken for correction is taken: the durable record goes, so the resend
    // (a fresh intent) cannot leave a duplicate behind on the next reload.
    expect(journal.dismissAttentionWrite).toHaveBeenCalledWith({
      intentId: "intent-denied",
    });
    expect(journal.rows).toStrictEqual([]);
    expect(logic.pendingLedgerRows()).toStrictEqual([]);
  });

  test("an edit-expense carries the row version it was composed against; a create carries none, and a conflict states both versions", async () => {
    const rowVersion = vi.fn<NonNullable<CentraidClient["rowVersion"]>>(
      async () => 4
    );
    const write = vi.fn<CentraidClient["write"]>(
      async () =>
        ({
          status: "conflict",
          reason: "Someone else changed this first.",
          conflict: {
            entity: "tally.expense",
            rowId: "expense-lunch",
            expectedVersion: 4,
            actualVersion: 6,
          },
        }) as never
    );
    stubCentraid({
      write: write as CentraidClient["write"],
      rowVersion,
      pendingWrites: async () => [],
    });
    const logic = newLogic();

    await logic.act("edit-expense", {
      expense_id: "expense-lunch",
      description: "Lunch",
      amount_minor: 2000,
      paid_by: "party-bob",
      category: "food",
      spent_on: "2026-08-09",
      splits: [{ party_id: "party-bob", share_minor: 2000 }],
    });
    expect(rowVersion).toHaveBeenCalledWith({
      entity: "tally.expense",
      rowId: "expense-lunch",
    });
    expect(write.mock.calls[0]![0].baseVersions).toStrictEqual([
      { entity: "tally.expense", rowId: "expense-lunch", version: 4 },
    ]);

    // The conflict reaches the row the ledger renders, with BOTH versions —
    // a conflict that degrades into a generic error wastes the precondition.
    const decorated = decorateLedgerRow(
      {
        expense_id: "expense-lunch",
        group_id: "group-trip",
        description: "Lunch",
        amount_minor: 2000,
        category: "food",
        spent_on: "2026-08-09",
        paid_by: "party-bob",
        your_role: "lent",
        your_amount_minor: 2000,
        splits: [],
      },
      logic.pendingByRowId(),
      "party-bob"
    );
    expect(decorated.pendingStatus).toBe("conflict");
    expect(decorated.pendingConflict).toStrictEqual({
      entity: "tally.expense",
      rowId: "expense-lunch",
      expectedVersion: 4,
      actualVersion: 6,
    });

    // A create has no existing row to be stale against.
    await logic.act("add-expense", {
      group_id: "group-trip",
      description: "Taxi",
      amount_minor: 1200,
      paid_by: "party-bob",
      category: "transport",
      spent_on: "2026-08-10",
    });
    expect(write.mock.calls[1]![0].baseVersions).toBeUndefined();
  });

  test("a discarded attention row stays discarded across a reload", async () => {
    const journal = attentionJournal();
    journal.rows.push({
      intentId: "intent-denied",
      action: "add-expense",
      status: "denied",
      reason: "Alice's device does not allow this split.",
      input: {
        group_id: "group-trip",
        description: "Taxi",
        amount_minor: 1200,
        paid_by: "party-bob",
        category: "transport",
        spent_on: "2026-08-10",
      },
      mutations: [],
      settledAt: "2026-08-11T10:00:00.000Z",
    });
    stubCentraid(journal.reads);

    const before = newLogic();
    await before.restorePendingWrites();
    expect(before.pendingLedgerRows()).toMatchObject([
      { description: "Taxi", pendingStatus: "denied" },
    ]);

    before.dismissCommonsIntent("intent-denied");
    expect(before.pendingLedgerRows()).toStrictEqual([]);
    // Discard reaches the DURABLE record — without this the next reload
    // brings the row straight back, which is not discarding.
    expect(journal.dismissAttentionWrite).toHaveBeenCalledWith({
      intentId: "intent-denied",
    });
    expect(journal.rows).toStrictEqual([]);

    const after = newLogic();
    await after.restorePendingWrites();
    expect(after.pendingLedgerRows()).toStrictEqual([]);
  });

  test("restorePendingWrites() is a safe no-op on a host with neither durable surface (the visual-harness mock)", async () => {
    stubCentraid({});
    const logic = newLogic();
    await expect(logic.restorePendingWrites()).resolves.toBeUndefined();
    expect(logic.pendingLedgerRows()).toStrictEqual([]);
  });
});
