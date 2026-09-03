import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { seedYear3Distributions } from "./year3-distributions.js";
import {
  YEAR3_CONTACT_NEEDLE,
  YEAR3_CONTACT_NEEDLE_INDEX,
  YEAR3_DISTRIBUTIONS,
} from "./year3-shape.js";
import type {
  Year3SeedCounts,
  Year3VaultProfile,
  Year3VaultTarget,
} from "./year3-shape.js";

// One public subpath: `./year3-vault` stays the whole vocabulary's front door,
// so splitting the module changed no import anywhere else in the tree.
export * from "./year3-shape.js";

/**
 * 2 — the golden artifact (#927 P4). Version 1 declared row COUNTS only; the
 * golden year-3 vault declares DISTRIBUTIONS as well (long note bodies over
 * the previous 64 KiB default but under the declared content ceiling, grantees with live bindings and standing
 * authority, a year of receipts in the audit band, the five-vault footprint),
 * so a fixture cached under version 1 is a different artifact and is not
 * reusable. `year3FixtureCacheKey` carries the version, so the bump alone
 * invalidates every cached directory.
 */
export const YEAR3_FIXTURE_VERSION = 2;

/**
 * Stand-in for a caller that names no schema. Distinct from any real ladder
 * length so a fixture cached without a schema can never be mistaken for one
 * cached with a matching schema.
 */
const UNVERSIONED_SCHEMA = -1;
export const YEAR3_DEFAULT_SEED = 679_003;

/**
 * One deterministic generator for the year-3 row, chronology, custody, and
 * ledger axes. Scale lanes pass the full profile; PR tests use small counts
 * through the same statements. Callers checkpoint the file before
 * caching/copying the generated fixture (docs/traps/wal-checkpoint.md).
 */
