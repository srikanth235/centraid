// The receipt chain has to cover the WHOLE receipt, or it proves the wrong
// thing (#916, review 5.3). It used to hash seven columns — action, object,
// decision, time — and leave `detail_json`, `grant_id`, `invocation_id` and
// the purpose outside, so the WHY of a decision could be rewritten and the
// chain that exists to detect exactly that would still verify.

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import {
  receiptHash,
  writeAuthorityReceipt,
  writeReceipt,
} from "./evidence.js";

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

/*
 * OPEN QUESTION 8 (#996, R17): `share_authority_use` goes "for an index over
 * receipts unless `evidence.ts` names a property it cannot serve".
 *
 * `writeAuthorityReceipt` stamps the use row from the same input, in the same
 * call, as a receipt carrying the same `authority_id`, and
 * `idx_receipt_authority(authority_id, occurred_at)` already exists — so for a
 * LIVE receipt the index is exactly as good, and this file names no property
 * the two disagree on. The property is in the receipt's LIFETIME, not in its
 * content: the audit band is retained 365 days and its `journal-archive` duty
 * DELETES the rows it seals out of `access_receipt`, while the use row is one
 * row per authority with no history and is never archived. So "granted a year
 * ago, nothing has used it since" — the one fact that makes a stale answer
 * visible on Settings → Access — is exactly the case where the index answers
 * "never used" and the use row answers correctly. The table stays. This test
 * pins the divergence rather than driving it: the answer here is KEEP, so
 * there is no behaviour to make red.
 */
describe(writeAuthorityReceipt, () => {
  test("the use row outlives the receipt an index would have to read", () => {
    const db = openVaultDb();
    try {
      writeAuthorityReceipt(db, {
        authorityId: "authority-1",
        invocationId: null,
        action: "read core.event",
        objectType: "core.event",
        objectId: "event-1",
        decision: "allow",
      });
      const lastUsed = (): string | undefined =>
        (
          db.vault
            .prepare(
              "SELECT last_used_at FROM share_authority_use WHERE authority_id = ?"
            )
            .get("authority-1") as { last_used_at: string } | undefined
        )?.last_used_at;
      const overReceipts = (): string | null =>
        (
          db.audit
            .prepare(
              "SELECT MAX(occurred_at) AS at FROM access_receipt WHERE authority_id = ?"
            )
            .get("authority-1") as { at: string | null }
        ).at;
      // While the receipt is live the two agree, which is why the question was
      // asked at all.
      expect(lastUsed()).toBeDefined();
      expect(overReceipts()).not.toBeNull();

      // The archive pass, through its own door — the band refuses DELETE any
      // other way.
      db.audit.exec("INSERT INTO audit_archive_pass (active) VALUES (1)");
      db.audit
        .prepare("DELETE FROM access_receipt WHERE authority_id = ?")
        .run("authority-1");
      db.audit.exec("DELETE FROM audit_archive_pass WHERE active = 1");

      // The index now says "never used" about an answer that WAS used.
      expect(overReceipts()).toBeNull();
      expect(lastUsed()).toBeDefined();
    } finally {
      db.close();
    }
  });
});
