import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import {
  listEnrichConsent,
  readEnrichConsent,
  recordEnrichConsent,
} from "./egress-consent.js";

const T0 = "2026-08-16T00:00:00.000Z";
const T1 = "2026-08-17T00:00:00.000Z";

describe("enrich egress consent", () => {
  test("an answer is recorded with its receipt and read back by key", () => {
    const db = openVaultDb();
    recordEnrichConsent(db.vault, {
      capability: "ocr",
      egress: "provider",
      decision: "granted",
      receiptId: "receipt-1",
      now: T0,
    });
    expect(
      readEnrichConsent(db.vault, { capability: "ocr", egress: "provider" })
    ).toStrictEqual({
      capability: "ocr",
      egress: "provider",
      scopeRef: "",
      decision: "granted",
      decidedAt: T0,
      receiptId: "receipt-1",
    });
    db.close();
  });

  test("a decline is a record, distinguishable from never having asked", () => {
    const db = openVaultDb();
    recordEnrichConsent(db.vault, {
      capability: "faces",
      egress: "provider",
      decision: "declined",
      now: T0,
    });
    expect(
      readEnrichConsent(db.vault, { capability: "faces", egress: "provider" })
        ?.decision
    ).toBe("declined");
    expect(
      readEnrichConsent(db.vault, { capability: "faces", egress: "gateway" })
    ).toBeNull();
    db.close();
  });

  test("changing an answer replaces it — one decision per key", () => {
    const db = openVaultDb();
    recordEnrichConsent(db.vault, {
      capability: "ocr",
      egress: "provider",
      decision: "granted",
      now: T0,
    });
    recordEnrichConsent(db.vault, {
      capability: "ocr",
      egress: "provider",
      decision: "declined",
      now: T1,
    });
    expect(listEnrichConsent(db.vault)).toStrictEqual([
      {
        capability: "ocr",
        egress: "provider",
        scopeRef: "",
        decision: "declined",
        decidedAt: T1,
        receiptId: null,
      },
    ]);
    db.close();
  });

  test("a vault-wide answer does not answer for a narrower scope", () => {
    const db = openVaultDb();
    recordEnrichConsent(db.vault, {
      capability: "ocr",
      egress: "provider",
      decision: "granted",
      now: T0,
    });
    expect(
      readEnrichConsent(db.vault, {
        capability: "ocr",
        egress: "provider",
        scopeRef: "folder-tax-2026",
      })
    ).toBeNull();
    db.close();
  });

  test("the same capability is answered per egress class", () => {
    const db = openVaultDb();
    recordEnrichConsent(db.vault, {
      capability: "ocr",
      egress: "on-device",
      decision: "granted",
      now: T0,
    });
    recordEnrichConsent(db.vault, {
      capability: "ocr",
      egress: "provider",
      decision: "declined",
      now: T0,
    });
    expect(listEnrichConsent(db.vault)).toHaveLength(2);
    db.close();
  });

  test("an egress class outside the vocabulary can never be stored", () => {
    const db = openVaultDb();
    expect(() =>
      db.vault
        .prepare(
          `INSERT INTO share_authority
             (authority_id, principal_kind, principal_id, subject_type,
              subject_id, verb, duration, decision, granted_at)
           VALUES ('c1', 'harness', 'somewhere-else', 'enrich.scope', '',
                   'ocr', 'standing', 'granted', ?)`
        )
        .run(T0)
    ).toThrow(/CHECK constraint failed/u);
    db.close();
  });
});