export function seedYear3Vault(
  target: Year3VaultTarget,
  counts: Year3SeedCounts = year3VaultProfile()
): void {
  const profile = year3VaultProfile();
  const at = (index: number): string =>
    new Date(
      Date.parse(profile.multiYearStart) + index * 86_400_000
    ).toISOString();
  const id = (prefix: string, index: number): string =>
    `${prefix}-${String(index).padStart(6, "0")}`;
  const digest = (value: string): string =>
    createHash("sha256").update(value).digest("hex");
  const party = target.vault.prepare(
    "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at) VALUES (?, 'person', ?, ?, ?)"
  );
  const content = target.vault.prepare(
    "INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, title, created_at) VALUES (?, 'image/jpeg', ?, ?, 4096, ?, ?)"
  );
  const photo = target.vault.prepare(
    "INSERT INTO media_asset (asset_id, content_id, kind, captured_at) VALUES (?, ?, 'photo', ?)"
  );
  // The star is a flags-scheme tag on the ASSET (#916) — `media_asset.favorite`
  // is gone. One in fifty photos carries it, so the fixture still exercises the
  // join every Photos surface now makes.
  const flagsSchemeId = "year3-flags-scheme";
  const starredConceptId = "year3-starred-concept";
  const star = target.vault.prepare(
    `INSERT INTO core_tag (tag_id, concept_id, target_type, target_id, tagged_at)
     VALUES (?, ?, 'media.asset', ?, ?)`
  );
  target.vault.exec("BEGIN IMMEDIATE");
  target.vault
    .prepare(
      "INSERT INTO core_concept_scheme (scheme_id, uri, title, version, created_at) VALUES (?, 'https://centraid.dev/schemes/flags', 'Flags', '1', ?)"
    )
    .run(flagsSchemeId, at(0));
  target.vault
    .prepare(
      "INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, created_at) VALUES (?, ?, 'starred', 'Starred', ?)"
    )
    .run(starredConceptId, flagsSchemeId, at(0));
  for (let index = 0; index < counts.parties; index += 1) {
    const timestamp = at(index % 1_096);
    party.run(
      id("year3-party", index),
      // The golden vault plants its own search needle rather than leaving each
      // rig to UPDATE a row after copying the fixture: a rig that rewrites the
      // artifact is no longer measuring the artifact.
      counts.distributions &&
        index === YEAR3_CONTACT_NEEDLE_INDEX % Math.max(1, counts.parties)
        ? YEAR3_CONTACT_NEEDLE
        : `Year 3 person ${index}`,
      timestamp,
      timestamp
    );
  }
  for (let index = 0; index < counts.photos; index += 1) {
    const contentId = id("year3-content", index);
    const timestamp = at(index % 1_096);
    content.run(
      contentId,
      `file:///year3/photo-${index}.jpg`,
      digest(contentId),
      `Year 3 photo ${index}`,
      timestamp
    );
    const assetId = id("year3-photo", index);
    photo.run(assetId, contentId, timestamp);
    if (index % 50 === 0)
      star.run(id("year3-star", index), starredConceptId, assetId, timestamp);
  }
  const lockerId = "year3-sealed-locker";
  const lockerColumns = [
    "password",
    "otp_seed",
    "card_number",
    "cvv",
    "content",
  ];
  const lockerValues = lockerColumns.map((column) =>
    target.sealCell(
      "locker.item",
      column,
      lockerId,
      profile.sealedSentinels[`locker.item.${column}`] ??
        `CENTRAID-SEALED-${digest(`${profile.seed}:${column}`).slice(0, 24)}`
    )
  );
  target.vault
    .prepare(
      `INSERT INTO locker_item
       (item_id, type, title, password, otp_seed, card_number, cvv, content, created_at, updated_at)
       VALUES (?, 'login', 'Year 3 sealed canary', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(lockerId, ...lockerValues, at(1), at(1));
  // Locker's sealed sidecars (#872). Each hangs off the canary item above and
  // seals under its OWN row id — the AAD is `table.column:rowid`, so a field's
  // ciphertext is bound to its `field_id`, a history row's to its
  // `revision_id`, and the passkey's to the `item_id` that is its primary key.
  // Seeding them here is what lets the T3 canary prove the three new columns
  // reach all six enforcement points rather than merely being declared.
  const fieldId = "year3-sealed-field";
  target.vault
    .prepare(
      `INSERT INTO locker_item_field
       (field_id, item_id, section, label, kind, value_text, value_sealed,
        position, created_at, updated_at)
       VALUES (?, ?, '', 'Year 3 sealed field', 'sealed', NULL, ?, 0, ?, ?)`
    )
    .run(
      fieldId,
      lockerId,
      target.sealCell(
        "locker.item_field",
        "value_sealed",
        fieldId,
        profile.sealedSentinels["locker.item_field.value_sealed"]!
      ),
      at(1),
      at(1)
    );
  // ONE revision mechanism (#916, ONT-revisions): `locker_item_history` is
  // gone. A snapshot records that a sealed column CHANGED, never its
  // plaintext, so this row carries no sentinel.
  const revisionId = "year3-sealed-revision";
  target.vault
    .prepare(
      `INSERT INTO core_entity_revision
       (revision_id, entity_type, entity_id, operation, snapshot_json,
        recorded_at, undo_until)
       VALUES (?, 'locker.item', ?, 'update', ?, ?, ?)`
    )
    .run(
      revisionId,
      lockerId,
      JSON.stringify({ title: "Year 3 sealed canary", password: true }),
      at(1),
      at(1)
    );
  target.vault
    .prepare(
      `INSERT INTO locker_item_passkey
       (item_id, rp_id, user_handle, display_name, credential_id, algorithm,
        private_key, created_at, updated_at)
       VALUES (?, 'year3.example', 'year3-handle', 'Year 3 passkey',
               'year3-credential', 'ES256', ?, ?, ?)`
    )
    .run(
      lockerId,
      target.sealCell(
        "locker.item_passkey",
        "private_key",
        lockerId,
        profile.sealedSentinels["locker.item_passkey.private_key"]!
      ),
      at(1),
      at(1)
    );
  const connectionId = "year3-sealed-connection";
  target.vault
    .prepare(
      `INSERT INTO sync_connection
       (connection_id, kind, label, status, trust, created_at)
       VALUES (?, 'quality-canary', 'Year 3 sealed canary', 'active', 'staged', ?)`
    )
    .run(connectionId, at(2));
  const credentialColumns = [
    "client_secret",
    "access_token",
    "refresh_token",
    "refresh_capability",
    "api_key",
  ];
  const credentialValues = credentialColumns.map((column) =>
    target.sealCell(
      "sync.connection_credential",
      column,
      connectionId,
      profile.sealedSentinels[`sync.connection_credential.${column}`]!
    )
  );
  target.vault
    .prepare(
      `INSERT INTO sync_connection_credential
       (connection_id, cred_kind, provider, client_secret, access_token,
        refresh_token, refresh_capability, api_key, allowed_hosts, updated_at)
       VALUES (?, 'oauth2', 'quality-canary', ?, ?, ?, ?, ?, '[]', ?)`
    )
    .run(connectionId, ...credentialValues, at(2));
  target.vault.exec("COMMIT");

  const owner = target.vault
    .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
    .get() as { self_party_id: string };
  const conversation = target.vault.prepare(
    "INSERT INTO conversations (id, kind, user_id, app_id, title, turn_count, item_count, created_at, updated_at) VALUES (?, 'chat', ?, '_assistant', ?, ?, ?, ?, ?)"
  );
  const turn = target.vault.prepare(
    "INSERT INTO turns (id, conversation_id, seq, trigger, ok, started_at, ended_at) VALUES (?, ?, ?, 'manual', 1, ?, ?)"
  );
  const item = target.vault.prepare(
    "INSERT INTO items (id, turn_id, ordinal, kind, role, text, started_at, ended_at) VALUES (?, ?, 0, 'message_in', 'user', ?, ?, ?)"
  );
  target.vault.exec("BEGIN IMMEDIATE");
  for (
    let conversationIndex = 0;
    conversationIndex < counts.conversations;
    conversationIndex += 1
  ) {
    const conversationId = id("year3-conversation", conversationIndex);
    const timestamp = Date.parse(at(conversationIndex % 1_096));
    conversation.run(
      conversationId,
      owner.self_party_id,
      `Year 3 conversation ${conversationIndex}`,
      counts.turnsPerConversation,
      counts.turnsPerConversation,
      timestamp,
      timestamp
    );
    for (
      let turnIndex = 0;
      turnIndex < counts.turnsPerConversation;
      turnIndex += 1
    ) {
      const turnId = `${conversationId}-turn-${turnIndex}`;
      turn.run(
        turnId,
        conversationId,
        turnIndex,
        timestamp + turnIndex,
        timestamp + turnIndex
      );
      item.run(
        `${turnId}-item`,
        turnId,
        `Year 3 item ${turnIndex}`,
        timestamp + turnIndex,
        timestamp + turnIndex
      );
    }
  }
  target.vault.exec("COMMIT");
  if (counts.distributions) {
    seedYear3Distributions(target, counts.distributions, profile, {
      at,
      id,
      digest,
      ownerPartyId: owner.self_party_id,
      parties: counts.parties,
      photos: counts.photos,
    });
  }
  target.vault.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

/**
 * Deterministic metadata shared by scale and quality rigs. Large byte payloads
 * remain lazily materialized by each owner; this profile is cheap to cache by
 * its stable fingerprint and prevents the row/consent/sealed axes drifting.
 */
export function year3VaultProfile(
  seed = YEAR3_DEFAULT_SEED
): Year3VaultProfile {
  const sentinel = (field: string): string =>
    `CENTRAID-SEALED-${createHash("sha256")
      .update(`${seed}:${field}`)
      .digest("hex")
      .slice(0, 24)}`;
  return {
    seed,
    generatedAt: "2026-01-01T00:00:00.000Z",
    parties: 5_000,
    photos: 90_000,
    conversations: 2_000,
    turnsPerConversation: 12,
    multiYearStart: "2023-01-01T00:00:00.000Z",
    sealedSentinels: {
      "locker.item.password": sentinel("locker.item.password"),
      "locker.item.otp_seed": sentinel("locker.item.otp_seed"),
      "locker.item.card_number": sentinel("locker.item.card_number"),
      "locker.item.cvv": sentinel("locker.item.cvv"),
      "locker.item.content": sentinel("locker.item.content"),
      "locker.item_field.value_sealed": sentinel(
        "locker.item_field.value_sealed"
      ),
      "locker.item_passkey.private_key": sentinel(
        "locker.item_passkey.private_key"
      ),
      "sync.connection_credential.client_secret": sentinel(
        "sync.connection_credential.client_secret"
      ),
      "sync.connection_credential.access_token": sentinel(
        "sync.connection_credential.access_token"
      ),
      "sync.connection_credential.refresh_token": sentinel(
        "sync.connection_credential.refresh_token"
      ),
      "sync.connection_credential.refresh_capability": sentinel(
        "sync.connection_credential.refresh_capability"
      ),
      "sync.connection_credential.api_key": sentinel(
        "sync.connection_credential.api_key"
      ),
    },
    parkedActions: ["outbox.stage", "schedule.propose_event"],
  };
}

/**
 * THE golden year-3 vault (#927 P4): one named, versioned, content-addressed
 * artifact every rig mounts, so "shape ids unchanged on the golden vault" and
 * every before/after number stand on the same fixture.
 *
 * `photos` is the DAILY-USE path count (10,000), not the library total
 * (90,000): the golden vault is what a journey rig opens, and a journey reads
 * the daily path. The 90,000-asset library stays `year3VaultProfile()`'s
 * number, seeded by the two rigs that measure the library itself
 * (`phash-clustering`, `restore-10gib`).
 */
export function goldenYear3Profile(
  seed = YEAR3_DEFAULT_SEED
): Year3VaultProfile {
  return {
    ...year3VaultProfile(seed),
    photos: YEAR3_DISTRIBUTIONS.dailyPathPhotos,
    distributions: YEAR3_DISTRIBUTIONS,
  };
}

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

/**
 * Materialize a generated fixture once under a content-addressed cache.
 * `generate` must close its handles after checkpointing; the atomic rename
 * means readers never copy a live SQLite database beside an uncheckpointed WAL.
 */
export async function materializeYear3Fixture(
  cacheRoot: string,
  generate: (targetDir: string) => Promise<void>,
  profile = year3VaultProfile(),
  schemaVersion: number = UNVERSIONED_SCHEMA
): Promise<{ dir: string; cacheHit: boolean }> {
  const key = year3FixtureCacheKey(profile, schemaVersion);
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
