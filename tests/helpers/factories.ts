import { readFileSync } from "node:fs";
import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import { onTestFinished } from "vitest";

import type { SeatLogRowWire } from "@centraid/core/protocol";
import { staticSeatSnapshotTransport } from "@centraid/test-kit/seat-snapshot-transport";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { bootstrappedVault } from "@centraid/test-kit/vault";
import {
  buildYear3SeatReplica,
  year3ReplicaCacheKey,
} from "@centraid/test-kit/year3-replica";
import type { Year3SeatFacts } from "@centraid/test-kit/year3-replica";
import {
  goldenYear3Profile,
  materializeYear3Fixture,
  seedYear3Vault,
  YEAR3_DISTRIBUTIONS,
  year3FixtureCacheKey,
  year3FixtureCacheRoot,
} from "@centraid/test-kit/year3-vault";
import type { Year3VaultProfile } from "@centraid/test-kit/year3-vault";
import {
  beginReplicaCommit,
  bootstrapVault,
  buildSeatSnapshot,
  currentReplicaLogState,
  endReplicaCommit,
  openVaultDb,
  readReplicaLog,
  sealAad,
  sealValue,
  seatLogRowWire,
  VAULT_MIGRATIONS,
} from "@centraid/vault";
import type { OpenVaultOptions, VaultDb } from "@centraid/vault";

import { intentPayloadHash } from "../../packages/client/src/replica/payload-hash.js";
import {
  addSeatOutboxIntent,
  applySeatLogPage,
  bootstrapSeatFile,
  createSeatOutbox,
  readSeatState,
} from "../../packages/client/src/replica/seat/index.js";
import { NodeSeatDriver } from "../../packages/client/src/replica/seat/node-seat-driver.js";
import { nodeSeatStaging } from "../../packages/client/src/replica/seat/node-staging.js";

const helpersDir = import.meta.dirname;

/**
 * Resolve a workspace package's TypeScript entry without requiring a prior
 * `tsc` build — vitest can transform the source directly. Dynamic package
 * imports of `@centraid/*` fail when `dist/` is absent.
 */
function workspaceSrc(packageName: string, entry = "index.ts"): string {
  return pathToFileURL(
    path.join(helpersDir, "..", "..", "packages", packageName, "src", entry)
  ).href;
}

export interface CreateTestVaultOptions extends OpenVaultOptions {
  /** Defaults to an on-disk pair so tests exercise the production SQLite posture. */
  inMemory?: boolean;
  /** Defaults true: most callers need the owner row and full bootstrapped schema. */
  bootstrap?: boolean;
  ownerName?: string;
}

export async function createTestVault(
  options: CreateTestVaultOptions = {}
): Promise<VaultDb> {
  // Aliased: the golden-artifact factories below import the same two names
  // statically, and the shadow would be silent.
  const { bootstrapVault: bootstrapFromSrc, openVaultDb: openFromSrc } =
    await import(workspaceSrc("vault"));
  const {
    inMemory = false,
    bootstrap = true,
    ownerName = "Test owner",
    ...vaultOptions
  } = options;
  const dir = inMemory
    ? undefined
    : (vaultOptions.dir ?? (await tempDir("centraid-vault-test-")));
  // #656 Layer 4: open + bootstrap + register-the-close is one flow with one
  // home, `@centraid/test-kit/vault`. This factory only adds the root-suite
  // conveniences on top (in-memory default, auto temp dir, bootstrap opt-out).
  if (!bootstrap) {
    const bare = openFromSrc({ ...vaultOptions, ...(dir ? { dir } : {}) });
    onTestFinished(() => {
      bare.close();
    });
    return bare;
  }
  return bootstrappedVault<VaultDb, unknown>(
    {
      // The kit's only open knob is `dir`; the suite's other OpenVaultOptions
      // ride in through the injected opener rather than widening the kit.
      openVaultDb: (open) => openFromSrc({ ...vaultOptions, ...open }),
      bootstrapVault: bootstrapFromSrc,
    },
    { ...(dir ? { dir } : {}), ownerName }
  ).db;
}

