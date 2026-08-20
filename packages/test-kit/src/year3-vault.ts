import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";

export const YEAR3_FIXTURE_VERSION = 1;
export const YEAR3_DEFAULT_SEED = 679_003;

export interface Year3VaultProfile {
  readonly seed: number;
  readonly generatedAt: string;
  readonly parties: number;
  readonly photos: number;
  readonly conversations: number;
  readonly turnsPerConversation: number;
  readonly multiYearStart: string;
  readonly sealedSentinels: Readonly<Record<string, string>>;
  readonly parkedActions: readonly string[];
}

interface Statement {
  get: (...values: SQLInputValue[]) => unknown;
  run: (...values: SQLInputValue[]) => unknown;
}

export interface Year3Sqlite {
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
}

export interface Year3VaultTarget {
  readonly vault: Year3Sqlite;
  readonly journal: Year3Sqlite;
  readonly sealCell: (
    entity: string,
    column: string,
    rowId: string,
    plaintext: string
  ) => string;
}

export interface Year3SeedCounts {
  readonly parties: number;
  readonly photos: number;
  readonly conversations: number;
  readonly turnsPerConversation: number;
}

/**
 * One deterministic generator for the year-3 row, chronology, custody, and
 * ledger axes. Scale lanes pass the full profile; PR tests use small counts
 * through the same statements. Callers checkpoint both databases before
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
    "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version) VALUES (?, 'person', ?, ?, ?, 'v0')"
  );
  const content = target.vault.prepare(
    "INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, title, created_at) VALUES (?, 'image/jpeg', ?, ?, 4096, ?, ?)"
  );
  const photo = target.vault.prepare(
    "INSERT INTO media_asset (asset_id, content_id, kind, captured_at, favorite) VALUES (?, ?, 'photo', ?, 0)"
  );
  target.vault.exec("BEGIN IMMEDIATE");
  for (let index = 0; index < counts.parties; index += 1) {
    const timestamp = at(index % 1_096);
    party.run(
      id("year3-party", index),
      `Year 3 person ${index}`,
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
    photo.run(id("year3-photo", index), contentId, timestamp);
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
        refresh_token, api_key, allowed_hosts, updated_at)
       VALUES (?, 'oauth2', 'quality-canary', ?, ?, ?, ?, '[]', ?)`
    )
    .run(connectionId, ...credentialValues, at(2));
  target.vault.exec("COMMIT");

  const owner = target.vault
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string };
  const conversation = target.journal.prepare(
    "INSERT INTO conversations (id, kind, user_id, app_id, title, turn_count, item_count, created_at, updated_at) VALUES (?, 'chat', ?, '_assistant', ?, ?, ?, ?, ?)"
  );
  const turn = target.journal.prepare(
    "INSERT INTO turns (id, conversation_id, seq, trigger, ok, started_at, ended_at) VALUES (?, ?, ?, 'manual', 1, ?, ?)"
  );
  const item = target.journal.prepare(
    "INSERT INTO items (id, turn_id, ordinal, kind, role, text, started_at, ended_at) VALUES (?, ?, 0, 'message_in', 'user', ?, ?, ?)"
  );
  target.journal.exec("BEGIN IMMEDIATE");
  for (
    let conversationIndex = 0;
    conversationIndex < counts.conversations;
    conversationIndex += 1
  ) {
    const conversationId = id("year3-conversation", conversationIndex);
    const timestamp = Date.parse(at(conversationIndex % 1_096));
    conversation.run(
      conversationId,
      owner.owner_party_id,
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
  target.journal.exec("COMMIT");
  target.vault.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  target.journal.exec("PRAGMA wal_checkpoint(TRUNCATE)");
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
      "sync.connection_credential.client_secret": sentinel(
        "sync.connection_credential.client_secret"
      ),
      "sync.connection_credential.access_token": sentinel(
        "sync.connection_credential.access_token"
      ),
      "sync.connection_credential.refresh_token": sentinel(
        "sync.connection_credential.refresh_token"
      ),
      "sync.connection_credential.api_key": sentinel(
        "sync.connection_credential.api_key"
      ),
    },
    parkedActions: ["outbox.stage", "schedule.propose_event"],
  };
}

/**
 * Fingerprint of the SCHEMA a cached fixture was generated against.
 *
 * A cached fixture is a real SQLite vault on disk, so it is only reusable by a
 * build whose schema still matches the one that wrote it. The profile below
 * describes the fixture's SHAPE (row counts, seed) and says nothing about its
 * schema, and `YEAR3_FIXTURE_VERSION` is hand-maintained — so before this
 * existed, adding a table to the fresh-schema rung left every cached fixture
 * looking valid while being unopenable. That is not hypothetical: the nightly
 * `restore-year3` job failed every night with `no such table:
 * main.enrich_policy_rule` out of `openVaultDb`, because `actions/cache`
 * restored the same pre-`enrich_policy_rule` fixture into each run (#676).
 * Bumping the hand-maintained version would have cleared it once and left the
 * next schema change to rediscover it the same way.
 *
 * `@centraid/test-kit` must not depend on `@centraid/vault` (see src/vault.ts —
 * the dependency runs the other way), so the schema cannot be hashed here. The
 * caller, which already imports the vault, passes its own fingerprint instead;
 * `tests/helpers/year3-schema-fingerprint.ts` derives one from the migration
 * ladder so any schema edit invalidates the cache with no one having to
 * remember.
 *
 * Optional, and absent means "unfingerprinted" rather than "no schema": a
 * caller that omits it keeps the old key exactly, so an in-process fixture with
 * no durable cache does not have to care.
 */
export function year3FixtureCacheKey(
  profile: Year3VaultProfile,
  schemaFingerprint?: string
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: YEAR3_FIXTURE_VERSION,
        ...profile,
        ...(schemaFingerprint ? { schemaFingerprint } : {}),
      })
    )
    .digest("hex");
}

/**
 * Materialize a generated fixture once under a content-addressed cache.
 * `generate` must close its handles after checkpointing; the atomic rename
 * means readers never copy a live SQLite database beside an uncheckpointed WAL.
 *
 * Pass `schemaFingerprint` whenever the cache outlives the process (the nightly
 * jobs restore `artifacts/year3-cache` through `actions/cache`), or a schema
 * change will silently reuse a fixture the current build cannot open.
 */
export async function materializeYear3Fixture(
  cacheRoot: string,
  generate: (targetDir: string) => Promise<void>,
  profile = year3VaultProfile(),
  schemaFingerprint?: string
): Promise<{ dir: string; cacheHit: boolean }> {
  const key = year3FixtureCacheKey(profile, schemaFingerprint);
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
      `${JSON.stringify({ key, version: YEAR3_FIXTURE_VERSION })}\n`,
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
