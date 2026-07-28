/*
 * Pure serve-flag parse + loopback-token compare (issue #545 B7).
 * Kept free of process.exit / main() so unit tests can import without
 * booting the daemon entrypoint.
 */

import crypto from 'node:crypto';

export interface ParsedServe {
  configPath?: string;
  dataDir?: string;
  host?: string;
  port?: number;
  /** Explicit kit-less zero→one bootstrap for automation/tests only. */
  initVaultName?: string;
  /** Extra Hostnames from repeated `--allowed-host` (issue #504 packaging). */
  allowedHosts?: string[];
}

/** Constant-time string compare — same posture as app-engine's bearer check. */
export function timingSafeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Pure serve-flag parse. Returns a result instead of exiting so unit tests can
 * exercise every branch without spawning the process.
 */
export type ParseServeArgsResult =
  | { ok: true; value: ParsedServe }
  | { ok: false; message: string; code: number }
  | { ok: false; help: true };

export function parseServeArgsPure(args: string[]): ParseServeArgsResult {
  const out: ParsedServe = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === undefined) continue;
    const readValue = (): string | { error: string } => {
      const v = args[++i];
      if (v === undefined) return { error: `flag "${flag}" requires a value` };
      return v;
    };
    switch (flag) {
      case '--config': {
        const v = readValue();
        if (typeof v !== 'string') return { ok: false, message: v.error, code: 2 };
        out.configPath = v;
        break;
      }
      case '--data-dir': {
        const v = readValue();
        if (typeof v !== 'string') return { ok: false, message: v.error, code: 2 };
        out.dataDir = v;
        break;
      }
      case '--host': {
        const v = readValue();
        if (typeof v !== 'string') return { ok: false, message: v.error, code: 2 };
        out.host = v;
        break;
      }
      case '--port': {
        const v = readValue();
        if (typeof v !== 'string') return { ok: false, message: v.error, code: 2 };
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 65535) {
          return {
            ok: false,
            message: `--port must be an integer in [0, 65535], got "${v}"`,
            code: 2,
          };
        }
        out.port = n;
        break;
      }
      case '--allowed-host': {
        const v = readValue();
        if (typeof v !== 'string') return { ok: false, message: v.error, code: 2 };
        const name = v.trim();
        if (!name)
          return {
            ok: false,
            message: '--allowed-host requires a hostname',
            code: 2,
          };
        out.allowedHosts = [...(out.allowedHosts ?? []), name];
        break;
      }
      case '--init-vault': {
        const v = readValue();
        if (typeof v !== 'string') return { ok: false, message: v.error, code: 2 };
        const name = v.trim();
        if (!name)
          return {
            ok: false,
            message: '--init-vault requires a non-empty name',
            code: 2,
          };
        out.initVaultName = name;
        break;
      }
      case '--help':
      case '-h':
        return { ok: false, help: true };
      default:
        return { ok: false, message: `unknown flag "${flag}"`, code: 2 };
    }
  }
  return { ok: true, value: out };
}