// ── The golden year-3 artifact (#927 P4) ─────────────────────────────────────
//
// ONE fixture every rig mounts by name, so "shape ids for all eight apps
// unchanged on the golden vault" and every before/after number stand on the
// same bytes. Rigs call `goldenYear3Vault()` / `goldenYear3Replica()`; nothing
// under `tests/` seeds year-3 volume by hand any more.

/** Deterministic, and the same key every rig opens the golden vault with. */
export const GOLDEN_YEAR3_SEAL_KEY = Buffer.alloc(32, 0x67);
const GOLDEN_YEAR3_OWNER = "Year 3 owner";

/**
 * The artifact as BUILT: a directory in the content-addressed cache that no
 * rig may open. Opening it would write a WAL and an identity key into the
 * bytes every other rig measures against.
 */
export interface GoldenYear3Build {
  readonly cacheDir: string;
  readonly cacheHit: boolean;
  readonly buildMs: number;
  readonly profile: Year3VaultProfile;
  readonly sealKey: Buffer;
}

export interface GoldenYear3Vault {
  /** A WRITABLE copy of the fixture; `vault.db` sits at its root. */
  readonly dir: string;
  /** The content-addressed cache entry the copy came from. */
  readonly cacheDir: string;
  readonly cacheHit: boolean;
  readonly buildMs: number;
  /** What MOUNTING cost — the copy, not the build. */
  readonly mountMs: number;
  readonly bytes: number;
  readonly profile: Year3VaultProfile;
  readonly sealKey: Buffer;
  /**
   * The other four mounted vaults of the declared five-vault footprint
   * (`YEAR3_DISTRIBUTIONS.mountedVaults`). ONE FILE per vault (#916), so the
   * footprint is five directories; the companions carry bootstrap rows only,
   * which is all a reservation-pragma measurement can honestly use.
   */
  readonly companionDirs: readonly string[];
}

function sealCellWith(db: VaultDb) {
  return (entity: string, column: string, rowId: string, plaintext: string) =>
    sealValue(
      db.sealKey,
      sealAad(entity.replace(".", "_"), column, rowId),
      plaintext
    );
}

/** One of the four vaults beside the golden one, bootstrapped and checkpointed. */
function bootstrapCompanionVault(root: string, index: number): void {
  const companion = openVaultDb({
    dir: path.join(root, "companions", `vault-${index}`),
    sealKey: GOLDEN_YEAR3_SEAL_KEY,
  });
  try {
    bootstrapVault(companion, { ownerName: `${GOLDEN_YEAR3_OWNER} ${index}` });
    companion.vault.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    companion.close();
  }
}

const GOLDEN_YEAR3_COMPANIONS = YEAR3_DISTRIBUTIONS.mountedVaults - 1;

/**
 * BUILD the golden year-3 vault: after this the artifact exists in the
 * content-addressed cache. Nothing is copied and nothing is opened.
 *
 * The cache is content-addressed on the profile, the fixture version and the
 * schema ladder length, so a migration rung or a distribution change rebuilds
 * it and nothing else does. Building is separated from mounting because they
 * have different costs and different frequencies: one build per run at most —
 * the kit's warm set holds it — against one mount per rig that needs to write.
 * A caller that only needs to KNOW the artifact exists (the golden replica,
 * whose own cache may already hold the answer) must not pay a mount to find
 * out.
 */
export async function buildGoldenYear3Vault(): Promise<GoldenYear3Build> {
  const profile = goldenYear3Profile();
  const startedBuild = performance.now();
  const materialized = await materializeYear3Fixture(
    year3FixtureCacheRoot(),
    async (target) => {
      const seeded = openVaultDb({
        dir: target,
        sealKey: GOLDEN_YEAR3_SEAL_KEY,
      });
      try {
        bootstrapVault(seeded, { ownerName: GOLDEN_YEAR3_OWNER });
        seedYear3Vault(
          { vault: seeded.vault, sealCell: sealCellWith(seeded) },
          profile
        );
      } finally {
        seeded.close();
      }
      for (let index = 1; index <= GOLDEN_YEAR3_COMPANIONS; index += 1) {
        bootstrapCompanionVault(target, index);
      }
    },
    profile,
    VAULT_MIGRATIONS.length
  );
  return {
    cacheDir: materialized.dir,
    cacheHit: materialized.cacheHit,
    buildMs: performance.now() - startedBuild,
    profile,
    sealKey: GOLDEN_YEAR3_SEAL_KEY,
  };
}

