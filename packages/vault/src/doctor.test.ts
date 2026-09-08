// #892 — the doctor has to FAIL on a broken vault, or it is a slower no-op.
//
// Every assertion here corrupts a real vault in a way an ordinary command
// could not and then requires the sweep to name it. A test that only proved
// "a healthy vault is healthy" would pass just as happily against a doctor
// that returned `{ ok: true }` unconditionally, which is the exact failure
// mode a structural checker is prone to.
//
// Since the entity supertype landed (#916) the polymorphic pointers the old
// sweep walked by hand are REAL composite foreign keys, so the engine refuses
// a dangling pointer at write time and `PRAGMA foreign_key_check` is what
// finds one that got in behind its back.

import { describe, expect, it } from "vitest";

import { openVaultDb } from "./db.js";
import {
  assertVaultHealthy,
  formatDoctorReport,
  vaultDoctor,
} from "./doctor.js";
import { uuidv7 } from "./ids.js";

function freshVault() {
  return openVaultDb();
}

describe(vaultDoctor, () => {
  it("passes a freshly migrated vault and says what it looked at", () => {
    const db = freshVault();
    try {
      const report = vaultDoctor(db);
      expect(report.ok).toBe(true);
      expect(report.findings).toStrictEqual([]);
      // A vacuous pass is the risk: prove the sweep had something to sweep.
      expect(report.checked.foreignKeys).toBeGreaterThan(0);
      expect(formatDoctorReport(report)).toContain("foreign key");
    } finally {
      db.close();
    }
  });

  it("refuses the dangling polymorphic pointer at write time (#916)", () => {
    const db = freshVault();
    try {
      // The old #441 orphan vector: a derivation stamped for a target row that
      // does not exist. `(target_type, target_id)` is now a composite FK into
      // `core_entity`, so the engine — not a hand-written registry walk — is
      // the check, and it refuses.
      expect(() =>
        db.vault
          .prepare(
            `INSERT INTO enrich_derivation
               (derivation_id, target_type, target_id, variant, capability, model, produced_at)
             VALUES (?, 'core.document', ?, 'caption', 'vision', 'fake@1', '2026-01-01T00:00:00.000Z')`
          )
          .run(uuidv7(), uuidv7())
      ).toThrow(/FOREIGN KEY/iu);
      expect(vaultDoctor(db).ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("catches a pointer written behind the engine's back", () => {
    const db = freshVault();
    try {
      const missing = uuidv7();
      // Exactly how a corrupt file arrives: bytes restored from elsewhere, or
      // a writer that turned the enforcement off. The doctor is the last look.
      db.vault.exec("PRAGMA foreign_keys = OFF");
      db.vault
        .prepare(
          `INSERT INTO enrich_derivation
             (derivation_id, target_type, target_id, variant, capability, model, produced_at)
           VALUES (?, 'core.document', ?, 'caption', 'vision', 'fake@1', '2026-01-01T00:00:00.000Z')`
        )
        .run(uuidv7(), missing);
      db.vault.exec("PRAGMA foreign_keys = ON");

      const report = vaultDoctor(db);
      expect(report.ok).toBe(false);
      const finding = report.findings.find((f) => f.class === "foreign-keys");
      expect(finding).toBeDefined();
      expect(finding?.sample).toContain("enrich_derivation");
    } finally {
      db.close();
    }
  });

  it("formats a failing report as a readable block and throws it", () => {
    const db = freshVault();
    try {
      db.vault.exec("PRAGMA foreign_keys = OFF");
      db.vault
        .prepare(
          `INSERT INTO enrich_derivation
             (derivation_id, target_type, target_id, variant, capability, model, produced_at)
           VALUES (?, 'core.document', ?, 'caption', 'vision', 'fake@1', '2026-01-01T00:00:00.000Z')`
        )
        .run(uuidv7(), uuidv7());
      db.vault.exec("PRAGMA foreign_keys = ON");
      expect(() => assertVaultHealthy(db)).toThrow(/vault doctor/u);
      expect(formatDoctorReport(vaultDoctor(db))).toMatch(/\[foreign-keys\]/u);
    } finally {
      db.close();
    }
  });
});
