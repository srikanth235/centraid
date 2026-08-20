import { describe, expect, test } from "vitest";

import { year3FixtureCacheKey, year3VaultProfile } from "./year3-vault.js";

/**
 * The year-3 fixture cache is a DURABLE cache: the nightly scale jobs carry
 * `artifacts/year3-cache` between runs through `actions/cache`, so a key that
 * cannot see a schema change hands the next run a SQLite file the current build
 * cannot open. That is not a theoretical failure mode — `restore-year3` failed
 * every night for weeks with `no such table: main.enrich_policy_rule` out of
 * `openVaultDb`, because the key hashed only the fixture's SHAPE and a
 * hand-maintained version constant, and neither moved when the fresh-schema
 * rung gained a table (#676).
 *
 * These are the three properties the key has to hold for that to stay fixed.
 */
describe(year3FixtureCacheKey, () => {
  const profile = year3VaultProfile();
  const schemaA = "a".repeat(32);
  const schemaB = "b".repeat(32);

  test("a fingerprinted key never collides with an unfingerprinted one", () => {
    // The load-bearing one. Fixtures cached by builds that predate the
    // fingerprint must MISS rather than be adopted by a build that fingerprints
    // — otherwise the first run after this change reuses the very fixture that
    // was breaking the nightly.
    expect(year3FixtureCacheKey(profile, schemaA)).not.toBe(
      year3FixtureCacheKey(profile)
    );
  });

  test("the same schema keeps the same key, so the cache still caches", () => {
    // Invalidation is only half the contract: a key that moved per run would
    // regenerate a 10 GiB-class fixture every night and the cache would be
    // pure cost.
    expect(year3FixtureCacheKey(profile, schemaA)).toBe(
      year3FixtureCacheKey(profile, schemaA)
    );
  });

  test("a schema change invalidates the key", () => {
    expect(year3FixtureCacheKey(profile, schemaA)).not.toBe(
      year3FixtureCacheKey(profile, schemaB)
    );
  });

  test("the profile still participates in the key", () => {
    // Guards the regression where folding in a fingerprint accidentally
    // replaces the shape rather than joining it.
    expect(year3FixtureCacheKey(profile, schemaA)).not.toBe(
      year3FixtureCacheKey({ ...profile, photos: profile.photos + 1 }, schemaA)
    );
  });
});
