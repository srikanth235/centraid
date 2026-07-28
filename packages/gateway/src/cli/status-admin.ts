/*
 * `centraid-gateway status [--json]` — one-shot health summary (issue #382),
 * combining two things the desktop's SSH-driven ConnectFlow "handshake
 * ladder" needs from a single round trip:
 *
 *   - service-supervision state (reuses `service-admin.ts`'s
 *     `queryServiceStatus` — the same OS probe `service status` runs, just
 *     data instead of printed text)
 *   - a data-dir identity summary: does the directory exist, what stable
 *     EndpointId derives from its custody key, and how many vaults its
 *     registry holds. A current dial ticket comes only from the live daemon.
 *
 * The shared fixed default port makes that live query deterministic; an
 * explicit config remains authoritative for non-default deployments.
 *
 * `--data-dir <path>`/`--config <path>` are optional here (unlike `backup`,
 * where the config is load-bearing) — a caller that only wants "is the
 * service alive" doesn't need to know a data dir at all.
 */

import fs from "node:fs";
import path from "node:path";

import { handshakeGateway } from "@centraid/protocol";
import { endpointIdForSecret } from "@centraid/tunnel";

import {
  openVaultRegistry,
  type FailedMount,
} from "../serve/vault-registry.js";
import { jsonFail, runJson, type Fail } from "./json-cli.js";
import { daemonKeyStore } from "./key-store.js";
import { landlordBearerForEndpointSecret } from "./landlord-auth.js";
import { daemonLayoutFor } from "./paths.js";
import { resolveDaemonConfig } from "./resolve-config.js";
import { queryServiceStatus, type ServiceStatusInfo } from "./service-admin.js";

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
  /** Stable iroh identity derived from `keys/endpoint-key.bin`. */
  endpointId?: string;
  /** Refreshable dial address returned by the running daemon only. */
  endpointTicket?: string;
  daemonRunning?: boolean;
  vaultCount?: number;
  /** Vault directories present on disk that would not open (issue #603 X1). */
  failedMounts?: FailedMount[];
  /** Why the vault root could not be read at all; `vaultCount` is absent then. */
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
      // Same custody the daemon uses, or every vault fails to mount and
      // `status` reports a gateway with zero vaults (issue #568 item D).
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
    // The vault root may legitimately not exist yet, so this does not fail
    // the whole status read — but it is REPORTED rather than swallowed: a
    // status that quietly omits the vault count reads as "no vaults".
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
  // Pre-scan for `--json` so it governs the whole run — including a
  // `fail()` triggered by argument parsing itself — regardless of flag order.
  const json = args.includes("--json");
  // Explicit annotation: TS's never-return control-flow narrowing (used
  // below on `parsed.dataDir`) only kicks in when the call-derived const is
  // annotated — inferred-from-call-expression alone doesn't carry it.
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
      // Live dial tickets are auth-gated (#568 item C). Present the host
      // custody bearer when we have the key so `status` can report them;
      // without a key, an anonymous handshake still answers "is the daemon up".
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
