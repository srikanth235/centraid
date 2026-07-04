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
 */

import path from 'node:path';
import type { GatewayPaths } from '../paths.js';

export interface DaemonLayout extends GatewayPaths {
  /** Persistent shared-bearer token file (`<dataDir>/token.bin`). */
  tokenFile: string;
}

export function daemonLayoutFor(dataDir: string): DaemonLayout {
  const abs = path.resolve(dataDir);
  return {
    prefsFile: path.join(abs, 'prefs.json'),
    modelCatalogFile: path.join(abs, 'model-catalog.json'),
    tokenFile: path.join(abs, 'token.bin'),
    // Mounting the vault registry (duaility §12): the daemon hosts one
    // gateway, which holds the owner's vaults (one subdirectory each,
    // exactly one active) — and, post-#280, each vault's whole app world.
    vaultDir: path.join(abs, 'vault'),
  };
}
