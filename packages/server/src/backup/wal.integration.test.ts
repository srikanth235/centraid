import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
// governance: allow-repo-hygiene file-size-limit (#408) one acceptance story sharing one fixture vocabulary — loop, PITR, multi-process break, offline drain, restore-verification, O(change)
import { existsSync, statSync, promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createSnapshot,
  openLocalBackupProvider,
  openManifest,
  SNAPSHOT_FORMAT_V2,
  validateKeyring,
} from "@centraid/backup";
import type { BackupProvider, ObjectStore } from "@centraid/backup";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  readBackupPolicy,
  KeyStore,
  sealKeyFileFor,
  updateBackupPolicy,
  verifyRestoredPair,
} from "@centraid/vault";
import type { WalShipper, WalShipperOptions } from "@centraid/vault";

import { ledgerDbFileIn } from "../engine/stores/ledger-db.test-fixtures.js";
import { HealthRegistry } from "../serve/health-registry.js";
import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import type { BackupConfig } from "./backup-config.js";
import { evaluateBackupHealth } from "./backup-health.js";
import { BackupService } from "./backup-service.js";
import type { BackupServiceOptions } from "./backup-service.js";
import { assembleSourceEntries } from "./backup-sources.js";
import type { BackupTargetState } from "./backup-state.js";

vi.setConfig({ testTimeout: 30_000 });

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const WAL_THRESHOLD = 8 * 1024;
const WAL_HEADER_BYTES = 32;
const WAL_FRAME_BYTES = 24 + 8 * 1024;

