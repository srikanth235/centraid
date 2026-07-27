/*
 * `centraid-gateway lock-status` (issue #555).
 *
 * gateway.db is the process lock. A running daemon is asked first; when it
 * cannot answer, an exclusive open distinguishes "free" from "held by a live
 * process". lsof is diagnostic only and best-effort—the SQLite lock remains
 * authoritative on every platform.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { handshakeGateway } from '@centraid/protocol';
import { endpointIdForSecret } from '@centraid/tunnel';
import { daemonLayoutFor } from './paths.js';
import { resolveDaemonConfig } from './resolve-config.js';
import { GatewayDatabase, GatewayLockError } from '../serve/gateway-db.js';
import { daemonKeyStore } from './key-store.js';

interface LockStatus {
  dataDir: string;
  held: boolean;
  answering: boolean;
  holderPid?: number;
  detail: string;
}

export interface LockStatusDependencies {
  holderPid?: (file: string) => number | undefined;
}

function holderPid(file: string): number | undefined {
  const result = spawnSync('lsof', ['-t', file], { encoding: 'utf8', timeout: 2_000 });
  if (result.status !== 0) return undefined;
  const pid = Number(result.stdout.trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export async function commandLockStatus(
  args: string[],
  fail: (message: string, code?: number) => never,
  fetchImpl: typeof fetch = fetch,
  dependencies: LockStatusDependencies = {},
): Promise<void> {
  const findHolderPid = dependencies.holderPid ?? holderPid;
  let dataDir: string | undefined;
  let configPath: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const next = (): string => {
      const value = args[++i];
      if (value === undefined) fail(`${flag} requires a value`, 2);
      return value;
    };
    if (flag === '--data-dir') dataDir = next();
    else if (flag === '--config') configPath = next();
    else if (flag === '--json') json = true;
    else fail(`unknown flag "${flag}"`, 2);
  }
  const config = await resolveDaemonConfig({ dataDir, configPath }, fail);
  const layout = daemonLayoutFor(config.dataDir);
  const live =
    config.port !== undefined && config.port !== 0
      ? await handshakeGateway(`http://127.0.0.1:${config.port}`, undefined, fetchImpl)
      : { ok: false as const };
  const endpointSecret = daemonKeyStore(layout.keysDir).load('endpoint-key.bin');
  const expectedEndpointId = endpointSecret ? endpointIdForSecret(endpointSecret) : undefined;
  const answeringTarget =
    live.ok && expectedEndpointId !== undefined && live.info.endpointId === expectedEndpointId;

  let status: LockStatus;
  if (answeringTarget) {
    const pid = findHolderPid(layout.gatewayDbFile);
    status = {
      dataDir: config.dataDir,
      held: true,
      answering: true,
      ...(pid !== undefined ? { holderPid: pid } : {}),
      detail: 'gateway.db is held by the answering daemon',
    };
  } else if (!existsSync(layout.gatewayDbFile)) {
    status = {
      dataDir: config.dataDir,
      held: false,
      answering: false,
      detail: 'gateway.db does not exist; the lock is free',
    };
  } else {
    try {
      GatewayDatabase.open(config.dataDir, { lock: 'exclusive' }).close();
      status = {
        dataDir: config.dataDir,
        held: false,
        answering: false,
        detail: 'gateway.db opened exclusively; the lock is free',
      };
    } catch (error) {
      if (!(error instanceof GatewayLockError)) throw error;
      const pid = findHolderPid(layout.gatewayDbFile);
      status = {
        dataDir: config.dataDir,
        held: true,
        answering: false,
        ...(pid !== undefined ? { holderPid: pid } : {}),
        detail:
          'gateway.db is held but the daemon is not answering' +
          (pid !== undefined ? ` (OS holder pid ${pid})` : ''),
      };
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...status })}\n`);
    return;
  }
  process.stdout.write(
    `${status.held ? 'held' : 'free'}${status.answering ? ', answering' : ''}: ${status.detail}\n`,
  );
}
