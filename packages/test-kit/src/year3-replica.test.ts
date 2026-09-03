/**
 * The golden phone replica (#927 P4) is built through the REAL bootstrap path,
 * so the property this suite holds is exactly that: what the builder produces
 * equals what a real bootstrap produces — same shape catalog, same row counts
 * per shape, same deferral decisions — and the outbox it carries is the
 * phone's own outbox, not a table this fixture invented.
 *
 * Both `@centraid/vault` and `@centraid/client` are imported by PATH rather
 * than by package specifier: the vault devDepends on this package, so a
 * package import would close a cycle. See `year3-vault.test.ts`.
 */
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { tempDir } from "./temp-dir.js";
import {
  buildYear3ReplicaSnapshot,
  YEAR3_PENDING_INTENT_VOLUMES,
  YEAR3_REPLICA_ENTITIES,
  YEAR3_REPLICA_SHAPE_ID,
  year3PendingIntents,
  year3ReplicaCacheKey,
} from "./year3-replica.js";
import type { Year3ReplicaSourcePage } from "./year3-replica.js";
import { seedYear3Vault, YEAR3_DISTRIBUTIONS } from "./year3-vault.js";
import type { Year3SeedCounts } from "./year3-vault.js";

const SMALL: Year3SeedCounts = {
  parties: 40,
  photos: 30,
  conversations: 2,
  turnsPerConversation: 2,
  distributions: {
    ...YEAR3_DISTRIBUTIONS,
    notes: 40,
    automations: 4,
    grantees: 3,
    receiptDays: 5,
    longNoteMaxBytes: 96 * 1_024,
    replicaRows: 500,
  },
};

interface VaultHandle {
  vault: DatabaseSync;
  sealKey: Buffer;
  close: () => void;
}

/**
 * The slice of `@centraid/vault` and `@centraid/client` this suite drives. A
 * hand-written shape rather than an import type, for the same reason the
 * modules themselves arrive by file URL: naming the package would close a
 * dependency cycle.
 */
interface VaultApi {
  openVaultDb: (options: { dir: string; sealKey: Buffer }) => VaultHandle;
  bootstrapVault: (db: VaultHandle, options: { ownerName: string }) => unknown;
  sealAad: (entity: string, column: string, rowId: string) => Buffer;
  sealValue: (key: Buffer, aad: Buffer, plaintext: string) => string;
  currentReplicaLogState: (vault: DatabaseSync) => {
    epoch: string;
    schemaEpoch: number;
    watermark: { epoch: string; seq: number };
  };
  readReplicaRows: (
    vault: DatabaseSync,
    entity: string,
    options: { after?: string; limit: number }
  ) => Year3ReplicaSourcePage;
  resolveEntity: (
    entity: string,
    vault: DatabaseSync
  ) => { physical: string } | undefined;
}

interface PayloadHashApi {
  intentPayloadHash: (payload: {
    appId: string;
    action: string;
    input: Record<string, unknown>;
  }) => Promise<string>;
}

async function byPath<T>(relative: string): Promise<T> {
  return (await import(
    pathToFileURL(path.resolve(import.meta.dirname, relative)).href
  )) as T;
}

interface Fixture {
  vault: DatabaseSync;
  vaultId: string;
  api: VaultApi;
}

async function seededVault(): Promise<Fixture> {
  const api = await byPath<VaultApi>("../../vault/src/index.ts");
  const db = api.openVaultDb({
    dir: await tempDir("year3-replica-vault-"),
    sealKey: Buffer.alloc(32, 0x67),
  });
  api.bootstrapVault(db, { ownerName: "Year 3 owner" });
  seedYear3Vault(
    {
      vault: db.vault,
      sealCell: (entity, column, rowId, plaintext) =>
        api.sealValue(
          db.sealKey,
          api.sealAad(entity.replace(".", "_"), column, rowId),
          plaintext
        ),
    },
    SMALL
  );
  return {
    vault: db.vault,
    vaultId: (
      db.vault.prepare("SELECT vault_id FROM core_vault LIMIT 1").get() as {
        vault_id: string;
      }
    ).vault_id,
    api,
  };
}

interface SnapshotSource {
  vaultId: string;
  schemaEpoch: string;
  cursor: { epoch: string; seq: number };
  readRows: (
    entity: string,
    options: { after?: string; limit: number }
  ) => Year3ReplicaSourcePage;
  primaryKeyOf: (entity: string) => string;
}

function sourceOf(fixture: Fixture): SnapshotSource {
  const state = fixture.api.currentReplicaLogState(fixture.vault);
  return {
    vaultId: fixture.vaultId,
    schemaEpoch: String(state.schemaEpoch),
    cursor: { epoch: state.watermark.epoch, seq: state.watermark.seq },
    readRows: (entity, options) =>
      fixture.api.readReplicaRows(fixture.vault, entity, options),
    primaryKeyOf: (entity) => {
      const ref = fixture.api.resolveEntity(entity, fixture.vault);
      if (!ref) throw new Error(`unknown replica entity "${entity}"`);
      const info = fixture.vault
        .prepare(`PRAGMA table_info(${JSON.stringify(ref.physical)})`)
        .all() as unknown as { name: string; pk: number }[];
      return info.find((column) => column.pk > 0)!.name;
    },
  };
}

