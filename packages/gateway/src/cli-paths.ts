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
 *     chat-runner-sessions/ — codex thread state for in-app chat
 *     token.bin             — persistent bearer token (mode 0o600)
 */

import path from 'node:path';
import type { GatewayPaths } from './paths.js';

export interface DaemonLayout extends GatewayPaths {
  /** Persistent shared-bearer token file (`<dataDir>/token.bin`). */
  tokenFile: string;
}

export function daemonLayoutFor(dataDir: string): DaemonLayout {
  const abs = path.resolve(dataDir);
  return {
    appsDir: path.join(abs, 'apps'),
    identityDb: path.join(abs, 'identity.sqlite'),
    analyticsDb: path.join(abs, 'analytics.sqlite'),
    chatRunnerSessionDir: path.join(abs, 'chat-runner-sessions'),
    tokenFile: path.join(abs, 'token.bin'),
  };
}
