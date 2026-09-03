import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import { receiptHash, writeReceipt } from "./evidence.js";

interface Row {
  receipt_id: string;
  seq: number;
  hash: string;
  grant_id: string | null;
  invocation_id: string | null;
  action: string;
  object_type: string;
  object_id: string | null;
  purpose_concept_id: string | null;
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
      grantId: row.grant_id,
      invocationId: row.invocation_id,
      action: row.action,
      objectType: row.object_type,
      objectId: row.object_id,
      purpose: row.purpose_concept_id,
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
          grantId: null,
          invocationId: null,
          action: `act test.${n}`,
          objectType: "core.vault",
          objectId: `object-${n}`,
          purpose: null,
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
        grantId: null,
        invocationId: null,
        action: "act access.revoke_grant",
        objectType: "access.grant",
        objectId: "grant-1",
        purpose: null,
        decision: "allow",
        detail: { revokedBy: "party-owner", reason: "asked" },
      });
      expect(verify(chain(db))).toBe(true);
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
        grantId: "grant-1",
        invocationId: null,
        action: "read core.event",
        objectType: "core.event",
        objectId: "event-1",
        purpose: null,
        decision: "allow",
      });
      db.audit.exec("PRAGMA writable_schema = ON");
      db.audit.exec("DROP TRIGGER access_receipt_append_only_u");
      db.audit.exec("PRAGMA writable_schema = OFF");
      db.audit.prepare("UPDATE access_receipt SET grant_id = 'grant-2'").run();
      expect(verify(chain(db))).toBe(false);
    } finally {
      db.close();
    }
  });
});
