import fs from "node:fs";
import path from "node:path";

import { handshakeGateway } from "@centraid/core/protocol";
import { endpointIdForSecret } from "@centraid/tunnel";

import { openVaultRegistry } from "../serve/vault-registry.js";
import type { FailedMount } from "../serve/vault-registry.js";
import { jsonFail, runJson } from "./json-cli.js";
import type { Fail } from "./json-cli.js";
import { daemonKeyStore } from "./key-store.js";
import { landlordBearerForEndpointSecret } from "./landlord-auth.js";
import { daemonLayoutFor } from "./paths.js";
import { resolveDaemonConfig } from "./resolve-config.js";
import { queryServiceStatus } from "./service-admin.js";
import type { ServiceStatusInfo } from "./service-admin.js";

const quietLogger = {
  info: () => undefined,
  warn: (msg: string) => process.stderr.write(`centraid-gateway: ${msg}\n`),
  error: (msg: string) => process.stderr.write(`centraid-gateway: ${msg}\n`),
};

interface StatusArgs {
  dataDir?: string;
  configPath?: string;
  label?: string;
  json: boolean;
}

function parseStatusArgs(args: string[], fail: Fail): StatusArgs {
  const out: StatusArgs = { json: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === undefined) continue;
    const readValue = (): string => {
      const v = args[++i];
      if (v === undefined) return fail(`flag "${flag}" requires a value`, 2);
      return v;
    };
    switch (flag) {
      case "--data-dir":
        out.dataDir = readValue();
        break;
      case "--config":
        out.configPath = readValue();
        break;
      case "--label":
        out.label = readValue();
        break;
      case "--json":
        out.json = true;
        break;
      default:
        return fail(`unknown flag "${flag}"`, 2);
    }
  }
  return out;
}

interface DataDirSummary {
  dataDir: string;
  exists: boolean;
  endpointId?: string;
  endpointTicket?: string;
  daemonRunning?: boolean;
  vaultCount?: number;
  failedMounts?: FailedMount[];
  vaultReadError?: string;
}

function buildDataDirSummary(dataDir: string): DataDirSummary {
  const resolved = path.resolve(dataDir);
  if (!fs.existsSync(resolved)) return { dataDir: resolved, exists: false };
  const layout = daemonLayoutFor(resolved);

  const secret = daemonKeyStore(layout.keysDir).load("endpoint-key.bin");
  const endpointId = secret ? endpointIdForSecret(secret) : undefined;

  let vaultCount: number | undefined;
  let failedMounts: FailedMount[] = [];
  let vaultReadError: string | undefined;
  try {
    const registry = openVaultRegistry({
      keyStore: daemonKeyStore(layout.keysDir),
      rootDir: layout.vaultDir,
      logger: quietLogger,
      enableWalShipper: false,
    });
    try {
      vaultCount = registry.list().length;
      failedMounts = registry.failedMounts();
    } finally {
      registry.stop();
    }
  } catch (error) {
    vaultReadError = error instanceof Error ? error.message : String(error);
  }

  return {
    dataDir: resolved,
    exists: true,
    ...(endpointId === undefined ? {} : { endpointId }),
    ...(vaultCount === undefined ? {} : { vaultCount }),
    ...(failedMounts.length > 0 ? { failedMounts } : {}),
    ...(vaultReadError === undefined ? {} : { vaultReadError }),
  };
}

function describeService(service: ServiceStatusInfo): string {
  if (!service.installed) return `not installed (label ${service.label})`;
  const running = service.running
    ? "running"
    : `installed, ${service.state ?? "stopped"}`;
  return `${running} (label ${service.label}${service.pid === undefined ? "" : `, pid ${service.pid}`})`;
}

export async function commandStatus(
  args: string[],
  fail: Fail,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const json = args.includes("--json");
  const localFail: Fail = jsonFail(json, fail);
  await runJson(json, fail, async () => {
    const parsed = parseStatusArgs(args, localFail);
    const service = queryServiceStatus(parsed.label, localFail);

    const config = await resolveDaemonConfig(
      { dataDir: parsed.dataDir, configPath: parsed.configPath },
      localFail
    );
    const dataDir = buildDataDirSummary(config.dataDir);
    if (config.port !== undefined && config.port !== 0) {
      const endpointSecret = daemonKeyStore(
        daemonLayoutFor(config.dataDir).keysDir
      ).load("endpoint-key.bin");
      const live = await handshakeGateway(
        `http://127.0.0.1:${config.port}`,
        endpointSecret
          ? landlordBearerForEndpointSecret(endpointSecret)
          : undefined,
        fetchImpl
      );
      dataDir.daemonRunning = live.ok;
      if (
        live.ok &&
        live.info.endpointId === dataDir.endpointId &&
        live.info.endpointTicket !== undefined
      ) {
        dataDir.endpointTicket = live.info.endpointTicket;
      }
    }

    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, service, dataDir })}\n`
      );
      return;
    }

    const lines = [
      `service: ${describeService(service)}`,
      `data dir: ${dataDir.dataDir} (${dataDir.exists ? "exists" : "missing"})`,
    ];
    if (dataDir.endpointId) lines.push(`endpoint: ${dataDir.endpointId}`);
    lines.push(`daemon: ${dataDir.daemonRunning ? "running" : "not running"}`);
    if (dataDir.vaultCount !== undefined)
      lines.push(`vaults: ${dataDir.vaultCount}`);
    if (dataDir.failedMounts?.length) {
      lines.push(`vaults that failed to mount: ${dataDir.failedMounts.length}`);
      for (const failure of dataDir.failedMounts) {
        lines.push(`  ${failure.dir} — ${failure.message}`);
      }
    }
    if (dataDir.vaultReadError !== undefined) {
      lines.push(`vaults: unreadable — ${dataDir.vaultReadError}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  });
}
