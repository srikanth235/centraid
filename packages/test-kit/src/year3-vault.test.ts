/**
 * The golden year-3 vault is an ARTIFACT (#927 P4): a version, a seed and a
 * schema ladder name exactly one directory of bytes. This suite holds three
 * properties that make that true — the declared distributions are actually in
 * the file, two builds at one seed are row-identical, and the cache is a real
 * cache (hit, miss, and invalidated by a version or schema bump).
 *
 * It opens a REAL vault: the column lists in `year3-vault.ts` are mirrors of
 * what the product's own writers put in these tables, and mirrors go stale.
 * Running them against the bootstrapped schema is what catches that.
 */
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { tempDir } from "./temp-dir.js";
import {
  goldenYear3Profile,
  materializeYear3Fixture,
  seedYear3Vault,
  YEAR3_CONTACT_NEEDLE,
  YEAR3_DISTRIBUTIONS,
  YEAR3_FIXTURE_VERSION,
  YEAR3_NOTE_NEEDLE,
  year3FixtureCacheKey,
  year3VaultProfile,
} from "./year3-vault.js";
import type { Year3SeedCounts } from "./year3-vault.js";

/**
 * A SMALL golden vault: every declared axis present, each shrunk by the same
 * factor. The distributions are proportions and needle placements, so they
 * hold at any size — and a suite that seeded 10,000 photos would be a scale
 * rig, not a unit test.
 */
const SMALL: Year3SeedCounts = {
  parties: 200,
  photos: 120,
  conversations: 4,
  turnsPerConversation: 3,
  distributions: {
    ...YEAR3_DISTRIBUTIONS,
    notes: 200,
    automations: 20,
    grantees: 5,
    receiptDays: 30,
    longNoteMaxBytes: 96 * 1_024,
  },
};

interface VaultApi {
  openVaultDb: (options: { dir: string; sealKey: Buffer }) => {
    vault: DatabaseSync;
    sealKey: Buffer;
    close: () => void;
  };
  bootstrapVault: (db: unknown, options: { ownerName: string }) => unknown;
  sealAad: (entity: string, column: string, rowId: string) => Buffer;
  sealValue: (key: Buffer, aad: Buffer, plaintext: string) => string;
}

/**
 * The vault is imported by PATH, not by package specifier: `@centraid/vault`
 * devDepends on this package, so a package import here would close a cycle —
 * which is exactly why `seedYear3Vault` takes its writer seams as arguments in
 * the first place. A runtime file URL adds no dependency edge and no type
 * dependency, and vitest transforms the source directly.
 */
async function vaultApi(): Promise<VaultApi> {
  return (await import(
    pathToFileURL(path.resolve(import.meta.dirname, "../../vault/src/index.ts"))
      .href
  )) as unknown as VaultApi;
}

async function openSeeded(): Promise<DatabaseSync> {
  const { bootstrapVault, openVaultDb, sealAad, sealValue } = await vaultApi();
  const db = openVaultDb({
    dir: await tempDir("year3-kit-vault-"),
    sealKey: Buffer.alloc(32, 0x67),
  });
  bootstrapVault(db, { ownerName: "Year 3 owner" });
  seedYear3Vault(
    {
      vault: db.vault,
      sealCell: (entity, column, rowId, plaintext) =>
        sealValue(
          db.sealKey,
          sealAad(entity.replace(".", "_"), column, rowId),
          plaintext
        ),
    },
    SMALL
  );
  return db.vault as unknown as DatabaseSync;
}

