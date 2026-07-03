/*
 * Filesystem layout the `centraid-gateway` daemon reads/writes under
 * `<dataDir>`.
 *
 * Mirrors the Electron embed's per-gateway tree at
 * `<userData>/gateways/<id>/`, just without the `gateways/<id>/`
 * segment — the daemon hosts exactly one gateway, so there's nothing
 * to multiplex.
 *
 *   <dataDir>/
 *     apps/                 — registered apps + `_registry.json`
 *     identity.sqlite       — users + per-user prefs
 *     analytics.sqlite      — one summary row per run
 *     conversation-runner-sessions/ — codex thread state for in-app chat
 *     model-catalog.json    — chat picker's per-runner model catalog
 *     token.bin             — persistent bearer token (mode 0o600)
 *     vault/                — personal vault pair (vault.db + journal.db)
 */

import path from 'node:path';
import type { GatewayPaths } from '../paths.js';

export interface DaemonLayout extends GatewayPaths {
  /** Persistent shared-bearer token file (`<dataDir>/token.bin`). */
  tokenFile: string;
  /** The daemon always mounts the vault plane (narrowed from optional). */
  vaultDir: string;
}

export function daemonLayoutFor(dataDir: string): DaemonLayout {
  const abs = path.resolve(dataDir);
  return {
    appsDir: path.join(abs, 'apps'),
    identityDb: path.join(abs, 'identity.sqlite'),
    analyticsDb: path.join(abs, 'analytics.sqlite'),
    conversationRunnerSessionDir: path.join(abs, 'conversation-runner-sessions'),
    modelCatalogFile: path.join(abs, 'model-catalog.json'),
    tokenFile: path.join(abs, 'token.bin'),
    // Mounting the vault plane (duaility §12): the daemon hosts one
    // gateway, so it holds one owner vault beside the per-app silos.
    vaultDir: path.join(abs, 'vault'),
  };
}
