import { createHash } from "node:crypto";

import { JOURNAL_MIGRATIONS, VAULT_MIGRATIONS } from "@centraid/vault";

/**
 * The schema a cached year-3 fixture was generated against, as one hash.
 *
 * The scale rigs cache a generated 10 GiB-class vault under
 * `artifacts/year3-cache` and the nightly jobs carry that directory between
 * runs through `actions/cache`. A cached fixture is a real SQLite file, so it
 * is only reusable while the schema that wrote it still matches this build's.
 * `year3FixtureCacheKey` hashes the fixture's SHAPE (row counts, seed) plus a
 * hand-maintained `YEAR3_FIXTURE_VERSION`, and neither moves when a table is
 * added — so the cache key alone cannot see a schema change.
 *
 * It has already cost a nightly: `restore-year3` failed every night with
 * `no such table: main.enrich_policy_rule` thrown from `openVaultDb`, because
 * each run restored the same fixture generated before that table existed
 * (#676). Hashing the migration ladder makes the invalidation automatic —
 * add a table, get a new key, regenerate once — instead of depending on
 * someone remembering to bump a constant.
 *
 * Both ladders are included: the fixture is a vault database beside a journal
 * database, and either one drifting is enough to make the pair unopenable.
 *
 * NOTE ON WHY THIS LIVES HERE, not in `@centraid/test-kit`: test-kit must not
 * depend on `@centraid/vault` — that edge runs the other way (see
 * packages/test-kit/src/vault.ts) — so the fixture cache cannot hash the schema
 * itself and takes this from the caller.
 */
export function year3SchemaFingerprint(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        journal: JOURNAL_MIGRATIONS,
        vault: VAULT_MIGRATIONS,
      })
    )
    .digest("hex")
    .slice(0, 32);
}
