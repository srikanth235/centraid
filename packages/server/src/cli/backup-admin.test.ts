import crypto from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  SNAPSHOT_FORMAT_V2,
  openLocalBackupProvider,
  parseRecoveryKit,
} from "@centraid/backup";
import type { BackupProvider } from "@centraid/backup";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { KeyStore } from "@centraid/vault";

import { GatewayDatabase } from "../serve/gateway-db.js";
import { openVaultRegistry } from "../serve/vault-registry.js";
import { commandBackup } from "./backup-admin.js";
import { daemonLayoutFor } from "./paths.js";

vi.setConfig({ testTimeout: 60_000 });

class CliFailError extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message);
    this.name = "CliFailError";
  }
}
const fail = (message: string, code = 1): never => {
  throw new CliFailError(message, code);
};

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let dataDir: string;
let providerDir: string;
let configPath: string;
let vaultId: string;

async function capture(fn: () => Promise<void> | void): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

function lines(out: string): unknown[] {
  return out
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

describe("backup-admin", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`backup-admin-${crypto.randomUUID()}-`);
    providerDir = await tempDir(
      `backup-admin-provider-${crypto.randomUUID()}-`
    );
    configPath = path.join(dataDir, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        dataDir,
        backup: {
          enabled: true,
          provider: { kind: "local", dir: providerDir },
        },
      })
    );
    const layout = daemonLayoutFor(dataDir);
    const database = GatewayDatabase.open(dataDir);
    database.close();
    const keyStore = new KeyStore(layout.keysDir);
    keyStore.loadOrCreate("endpoint-key.bin");
    const registry = openVaultRegistry({
      rootDir: layout.vaultDir,
      cacheRootDir: layout.cacheDir,
      keyStore,
      logger: silentLogger,
    });
    registry.create("Backup fixture");
    vaultId = registry.defaultVaultId();
    registry.stop();
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(providerDir, { recursive: true, force: true });
  });

  test("run backs up every vault, status reports it, list shows the registry row", async () => {
    const runOut = await capture(() =>
      commandBackup(["run", "--config", configPath], fail)
    );
    const [ran] = lines(runOut) as [Record<string, unknown>];
    expect(ran["vaultId"]).toBe(vaultId);
    expect(ran["lastSeq"]).toBe(1);

    const statusOut = await capture(() =>
      commandBackup(["status", "--config", configPath], fail)
    );
    const [status] = lines(statusOut) as [Record<string, unknown>];
    expect(status["vaultId"]).toBe(vaultId);
    expect(status["generation"]).toBe(1);

    const listOut = await capture(() =>
      commandBackup(["list", "--config", configPath], fail)
    );
    const [row] = lines(listOut) as [Record<string, unknown>];
    expect(row["vaultId"]).toBe(vaultId);
    expect(row["seq"]).toBe(1);
    expect(row["format"]).toBe(SNAPSHOT_FORMAT_V2);
  });

  test("verify reports a clean snapshot", async () => {
    await capture(() => commandBackup(["run", "--config", configPath], fail));
    const out = await capture(() =>
      commandBackup(
        ["verify", "--config", configPath, "--vault", vaultId],
        fail
      )
    );
    const [{ result }] = lines(out) as [
      { result: { missing: string[]; corrupt: string[] } },
    ];
    expect(result.missing).toHaveLength(0);
    expect(result.corrupt).toHaveLength(0);
  });

  test("restore materializes into a fresh --dest with a quarantine marker, never touching the live vault", async () => {
    await capture(() => commandBackup(["run", "--config", configPath], fail));
    const destDir = path.join(dataDir, "restored");
    const out = await capture(() =>
      commandBackup(
        [
          "restore",
          "--config",
          configPath,
          "--vault",
          vaultId,
          "--dest",
          destDir,
        ],
        fail
      )
    );
    const [result] = lines(out) as [{ seq: number; entries: string[] }];
    expect(result.seq).toBe(1);
    expect(result.entries).toContain("vault.db");
    expect(existsSync(path.join(destDir, "vault.db"))).toBe(true);
    expect(existsSync(path.join(destDir, "RESTORE_QUARANTINE.json"))).toBe(
      true
    );
    const liveVaultDb = path.join(
      daemonLayoutFor(dataDir).vaultDir,
      vaultId,
      "vault.db"
    );
    expect(existsSync(liveVaultDb)).toBe(true);
  });

  test("kit emits the recovery keyring with a store-offline warning on stderr", async () => {
    await capture(() => commandBackup(["run", "--config", configPath], fail));
    const kitFile = path.join(dataDir, "kit.json");
    const passwordFile = path.join(dataDir, "kit-password.txt");
    await fs.writeFile(passwordFile, "correct horse battery staple\n", {
      mode: 0o600,
    });
    const originalErr = process.stderr.write.bind(process.stderr);
    const errChunks: string[] = [];
    process.stderr.write = ((chunk: unknown): boolean => {
      errChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await commandBackup(
        [
          "kit",
          "--config",
          configPath,
          "--out",
          kitFile,
          "--password-file",
          passwordFile,
        ],
        fail
      );
    } finally {
      process.stderr.write = originalErr;
    }
    expect(existsSync(kitFile)).toBe(true);
    const wrapped = JSON.parse(await fs.readFile(kitFile, "utf8")) as {
      kind: string;
      keyring?: unknown;
    };
    expect(wrapped.kind).toBe("centraid-recovery-kit-wrapped");
    expect(wrapped.keyring).toBeUndefined();
    const kit = parseRecoveryKit(wrapped, "correct horse battery staple");
    expect(kit.kind).toBe("centraid-recovery-kit");
    expect(kit.keyring.epochs.length).toBeGreaterThan(0);
    expect(kit.targets.some((t) => t.vaultId === vaultId)).toBe(true);
    expect(errChunks.join("")).toMatch(/store it offline/u);
  });

  test('backup CLI refuses when the config has no "backup" block', async () => {
    const bareConfig = path.join(dataDir, "bare.json");
    await fs.writeFile(bareConfig, JSON.stringify({ dataDir }));
    await expect(
      capture(() => commandBackup(["status", "--config", bareConfig], fail))
    ).rejects.toThrow(/not configured/u);
  });

  function meteredLocalProvider(dir: string): BackupProvider {
    const real = openLocalBackupProvider({ rootDir: dir });
    return {
      capabilities: async () => {
        const caps = await real.capabilities();
        return caps.backup
          ? {
              ...caps,
              backup: { ...caps.backup, restoreCostClass: "metered-egress" },
            }
          : caps;
      },
      createTarget: (...a) => real.createTarget(...a),
      deleteTarget: (...a) => real.deleteTarget(...a),
      undeleteTarget: (...a) => real.undeleteTarget(...a),
      purgeTarget: (...a) => real.purgeTarget(...a),
      openDataPlane: (...a) => real.openDataPlane(...a),
      registerSnapshot: (...a) => real.registerSnapshot(...a),
      listSnapshots: (...a) => real.listSnapshots(...a),
      getSnapshot: (...a) => real.getSnapshot(...a),
      getTarget: (...a) => real.getTarget(...a),
      usage: (...a) => real.usage(...a),
    };
  }

  test("restore accepts --full and reports a full (non-lazy) materialization (#439 R2)", async () => {
    await capture(() => commandBackup(["run", "--config", configPath], fail));
    const destDir = path.join(dataDir, "restored-full");
    const out = await capture(() =>
      commandBackup(
        [
          "restore",
          "--config",
          configPath,
          "--vault",
          vaultId,
          "--dest",
          destDir,
          "--full",
        ],
        fail
      )
    );
    const [result] = lines(out) as [{ seq: number; previewsWarm?: unknown }];
    expect(result.seq).toBe(1);
    expect(result.previewsWarm).toBeUndefined();
    expect(existsSync(path.join(destDir, "vault.db"))).toBe(true);
  });

  test("a free-egress home never gates the restore (#439 R2)", async () => {
    await capture(() => commandBackup(["run", "--config", configPath], fail));
    const destDir = path.join(dataDir, "restored-free");
    const out = await capture(() =>
      commandBackup(
        [
          "restore",
          "--config",
          configPath,
          "--vault",
          vaultId,
          "--dest",
          destDir,
        ],
        fail
      )
    );
    const [result] = lines(out) as [{ seq: number }];
    expect(result.seq).toBe(1);
    expect(existsSync(path.join(destDir, "vault.db"))).toBe(true);
  });

  test("a metered-egress home refuses restore without --yes and proceeds with it (#439 R2)", async () => {
    const provider = meteredLocalProvider(providerDir);
    await capture(() =>
      commandBackup(["run", "--config", configPath], fail, { provider })
    );
    const destDir = path.join(dataDir, "restored-metered");
    await expect(
      capture(() =>
        commandBackup(
          [
            "restore",
            "--config",
            configPath,
            "--vault",
            vaultId,
            "--dest",
            destDir,
          ],
          fail,
          { provider }
        )
      )
    ).rejects.toThrow(/metered-egress/u);
    expect(existsSync(destDir)).toBe(false);
    const out = await capture(() =>
      commandBackup(
        [
          "restore",
          "--config",
          configPath,
          "--vault",
          vaultId,
          "--dest",
          destDir,
          "--yes",
        ],
        fail,
        { provider }
      )
    );
    const [result] = lines(out) as [{ seq: number }];
    expect(result.seq).toBe(1);
    expect(existsSync(path.join(destDir, "vault.db"))).toBe(true);
  });

  test("restore refuses a --dest that already holds a vault — restore stays to-side (#439 R3)", async () => {
    await capture(() => commandBackup(["run", "--config", configPath], fail));
    const destDir = path.join(dataDir, "occupied-vault");
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(path.join(destDir, "vault.db"), "live-bytes");
    await expect(
      capture(() =>
        commandBackup(
          [
            "restore",
            "--config",
            configPath,
            "--vault",
            vaultId,
            "--dest",
            destDir,
          ],
          fail
        )
      )
    ).rejects.toThrow(/not empty|refusing to restore over/u);
    await expect(
      fs.readFile(path.join(destDir, "vault.db"), "utf8")
    ).resolves.toBe("live-bytes");
  });
});
