/*
 * `centraid-gateway status [--json]` — one-shot health summary (issue #382),
 * combining two things the desktop's SSH-driven ConnectFlow "handshake
 * ladder" needs from a single round trip:
 *
 *   - service-supervision state (reuses `service-admin.ts`'s
 *     `queryServiceStatus` — the same OS probe `service status` runs, just
 *     data instead of printed text)
 *   - a data-dir identity summary: does the directory exist, what iroh
 *     endpoint identity has the daemon published there (`endpoint.json`,
 *     present only after `serve` has booted at least once), and how many
 *     vaults its registry holds.
 *
 * Deliberately NOT included: an HTTP liveness probe. `serve()` never
 * persists which host:port it bound to — only its own startup stdout line
 * says that, and that process is gone by the time this CLI runs. Guessing a
 * port (e.g. re-deriving it from a config file default) would produce a
 * false "unreachable" for a daemon actually listening elsewhere, which is
 * worse than omitting the check; the connectivity-test IPC on the desktop
 * side does its OWN liveness probe once it already has a URL from other
 * means (a `direct` profile's stored URL, or the iroh loopback proxy).
 *
 * `--data-dir <path>`/`--config <path>` are optional here (unlike `backup`,
 * where the config is load-bearing) — a caller that only wants "is the
 * service alive" doesn't need to know a data dir at all.
 */

import fs from 'node:fs';
import path from 'node:path';
import { daemonLayoutFor } from './paths.js';
import { resolveDaemonConfig } from './resolve-config.js';
import { openVaultRegistry } from '../serve/vault-registry.js';
import { queryServiceStatus, type ServiceStatusInfo } from './service-admin.js';
import { jsonFail, runJson, type Fail } from './json-cli.js';

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
    const next = (): string => {
      const v = args[++i];
      if (v === undefined) fail(`flag "${flag}" requires a value`, 2);
      return v;
    };
    switch (flag) {
      case '--data-dir':
        out.dataDir = next();
        break;
      case '--config':
        out.configPath = next();
        break;
      case '--label':
        out.label = next();
        break;
      case '--json':
        out.json = true;
        break;
      default:
        fail(`unknown flag "${flag}"`, 2);
    }
  }
  return out;
}

interface DataDirSummary {
  dataDir: string;
  exists: boolean;
  /** The daemon's persistent iroh endpoint id, from `endpoint.json` — absent
   *  until `serve` has booted at least once with the endpoint enabled. */
  endpointId?: string;
  vaultCount?: number;
}

function buildDataDirSummary(dataDir: string): DataDirSummary {
  const resolved = path.resolve(dataDir);
  if (!fs.existsSync(resolved)) return { dataDir: resolved, exists: false };
  const layout = daemonLayoutFor(resolved);

  let endpointId: string | undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(layout.endpointStateFile, 'utf8')) as {
      endpointId?: unknown;
    };
    if (typeof raw.endpointId === 'string') endpointId = raw.endpointId;
  } catch {
    // No endpoint identity yet (daemon never booted, or iroh disabled) —
    // that's a normal state, not a failure of this read.
  }

  let vaultCount: number | undefined;
  try {
    const registry = openVaultRegistry({ rootDir: layout.vaultDir, logger: quietLogger });
    try {
      vaultCount = registry.list().length;
    } finally {
      registry.stop();
    }
  } catch {
    // Vault dir missing/unreadable — leave undefined rather than fail the
    // whole status read over a directory that may just not exist yet.
  }

  return {
    dataDir: resolved,
    exists: true,
    ...(endpointId !== undefined ? { endpointId } : {}),
    ...(vaultCount !== undefined ? { vaultCount } : {}),
  };
}

function describeService(service: ServiceStatusInfo): string {
  if (!service.installed) return `not installed (label ${service.label})`;
  const running = service.running ? 'running' : `installed, ${service.state ?? 'stopped'}`;
  return `${running} (label ${service.label}${service.pid !== undefined ? `, pid ${service.pid}` : ''})`;
}

export async function commandStatus(args: string[], fail: Fail): Promise<void> {
  // Pre-scan for `--json` so it governs the whole run — including a
  // `fail()` triggered by argument parsing itself — regardless of flag order.
  const json = args.includes('--json');
  // Explicit annotation: TS's never-return control-flow narrowing (used
  // below on `parsed.dataDir`) only kicks in when the call-derived const is
  // annotated — inferred-from-call-expression alone doesn't carry it.
  const localFail: Fail = jsonFail(json, fail);
  await runJson(json, fail, async () => {
    const parsed = parseStatusArgs(args, localFail);
    const service = queryServiceStatus(parsed.label, localFail);

    let dataDir: DataDirSummary | undefined;
    if (parsed.dataDir || parsed.configPath) {
      const config = await resolveDaemonConfig(
        { dataDir: parsed.dataDir, configPath: parsed.configPath },
        localFail,
      );
      dataDir = buildDataDirSummary(config.dataDir);
    }

    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, service, ...(dataDir ? { dataDir } : {}) })}\n`,
      );
      return;
    }

    const lines = [`service: ${describeService(service)}`];
    if (dataDir) {
      lines.push(`data dir: ${dataDir.dataDir} (${dataDir.exists ? 'exists' : 'missing'})`);
      if (dataDir.endpointId) lines.push(`endpoint: ${dataDir.endpointId}`);
      if (dataDir.vaultCount !== undefined) lines.push(`vaults: ${dataDir.vaultCount}`);
    } else {
      lines.push('data dir: not specified (pass --data-dir or --config for a data summary)');
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  });
}
