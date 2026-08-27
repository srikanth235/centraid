import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";

export const YEAR3_FIXTURE_VERSION = 1;

/**
 * Stand-in for a caller that names no schema. Distinct from any real ladder
 * length so a fixture cached without a schema can never be mistaken for one
 * cached with a matching schema.
 */
const UNVERSIONED_SCHEMA = -1;
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
  const revisionId = "year3-sealed-revision";
  target.vault
    .prepare(
      `INSERT INTO locker_item_history
       (revision_id, item_id, operation, title, password, changed_json, recorded_at)
       VALUES (?, ?, 'update', 'Year 3 sealed canary', ?, '{"password":true}', ?)`
    )
    .run(
      revisionId,
      lockerId,
      target.sealCell(
        "locker.item_history",
        "password",
        revisionId,
        profile.sealedSentinels["locker.item_history.password"]!
      ),
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
      "locker.item_field.value_sealed": sentinel(
        "locker.item_field.value_sealed"
      ),
      "locker.item_history.password": sentinel("locker.item_history.password"),
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
