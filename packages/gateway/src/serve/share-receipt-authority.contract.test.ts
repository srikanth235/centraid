/*
 * The durable cross-vault ACCESS AUDIT, as a law (issues #726 P2 / #750
 * abstraction 5).
 *
 * `share_access_receipts` is what an owner is shown when they ask "what left
 * this vault, to whom?". Its worth is entirely in the two directions being
 * true at once: a receipt for every edge whose rows actually landed, and NO
 * receipt for an edge that was refused, parked, revoked, or handed to a peer
 * whose projection this gateway cannot observe. A receipt that appears for an
 * edge nobody accepted is a false accusation; one missing for an edge that
 * landed is exactly the silence the audit exists to prevent.
 *
 * Owned here rather than at a route because `share-edge-store.ts` is the ONE
 * door every status change goes through — the routes are four callers of it,
 * and pinning the invariant at the door is what stops a fifth from inventing
 * a receipt policy of its own. `edges-routes.test.ts` owns the HTTP surface's
 * replay behaviour; nothing there (or anywhere) asserts the negative cases or
 * that a malformed scope refuses ATOMICALLY.
 */

import { afterEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { EnrollmentStore } from "./enrollment-store.js";
import { GatewayDatabase } from "./gateway-db.js";
import type { EdgeFacts, EdgeSignal } from "./share-coordinator.js";
import { readEdgeRow } from "./share-edge-row.js";
import type { EdgeRow } from "./share-edge-row.js";
import { applyEdgeSignal, edgeFactsOf } from "./share-edge-store.js";
import { ShareScopeError } from "./share-scope.js";

const opened: GatewayDatabase[] = [];

interface Receipt {
  edge_id: string | null;
  owner_id: string | null;
  action: string;
  item_type: string;
  origin_vault_id: string | null;
  origin_item_ids_json: string | null;
  audience_vault_id: string;
  audience_item_ids_json: string;
}

interface Origin {
  db: GatewayDatabase;
  edge: (edgeId: string, scopeJson: string) => EdgeRow;
}

async function origin(name: string): Promise<Origin> {
  const db = GatewayDatabase.open(await tempDir());
  opened.push(db);
  const enrollment = EnrollmentStore.open(db).enroll({
    endpointId: `device-${name}`,
    vaultIds: [`vlt-${name}`],
    label: `${name} laptop`,
    ownerLabel: name,
  });
  return {
    db,
    edge: (edgeId, scopeJson) => {
      const now = "2026-08-14T00:00:00.000Z";
      db.run(
        `INSERT INTO share_edges
           (edge_id, created_by_device, owner_id, kind, mode, item_type,
            scope_json, origin_vault_id, audience_vault_id, verbs,
            target_state, source_state, status, created_at, updated_at)
         VALUES (?, ?, ?, 'add', 'snapshot', 'media.asset', ?, ?, ?, 'read',
                 'queued', 'not-needed', 'in-flight', ?, ?)`,
        edgeId,
        `device-${name}`,
        enrollment.ownerId,
        scopeJson,
        `vlt-${name}`,
        "vlt-family",
        now,
        now
      );
      return readEdgeRow(db, edgeId)!;
    },
  };
}

const LOCAL = { delivery: "local", crossOwner: false } as const;

function factsFor(row: EdgeRow): EdgeFacts {
  return edgeFactsOf(row, LOCAL);
}

function receipts(db: GatewayDatabase): Receipt[] {
  return (
    db.db
      .prepare(
        `SELECT edge_id, owner_id, action, item_type, origin_vault_id,
                origin_item_ids_json, audience_vault_id, audience_item_ids_json
           FROM share_access_receipts ORDER BY created_at, receipt_id`
      )
      .all() as unknown as Receipt[]
  ).map((row) => ({ ...row }));
}

function receiptIds(db: GatewayDatabase): string[] {
  return (
    db.db
      .prepare("SELECT receipt_id FROM share_access_receipts")
      .all() as Array<{ receipt_id: string }>
  ).map((row) => row.receipt_id);
}

describe("[law:share-receipt-authority] the access audit names exactly what landed", () => {
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close();
  });

  test("[law:share-receipt-authority] a landed projection leaves one receipt naming the authorised scope and the ids it created", async () => {
    const gateway = await origin("priya");
    const row = gateway.edge(
      "edge-landed",
      JSON.stringify(["asset-a", "asset-b"])
    );

    const after = applyEdgeSignal(gateway.db, row, factsFor(row), {
      type: "target-projected",
      targetItemIds: ["audience-a", "audience-b"],
    });

    expect(after.status).toBe("completed");
    expect(receipts(gateway.db)).toStrictEqual([
      {
        edge_id: "edge-landed",
        owner_id: row.owner_id,
        action: "share",
        item_type: "media.asset",
        origin_vault_id: "vlt-priya",
        // The audit records the scope the OWNER authorised, not the audience's
        // account of what it took.
        origin_item_ids_json: JSON.stringify(["asset-a", "asset-b"]),
        audience_vault_id: "vlt-family",
        audience_item_ids_json: JSON.stringify(["audience-a", "audience-b"]),
      },
    ]);
  });

  test("[law:share-receipt-authority] a replayed projection neither duplicates the receipt nor rewrites it", async () => {
    const gateway = await origin("replay");
    const row = gateway.edge("edge-replay", JSON.stringify(["asset-a"]));
    const landed = applyEdgeSignal(gateway.db, row, factsFor(row), {
      type: "target-projected",
      targetItemIds: ["audience-a"],
    });
    const first = receiptIds(gateway.db);

    // A crash-resumed reconcile pass replays the signal — with a DIFFERENT
    // audience list, which the audit must not adopt after the fact.
    const again = applyEdgeSignal(gateway.db, landed, factsFor(landed), {
      type: "target-projected",
      targetItemIds: ["audience-a", "audience-forged"],
    });

    expect(again.updated_at).toBe(landed.updated_at);
    expect(receiptIds(gateway.db)).toStrictEqual(first);
    expect(receipts(gateway.db)[0]!.audience_item_ids_json).toBe(
      JSON.stringify(["audience-a"])
    );
  });

  test.each([
    ["a refused edge", { type: "give-denied", reason: "declined" }, "denied"],
    [
      "an unreachable peer",
      { type: "give-parked", reason: "offline" },
      "parked",
    ],
    [
      "a withdrawn edge",
      { type: "revoked", reason: "owner withdrew" },
      "revoked",
    ],
    // "Given" to a peer is this gateway's optimism, not an observation: it
    // learns no audience ids, so it may claim no audit of what landed.
    ["a peer hand-off", { type: "give-served" }, "completed"],
  ] satisfies Array<[string, EdgeSignal, string]>)(
    "[law:share-receipt-authority] %s leaves no access record",
    async (label, signal, expectedStatus) => {
      const gateway = await origin(`no-receipt-${expectedStatus}`);
      const row = gateway.edge(`edge-${expectedStatus}`, '["asset-a"]');

      const after = applyEdgeSignal(gateway.db, row, factsFor(row), signal);

      expect(after.status, label).toBe(expectedStatus);
      expect(receipts(gateway.db)).toStrictEqual([]);
    }
  );

  test("[law:share-receipt-authority] a malformed scope refuses the whole transition — no receipt, no moved state", async () => {
    const gateway = await origin("malformed");
    // A hand edit, a half-written generation: the column drifted to something
    // no scope parser accepts. Recording an EMPTY origin list here would be a
    // durable audit that says a share carried nothing.
    const row = gateway.edge("edge-malformed", "{not json");

    expect(() =>
      applyEdgeSignal(gateway.db, row, factsFor(row), {
        type: "target-projected",
        targetItemIds: ["audience-a"],
      })
    ).toThrow(ShareScopeError);

    expect(receipts(gateway.db)).toStrictEqual([]);
    // The status move and the receipt are one transaction, so the edge is
    // still exactly where it was — a later fix can still land it honestly.
    const unchanged = readEdgeRow(gateway.db, "edge-malformed")!;
    expect(unchanged.status).toBe("in-flight");
    expect(unchanged.target_state).toBe("queued");
    expect(unchanged.target_item_ids_json).toBeNull();
  });
});
