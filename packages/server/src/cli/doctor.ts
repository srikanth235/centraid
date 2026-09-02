/*
 * `centraid-gateway doctor` — the in-product integrity scrub (#839). One line
 * per finding, nonzero exit when any check errored; exclusive-locks gateway.db
 * and refuses while the daemon runs.
 *
 *   centraid-gateway doctor --data-dir <path> [--vault <id>] [--full] [--json]
 */

import path from "node:path";

import { hasError, runIntegrityScrub } from "../doctor/index.js";
import type { DoctorVaultTarget, IntegrityFinding } from "../doctor/index.js";
import { GatewayDatabase, GatewayLockError } from "../serve/gateway-db.js";
import {
  openVaultRegistry,
  VaultRegistryError,
} from "../serve/vault-registry.js";
import { jsonFail, runJson } from "./json-cli.js";
import type { Fail } from "./json-cli.js";
import { daemonKeyStore } from "./key-store.js";
import { daemonLayoutFor } from "./paths.js";

const quietLogger = {
  info: () => undefined,
  warn: (msg: string) => process.stderr.write(`centraid-gateway: ${msg}\n`),
  error: (msg: string) => process.stderr.write(`centraid-gateway: ${msg}\n`),
};

interface DoctorArgs {
  dataDir?: string;
  vault?: string;
  full: boolean;
  json: boolean;
}

function parseDoctorArgs(args: string[], fail: Fail): DoctorArgs {
  const out: DoctorArgs = { full: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === undefined) continue;
    if (flag === "--data-dir") {
      const value = args[++i];
      if (value === undefined) fail("--data-dir requires a value", 2);
      out.dataDir = value;
    } else if (flag === "--vault") {
      const value = args[++i];
      if (value === undefined) fail("--vault requires a value", 2);
      out.vault = value;
    } else if (flag === "--full") {
      out.full = true;
    } else if (flag === "--json") {
      out.json = true;
    } else {
      fail(`unknown flag "${flag}"`, 2);
    }
  }
  return out;
}

const SYMBOL: Record<IntegrityFinding["level"], string> = {
  ok: "ok  ",
  warning: "WARN",
  error: "FAIL",
};

export async function commandDoctor(args: string[], fail: Fail): Promise<void> {
  const json = args.includes("--json");
  const localFail: Fail = jsonFail(json, fail);
  await runJson(json, fail, async () => {
    const parsed = parseDoctorArgs(args, localFail);
    if (!parsed.dataDir) localFail("--data-dir is required", 2);
    const layout = daemonLayoutFor(parsed.dataDir);

    // A scrub racing a live writer reports false corruption: hold the
    // maintenance verbs' exclusive lock, refusing while the daemon runs.
    let gatewayDb: GatewayDatabase;
    try {
      gatewayDb = GatewayDatabase.open(parsed.dataDir, { lock: "exclusive" });
    } catch (error) {
      if (error instanceof GatewayLockError) return localFail(error.message, 1);
      throw error;
    }

    const registry = openVaultRegistry({
      keyStore: daemonKeyStore(layout.keysDir),
      rootDir: layout.vaultDir,
      logger: quietLogger,
      enableWalShipper: false,
    });
    try {
      const planes = registry
        .planesList()
        .filter(
          (plane) =>
            parsed.vault === undefined || plane.boot.vaultId === parsed.vault
        );
      if (parsed.vault !== undefined && planes.length === 0) {
        return localFail(`no mounted vault matches "${parsed.vault}"`, 1);
      }

      const vaults: DoctorVaultTarget[] = planes.map((plane) => ({
        vaultId: plane.boot.vaultId,
        vault: plane.db.vault,
        local: plane.db.blobs.local,
        casRoot: path.join(plane.dir, "blobs"),
      }));

      const findings = runIntegrityScrub({
        vaults,
        extraDatabases: [{ label: "gateway.db", db: gatewayDb.db }],
        full: parsed.full,
      });

      // An unmountable vault is an integrity fault of its own — never report clean.
      const failedMounts = registry.failedMounts();

      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: !hasError(findings) && failedMounts.length === 0,
            vaults: vaults.map((v) => v.vaultId),
            findings,
            failedMounts,
          })}\n`
        );
      } else {
        for (const finding of findings) {
          process.stdout.write(
            `[${SYMBOL[finding.level]}] ${finding.check}: ${finding.detail}\n`
          );
        }
        for (const failure of failedMounts) {
          process.stderr.write(
            `[FAIL] mount: ${failure.dir} — ${failure.message}\n`
          );
        }
        const errors = findings.filter((f) => f.level === "error").length;
        process.stdout.write(
          `\n${vaults.length} vault(s) scrubbed, ${findings.length} check(s), ` +
            `${errors} failing${failedMounts.length > 0 ? `, ${failedMounts.length} unmountable` : ""}.\n`
        );
      }

      if (hasError(findings) || failedMounts.length > 0) {
        // Clean run that FOUND defects: exit nonzero so a wrapper can gate.
        process.exitCode = 1;
      }
    } catch (error) {
      if (error instanceof VaultRegistryError)
        return localFail(error.message, 1);
      throw error;
    } finally {
      registry.stop();
      gatewayDb.close();
    }
  });
}