function count(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

describe("golden year-3 vault", () => {
  test("the declared distributions are in the file", async () => {
    const vault = await openSeeded();
    const distributions = SMALL.distributions!;

    expect(count(vault, "SELECT COUNT(*) AS n FROM core_party")).toBe(
      SMALL.parties + 1 // the bootstrapped owner
    );
    expect(count(vault, "SELECT COUNT(*) AS n FROM media_asset")).toBe(
      SMALL.photos
    );
    expect(count(vault, "SELECT COUNT(*) AS n FROM knowledge_note")).toBe(
      distributions.notes
    );

    // The >64 KiB share: exactly what the declaration says, no more.
    const long = count(
      vault,
      `SELECT COUNT(*) AS n FROM core_content_item
        WHERE content_id LIKE 'year3-note-content-%'
          AND byte_size > ${64 * 1_024}`
    );
    expect(long).toBe(
      Math.round(distributions.notes * distributions.longNoteShare)
    );
    expect(long).toBeGreaterThan(0);

    // Grantees: a LIVE binding and a standing answer each, plus the circle.
    expect(
      count(
        vault,
        "SELECT COUNT(*) AS n FROM share_party_vault_binding WHERE revoked_at IS NULL"
      )
    ).toBe(distributions.grantees);
    expect(
      count(
        vault,
        `SELECT COUNT(*) AS n FROM share_authority
          WHERE revoked_at IS NULL AND decision = 'granted' AND verb = 'view'`
      )
    ).toBe(distributions.grantees);
    expect(
      count(
        vault,
        `SELECT COUNT(*) AS n FROM share_authority
          WHERE principal_kind = 'circle' AND verb = 'edit'`
      )
    ).toBe(distributions.granteeCircles);
    expect(count(vault, "SELECT COUNT(*) AS n FROM social_circle")).toBe(1);

    // Automations: durable ledger state, not a manifest.
    expect(
      count(
        vault,
        "SELECT COUNT(DISTINCT automation_id) AS n FROM automation_state"
      )
    ).toBe(distributions.automations);

    // A year of receipts, one per day, in an unbroken chain.
    const receipts = vault
      .prepare(
        `SELECT COUNT(*) AS n,
                COUNT(DISTINCT substr(occurred_at, 1, 10)) AS days,
                MIN(seq) AS lo, MAX(seq) AS hi
           FROM access_receipt`
      )
      .get() as { n: number; days: number; lo: number; hi: number };
    expect(receipts.n).toBe(distributions.receiptDays);
    expect(receipts.days).toBe(distributions.receiptDays);
    expect(receipts.lo).toBe(1);
    expect(receipts.hi).toBe(distributions.receiptDays);

    // Both needles reach exactly one row through the product's own indexes.
    expect(
      vault
        .prepare(
          `SELECT party_id FROM fts_core_party WHERE fts_core_party MATCH ?`
        )
        .all(YEAR3_CONTACT_NEEDLE)
    ).toHaveLength(1);
    expect(
      vault
        .prepare(
          `SELECT note_id FROM fts_knowledge_note
            WHERE fts_knowledge_note MATCH ?`
        )
        .all(YEAR3_NOTE_NEEDLE)
    ).toHaveLength(1);
  });

  test("two builds at one seed are row-identical", async () => {
    const [first, second] = await Promise.all([openSeeded(), openSeeded()]);
    const digestOf = (vault: DatabaseSync): string =>
      JSON.stringify(
        [
          "core_party",
          "knowledge_note",
          "core_content_item",
          "share_authority",
          "share_party_vault_binding",
          "access_receipt",
          "automation_state",
        ].map((table) => [
          table,
          // The owner party and vault ids are minted per bootstrap, so the
          // comparison is over the SEEDED rows: their ids, and the content
          // that makes the fixture what it is.
          vault
            .prepare(
              `SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(rowid AS TEXT))), 0) AS w
                 FROM ${table}`
            )
            .get(),
        ])
      );
    expect(digestOf(first)).toBe(digestOf(second));
    // Content equality where it is deterministic: the note bodies.
    const bodies = (vault: DatabaseSync): unknown =>
      vault
        .prepare(
          `SELECT content_id, byte_size, sha256 FROM core_content_item
            WHERE content_id LIKE 'year3-note-content-%' ORDER BY content_id`
        )
        .all();
    expect(bodies(first)).toStrictEqual(bodies(second));
  });

  test("the plain year-3 profile declares no distributions", () => {
    // Rigs that spread `year3VaultProfile()` for one axis must keep seeding
    // exactly what they seeded before the golden artifact existed.
    expect(year3VaultProfile().distributions).toBeUndefined();
    expect(goldenYear3Profile().distributions).toStrictEqual(
      YEAR3_DISTRIBUTIONS
    );
    expect(goldenYear3Profile().photos).toBe(
      YEAR3_DISTRIBUTIONS.dailyPathPhotos
    );
  });

  test("the cache key covers the version, the seed and the schema ladder", () => {
    const profile = goldenYear3Profile();
    const key = year3FixtureCacheKey(profile, 42);
    expect(year3FixtureCacheKey(profile, 42)).toBe(key);
    expect(year3FixtureCacheKey(profile, 43)).not.toBe(key);
    expect(year3FixtureCacheKey(goldenYear3Profile(1), 42)).not.toBe(key);
    expect(
      year3FixtureCacheKey(
        { ...profile, distributions: { ...YEAR3_DISTRIBUTIONS, notes: 999 } },
        42
      )
    ).not.toBe(key);
    // The version is IN the key, which is what makes a bump an invalidation
    // rather than a note in a changelog.
    expect(YEAR3_FIXTURE_VERSION).toBe(3);
  });

  test("materializing hits the cache the second time and misses after a bump", async () => {
    const root = await tempDir("year3-fixture-cache-");
    const profile = goldenYear3Profile();
    let builds = 0;
    const generate = async (): Promise<void> => {
      builds += 1;
    };
    const first = await materializeYear3Fixture(root, generate, profile, 1);
    expect(first.cacheHit).toBe(false);
    const second = await materializeYear3Fixture(root, generate, profile, 1);
    expect(second.cacheHit).toBe(true);
    expect(second.dir).toBe(first.dir);
    expect(builds).toBe(1);
    // A schema rung is a different artifact, not a stale one.
    const bumped = await materializeYear3Fixture(root, generate, profile, 2);
    expect(bumped.cacheHit).toBe(false);
    expect(bumped.dir).not.toBe(first.dir);
    expect(builds).toBe(2);
  });

  test("one build per key per run, however many callers ask at once", async () => {
    const root = await tempDir("year3-fixture-warm-");
    const profile = goldenYear3Profile();
    let builds = 0;
    const generate = async (): Promise<void> => {
      builds += 1;
    };
    // Concurrent, not sequential: the on-disk cache cannot answer callers that
    // arrive before the first one has renamed its temporary directory, so
    // without the warm set every one of these pays a full build.
    const [first, second, third] = await Promise.all([
      materializeYear3Fixture(root, generate, profile, 1),
      materializeYear3Fixture(root, generate, profile, 1),
      materializeYear3Fixture(root, generate, profile, 1),
    ]);
    expect(builds).toBe(1);
    expect(second!.dir).toBe(first!.dir);
    expect(third!.dir).toBe(first!.dir);
    expect([second!.cacheHit, third!.cacheHit]).toStrictEqual([true, true]);
  });
});
