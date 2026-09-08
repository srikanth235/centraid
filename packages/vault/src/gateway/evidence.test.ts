// The receipt chain has to cover the WHOLE receipt, or it proves the wrong
// thing (#916, review 5.3). It used to hash seven columns — action, object,
// decision, time — and leave `detail_json`, `grant_id`, `invocation_id` and
// the purpose outside, so the WHY of a decision could be rewritten and the
// chain that exists to detect exactly that would still verify.

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import { receiptHash, writeReceipt } from "./evidence.js";

interface Row {
  receipt_id: string;
  seq: number;
  hash: string;
  authority_id: string | null;
  invocation_id: string | null;
  action: string;
  object_type: string;
  object_id: string | null;
  decision: string;
  occurred_at: string;
  detail_json: string | null;
}

function chain(db: ReturnType<typeof openVaultDb>): Row[] {
  return db.audit
    .prepare("SELECT * FROM access_receipt ORDER BY seq")
    .all() as unknown as Row[];
}

function verify(rows: Row[]): boolean {
  let prev: string | null = null;
  for (const row of rows) {
    const expected = receiptHash({
      prevHash: prev,
      receiptId: row.receipt_id,
      seq: row.seq,
      authorityId: row.authority_id,
      invocationId: row.invocation_id,
      action: row.action,
      objectType: row.object_type,
      objectId: row.object_id,
      decision: row.decision,
      occurredAt: row.occurred_at,
      detailJson: row.detail_json,
    });
    if (expected !== row.hash) return false;
    prev = row.hash;
  }
  return true;
}

describe(writeReceipt, () => {
  test("numbers the chain and hashes every column of the body", () => {
    const db = openVaultDb();
    try {
      for (const n of [1, 2, 3])
        writeReceipt(db.audit, {
          authorityId: null,
          invocationId: null,
          action: `act test.${n}`,
          objectType: "core.vault",
          objectId: `object-${n}`,
          decision: "allow",
          detail: { n },
        });
      const rows = chain(db);
      expect(rows.map((r) => r.seq)).toStrictEqual([1, 2, 3]);
      expect(verify(rows)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("rewriting a receipt's DETAIL breaks the chain", () => {
    const db = openVaultDb();
    try {
      writeReceipt(db.audit, {
        authorityId: null,
        invocationId: null,
        action: "act access.revoke_grant",
        objectType: "access.grant",
        objectId: "grant-1",
        decision: "allow",
        detail: { revokedBy: "party-owner", reason: "asked" },
      });
      expect(verify(chain(db))).toBe(true);
      // The audit band refuses UPDATE, so a tamper has to go around the
      // triggers — which is what a tamper IS. The chain is the last line.
      db.audit.exec("PRAGMA writable_schema = ON");
      db.audit.exec("DROP TRIGGER access_receipt_append_only_u");
      db.audit.exec("PRAGMA writable_schema = OFF");
      db.audit
        .prepare("UPDATE access_receipt SET detail_json = ?")
        .run(JSON.stringify({ revokedBy: "somebody-else", reason: "asked" }));
      expect(verify(chain(db))).toBe(false);
    } finally {
      db.close();
    }
  });

  test("rewriting the grant a receipt names breaks the chain", () => {
    const db = openVaultDb();
    try {
      writeReceipt(db.audit, {
        authorityId: "grant-1",
        invocationId: null,
        action: "read core.event",
        objectType: "core.event",
        objectId: "event-1",
        decision: "allow",
      });
      db.audit.exec("PRAGMA writable_schema = ON");
      db.audit.exec("DROP TRIGGER access_receipt_append_only_u");
      db.audit.exec("PRAGMA writable_schema = OFF");
      db.audit
        .prepare("UPDATE access_receipt SET authority_id = 'authority-2'")
        .run();
      expect(verify(chain(db))).toBe(false);
    } finally {
      db.close();
    }
  });
});
