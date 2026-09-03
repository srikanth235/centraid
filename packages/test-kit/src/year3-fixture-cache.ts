/**
 * THE CONTENT-ADDRESSED CACHE behind the golden year-3 artifact (#927 P4):
 * its version, its content address, where materialized directories live, and
 * the one function that BUILDS one.
 *
 * Separate from `year3-vault.ts` because building an artifact and seeding one
 * are different jobs with different reasons to change — the seeder gains a
 * dimension, the cache gains an invalidation rule — and because the seeder is
 * not allowed to be the only door to the cache: `year3-replica.ts` and the
 * root suite's factories materialize artifacts that hold no seeded vault at
 * all. Everything here is re-exported by `./year3-vault`, which stays the one
 * public subpath.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Year3VaultProfile } from "./year3-shape.js";

/**
 * 3 — the golden artifact (#927 P4). Version 1 declared row COUNTS only;
 * version 2 declared DISTRIBUTIONS as well (long note bodies over the
 * replica's 64 KiB value ceiling, grantees with live bindings and standing
 * authority, a year of receipts in the audit band, the five-vault footprint).
 * Version 3 adds the golden replica's `meta.json` — the row count and
 * bootstrap cursor of the artifact, written beside `replica.db` so a warm run
 * can report them without walking 50,000 rows to rediscover what it already
 * built. A directory cached under an earlier version is a different artifact
 * and is not reusable; `year3FixtureCacheKey` carries the version, so the bump
 * alone invalidates every cached directory.
 */
export const YEAR3_FIXTURE_VERSION = 3;

/**
 * Stand-in for a caller that names no schema. Distinct from any real ladder
 * length so a fixture cached without a schema can never be mistaken for one
 * cached with a matching schema.
 */
const UNVERSIONED_SCHEMA = -1;

/**
 * Where materialized fixtures live. `CENTRAID_YEAR3_CACHE_DIR` is the CI
 * override (a cached workflow path); otherwise the host's scratch dir, which
 * survives between local runs and so gives a warm build on the second run.
 *
 * ONE way to name the cache: every rig calls this rather than repeating the
 * env-var-or-temp-dir dance, which is how `artifacts/year3-cache` ended up
 * spelled out in rig bodies in the first place.
 */
export function year3FixtureCacheRoot(): string {
  return (
    process.env.CENTRAID_YEAR3_CACHE_DIR ??
    path.join(tmpdir(), "centraid-year3-fixture-cache")
  );
}

/**
 * Content address of a materialized fixture.
 *
 * `schemaVersion` is part of the identity, and has to be: the fixture IS a
 * vault on disk, so the schema that produced it is as much of its content as
 * the profile is. Without it a cached fixture built before a migration rung
 * lands is reused afterwards and opened by newer code — which is how the
 * nightly restore lane failed with `no such table: main.enrich_policy_rule`,
 * a table a later rung added. Callers pass `VAULT_MIGRATIONS.length`;
 * `test-kit` deliberately does not depend on `@centraid/vault`, so the number
 * arrives as an argument rather than an import.
 */
export function year3FixtureCacheKey(
  profile: Year3VaultProfile,
  schemaVersion: number
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: YEAR3_FIXTURE_VERSION,
        schemaVersion,
        ...profile,
      })
    )
    .digest("hex");
}

export interface Year3Fixture {
  readonly dir: string;
  readonly cacheHit: boolean;
}

/**
 * One materialization per (cache root, key) per RUN — the WARM set.
 *
 * The on-disk cache makes a second build cheap, not free: every caller still
 * re-reads `READY.json`, and two callers that arrive before either has renamed
 * its temporary directory each pay a full build. Rigs in one run asking for
 * the same fixture are asking for the same directory, so they share one
 * promise and the artifact is warmed exactly once.
 */
const warmFixtures = new Map<string, Promise<Year3Fixture>>();

/**
 * BUILD, as distinct from MOUNT: after this resolves the artifact exists in
 * the content-addressed cache. It is never the directory a rig writes to —
 * a caller that needs to open the fixture copies it first, or it corrupts the
 * artifact every other rig is measuring against.
 *
 * `generate` must close its handles after checkpointing; the atomic rename
 * means readers never copy a live SQLite database beside an uncheckpointed WAL.
 */
export function materializeYear3Fixture(
  cacheRoot: string,
  generate: (targetDir: string) => Promise<void>,
  profile: Year3VaultProfile,
  schemaVersion: number = UNVERSIONED_SCHEMA
): Promise<Year3Fixture> {
  const key = year3FixtureCacheKey(profile, schemaVersion);
  const warmKey = `${cacheRoot}\u0000${key}`;
  const warmed = warmFixtures.get(warmKey);
  // Warm is a hit, whatever the first caller in this run paid for it.
  if (warmed) return warmed.then(({ dir }) => ({ dir, cacheHit: true }));
  const building = buildYear3Fixture(cacheRoot, key, generate, schemaVersion);
  warmFixtures.set(warmKey, building);
  // A failed build must not poison the run: the next caller retries rather
  // than inheriting this rejection.
  void building.catch(() => warmFixtures.delete(warmKey));
  return building;
}

async function buildYear3Fixture(
  cacheRoot: string,
  key: string,
  generate: (targetDir: string) => Promise<void>,
  schemaVersion: number
): Promise<Year3Fixture> {
  const dir = path.join(cacheRoot, key);
  const ready = path.join(dir, "READY.json");
  try {
    const value = JSON.parse(await readFile(ready, "utf8")) as { key?: string };
    if (value.key === key) return { dir, cacheHit: true };
  } catch {
    // Cache miss or interrupted prior generation.
  }
  await mkdir(cacheRoot, { recursive: true });
  const temporary = `${dir}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    await generate(temporary);
    await writeFile(
      path.join(temporary, "READY.json"),
      `${JSON.stringify({ key, version: YEAR3_FIXTURE_VERSION, schemaVersion })}\n`,
      "utf8"
    );
    try {
      await rename(temporary, dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { dir, cacheHit: false };
}
