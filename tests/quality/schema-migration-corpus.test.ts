/*
 * Schema-migration archaeology corpus (umbrella #842, slice B3, W1.5).
 *
 * A seeded vault/journal pair is pinned at every schema epoch (`user_version`
 * 1..N, replayed through today's `migrate.ts` ladder rather than committed as
 * multi-megabyte binary goldens — see scripts/corpora/vault-corpus.ts for why).
 * This lane migrates each member FORWARD with today's code and proves:
 *
 *   - the pair lands at HEAD (`user_version === ladder length`);
 *   - a doctor report is clean (integrity ok, zero FK violations, zero
 *     dangling receipts, seal key `not-sealed`);
 *   - the semantic census survives the migration unchanged;
 *   - a DOWNGRADE (a file stamped ahead of the ladder) is refused cleanly with
 *     `VaultSchemaAheadError` and leaves the file uncorrupted;
 *   - the corpus only GROWS (the committed manifest tracks every epoch).
 *
 * Bite proof (demonstrated-red): tamper the expected census, or drop an epoch
 * from the manifest, and the matching assertion fails — recorded in the receipt.
 */

import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  VAULT_MIGRATIONS,
  migrate,
  verifyRestoredPair,
  VaultSchemaAheadError,
} from "@centraid/vault";

import { registerContentTextFn } from "../../packages/vault/src/schema/fts.js";
import manifest from "../../scripts/corpora/schema-epoch-census.json";
import {
  EXPECTED_CENSUS,
  VAULT_LADDER_LENGTH,
  buildEpochPair,
  censusPair,
  migratePairForward,
  readVaultUserVersion,
} from "../../scripts/corpora/vault-corpus.js";

describe("schema-migration corpus", () => {
  test("growth-guard: the manifest covers every epoch the ladder defines", () => {
    // Removing a rung, or adding one without extending the corpus, fails here.
    expect(manifest.ladderLength).toBe(VAULT_LADDER_LENGTH);
    const contiguous = Array.from(
      { length: VAULT_LADDER_LENGTH },
      (_, i) => i + 1
    );
    expect(manifest.epochs).toStrictEqual(contiguous);
    expect(manifest.expectedCensus).toStrictEqual(EXPECTED_CENSUS);
  });

  test.each(manifest.epochs)(
    "epoch %i migrates forward to HEAD with a clean doctor report and a preserved census",
    async (epoch) => {
      const dir = await tempDir(`schema-epoch-${epoch}-`);
      const paths = buildEpochPair(dir, epoch);

      // The member really is pinned at its epoch, not silently at HEAD.
      expect(readVaultUserVersion(paths.vaultFile)).toBe(epoch);
      const before = censusPair(dir);
      expect(before).toStrictEqual(EXPECTED_CENSUS);

      const stamped = migratePairForward(paths);
      expect(stamped.vaultUserVersion).toBe(VAULT_LADDER_LENGTH);

      const report = verifyRestoredPair(dir);
      expect(report.vault.integrity).toBe("ok");
      expect(report.journal.integrity).toBe("ok");
      expect(report.vault.foreignKeyViolations).toBe(0);
      expect(report.journal.foreignKeyViolations).toBe(0);
      expect(report.danglingReceipts).toStrictEqual([]);
      expect(report.sealKey.verdict).toBe("not-sealed");

      // Semantic invariant: forward migration preserves the seeded rows.
      expect(censusPair(dir)).toStrictEqual(EXPECTED_CENSUS);
    }
  );

  test("a vault stamped AHEAD of the ladder is refused cleanly, not corrupted", async () => {
    const dir = await tempDir("schema-ahead-");
    const paths = buildEpochPair(dir, VAULT_LADDER_LENGTH);
    const ahead = VAULT_LADDER_LENGTH + 1;
    {
      const db = new DatabaseSync(paths.vaultFile);
      db.exec(`PRAGMA user_version = ${ahead}`);
      db.close();
    }

    const db = new DatabaseSync(paths.vaultFile);
    registerContentTextFn(db);
    try {
      let caught: unknown;
      try {
        migrate(db, VAULT_MIGRATIONS);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(VaultSchemaAheadError);
      const err = caught as VaultSchemaAheadError;
      expect(err.fileVersion).toBe(ahead);
      expect(err.knownVersion).toBe(VAULT_LADDER_LENGTH);

      // Refused, not corrupted: version untouched, file still integral, rows intact.
      expect(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version
      ).toBe(ahead);
      expect(
        (
          db.prepare("PRAGMA integrity_check").get() as {
            integrity_check: string;
          }
        ).integrity_check
      ).toBe("ok");
      expect(
        (
          db.prepare("SELECT count(*) AS c FROM core_party").get() as {
            c: number;
          }
        ).c
      ).toBe(EXPECTED_CENSUS.party);
    } finally {
      db.close();
    }
  });

  test("regenerating an epoch member twice is byte-identical (determinism)", async () => {
    const epoch = VAULT_LADDER_LENGTH;
    const dirA = await tempDir("schema-det-a-");
    const dirB = await tempDir("schema-det-b-");
    buildEpochPair(dirA, epoch);
    buildEpochPair(dirB, epoch);
    const { readFile } = await import("node:fs/promises");
    const compared = await Promise.all(
      ["vault.db", "journal.db"].map(async (name) => {
        const [a, b] = await Promise.all([
          readFile(path.join(dirA, name)),
          readFile(path.join(dirB, name)),
        ]);
        return a.equals(b);
      })
    );
    expect(compared).toStrictEqual([true, true]);
  });
});