/** MOUNT a built artifact: a private, writable copy the caller may open. */
export async function mountGoldenYear3Vault(
  build: GoldenYear3Build
): Promise<GoldenYear3Vault> {
  const startedMount = performance.now();
  const dir = await tempDir("golden-year3-vault-");
  await cp(build.cacheDir, dir, { recursive: true });
  return {
    dir,
    cacheDir: build.cacheDir,
    cacheHit: build.cacheHit,
    buildMs: build.buildMs,
    mountMs: performance.now() - startedMount,
    bytes: (await stat(path.join(dir, "vault.db"))).size,
    profile: build.profile,
    sealKey: build.sealKey,
    companionDirs: Array.from(
      { length: GOLDEN_YEAR3_COMPANIONS },
      (_value, index) => path.join(dir, "companions", `vault-${index + 1}`)
    ),
  };
}

/** Build if needed, then mount — what a rig that opens the vault wants. */
export async function goldenYear3Vault(): Promise<GoldenYear3Vault> {
  return mountGoldenYear3Vault(await buildGoldenYear3Vault());
}

export interface GoldenYear3Replica {
  /** Directory holding `seat.db`. */
  readonly dir: string;
  readonly file: string;
  readonly cacheDir: string;
  readonly cacheHit: boolean;
  readonly buildMs: number;
  readonly bytes: number;
  /** Tables the seat holds — the gateway's, minus the private list. */
  readonly tables: number;
  readonly pendingIntents: number;
  /** Where the seat's applied cursor stands after the snapshot and the tail. */
  readonly cursor: number;
  readonly snapshotSeq: number;
  readonly tailRows: number;
}

/**
 * What the built seat file knows about itself, written beside `seat.db`.
 *
 * Without it a warm run has to mount the golden vault to rediscover facts
 * about an artifact it already has on disk — which is most of what building
 * one costs. Part of the artifact's shape, so `YEAR3_FIXTURE_VERSION` covers
 * it.
 */
type GoldenReplicaMeta = Year3SeatFacts;

/**
 * Write the golden SEAT FILE into `target` (#996 wave 2).
 *
 * Built through the REAL path and nothing else, and the path is now the seat's
 * (R1, R4): `buildSeatSnapshot` produces the gateway's sanitised copy,
 * `bootstrapSeatFile` stages and installs it exactly as a phone does,
 * `applySeatLogPage` applies a tail of REAL commits made on the gateway after
 * the snapshot, and the seat's own outbox queues the intents.
 *
 * THE TAIL IS NOT DECORATION. A snapshot alone proves the copy; only a tail
 * applied on top proves the log, and the converge journey this artifact feeds
 * is about the log.
 */
