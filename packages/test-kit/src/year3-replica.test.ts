/**
 * The golden seat file (#927 P4, rewired by #996 wave 2) is built through the
 * REAL seat path, so the property this suite holds is exactly that: what the
 * builder produces is the gateway's own sanitised file with a tail of real log
 * rows applied on top and the seat's own outbox beside it — never a set of
 * tables this fixture wrote itself.
 *
 * Both `@centraid/vault` and `@centraid/client` are imported by PATH rather
 * than by package specifier: the vault devDepends on this package, so a
 * package import would close a cycle. See `year3-vault.test.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import { describe, expect, test } from "vitest";

import { staticSeatSnapshotTransport } from "./seat-snapshot-transport.js";
import { tempDir } from "./temp-dir.js";
import {
  assertYear3SeatNotHandBuilt,
  buildYear3SeatReplica,
  YEAR3_PENDING_INTENT_VOLUMES,
  year3PendingIntents,
  year3ReplicaCacheKey,
} from "./year3-replica.js";
import type { Year3SeatFacts, Year3SeatSeams } from "./year3-replica.js";
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
  buildSeatSnapshot: (
    vault: DatabaseSync,
    destination: string
  ) => {
    path: string;
    seq: number;
    epoch: string;
    schemaEpoch: number;
    bytes: number;
  };
  beginReplicaCommit: (vault: DatabaseSync) => unknown;
  endReplicaCommit: (vault: DatabaseSync, handle: unknown) => unknown;
  currentReplicaLogState: (vault: DatabaseSync) => {
    epoch: string;
    schemaEpoch: number;
    watermark: { epoch: string; seq: number };
  };
  readReplicaLog: (
    vault: DatabaseSync,
    options: { since: { epoch: string; seq: number }; limit: number }
  ) => {
    rows: readonly Record<string, unknown>[];
    watermark: { seq: number };
  };
}

interface SeatApi {
  bootstrapSeatFile: (options: Record<string, unknown>) => Promise<unknown>;
  applySeatLogPage: (
    driver: unknown,
    page: Record<string, unknown>
  ) => { applied: number };
  createSeatOutbox: (driver: unknown) => void;
  addSeatOutboxIntent: (
    driver: unknown,
    intent: Record<string, unknown>
  ) => void;
  readSeatOutbox: (driver: unknown) => { intentId: string }[];
  readSeatState: (driver: unknown) => { appliedSeq: number };
}

interface NodeSeatStagingApi {
  nodeSeatStaging: (options: {
    directory: string;
    databasePath: string;
  }) => unknown;
}

interface NodeSeatDriverApi {
  NodeSeatDriver: new (file: string) => {
    all: <T extends object>(sql: string) => T[];
    exec: (sql: string) => void;
    close: () => void;
  };
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
    dir: await tempDir("year3-seat-vault-"),
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

/** The real seams, wired to the real modules on both sides of the wire. */
async function seamsOver(
  fixture: Fixture,
  target: string
): Promise<{
  seams: Year3SeatSeams;
  outbox: () => { intentId: string }[];
  release: () => void;
}> {
  const seat = await byPath<SeatApi>("../../client/src/replica/seat/index.ts");
  const { NodeSeatDriver } = await byPath<NodeSeatDriverApi>(
    "../../client/src/replica/seat/node-seat-driver.ts"
  );
  // By its own path: `node-*` is deliberately not re-exported from the seat
  // barrel, because the browser bundle must not see `node:fs`.
  const { nodeSeatStaging } = await byPath<NodeSeatStagingApi>(
    "../../client/src/replica/seat/node-staging.ts"
  );
  const seatFile = path.join(target, "seat.db");
  let driver: InstanceType<NodeSeatDriverApi["NodeSeatDriver"]> | undefined;
  const seams: Year3SeatSeams = {
    snapshot: (destination) =>
      fixture.api.buildSeatSnapshot(fixture.vault, destination),
    tail: (since) => {
      // A real commit through the gateway's own capture, so the rows the seat
      // applies are the rows a device would have received.
      fixture.vault.exec("BEGIN IMMEDIATE");
      const handle = fixture.api.beginReplicaCommit(fixture.vault);
      fixture.vault.exec(
        `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
           VALUES ('seat-tail', 'urn:seat-tail', 'Seat tail', '1')`
      );
      fixture.api.endReplicaCommit(fixture.vault, handle);
      fixture.vault.exec("COMMIT");
      const state = fixture.api.currentReplicaLogState(fixture.vault);
      const page = fixture.api.readReplicaLog(fixture.vault, {
        since: { epoch: state.epoch, seq: since },
        limit: 10_000,
      });
      return {
        rows: page.rows.map((row) => ({
          seq: row["seq"],
          commitSeq: row["commitSeq"],
          schemaEpoch: row["schemaEpoch"],
          ddlVersion: row["ddlVersion"],
          table: row["table"],
          op: row["op"],
          pk: row["primaryKey"],
          ...(row["row"] === null ? {} : { row: row["row"] }),
          producer: row["producer"],
          committedAt: row["committedAt"],
        })),
        watermark: page.watermark.seq,
      };
    },
    install: async (snapshot) => {
      const compressed = gzipSync(readFileSync(snapshot.path), { level: 6 });
      await seat.bootstrapSeatFile({
        transport: staticSeatSnapshotTransport(compressed, snapshot),
        staging: nodeSeatStaging({
          directory: path.join(target, "staging"),
          databasePath: seatFile,
        }),
        vaultId: fixture.vaultId,
        open: () => {
          driver = new NodeSeatDriver(seatFile);
          return driver;
        },
      });
      const held = driver!;
      seat.createSeatOutbox(held);
      return {
        apply: (page) =>
          seat.applySeatLogPage(held, {
            vaultId: fixture.vaultId,
            epoch: snapshot.epoch,
            schemaEpoch: snapshot.schemaEpoch,
            ddlVersion: 0,
            floor: 0,
            watermark: page.watermark,
            next: page.watermark,
            hasMore: false,
            rows: page.rows,
          }).applied,
        queue: (intent) => {
          seat.addSeatOutboxIntent(held, {
            intentId: intent.intentId,
            appId: intent.appId,
            action: intent.action,
            input: intent.input,
            payloadHash: intent.payloadHash,
            enqueuedAt: intent.enqueuedAt,
          });
        },
        tables: () =>
          held.all<{ n: number }>(
            `SELECT count(*) AS n FROM sqlite_schema
              WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
          )[0]!.n,
        cursor: () => seat.readSeatState(held).appliedSeq,
        close: () => {
          /* held open for the assertions below; `release` closes it */
        },
      };
    },
  };
  return {
    seams,
    outbox: () => seat.readSeatOutbox(driver!),
    release: () => driver?.close(),
  };
}

describe("the golden seat file", () => {
  test("is the gateway's own file, with a real tail applied on top", async () => {
    const fixture = await seededVault();
    const target = await tempDir("year3-seat-");
    const wired = await seamsOver(fixture, target);
    const facts = await buildYear3SeatReplica(
      wired.seams,
      path.join(target, "snapshot.db"),
      {
        pendingIntents: 10,
        seed: 679_003,
        hashPayload: async (payload) =>
          (
            await byPath<PayloadHashApi>(
              "../../client/src/replica/payload-hash.ts"
            )
          ).intentPayloadHash(payload),
      }
    );

    // The gateway's schema, not a projection: scores of tables, not one.
    expect(facts.tables).toBeGreaterThan(20);
    // The tail really was applied, and the cursor moved past the snapshot.
    expect(facts.tailRows).toBeGreaterThan(0);
    expect(facts.cursor).toBeGreaterThan(facts.snapshotSeq);
    expect(facts.pendingIntents).toBe(10);
    expect(facts.contents).toBe("full");
    // The outbox is the seat's own table, in the order the intents were made.
    expect(wired.outbox().map((row) => row.intentId)).toStrictEqual(
      (
        await year3PendingIntents(
          10,
          async (payload) =>
            (
              await byPath<PayloadHashApi>(
                "../../client/src/replica/payload-hash.ts"
              )
            ).intentPayloadHash(payload),
          679_003
        )
      ).map((intent) => intent.intentId)
    );
    wired.release();
  }, 120_000);

  test("refuses a hand-built file at build time, not at assertion time", () => {
    const honest: Year3SeatFacts = {
      snapshotBytes: 1,
      snapshotSeq: 4,
      tailRows: 2,
      cursor: 6,
      tables: 120,
      pendingIntents: 0,
      contents: "full",
    };
    expect(() => assertYear3SeatNotHandBuilt(honest)).not.toThrow();
    expect(() => assertYear3SeatNotHandBuilt({ ...honest, tables: 1 })).toThrow(
      /not a copy of the gateway's file/u
    );
    expect(() => assertYear3SeatNotHandBuilt({ ...honest, cursor: 0 })).toThrow(
      /behind the snapshot/u
    );
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

  test("the cache key separates outboxes and what the file contains", () => {
    const key = year3ReplicaCacheKey("vault-key", 10);
    expect(year3ReplicaCacheKey("vault-key", 10)).toBe(key);
    expect(year3ReplicaCacheKey("vault-key", 40)).not.toBe(key);
    expect(year3ReplicaCacheKey("other-vault-key", 10)).not.toBe(key);
    // OQ-2: a seat whose search index was dropped is a different artifact.
    expect(year3ReplicaCacheKey("vault-key", 10, "rows-minus-fts")).not.toBe(
      key
    );
  });
});
