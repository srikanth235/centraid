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
      expect(report.checked.foreignKeys).toBeGreaterThan(0);
      expect(formatDoctorReport(report)).toContain("foreign key");
    } finally {
      db.close();
    }
  });

  it("refuses the dangling polymorphic pointer at write time (#916)", () => {
    const db = freshVault();
    try {
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