async function buildGoldenReplicaInto(
  target: string,
  pendingIntents: number
): Promise<void> {
  const vault = await goldenYear3Vault();
  const source = openVaultDb({ dir: vault.dir, sealKey: vault.sealKey });
  const seatFile = path.join(target, "seat.db");
  let driver: NodeSeatDriver | undefined;
  try {
    const vaultId = (
      source.vault.prepare("SELECT vault_id FROM core_vault LIMIT 1").get() as {
        vault_id: string;
      }
    ).vault_id;
    const facts = await buildYear3SeatReplica(
      {
        snapshot: (destination) => {
          const built = buildSeatSnapshot(source.vault, destination);
          return {
            path: built.path,
            seq: built.seq,
            epoch: built.epoch,
            schemaEpoch: built.schemaEpoch,
            bytes: built.bytes,
          };
        },
        // THE COMMITS THE SEAT TAILS. Written through the gateway's own
        // capture, one commit each, so the log rows are the log rows a device
        // would have received — not rows this fixture composed.
        tail: (since) => {
          for (const statement of [
            `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
               VALUES ('year3-seat-tail', 'urn:year3-seat-tail', 'Seat tail', '1')`,
            `UPDATE core_concept_scheme SET title = 'Seat tail, renamed'
               WHERE scheme_id = 'year3-seat-tail'`,
          ]) {
            source.vault.exec("BEGIN IMMEDIATE");
            const handle = beginReplicaCommit(source.vault);
            source.vault.exec(statement);
            endReplicaCommit(source.vault, handle);
            source.vault.exec("COMMIT");
          }
          const state = currentReplicaLogState(source.vault);
          const page = readReplicaLog(source.vault, {
            since: { epoch: state.epoch, seq: since },
            limit: 10_000,
          });
          return {
            rows: page.rows.map((row) => seatLogRowWire(row)),
            watermark: page.watermark.seq,
          };
        },
        install: async (snapshot) => {
          const compressed = gzipSync(readFileSync(snapshot.path), {
            level: 6,
          });
          await bootstrapSeatFile({
            transport: staticSeatSnapshotTransport(compressed, snapshot),
            staging: nodeSeatStaging({
              directory: path.join(target, "staging"),
              databasePath: seatFile,
            }),
            vaultId,
            open: () => {
              driver = new NodeSeatDriver(seatFile);
              return driver;
            },
          });
          const held = driver!;
          createSeatOutbox(held);
          return {
            apply: (page) =>
              applySeatLogPage(held, {
                vaultId,
                epoch: snapshot.epoch,
                schemaEpoch: snapshot.schemaEpoch,
                ddlVersion: 0,
                floor: 0,
                watermark: page.watermark,
                next: page.watermark,
                hasMore: false,
                rows: page.rows as SeatLogRowWire[],
              }).applied,
            queue: (intent) => {
              addSeatOutboxIntent(held, {
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
            cursor: () => readSeatState(held).appliedSeq,
            close: () => {
              held.exec("PRAGMA wal_checkpoint(TRUNCATE)");
              held.close();
              driver = undefined;
            },
          };
        },
      },
      path.join(target, "snapshot.db"),
      {
        pendingIntents,
        seed: vault.profile.seed,
        hashPayload: (payload) => intentPayloadHash(payload as never),
      }
    );
    await rm(path.join(target, "snapshot.db"), { force: true });
    await rm(path.join(target, "staging"), { recursive: true, force: true });
    await writeFile(
      path.join(target, "meta.json"),
      `${JSON.stringify(facts)}\n`,
      "utf8"
    );
  } finally {
    driver?.close();
    source.close();
  }
}

/**
 * The SQLite file a seat holds after bootstrapping the golden vault — the
 * gateway's whole sanitised file with a tail applied — plus `pendingIntents`
 * queued intents in its outbox: the converge journey's N (#927 journey table:
 * 1, 10, 40).
 *
 * The content address is computed BEFORE anything is opened — the replica's
 * key is the vault's key plus what makes this replica different from another
 * built off it, and both are functions of the profile alone. A warm run
 * therefore answers out of the cache without mounting the golden vault or
 * walking one row.
 */
export async function goldenYear3Replica(
  options: { pendingIntents?: number } = {}
): Promise<GoldenYear3Replica> {
  const pendingIntents = options.pendingIntents ?? 0;
  const profile = goldenYear3Profile();
  const replicaProfile: Year3VaultProfile = {
    ...profile,
    generatedAt: `replica:${year3ReplicaCacheKey(
      year3FixtureCacheKey(profile, VAULT_MIGRATIONS.length),
      pendingIntents
    )}`,
  };
  const started = performance.now();
  const materialized = await materializeYear3Fixture(
    year3FixtureCacheRoot(),
    (target) => buildGoldenReplicaInto(target, pendingIntents),
    replicaProfile,
    VAULT_MIGRATIONS.length
  );
  const file = path.join(materialized.dir, "seat.db");
  const meta = JSON.parse(
    await readFile(path.join(materialized.dir, "meta.json"), "utf8")
  ) as GoldenReplicaMeta;
  return {
    dir: materialized.dir,
    file,
    cacheDir: materialized.dir,
    cacheHit: materialized.cacheHit,
    buildMs: performance.now() - started,
    bytes: (await stat(file)).size,
    tables: meta.tables,
    pendingIntents,
    cursor: meta.cursor,
    snapshotSeq: meta.snapshotSeq,
    tailRows: meta.tailRows,
  };
}
