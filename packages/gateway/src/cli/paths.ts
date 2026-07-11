/*
 * Filesystem layout the `centraid-gateway` daemon reads/writes under
 * `<dataDir>`.
 *
 * Mirrors the Electron embed's per-gateway tree at
 * `<userData>/gateways/<id>/`, just without the `gateways/<id>/`
 * segment — the daemon hosts exactly one gateway, so there's nothing
 * to multiplex.
 *
 * Issue #280 — the vault is the unit. Everything personal (apps, code,
 * transcripts, run history) lives inside `vault/<vaultId>/`; the daemon
 * level keeps only plumbing:
 *
 *   <dataDir>/
 *     prefs.json            — device prefs (runner choice, binPath, …)
 *     model-catalog.json    — chat picker's per-runner model catalog
 *     token.bin             — persistent bearer token (mode 0o600)
 *     vault/                — vault registry root (one dir per vault)
 *     backup/               — offsite backup engine state (keyring, per-vault
 *                              targets, staging) — kept OUTSIDE vault/ so a
 *                              raw vault-dir copy never carries the keyring
 *     gateway-logs/         — rotated JSONL persistence of the log ring
 *                              (issue #351), so a crash/restart doesn't
 *                              lose the lines a post-mortem needs
 *     devices.json          — device enrollments: device key ↔ vault (#289)
 *     pairing-tickets.json  — one-time pairing tickets, secret hashes only (#289)
 *     endpoint-key.bin      — the gateway's persistent iroh secret key (#289)
 *     endpoint.json         — the live endpoint's id + dial ticket, for the pair CLI (#289)
 */

import path from 'node:path';
import type { GatewayPaths } from '../paths.js';

export interface DaemonLayout extends GatewayPaths {
  /** Persistent shared-bearer token file (`<dataDir>/token.bin`). */
  tokenFile: string;
  /** Device enrollment registry — device key ↔ vault rows (issue #289). */
  devicesFile: string;
  /** One-time pairing tickets (secret hashes + TTLs, issue #289). */
  pairingTicketsFile: string;
  /** The gateway's persistent iroh secret key (32 bytes, mode 0o600). */
  endpointKeyFile: string;
  /**
   * The running endpoint's public identity — `{endpointId, ticket}` —
   * written by `serve` on boot so the `pair` CLI can pin it into tickets
   * without joining the iroh network itself.
   */
  endpointStateFile: string;
}

export function daemonLayoutFor(dataDir: string): DaemonLayout {
  const abs = path.resolve(dataDir);
  return {
    prefsFile: path.join(abs, 'prefs.json'),
    modelCatalogFile: path.join(abs, 'model-catalog.json'),
    tokenFile: path.join(abs, 'token.bin'),
    // Mounting the vault registry (duaility §12): the daemon hosts one
    // gateway holding N sovereign vaults, one subdirectory each — and,
    // post-#280, each vault's whole app world.
    vaultDir: path.join(abs, 'vault'),
    backupDir: path.join(abs, 'backup'),
    logsDir: path.join(abs, 'gateway-logs'),
    // Storage connections + recovery-kit state (issue #367 §C1/§C10) — same
    // sibling-of-`vault/` convention as `backupDir`/`logsDir`.
    storageDir: path.join(abs, 'storage'),
    devicesFile: path.join(abs, 'devices.json'),
    pairingTicketsFile: path.join(abs, 'pairing-tickets.json'),
    endpointKeyFile: path.join(abs, 'endpoint-key.bin'),
    endpointStateFile: path.join(abs, 'endpoint.json'),
  };
}