const cleanups: Array<() => Promise<void> | void> = [];
describe("wal", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });
  interface Fx {
    providerDir: string;
    backupDir: string;
    config: BackupConfig;
    plane: VaultPlane;
    vaultId: string;
    shipper: WalShipper;
    registry: VaultRegistry;
    health: HealthRegistry;
    service: BackupService;
    logs: string[];
  }

  function fixtureKeyring(f: Fx) {
    const bytes = new KeyStore(
      path.dirname(sealKeyFileFor(f.plane.dir))
    ).export("keyring.key");
    if (!bytes) throw new Error("fixture keyring missing");
    return validateKeyring(JSON.parse(bytes.toString("utf8")));
  }

  function stubRegistry(planes: VaultPlane[]): VaultRegistry {
    return {
      get: (vaultId: string) => planes.find((p) => p.boot.vaultId === vaultId),
      planesList: () => planes,
    } as unknown as VaultRegistry;
  }

  interface FxOptions {
    provider?: BackupProvider;
    now?: () => number;
    walShipper?: Partial<Omit<WalShipperOptions, "db" | "log">>;
    snapshot?: BackupServiceOptions["snapshot"];
  }

  async function fx(opts: FxOptions = {}): Promise<Fx> {
    const vaultDir = await tempDir("wal-e2e-vault");
    const providerDir = await tempDir("wal-e2e-provider");
    const backupDir = await tempDir("wal-e2e-backup");
    const plane = openVaultPlane({
      bootstrap: true,
      dir: vaultDir,
      logger: silentLogger,
      ownerName: "Priya",
      walShipper: {
        walSizeThresholdBytes: WAL_THRESHOLD,
        ...(opts.now ? { now: opts.now } : {}),
        ...opts.walShipper,
      },
    });
    updateBackupPolicy(plane.db.vault, {
      snapshotIntervalHours: 1,
      verifyEveryDays: 1,
    });
    cleanups.push(() => plane.stop());
    plane.db.vault.exec(
      "CREATE TABLE _wale2e_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)"
    );
    plane.db.audit.exec(
      "CREATE TABLE _wale2e_jprobe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)"
    );
    const config: BackupConfig = {
      enabled: true,
      provider: { kind: "local", dir: providerDir },
    };
    const logs: string[] = [];
    const logger = {
      info: (m: string) => void logs.push(m),
      warn: (m: string) => void logs.push(m),
      error: (m: string) => void logs.push(m),
    };
    const registry = stubRegistry([plane]);
    const health = new HealthRegistry();
    const service = new BackupService({
      config,
      cacheDir: backupDir,
      vaults: registry,
      health,
      logger,
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.snapshot ? { snapshot: opts.snapshot } : {}),
    });
    return {
      providerDir,
      backupDir,
      config,
      plane,
      vaultId: plane.boot.vaultId,
      shipper: plane.walShipper!,
      registry,
      health,
      service,
      logs,
    };
  }

  function invoke(
    plane: VaultPlane,
    command: string,
    input: Record<string, unknown>
  ): Record<string, unknown> {
    const out = plane.gateway.invoke(plane.ownerCredential, { command, input });
    if (out.status !== "executed")
      throw new Error(`${command} failed: ${JSON.stringify(out)}`);
    return (out as { output: Record<string, unknown> }).output;
  }

  function insertVault(
    plane: VaultPlane,
    rows: number,
    size: number,
    marker: string
  ): number {
    const payload = `${marker}-${"x".repeat(size)}`;
    plane.db.vault.exec("BEGIN");
    const stmt = plane.db.vault.prepare(
      "INSERT INTO _wale2e_probe (v) VALUES (?)"
    );
    for (let i = 0; i < rows; i++) stmt.run(`${i}-${payload}`);
    plane.db.vault.exec("COMMIT");
    return rows * (payload.length + 8);
  }

  function walSize(plane: VaultPlane): number {
    const p = path.join(plane.dir, "vault.db-wal");
    return existsSync(p) ? statSync(p).size : 0;
  }

  function vaultTitles(db: DatabaseSync): string[] {
    return (
      db.prepare("SELECT title FROM schedule_task ORDER BY title").all() as {
        title: string;
      }[]
    ).map((r) => r.title);
  }

  function probeCount(db: DatabaseSync, table: string): number {
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
  }

  function receiptCount(db: DatabaseSync): number {
    return (
      db.prepare("SELECT COUNT(*) AS n FROM access_receipt").get() as {
        n: number;
      }
    ).n;
  }

  function openRestored(destDir: string): DatabaseSync {
    const db = new DatabaseSync(path.join(destDir, "vault.db"), {
      readOnly: true,
    });
    cleanups.push(() => db.close());
    return db;
  }

  async function restoreTo(
    f: Fx,
    opts: { pointInTimeMs?: number } = {}
  ): Promise<string> {
    const dest = path.join(await tempDir("wal-e2e-dest"), "restored");
    await f.service.restore({ vaultId: f.vaultId, destDir: dest, ...opts });
    return dest;
  }

  async function walObjectFiles(f: Fx, targetId: string): Promise<string[]> {
    const root = path.join(f.providerDir, "objects", targetId, "backup", "wal");
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const walkNextEntry = async (index: number): Promise<void> => {
        const entry = entries[index];
        if (!entry) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else out.push(full);
        return walkNextEntry(index + 1);
      };
      await walkNextEntry(0);
    };
    await walk(root);
    return out.sort();
  }

  function drainedBytes(
    logs: string[],
    from = 0
  ): { objects: number; bytes: number } {
    let objects = 0;
    let bytes = 0;
    for (const line of logs.slice(from)) {
      const m =
        /drained (?<objects>\d+) wal object\(s\), (?<bytes>\d+) sealed byte\(s\)/u.exec(
          line
        );
      if (m) {
        objects += Math.trunc(Number(m[1]!));
        bytes += Math.trunc(Number(m[2]!));
      }
    }
    return { objects, bytes };
  }

  async function openNewestManifest(f: Fx): Promise<{
    entries: {
      path: string;
      kind: string;
      sha256?: string;
      walGeneration?: string;
      baseTickMs?: number;
      walTipTickMs?: number;
    }[];
  }> {
    const targetId = (await f.service.status())[f.vaultId]!.targetId;
    const provider = openLocalBackupProvider({ rootDir: f.providerDir });
    const keyring = fixtureKeyring(f);
    const row = (await provider.listSnapshots(targetId))[0]!;
    const store = await provider.openDataPlane(targetId, "backup", "read");
    return openManifest(
      await store.get(row.manifestKey),
      keyring,
      f.vaultId,
      row.manifestHash
    );
  }

  test("continuous loop: post-manifest writes survive a restore via segments alone (no new manifest)", async () => {
    const f = await fx();
    invoke(f.plane, "schedule.add_task", { title: "Frame the print" });
    insertVault(f.plane, 40, 200, "pre-manifest");

    await f.service.runBackup(f.vaultId);
    const provider = openLocalBackupProvider({ rootDir: f.providerDir });
    const targetId = (await f.service.status())[f.vaultId]!.targetId;
    const rows = await provider.listSnapshots(targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.format).toBe(SNAPSHOT_FORMAT_V2);
    const manifest = await openNewestManifest(f);
    const dbEntries = manifest.entries.filter((e) => e.kind === "db");
    expect(dbEntries.map((e) => e.path)).toStrictEqual(["vault.db"]);
    expect(dbEntries[0]!.walGeneration).toMatch(/^[0-9a-f]{32}$/u);
    expect(dbEntries[0]!.sha256).toMatch(/^[0-9a-f]{64}$/u);

    invoke(f.plane, "schedule.add_task", {
      title: "Pay the invoice (post-manifest)",
    });
    insertVault(f.plane, 30, 200, "post-manifest");
    f.plane.walTick();
    await f.service.drainWal();

    await expect(provider.listSnapshots(targetId)).resolves.toHaveLength(1); // no new manifest
    expect((await walObjectFiles(f, targetId)).length).toBeGreaterThan(0); // segments went remote
    expect(f.shipper.listUploadable()).toHaveLength(0); // and the local copies drained

    const dest = await restoreTo(f);
    const rv = openRestored(dest);
    expect(vaultTitles(rv)).toStrictEqual(vaultTitles(f.plane.db.vault));
    expect(vaultTitles(rv)).toContain("Pay the invoice (post-manifest)");
    expect(probeCount(rv, "_wale2e_probe")).toBe(
      probeCount(f.plane.db.vault, "_wale2e_probe")
    );
    const report = verifyRestoredPair(dest);
    expect(report.vault.integrity).toBe("ok");
    expect(report.vault.foreignKeyViolations).toBe(0);
    expect(report.receiptsChecked).toBeGreaterThan(0);
    expect(report.danglingReceipts).toStrictEqual([]);
  }, 30_000);

  test("PITR through the service: each captured tick restores exactly that instant", async () => {
    const f = await fx();
    await f.service.runBackup(f.vaultId);

    interface Point {
      tickMs: number;
      titles: string[];
      probe: number;
      jprobe: number;
      receipts: number;
    }
    const points: Point[] = [];
    for (let i = 0; i < 3; i++) {
      invoke(f.plane, "schedule.add_task", { title: `pitr-task-${i}` });
      insertVault(f.plane, 10, 150, `pitr-${i}`);
      f.plane.db.audit
        .prepare("INSERT INTO _wale2e_jprobe (v) VALUES (?)")
        .run(`jrow-${i}-${"y".repeat(100)}`);
      const report = f.shipper.tick();
      expect(report.errors).toStrictEqual([]);
      points.push({
        tickMs: report.tickMs,
        titles: vaultTitles(f.plane.db.vault),
        probe: probeCount(f.plane.db.vault, "_wale2e_probe"),
        jprobe: probeCount(f.plane.db.audit, "_wale2e_jprobe"),
        receipts: receiptCount(f.plane.db.audit),
      });
    }
    await f.service.drainWal();

    expect(new Set(points.map((p) => p.titles.length)).size).toBe(3);

    await forEachSequentially(points, async (point) => {
      const dest = await restoreTo(f, { pointInTimeMs: point.tickMs });
      const rv = openRestored(dest);
      expect(vaultTitles(rv)).toStrictEqual(point.titles);
      expect(probeCount(rv, "_wale2e_probe")).toBe(point.probe);
      expect(probeCount(rv, "_wale2e_jprobe")).toBe(point.jprobe);
      expect(receiptCount(rv)).toBe(point.receipts);
    });
  }, 30_000);

  async function foreignVaultWriter(
    plane: VaultPlane,
    opts: { rows: number; marker: string; checkpoint: boolean }
  ): Promise<{ run: () => void }> {
    const scriptDir = await tempDir("wal-e2e-foreign");
    const script = path.join(scriptDir, "foreign-writer.mjs");
    await fs.writeFile(
      script,
      [
        "import { DatabaseSync } from 'node:sqlite';",
        "const db = new DatabaseSync(process.argv[2]);",
        "db.exec('PRAGMA busy_timeout = 10000');",
        ...(opts.checkpoint
          ? []
          : ["db.exec('PRAGMA wal_autocheckpoint = 0');"]),
        "db.exec('CREATE TABLE IF NOT EXISTS _wale2e_foreign (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');",
        "db.exec('BEGIN');",
        "const ins = db.prepare('INSERT INTO _wale2e_foreign (v) VALUES (?)');",
        `for (let i = 0; i < ${opts.rows}; i++) ins.run(${JSON.stringify(opts.marker)} + '-' + i + '-' + 'x'.repeat(64));`,
        "db.exec('COMMIT');",
        ...(opts.checkpoint
          ? ["db.exec('PRAGMA wal_checkpoint(RESTART)');"]
          : []),
        "db.close();",
      ].join("\n")
    );
    return {
      run: () => {
        const child = spawnSync(
          process.execPath,
          [script, ledgerDbFileIn(plane.dir)],
          {
            encoding: "utf8",
            timeout: 30_000,
          }
        );
        expect(child.status).toBe(0);
      },
    };
  }

  test("G5 multi-process: a real child process COMMITTING inside the capture→TRUNCATE window is detected, and its rows survive the restore", async () => {
    const f = await fx();
    invoke(f.plane, "schedule.add_task", { title: "before-the-race" });
    await f.service.runBackup(f.vaultId);
    await f.service.drainWal();
    const genBefore = f.shipper.status().stream!.generation;
    const seqBefore = (await f.service.status())[f.vaultId]!.lastSeq!;

    const writer = await foreignVaultWriter(f.plane, {
      rows: 200,
      marker: "raced",
      checkpoint: false,
    });
    const vault = f.plane.db.vault;
    const realPrepare = vault.prepare.bind(vault);
    let raced = 0;
    vault.prepare = ((sql: string) => {
      if (raced === 0 && sql.includes("wal_checkpoint(TRUNCATE)")) {
        raced += 1;
        writer.run();
      }
      return realPrepare(sql);
    }) as typeof vault.prepare;

    let report;
    try {
      report = f.shipper.checkpointNow();
    } finally {
      vault.prepare = realPrepare;
    }
    expect(raced).toBe(1);
    expect(report.errors).toStrictEqual([]);
    expect(probeCount(f.plane.db.vault, "_wale2e_foreign")).toBe(200);

    expect(report.breaks).toStrictEqual([
      { reason: "checkpoint-raced-writer" },
    ]);
    expect(f.shipper.status().stream!.generation).not.toBe(genBefore);
    expect(f.shipper.baseReady()).toBe(true);

    await f.service.runBackup(f.vaultId);
    expect((await f.service.status())[f.vaultId]!.lastSeq).toBe(seqBefore + 1);
    await f.service.drainWal();

    const dest = await restoreTo(f);
    const rv = openRestored(dest);
    expect(probeCount(rv, "_wale2e_foreign")).toBe(200);
    expect(vaultTitles(rv)).toContain("before-the-race");
    const restored = verifyRestoredPair(dest);
    expect(restored.vault.integrity).toBe("ok");
    expect(restored.danglingReceipts).toStrictEqual([]);
  }, 45_000);

  test("G5 multi-process: a real child process checkpointing vault.db breaks the generation, re-bases, and restores CORRECTLY", async () => {
    const f = await fx();
    invoke(f.plane, "schedule.add_task", { title: "before-foreign-writer" });
    await f.service.runBackup(f.vaultId);
    await f.service.drainWal();
    const genBefore = f.shipper.status().stream!.generation;
    const seqBefore = (await f.service.status())[f.vaultId]!.lastSeq!;

    const writer = await foreignVaultWriter(f.plane, {
      rows: 1500,
      marker: "foreign",
      checkpoint: true,
    });
    writer.run();

    const report = f.shipper.tick();
    expect(report.breaks).toHaveLength(1);
    expect(report.breaks[0]!.reason).toMatch(/without-our-checkpoint/u);
    const after = f.shipper.status().stream!;
    expect(after.generation).not.toBe(genBefore);
    expect(after.basePending).toBe(true);
    expect(f.shipper.baseReady()).toBe(true);

    await f.service.runBackup(f.vaultId);
    expect((await f.service.status())[f.vaultId]!.lastSeq).toBe(seqBefore + 1);

    const foreignTarget = (await f.service.status())[f.vaultId]!;
    expect(foreignTarget.walForeignCheckpointCount).toBeGreaterThanOrEqual(1);
    expect(foreignTarget.walLastForeignCheckpoint?.reason).toMatch(
      /without-our-checkpoint/u
    );
    const foreignSnap = await f.health.snapshot();
    const foreignBackups = foreignSnap.components.find(
      (c) => c.component === "backups"
    );
    expect(foreignBackups?.status).toBe("degraded");
    expect(foreignBackups?.detail).toMatch(/foreign checkpoint/u);
    const manifest = await openNewestManifest(f);
    const vaultEntry = manifest.entries.find(
      (e) => e.kind === "db" && e.path === "vault.db"
    )!;
    expect(vaultEntry.walGeneration).toBe(after.generation);
    expect(vaultEntry.baseTickMs).toBeGreaterThan(0);
    expect(f.shipper.status().stream!.basePending).toBe(false);
    await f.service.drainWal();

    const dest = await restoreTo(f);
    const rv = openRestored(dest);
    expect(probeCount(rv, "_wale2e_foreign")).toBe(1500);
    expect(vaultTitles(rv)).toContain("before-foreign-writer");
    const restored = verifyRestoredPair(dest);
    expect(restored.vault.integrity).toBe("ok");
    expect(restored.danglingReceipts).toStrictEqual([]);
  }, 45_000);

  function offlineProvider(): BackupProvider {
    const offline = <T>(): Promise<T> =>
      Promise.reject(new Error("offline: provider unreachable"));
    return {
      capabilities: () => offline(),
      createTarget: () => offline(),
      deleteTarget: () => offline(),
      undeleteTarget: () => offline(),
      purgeTarget: () => offline(),
      openDataPlane: () => offline(),
      registerSnapshot: () => offline(),
      listSnapshots: () => offline(),
      getSnapshot: () => offline(),
      getTarget: () => offline(),
      usage: () => offline(),
    };
  }

  test("offline: segments accumulate across groups, the WAL stays checkpoint-bounded, and everything drains on reconnect with NO generation break", async () => {
    const f = await fx({ provider: offlineProvider() });
    f.shipper.tick(); // first-run: mint the generation before going "offline"
    const gen0 = f.shipper.status().stream!.generation;

    const reports: ReturnType<typeof f.shipper.tick>[] = [];
    await forEachSequentially(Array.from({ length: 6 }), async (_, i) => {
      invoke(f.plane, "schedule.add_task", { title: `offline-task-${i}` });
      insertVault(f.plane, 30, 400, `offline-${i}`); // ~12KB > threshold ⇒ rollover
      reports.push(f.shipper.tick());
      expect(walSize(f.plane)).toBeLessThanOrEqual(2 * WAL_THRESHOLD);
      await f.service.drainWal(); // fails inside (offline), never throws, never deletes
    });
    expect(reports.flatMap((r) => r.breaks)).toStrictEqual([]);
    expect(reports.flatMap((r) => r.errors)).toStrictEqual([]);

    expect(Object.keys(await f.service.status())).toHaveLength(0);
    const local = f.shipper.listUploadable();
    const groups = new Set(
      local.filter((i) => i.kind === "segment").map((i) => i.addr!.group)
    );
    expect(groups.size).toBeGreaterThanOrEqual(3);
    expect(
      local.filter((i) => i.kind === "closer").length
    ).toBeGreaterThanOrEqual(3);

    const service2 = new BackupService({
      config: f.config,
      cacheDir: f.backupDir,
      vaults: f.registry,
      health: new HealthRegistry(),
      logger: silentLogger,
    });
    await service2.runBackup(f.vaultId);
    await service2.drainWal();
    expect(f.shipper.listUploadable()).toHaveLength(0); // local dir drained

    expect(f.shipper.status().stream!.generation).toBe(gen0);

    const dest = path.join(await tempDir("wal-e2e-dest"), "restored");
    await service2.restore({ vaultId: f.vaultId, destDir: dest });
    const rv = openRestored(dest);
    expect(vaultTitles(rv)).toStrictEqual(vaultTitles(f.plane.db.vault));
    expect(probeCount(rv, "_wale2e_probe")).toBe(
      probeCount(f.plane.db.vault, "_wale2e_probe")
    );
    expect(verifyRestoredPair(dest).danglingReceipts).toStrictEqual([]);
  }, 45_000);

  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  test("offline for multiple days: daily base rotations fire, the WAL and the local dir stay bounded, and reconnect loses nothing", async () => {
    let clock = Date.now();
    const LOCAL_BUDGET = 8 * 1024 * 1024;
    const f = await fx({
      provider: offlineProvider(),
      now: () => clock,
      walShipper: { baseIntervalMs: DAY_MS, localBudgetBytes: LOCAL_BUDGET },
    });
    f.shipper.tick(); // first run: mint the generations before the outage
    const gen0 = f.shipper.status().stream!.generation;

    const DAYS = 4;
    const TICKS_PER_DAY = 6; // one every four hours
    const reports: ReturnType<typeof f.shipper.tick>[] = [];
    const written: string[] = [];
    const perDay: { wal: number; local: number }[] = [];
    await forEachSequentially(Array.from({ length: DAYS }), async (_, day) => {
      let maxWal = 0;
      let maxLocal = 0;
      await forEachSequentially(
        Array.from({ length: TICKS_PER_DAY }),
        async (_Local, t) => {
          const title = `outage-d${day}-t${t}`;
          invoke(f.plane, "schedule.add_task", { title });
          written.push(title);
          insertVault(f.plane, 30, 400, title); // ~12 KB > threshold ⇒ a rollover every tick
          f.plane.db.audit
            .prepare("INSERT INTO _wale2e_jprobe (v) VALUES (?)")
            .run(`${title}-${"y".repeat(200)}`);
          clock += 4 * HOUR_MS;
          reports.push(f.shipper.tick());

          // (1) CHECKPOINT-BOUNDED: stage 1 is local disk, so checkpointing
          // never waits on the network. A day-boundary tick ends by writing the
          // break's consent receipt AFTER the base clone, so the WAL carries a
          // CONSTANT few frames until the next tick captures them.
          maxWal = Math.max(maxWal, walSize(f.plane));
          // (2) The budget holds WITHOUT firing: each daily roll drops the
          // superseded generation's segments, so the footprint tracks ONE day.
          maxLocal = Math.max(maxLocal, f.shipper.status().localBytes);
          expect(f.shipper.status().localBytes).toBeLessThanOrEqual(
            LOCAL_BUDGET
          );
          await f.service.drainWal(); // fails inside (offline): never throws, never deletes
        }
      );
      perDay.push({ wal: maxWal, local: maxLocal });
    });
    expect(reports.flatMap((r) => r.errors)).toStrictEqual([]);

    // Neither GROWS WITH THE OUTAGE — the whole claim. A shipper that only
    // checkpointed when reachable would show both climbing monotonically.
    expect(perDay).toHaveLength(DAYS);
    const day0 = perDay[0]!;
    console.log(
      `[wal-e2e multi-day outage] per-day max WAL / local-segment bytes: ` +
        perDay.map((d) => `${d.wal}/${d.local}`).join("  ")
    );
    expect(day0.wal).toBeGreaterThan(0); // the measurement is live, not a no-op
    expect(day0.local).toBeGreaterThan(0);
    for (const day of perDay) {
      expect(day.wal).toBeLessThanOrEqual(
        WAL_HEADER_BYTES + 12 * WAL_FRAME_BYTES
      );
      expect(day.wal).toBeLessThanOrEqual(day0.wal * 2);
      expect(day.local).toBeLessThanOrEqual(day0.local * 2);
    }

    // The last tick above was a day-boundary roll, leaving the fresh generation
    // at offset 0; these two make what reconnect drains partially filled.
    const TAIL_TICKS = 2;
    await forEachSequentially(
      Array.from({ length: TAIL_TICKS }),
      async (_, t) => {
        const title = `outage-tail-${t}`;
        invoke(f.plane, "schedule.add_task", { title });
        written.push(title);
        insertVault(f.plane, 30, 400, title);
        f.plane.db.audit
          .prepare("INSERT INTO _wale2e_jprobe (v) VALUES (?)")
          .run(`${title}-${"y".repeat(200)}`);
        clock += 4 * HOUR_MS;
        reports.push(f.shipper.tick());
        expect(walSize(f.plane)).toBeLessThanOrEqual(2 * WAL_THRESHOLD);
        await f.service.drainWal();
      }
    );

    const breaks = reports.flatMap((r) => r.breaks);
    const cadence = breaks.filter((b) => /base-cadence/u.test(b.reason));
    const vaultRolls = cadence.length;
    expect(vaultRolls).toBeGreaterThanOrEqual(DAYS - 1); // one per day-boundary crossed
    expect(vaultRolls).toBeLessThanOrEqual(DAYS);
    expect(breaks).toHaveLength(cadence.length); // no local-budget, no detector break
    expect(f.shipper.status().stream!.generation).not.toBe(gen0);
    expect(f.shipper.baseReady()).toBe(true);

    expect(Object.keys(await f.service.status())).toHaveLength(0);
    expect(f.shipper.listUploadable().length).toBeGreaterThan(0);
    expect(f.shipper.status().stream!.basePending).toBe(true);

    const service2 = new BackupService({
      config: f.config,
      cacheDir: f.backupDir,
      vaults: f.registry,
      health: new HealthRegistry(),
      logger: silentLogger,
      now: () => clock,
    });
    cleanups.push(() => service2.stop());
    await service2.runBackup(f.vaultId);
    await service2.drainWal();

    expect(f.shipper.listUploadable()).toHaveLength(0);
    expect(f.shipper.status().stream!.basePending).toBe(false);

    // (6) Zero data loss. PITR *depth* into the outage is the documented trade
    // — each daily roll drops the never-registered predecessor's segments — but
    // the roll's fresh base clone carries every row.
    const dest = path.join(await tempDir("wal-e2e-dest"), "restored");
    await service2.restore({ vaultId: f.vaultId, destDir: dest });
    const rv = openRestored(dest);
    const titles = vaultTitles(rv);
    for (const title of written) expect(titles).toContain(title);
    expect(titles).toStrictEqual(vaultTitles(f.plane.db.vault));
    expect(probeCount(rv, "_wale2e_probe")).toBe(
      probeCount(f.plane.db.vault, "_wale2e_probe")
    );
    expect(probeCount(rv, "_wale2e_jprobe")).toBe(
      DAYS * TICKS_PER_DAY + TAIL_TICKS
    );
    const restored = verifyRestoredPair(dest);
    expect(restored.vault.integrity).toBe("ok");
    expect(restored.danglingReceipts).toStrictEqual([]);
    await service2.runRestoreVerify(f.vaultId); // and the G9 job agrees
  }, 120_000);

  /** ROWS, not file bytes: a restored database's bytes are never identical to
   *  the live one's, so only rows can answer "did PITR reproduce this state". */
  function contentDigest(vault: DatabaseSync): string {
    const col = (db: DatabaseSync, sql: string): string[] =>
      (db.prepare(sql).all() as Record<string, unknown>[]).map((r) =>
        String(Object.values(r)[0])
      );
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          tasks: col(vault, "SELECT title FROM schedule_task ORDER BY title"),
          probe: col(vault, "SELECT v FROM _wale2e_probe ORDER BY id"),
          jprobe: col(vault, "SELECT v FROM _wale2e_jprobe ORDER BY id"),
          receipts: col(
            vault,
            "SELECT receipt_id FROM access_receipt ORDER BY receipt_id"
          ),
        })
      )
      .digest("hex");
  }

  test("PITR at an ARBITRARY instant between two capture ticks restores the recorded content digest EXACTLY", async () => {
    let clock = Date.now();
    const f = await fx({ now: () => clock });
    await f.service.runBackup(f.vaultId);

    const points: { tickMs: number; digest: string; rows: number }[] = [];
    for (let i = 0; i < 8; i++) {
      invoke(f.plane, "schedule.add_task", { title: `pitr-arb-${i}` });
      insertVault(f.plane, 12, 220, `arb-${i}`);
      f.plane.db.audit
        .prepare("INSERT INTO _wale2e_jprobe (v) VALUES (?)")
        .run(`arb-${i}-${"y".repeat(160)}`);
      clock += 10 * 60 * 1000; // ten minutes between ticks — room for an arbitrary instant
      const report = f.shipper.tick();
      expect(report.errors).toStrictEqual([]);
      expect(report.breaks).toStrictEqual([]); // a break would write a receipt and move the digest
      // Taken before the next round's writes, so the live database IS the
      // restore point this tick captured.
      points.push({
        tickMs: report.tickMs,
        digest: contentDigest(f.plane.db.vault),
        rows: probeCount(f.plane.db.vault, "_wale2e_probe"),
      });
    }
    await f.service.drainWal();

    expect(new Set(points.map((p) => p.digest)).size).toBe(points.length);

    const ticks = new Set(points.map((p) => p.tickMs));
    await forEachSequentially([2, 4, 6], async (i) => {
      const at = points[i]!;
      const next = points[i + 1]!;
      const t = at.tickMs + Math.floor((next.tickMs - at.tickMs) * 0.37);
      expect(ticks.has(t)).toBe(false);
      expect(t).toBeGreaterThan(at.tickMs);
      expect(t).toBeLessThan(next.tickMs);

      const dest = await restoreTo(f, { pointInTimeMs: t });
      const rv = openRestored(dest);
      expect(contentDigest(rv)).toBe(at.digest);
      // The newest restore point at or before `t`, and NOT the rows committed
      // after it (they exist, and they are excluded).
      expect(probeCount(rv, "_wale2e_probe")).toBe(at.rows);
      expect(next.rows).toBeGreaterThan(at.rows);
      expect(contentDigest(rv)).not.toBe(next.digest);
      expect(verifyRestoredPair(dest).danglingReceipts).toStrictEqual([]);
    });

    // An instant BEFORE the first tick is the floor of the ladder, not an error.
    const early = await restoreTo(f, { pointInTimeMs: points[0]!.tickMs - 1 });
    expect(verifyRestoredPair(early).vault.integrity).toBe("ok");
    expect(contentDigest(openRestored(early))).not.toBe(points[0]!.digest);
  }, 60_000);

  async function anchoredGenerations(f: Fx): Promise<Set<string>> {
    const targetId = (await f.service.status())[f.vaultId]?.targetId;
    if (!targetId) return new Set();
    const provider = openLocalBackupProvider({ rootDir: f.providerDir });
    const keyring = fixtureKeyring(f);
    const store = await provider.openDataPlane(targetId, "backup", "read");
    const out = new Set<string>();
    const rows = await provider.listSnapshots(targetId);
    await forEachSequentially(rows, async (row) => {
      const opened = openManifest(
        await store.get(row.manifestKey),
        keyring,
        f.vaultId,
        row.manifestHash
      );
      for (const entry of opened.entries) {
        if (entry.walGeneration !== undefined) out.add(entry.walGeneration);
      }
    });
    return out;
  }

  test("a run that registers NOTHING must not mark the base registered — no manifest, no anchor", async () => {
    let registerNothing = false;
    const f = await fx({
      snapshot: async (o) => (registerNothing ? null : createSnapshot(o)),
    });
    invoke(f.plane, "schedule.add_task", { title: "anchored" });
    await f.service.runBackup(f.vaultId);
    const gen0 = f.shipper.status().stream!.generation;
    await expect(anchoredGenerations(f)).resolves.toContain(gen0);
    expect(f.shipper.pendingBase()).toBeNull(); // a manifest names it — correctly cleared

    insertVault(f.plane, 20, 200, "post-roll");
    f.shipper.rollGeneration("test-roll");
    const gen1 = f.shipper.status().stream!.generation;
    expect(gen1).not.toBe(gen0);
    expect(f.shipper.pendingBase()).not.toBeNull();

    registerNothing = true;
    await f.service.runBackup(f.vaultId);

    const anchored = await anchoredGenerations(f);
    expect(anchored.has(gen1)).toBe(false);
    expect(f.shipper.status().stream!.basePending).toBe(true);
    expect(f.shipper.pendingBase()?.generation).toBe(gen1);
    expect(f.logs.some((l) => /no manifest anchors/u.test(l))).toBe(true);

    // The retry heals it the moment a manifest names the base, and only then.
    registerNothing = false;
    await f.service.runBackup(f.vaultId);
    const healed = await anchoredGenerations(f);
    expect(healed.has(gen1)).toBe(true);
    expect(f.shipper.pendingBase()).toBeNull();

    await f.service.drainWal();
    const dest = await restoreTo(f);
    const rv = openRestored(dest);
    expect(vaultTitles(rv)).toContain("anchored");
    expect(probeCount(rv, "_wale2e_probe")).toBe(
      probeCount(f.plane.db.vault, "_wale2e_probe")
    );
    expect(verifyRestoredPair(dest).danglingReceipts).toStrictEqual([]);
  }, 45_000);

  test("a no-change run whose PREVIOUS manifest still anchors the live base DOES clear it (no pending livelock)", async () => {
    let registerNothing = false;
    const f = await fx({
      snapshot: async (o) => (registerNothing ? null : createSnapshot(o)),
    });
    invoke(f.plane, "schedule.add_task", { title: "anchored-then-forgotten" });
    await f.service.runBackup(f.vaultId);
    const target = (await f.service.status())[f.vaultId]!;

    // A manifest registered OUT OF BAND leaves the shipper's flag PENDING while
    // the provider holds a good anchor — the on-disk state a crash between
    // `registerSnapshot` and the shipper's state write leaves behind.
    insertVault(f.plane, 20, 200, "pre-crash");
    f.shipper.rollGeneration("test-roll");
    const gen = f.shipper.status().stream!.generation;
    const provider = openLocalBackupProvider({ rootDir: f.providerDir });
    const keyring = fixtureKeyring(f);
    const entries = await assembleSourceEntries({
      plane: f.plane,
      bundleDir: await tempDir("wal-e2e-oob-bundle"),
      log: {},
    });
    await createSnapshot({
      provider,
      targetId: target.targetId,
      keyring,
      vaultId: f.vaultId,
      entries,
      generation: target.generation,
      appMeta: {
        gatewayVersion: "0.0.0",
        vaultUserVersion: "1",
        ontologyVersion: "1.2",
      },
    });
    const anchored = await anchoredGenerations(f);
    expect(anchored.has(gen)).toBe(true); // the provider HAS the anchor…
    expect(f.shipper.pendingBase()).not.toBeNull(); // …the shipper doesn't know

    // A run registering nothing must still clear the flag: the anchor exists.
    registerNothing = true;
    await f.service.runBackup(f.vaultId);
    expect(f.shipper.status().stream!.basePending).toBe(false);
    expect(f.shipper.pendingBase()).toBeNull();
  }, 45_000);

  test("G9 restore-verify: succeeds against a real snapshot+segments, THROWS loudly on a damaged remote segment, and stales at 14 days", async () => {
    const f = await fx();
    invoke(f.plane, "schedule.add_task", { title: "verify-me" });
    await f.service.runBackup(f.vaultId);
    insertVault(f.plane, 20, 300, "post-base");
    f.plane.walTick();
    await f.service.drainWal();

    const beforeVerifyMs = Date.now();
    await f.service.runRestoreVerify(f.vaultId);
    const state = (await f.service.status())[f.vaultId]!;
    expect(state.lastRestoreVerifiedAt).toBeTruthy();
    // A lower bound, not a wall-clock window (TESTING.md: no real-time races).
    expect(Date.parse(state.lastRestoreVerifiedAt!)).toBeGreaterThanOrEqual(
      beforeVerifyMs - 1000
    );

    const segments = (await walObjectFiles(f, state.targetId)).filter((file) =>
      /^\d{12}-\d{12}-\d{13}$/u.test(path.basename(file))
    );
    expect(segments.length).toBeGreaterThan(0);
    const victim = segments[segments.length - 1]!;
    const original = await fs.readFile(victim);
    const flipped = Buffer.from(original);
    flipped[Math.floor(flipped.length / 2)]! ^= 0xff;
    await fs.writeFile(victim, flipped);

    await expect(f.service.runRestoreVerify(f.vaultId)).rejects.toThrow(
      /damaged wal object/u
    );
    expect(
      (await f.service.status())[f.vaultId]!.lastRestoreVerifyError
    ).toMatch(/damaged wal object/u);
    // The probe recomputes from persisted state and its status wins.
    const snap = await f.health.snapshot();
    const backups = snap.components.find((c) => c.component === "backups");
    expect(backups?.status).toBe("error");
    expect(backups?.detail).toMatch(/restore-verification failed/u);
    expect(backups?.lastError).toMatch(/restore-verify failed/u);

    await fs.writeFile(victim, original);
    await f.service.runRestoreVerify(f.vaultId);
    expect(
      (await f.service.status())[f.vaultId]!.lastRestoreVerifyError
    ).toBeUndefined();
    const healed = await f.health.snapshot();
    expect(
      healed.components.find((c) => c.component === "backups")?.status
    ).toBe("ok");

    // 15 days without a successful restore-verification is an ERROR.
    const now = Date.now();
    const iso = (agoMs: number): string => new Date(now - agoMs).toISOString();
    const health = evaluateBackupHealth({
      state: {
        targets: {
          [f.vaultId]: {
            targetId: state.targetId,
            label: state.label,
            generation: 1,
            lastSeq: 1,
            lastBackupAt: iso(30 * 60 * 1000),
            lastVerifiedAt: iso(30 * 60 * 1000),
            lastRestoreVerifiedAt: iso(15 * 24 * 60 * 60 * 1000),
          },
        },
        casReconciliations: {},
        sourceInstanceId: "test",
      },
      policyForVault: () => readBackupPolicy(f.plane.db.vault),
      now,
    });
    expect(health.status).toBe("error");
    expect(health.detail).toMatch(/restore-verification/u);
  }, 45_000);

  test("G8/G9 restore-verify: dangling receipts leave health DEGRADED, and the probe KEEPS it degraded", async () => {
    const f = await fx();
    invoke(f.plane, "schedule.add_task", { title: "receipted" });
    await f.service.runBackup(f.vaultId);

    // Only the ORDER of health pushes exposes a reportDegraded immediately
    // overwritten by a reportOk. The three methods have different signatures, so
    // one shared generic wrapper cannot be typed against all three.
    const pushed: string[] = [];
    const baseOk = f.health.reportOk.bind(f.health);
    const baseDegraded = f.health.reportDegraded.bind(f.health);
    const baseError = f.health.reportError.bind(f.health);
    f.health.reportOk = (component, detail) => {
      if (component === "backups") pushed.push("ok");
      baseOk(component, detail);
    };
    f.health.reportDegraded = (component, detail) => {
      if (component === "backups") pushed.push("degraded");
      baseDegraded(component, detail);
    };
    f.health.reportError = (component, message) => {
      if (component === "backups") pushed.push("error");
      baseError(component, message);
    };

    await f.service.runRestoreVerify(f.vaultId);
    expect(pushed).toStrictEqual(["ok"]);
    expect(
      (await f.service.status())[f.vaultId]!.lastRestoreVerifyDangling
    ).toBeUndefined();
    expect(
      (await f.health.snapshot()).components.find(
        (c) => c.component === "backups"
      )?.status
    ).toBe("ok");

    // The app-uninstall shape: the command row goes, its receipts stay. The
    // restore then carries a receipt pointing at nothing — a signal for
    // human review, NOT a failed restore.
    const { object_id: commandId } = f.plane.db.audit
      .prepare(
        `SELECT object_id FROM access_receipt
        WHERE object_type = 'agent.command' AND object_id IS NOT NULL AND decision = 'allow'
        LIMIT 1`
      )
      .get() as { object_id: string };
    f.plane.db.vault
      .prepare("DELETE FROM agent_capability WHERE command_id = ?")
      .run(commandId);
    f.plane.db.vault
      .prepare("DELETE FROM agent_command WHERE command_id = ?")
      .run(commandId);
    f.plane.walTick();
    await f.service.drainWal();

    await f.service.runRestoreVerify(f.vaultId); // must NOT throw
    expect(pushed).toStrictEqual(["ok", "degraded"]);

    const state = (await f.service.status())[f.vaultId]!;
    expect(state.lastRestoreVerifiedAt).toBeTruthy(); // the restore itself succeeded
    expect(state.lastRestoreVerifyError).toBeUndefined();
    expect(state.lastRestoreVerifyDangling).toBeGreaterThan(0); // …and it is PERSISTED

    // Without persistence this snapshot flips back to green.
    const snap = await f.health.snapshot();
    const backups = snap.components.find((c) => c.component === "backups");
    expect(backups?.status).toBe("degraded");
    expect(backups?.detail).toMatch(
      /receipt\(s\) referencing absent vault rows/u
    );

    // The count alone is what degrades, and its absence is what clears.
    const now = Date.now();
    const iso = (agoMs: number): string => new Date(now - agoMs).toISOString();
    const target: BackupTargetState = {
      targetId: state.targetId,
      label: state.label,
      generation: 1,
      lastSeq: 1,
      lastBackupAt: iso(30 * 60 * 1000),
      // Keeps the RPO signal healthy so this isolates the dangling verdict.
      lastWalDrainAt: iso(30 * 1000),
      lastVerifiedAt: iso(30 * 60 * 1000),
      lastRestoreVerifiedAt: iso(30 * 60 * 1000),
    };
    const evaluate = (
      t: BackupTargetState
    ): ReturnType<typeof evaluateBackupHealth> =>
      evaluateBackupHealth({
        state: {
          targets: { [f.vaultId]: t },
          casReconciliations: {},
          sourceInstanceId: "test",
        },
        policyForVault: () => readBackupPolicy(f.plane.db.vault),
        now,
      });
    expect(evaluate({ ...target, lastRestoreVerifyDangling: 3 }).status).toBe(
      "degraded"
    );
    expect(evaluate(target).status).toBe("ok");
  }, 45_000);

  test("with a SECOND connection appending between gateway writes, every PITR point restores with ZERO dangling receipts", async () => {
    const f = await fx();
    await f.service.runBackup(f.vaultId);

    // The tolerated multi-writer case: own connection, no autocheckpoint.
    const second = new DatabaseSync(ledgerDbFileIn(f.plane.dir));
    cleanups.push(() => second.close());
    second.exec("PRAGMA busy_timeout = 10000");
    second.exec("PRAGMA wal_autocheckpoint = 0");
    second.exec(
      "CREATE TABLE IF NOT EXISTS _wale2e_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)"
    );
    const append = second.prepare("INSERT INTO _wale2e_ledger (v) VALUES (?)");

    const points: { tickMs: number; ledger: number; titles: string[] }[] = [];
    for (let i = 0; i < 6; i++) {
      append.run(`pre-${i}-${"z".repeat(120)}`);
      invoke(f.plane, "schedule.add_task", { title: `g8-task-${i}` }); // life row + its receipt
      append.run(`post-${i}-${"z".repeat(120)}`);
      const report = f.shipper.tick();
      expect(report.breaks).toStrictEqual([]);
      expect(report.errors).toStrictEqual([]);
      points.push({
        tickMs: report.tickMs,
        ledger: probeCount(f.plane.db.audit, "_wale2e_ledger"),
        titles: vaultTitles(f.plane.db.vault),
      });
    }
    await f.service.drainWal();

    await forEachSequentially(
      [points[1]!, points[3]!, points[5]!],
      async (point) => {
        const dest = await restoreTo(f, { pointInTimeMs: point.tickMs });
        const restored = verifyRestoredPair(dest);
        expect(restored.vault.integrity).toBe("ok");
        expect(restored.receiptsChecked).toBeGreaterThan(0);
        expect(restored.danglingReceipts).toStrictEqual([]);
        const rv = openRestored(dest);
        expect(vaultTitles(rv)).toStrictEqual(point.titles);
        expect(probeCount(rv, "_wale2e_ledger")).toBe(point.ledger);
      }
    );

    // A lost segment tail is indistinguishable from an idle vault inside the
    // stream itself; only the tick markers can tell. Every PITR point must still
    // come back with zero dangling receipts — the restore walks back to the
    // newest tick the vault can PROVE it reached.
    const targetId = (await f.service.status())[f.vaultId]!.targetId;
    const vaultSegments = (await walObjectFiles(f, targetId))
      .filter((file) => /wal[/\\]vault[/\\]/u.test(file))
      .filter((file) => /^\d{12}-\d{12}-\d{13}$/u.test(path.basename(file)))
      .sort();
    expect(vaultSegments.length).toBeGreaterThan(2);
    await forEachSequentially(vaultSegments.slice(-2), async (victim) =>
      fs.rm(victim)
    );

    await forEachSequentially(points, async (point) => {
      const dest = await restoreTo(f, { pointInTimeMs: point.tickMs });
      const restored = verifyRestoredPair(dest);
      expect(restored.vault.integrity).toBe("ok");
      expect(restored.danglingReceipts).toStrictEqual([]);
      // The ledger band never runs ahead of the life rows it sits beside.
      const rv = openRestored(dest);
      expect(probeCount(rv, "_wale2e_ledger")).toBeLessThanOrEqual(
        point.ledger
      );
    });
  }, 60_000);

  test("G9: deleting the vault's ENTIRE segment stream fails restore-verify (it used to verify green)", async () => {
    const f = await fx();
    invoke(f.plane, "schedule.add_task", { title: "before-the-loss" });
    await f.service.runBackup(f.vaultId);

    for (let i = 0; i < 3; i++) {
      invoke(f.plane, "schedule.add_task", { title: `lost-stream-${i}` });
      insertVault(f.plane, 10, 200, `lost-${i}`);
      f.plane.walTick();
    }
    await f.service.drainWal();
    await f.service.runRestoreVerify(f.vaultId); // healthy first
    expect(
      (await f.service.status())[f.vaultId]!.lastRestoreVerifyError
    ).toBeUndefined();

    // An empty listing is indistinguishable from "never wrote anything" unless
    // the tick marker vouches for what shipped. Without it, verify would report
    // OK over hours that cannot restore.
    const state = (await f.service.status())[f.vaultId]!;
    const vaultSegments = (await walObjectFiles(f, state.targetId))
      .filter((file) => /wal[/\\]vault[/\\]/u.test(file))
      .filter((file) => /^\d{12}-\d{12}-\d{13}$/u.test(path.basename(file)));
    expect(vaultSegments.length).toBeGreaterThan(0);
    await forEachSequentially(vaultSegments, async (file) => fs.rm(file));

    await expect(f.service.runRestoreVerify(f.vaultId)).rejects.toThrow(
      /not restorable at its newest registered point/u
    );
    expect(
      (await f.service.status())[f.vaultId]!.lastRestoreVerifyError
    ).toMatch(/not restorable at its newest registered point/u);

    // The scheduled verifier plans the same marked cut restore does: a hole
    // check alone can never trip on an empty listing.
    const verify = await f.service.runVerify(f.vaultId);
    expect(verify!.missing.some((m) => /cannot be reassembled/u.test(m))).toBe(
      true
    );
  }, 60_000);

  test("measurement: drained sealed bytes for a known write volume are O(change), an order of magnitude story, not a DB re-upload", async () => {
    const f = await fx();
    // Bloat FIRST so "O(change)" is distinguishable from "O(db)".
    insertVault(f.plane, 400, 8000, "seed");
    await f.service.runBackup(f.vaultId);
    await f.service.drainWal();
    const logMark = f.logs.length;

    const payloadBytes = insertVault(f.plane, 64, 4096, "measured");
    f.plane.walTick();
    await f.service.drainWal();

    const drained = drainedBytes(f.logs, logMark);
    const dbBytes = statSync(path.join(f.plane.dir, "vault.db")).size;
    console.log(
      `[wal-e2e measurement] payload=${payloadBytes}B drained=${drained.bytes}B ` +
        `(${drained.objects} object(s)) liveDbs=${dbBytes}B ` +
        `ratio drained/payload=${(drained.bytes / payloadBytes).toFixed(2)} ` +
        `drained/db=${(drained.bytes / dbBytes).toFixed(3)}`
    );
    expect(drained.objects).toBeGreaterThan(0);
    // WAL page images cost a constant factor over row bytes.
    expect(drained.bytes).toBeGreaterThanOrEqual(payloadBytes / 10);
    expect(drained.bytes).toBeLessThanOrEqual(payloadBytes * 10);
    expect(drained.bytes).toBeLessThan(dbBytes / 2);
  }, 30_000);

  /** The shape of a drain interrupted between a tick's segments and its
   *  marker (markers drain LAST). */
  function markerBlockingProvider(
    get: () => BackupProvider,
    blocked: { on: boolean }
  ): BackupProvider {
    const inner = {
      get p(): BackupProvider {
        return get();
      },
    };
    return {
      capabilities: () => inner.p.capabilities(),
      createTarget: (o) => inner.p.createTarget(o),
      deleteTarget: (t) => inner.p.deleteTarget(t),
      undeleteTarget: (t) => inner.p.undeleteTarget(t),
      purgeTarget: (t) => inner.p.purgeTarget(t),
      registerSnapshot: (t, r) => inner.p.registerSnapshot(t, r),
      listSnapshots: (t, o) => inner.p.listSnapshots(t, o),
      getSnapshot: (t, s) => inner.p.getSnapshot(t, s),
      getTarget: (t) => inner.p.getTarget(t),
      usage: (t) => inner.p.usage(t),
      openDataPlane: async (targetId, storeClass, mode) => {
        const store = await inner.p.openDataPlane(targetId, storeClass, mode);
        const wrapped: ObjectStore = {
          put: async (key, data) => {
            if (blocked.on && key.startsWith("wal/tick/")) {
              throw new Error(
                "simulated drain interruption before the tick marker landed"
              );
            }
            return store.put(key, data);
          },
          get: (key) => store.get(key),
          getStream: (key) => store.getStream(key),
          head: (key) => store.head(key),
          list: (prefix) => store.list(prefix),
          delete: (key) => store.delete(key),
        };
        return wrapped;
      },
    };
  }

  async function markerObjectFiles(f: Fx, targetId: string): Promise<string[]> {
    return (await walObjectFiles(f, targetId)).filter((file) =>
      file.includes(`${path.sep}wal${path.sep}tick${path.sep}`)
    );
  }

  test("deleting ONLY the tick markers is DETECTED — restore degrades coherently, and says so", async () => {
    const f = await fx();
    invoke(f.plane, "schedule.add_task", { title: "before-marker-loss" });
    await f.service.runBackup(f.vaultId);

    for (let i = 0; i < 3; i++) {
      invoke(f.plane, "schedule.add_task", { title: `marker-loss-${i}` });
      insertVault(f.plane, 10, 200, `mloss-${i}`);
      f.plane.walTick();
    }
    await f.service.drainWal();

    // The manifest only ever claims markers the provider was watched accepting,
    // so the claim can never outrun reality.
    await f.service.runBackup(f.vaultId);
    const manifest = await openNewestManifest(f);
    const dbEntries = manifest.entries.filter((e) => e.kind === "db");
    expect(dbEntries).toHaveLength(1);
    expect(dbEntries[0]!.walTipTickMs!).toBeGreaterThan(0);

    await f.service.runRestoreVerify(f.vaultId); // healthy while the markers exist
    expect(
      (await f.service.status())[f.vaultId]!.lastRestoreVerifyError
    ).toBeUndefined();

    // Every segment and closer survives. With nothing vouching for what shipped,
    // a restore falls back to the base — coherent and SILENTLY hours stale.
    // The manifest's tip is what makes that loud.
    const state = (await f.service.status())[f.vaultId]!;
    const markers = await markerObjectFiles(f, state.targetId);
    expect(markers.length).toBeGreaterThan(0);
    await forEachSequentially(markers, async (file) => fs.rm(file));
    await expect(markerObjectFiles(f, state.targetId)).resolves.toStrictEqual(
      []
    );
    expect((await walObjectFiles(f, state.targetId)).length).toBeGreaterThan(0); // segments intact

    const verify = await f.service.runVerify(f.vaultId);
    expect(verify!.missing.some((m) => /tick marker/u.test(m))).toBe(true);

    await expect(f.service.runRestoreVerify(f.vaultId)).rejects.toThrow(
      /not restorable at its newest registered point/u
    );

    // The restore still SUCCEEDS at the older provable point (G6: degrade,
    // never refuse) — it is simply no longer silent about it.
    const dest = await restoreTo(f);
    const restored = verifyRestoredPair(dest);
    expect(restored.vault.integrity).toBe("ok");
    expect(restored.danglingReceipts).toStrictEqual([]);
    const rv = openRestored(dest);
    expect(vaultTitles(rv)).toContain("before-marker-loss"); // the base survived
  }, 60_000);

  test("a generation break RESETS the confirmed tip — a fresh stream is never held to the old one's", async () => {
    const f = await fx();
    invoke(f.plane, "schedule.add_task", { title: "before-the-roll" });
    await f.service.runBackup(f.vaultId);
    insertVault(f.plane, 10, 200, "pre-roll");
    f.plane.walTick();
    await f.service.drainWal();
    await f.service.runBackup(f.vaultId);
    const beforeRoll = (await openNewestManifest(f)).entries.find(
      (e) => e.kind === "db"
    )!;
    expect(beforeRoll.walTipTickMs).toBeGreaterThan(0);

    f.shipper.rollGeneration("test-roll");
    const rolled = f.shipper.status().stream!.generation;
    await f.service.runBackup(f.vaultId);
    const afterRoll = (await openNewestManifest(f)).entries.find(
      (e) => e.kind === "db"
    )!;
    expect(afterRoll.walGeneration).toBe(rolled);
    expect(afterRoll.walGeneration).not.toBe(beforeRoll.walGeneration);
    // Nothing has been shipped under the new generation yet, so there is no
    // confirmed marker to hold the store to.
    expect(afterRoll.walTipTickMs).toBeUndefined();
  }, 45_000);

  test("an INTERRUPTED drain (segments up, marker not) does NOT flap the check red", async () => {
    const blocked = { on: false };
    // LAZY: `fx` mints the provider dir every read helper here also reads, and
    // a second root would be a different world.
    let inner: BackupProvider | undefined = undefined;
    const f = await fx({
      provider: markerBlockingProvider(() => inner!, blocked),
    });
    inner = openLocalBackupProvider({ rootDir: f.providerDir });

    invoke(f.plane, "schedule.add_task", { title: "drain-interrupt" });
    await f.service.runBackup(f.vaultId);
    insertVault(f.plane, 10, 200, "confirmed");
    f.plane.walTick();
    await f.service.drainWal(); // clean drain: segments AND markers land
    await f.service.runBackup(f.vaultId); // stamps the confirmed tip
    const confirmedTip = (await openNewestManifest(f)).entries.find(
      (e) => e.kind === "db"
    )!.walTipTickMs!;
    expect(confirmedTip).toBeGreaterThan(0);

    // Interrupt where it hurts: the segments upload, the marker does not.
    insertVault(f.plane, 10, 200, "unconfirmed");
    const interrupted = f.shipper.tick();
    expect(interrupted.markers).toHaveLength(1);
    blocked.on = true;
    await f.service.drainWal(); // swallows the failure and retries later, by design
    blocked.on = false;
    expect(
      f.shipper.listUploadable().filter((i) => i.kind === "marker").length
    ).toBeGreaterThan(0);

    await f.service.runBackup(f.vaultId);
    const tipAfter = (await openNewestManifest(f)).entries.find(
      (e) => e.kind === "db"
    )!.walTipTickMs;
    expect(tipAfter).toBe(confirmedTip);
    expect(tipAfter).toBeLessThan(interrupted.tickMs);

    // A false red here trains the operator to ignore the one signal that matters.
    const verify = await f.service.runVerify(f.vaultId);
    expect(verify!.missing).toStrictEqual([]);
    expect(verify!.corrupt).toStrictEqual([]);
    await f.service.runRestoreVerify(f.vaultId);
    expect(
      (await f.service.status())[f.vaultId]!.lastRestoreVerifyError
    ).toBeUndefined();

    await f.service.drainWal();
    expect(
      f.shipper.listUploadable().filter((i) => i.kind === "marker")
    ).toStrictEqual([]);
    await f.service.runBackup(f.vaultId);
    const healed = (await openNewestManifest(f)).entries.find(
      (e) => e.kind === "db"
    )!.walTipTickMs!;
    expect(healed).toBeGreaterThanOrEqual(interrupted.tickMs);
  }, 60_000);
});
