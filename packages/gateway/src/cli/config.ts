/*
 * Daemon config-file loader for `centraid-gateway serve`.
 *
 * Shape (JSON):
 *
 *   {
 *     "dataDir": "/var/lib/centraid",
 *     "host": "0.0.0.0",
 *     "port": 8765,
 *     "runner": {
 *       "kind": "codex",
 *       "binPath": "/opt/homebrew/bin/codex",
 *       "extraArgs": ["--model", "<model-id>"]
 *     }
 *   }
 *
 * Every field is optional except `dataDir`. CLI flags
 * (`--host`/`--port`/`--data-dir`) override file fields. The `runner`
 * block is *seeded* into the gateway's identity DB on first boot so the
 * runtime's per-turn prefs loader picks it up unchanged.
 */

import { promises as fs } from 'node:fs';
import { validateBackupConfig, type BackupConfig } from '../backup/backup-config.js';

export interface DaemonRunnerConfig {
  kind: 'codex' | 'claude-code';
  binPath?: string;
  extraArgs?: string[];
}

export interface DaemonConfig {
  dataDir: string;
  host?: string;
  port?: number;
  runner?: DaemonRunnerConfig;
  /**
   * Whether the daemon binds its iroh endpoint (issue #289). Defaults to
   * true — the endpoint IS the remote story; set false for HTTP-only
   * setups (tests, boxes fronted by their own transport).
   */
  endpoint?: boolean;
  /** Offsite backup engine (PROTOCOL.md/FORMAT.md), off by default. */
  backup?: BackupConfig;
}

export class DaemonConfigError extends Error {
  constructor(message: string) {
    super(`config: ${message}`);
    this.name = 'DaemonConfigError';
  }
}

export async function loadConfigFile(path: string): Promise<DaemonConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    throw new DaemonConfigError(
      `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DaemonConfigError(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateConfig(parsed);
}

export function validateConfig(value: unknown): DaemonConfig {
  if (!isRecord(value)) throw new DaemonConfigError('top-level value must be an object');
  const dataDir = value.dataDir;
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new DaemonConfigError('`dataDir` is required and must be a non-empty string');
  }
  const out: DaemonConfig = { dataDir };
  if (value.host !== undefined) {
    if (typeof value.host !== 'string' || value.host.length === 0) {
      throw new DaemonConfigError('`host` must be a non-empty string when set');
    }
    out.host = value.host;
  }
  if (value.port !== undefined) {
    const port = value.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new DaemonConfigError('`port` must be an integer in [0, 65535]');
    }
    out.port = port;
  }
  if (value.runner !== undefined) {
    out.runner = validateRunner(value.runner);
  }
  if (value.endpoint !== undefined) {
    if (typeof value.endpoint !== 'boolean') {
      throw new DaemonConfigError('`endpoint` must be a boolean when set');
    }
    out.endpoint = value.endpoint;
  }
  if (value.backup !== undefined) {
    try {
      out.backup = validateBackupConfig(value.backup);
    } catch (err) {
      throw new DaemonConfigError(err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

function validateRunner(value: unknown): DaemonRunnerConfig {
  if (!isRecord(value)) throw new DaemonConfigError('`runner` must be an object');
  const kind = value.kind;
  if (kind !== 'codex' && kind !== 'claude-code') {
    throw new DaemonConfigError('`runner.kind` must be "codex" or "claude-code"');
  }
  const out: DaemonRunnerConfig = { kind };
  if (value.binPath !== undefined) {
    if (typeof value.binPath !== 'string') {
      throw new DaemonConfigError('`runner.binPath` must be a string when set');
    }
    out.binPath = value.binPath;
  }
  if (value.extraArgs !== undefined) {
    if (!Array.isArray(value.extraArgs) || value.extraArgs.some((v) => typeof v !== 'string')) {
      throw new DaemonConfigError('`runner.extraArgs` must be an array of strings when set');
    }
    out.extraArgs = value.extraArgs as string[];
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