describe("golden phone replica", () => {
  test("the snapshot matches what the vault's own reader answers", async () => {
    const fixture = await seededVault();
    const source = sourceOf(fixture);
    const snapshot = buildYear3ReplicaSnapshot(source, {
      // Above everything the small vault holds: this test is about equality
      // with the reader, and the ceiling has its own test below.
      maxRows: 100_000,
    });

    // One shape, one entity schema per mirrored entity, in walk order.
    expect(snapshot.shapes).toHaveLength(1);
    expect(snapshot.shapes[0]!.shapeId).toBe(YEAR3_REPLICA_SHAPE_ID);
    expect(
      snapshot.shapes[0]!.entities.map((entity) => entity.entity)
    ).toStrictEqual([...YEAR3_REPLICA_ENTITIES]);

    // Row counts per shape, against `snapshot.ts`'s own read of each table.
    for (const entity of YEAR3_REPLICA_ENTITIES) {
      const mine = snapshot.rows.filter((row) => row.entity === entity).length;
      let theirs = 0;
      let after: string | undefined;
      for (;;) {
        const page = source.readRows(entity, {
          ...(after === undefined ? {} : { after }),
          limit: 1_000,
        });
        theirs += page.rows.length;
        if (!page.hasMore || page.nextAfter === undefined) break;
        after = page.nextAfter;
      }
      expect(mine, `${entity} rows`).toBe(theirs);
    }

    // The columns are the READER's answer, never a hand-written list.
    const notes = snapshot.shapes[0]!.entities.find(
      (entity) => entity.entity === "knowledge.note"
    )!;
    expect(notes.columns).toStrictEqual([
      ...source.readRows("knowledge.note", { limit: 1 }).columns,
    ]);
    expect(notes.primaryKey).toBe("note_id");
  });

  test("the long note bodies ride in the eager half under the entity ceiling", async () => {
    const fixture = await seededVault();
    const snapshot = buildYear3ReplicaSnapshot(sourceOf(fixture), {
      // Above everything the small vault holds: this test is about equality
      // with the reader, and the ceiling has its own test below.
      maxRows: 100_000,
    });
    const longBodies = snapshot.rows.filter(
      (row) =>
        row.entity === "core.content_item" &&
        Number(row.values["byte_size"]) > 64 * 1_024
    );
    // The distribution stays over the old default so the fixture preserves the
    // before/after corpus shape, but core.content_item now declares a 1 MiB
    // ceiling. Those bodies must therefore arrive in full on the replica.
    expect(longBodies).toHaveLength(
      Math.round(
        SMALL.distributions!.notes * SMALL.distributions!.longNoteShare
      )
    );
    expect(longBodies.length).toBeGreaterThan(0);
    for (const row of longBodies) {
      expect(row.oversizedFields ?? []).toStrictEqual([]);
      expect(row.values).toHaveProperty("content_uri");
    }
  });

  test("the walk stops at the declared ceiling", async () => {
    const fixture = await seededVault();
    const snapshot = buildYear3ReplicaSnapshot(sourceOf(fixture), {
      maxRows: 25,
      pageLimit: 10,
    });
    expect(snapshot.rows).toHaveLength(25);
  });

  test("the pending outbox is deterministic at each converge volume", async () => {
    const hash = async (payload: {
      appId: string;
      action: string;
      input: Record<string, unknown>;
    }): Promise<string> => {
      const module = await byPath<PayloadHashApi>(
        "../../client/src/replica/payload-hash.ts"
      );
      return module.intentPayloadHash(payload);
    };
    for (const volume of YEAR3_PENDING_INTENT_VOLUMES) {
      // Sequential: the seeded stream is shared, so the draws must not race.
      // oxlint-disable-next-line no-await-in-loop
      const first = await year3PendingIntents(volume, hash, 679_003);
      // oxlint-disable-next-line no-await-in-loop
      const second = await year3PendingIntents(volume, hash, 679_003);
      expect(first).toHaveLength(volume);
      expect(first).toStrictEqual(second);
      expect(new Set(first.map((intent) => intent.intentId)).size).toBe(volume);
      for (const intent of first) {
        expect(intent.state).toBe("queued");
        expect(intent.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
      }
    }
  });

  test("the replica's cache key separates outboxes and entity lists", () => {
    const key = year3ReplicaCacheKey("vault-key", 10);
    expect(year3ReplicaCacheKey("vault-key", 10)).toBe(key);
    expect(year3ReplicaCacheKey("vault-key", 40)).not.toBe(key);
    expect(year3ReplicaCacheKey("other-vault-key", 10)).not.toBe(key);
    expect(year3ReplicaCacheKey("vault-key", 10, ["core.party"])).not.toBe(key);
  });
});
