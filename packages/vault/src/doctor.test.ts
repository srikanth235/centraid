// #892 — the doctor has to FAIL on a broken vault, or it is a slower no-op.
//
// Every assertion here corrupts a real vault in a way the engine cannot catch
// on its own and then requires the sweep to name it. A test that only proved
// "a healthy vault is healthy" would pass just as happily against a doctor that
// returned `{ ok: true }` unconditionally, which is the exact failure mode a
// structural checker is prone to.

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
      expect(report.checked.polyRefPairs).toBeGreaterThan(0);
      expect(formatDoctorReport(report)).toContain(
        "polymorphic reference pair"
      );
    } finally {
      db.close();
    }
  });

  it("catches a polymorphic pointer whose target row was hard-deleted", () => {
    const db = freshVault();
    try {
      // `enrich_derivation` is in POLY_REF_REGISTRY: it points at a canonical row
      // through a (target_type, target_id) pair SQLite knows nothing about, which
      // is why #441 had to sweep it by hand — and why a missed sweep is invisible
      // until something like this looks. #724 W2 names the consequence: a stamp
      // for a purged target claims a derivation that was never done for whatever
      // row later reuses the id.
      const missing = uuidv7();
      db.vault
        .prepare(
          `INSERT INTO enrich_derivation
             (derivation_id, target_type, target_id, variant, capability, model, produced_at)
           VALUES (?, 'core.document', ?, 'caption', 'vision', 'fake@1', '2026-01-01T00:00:00.000Z')`
        )
        .run(uuidv7(), missing);

      const report = vaultDoctor(db);
      expect(report.ok).toBe(false);
      const finding = report.findings.find((f) => f.class === "poly-refs");
      expect(finding).toBeDefined();
      expect(finding?.detail).toContain("enrich_derivation");
      expect(finding?.sample.join(",")).toContain(missing);
    } finally {
      db.close();
    }
  });

  it("does not flag a pointer whose logical type this build cannot resolve", () => {
    const db = freshVault();
    try {
      // An extension band or a newer schema can legitimately carry a type this
      // build has never heard of. Calling that an orphan would make the doctor
      // fail on exactly the forward-compatible vaults the golden-vault gate
      // exists to open.
      db.vault
        .prepare(
          `INSERT INTO enrich_derivation
             (derivation_id, target_type, target_id, variant, capability, model, produced_at)
           VALUES (?, 'some.futuretype', ?, 'caption', 'vision', 'fake@1', '2026-01-01T00:00:00.000Z')`
        )
        .run(uuidv7(), uuidv7());
      expect(vaultDoctor(db).ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("formats a failing report as a readable block and throws it", () => {
    const db = freshVault();
    try {
      db.vault
        .prepare(
          `INSERT INTO enrich_derivation
             (derivation_id, target_type, target_id, variant, capability, model, produced_at)
           VALUES (?, 'core.document', ?, 'caption', 'vision', 'fake@1', '2026-01-01T00:00:00.000Z')`
        )
        .run(uuidv7(), uuidv7());
      expect(() => assertVaultHealthy(db)).toThrow(/vault doctor/u);
      expect(formatDoctorReport(vaultDoctor(db))).toMatch(/\[poly-refs\]/u);
    } finally {
      db.close();
    }
  });
});
