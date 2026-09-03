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

function factsFor(row: EdgeRow): EdgeFacts {
  return edgeFactsOf(row);
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
    [
      "an edge this gateway could not act on",
      { type: "give-failed", reason: "the audience vault is not open here" },
      "parked",
    ],
    [
      "a withdrawn edge",
      { type: "revoked", reason: "owner withdrew" },
      "revoked",
    ],
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
    const row = gateway.edge("edge-malformed", "{not json");

    expect(() =>
      applyEdgeSignal(gateway.db, row, factsFor(row), {
        type: "target-projected",
        targetItemIds: ["audience-a"],
      })
    ).toThrow(ShareScopeError);

    expect(receipts(gateway.db)).toStrictEqual([]);
    const unchanged = readEdgeRow(gateway.db, "edge-malformed")!;
    expect(unchanged.status).toBe("in-flight");
    expect(unchanged.target_state).toBe("queued");
    expect(unchanged.target_item_ids_json).toBeNull();
  });
});
