/*
 * In-memory cache of `probeAcpCapabilities` results, keyed by runner kind +
 * effective launch overrides. Settings reads serve the cache; `?refresh=1`
 * forces a re-probe.
 * Probes are expensive (spawn + initialize), so we never run them on every
 * status poll.
 */

import type { RunnerKind } from '@centraid/app-engine';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { acpConfigFor } from '../../registry.js';
import { probeAcpCapabilities, type AcpAgentCapabilities } from './probe-capabilities.js';

export type { AcpAgentCapabilities };

const cache = new Map<string, AcpAgentCapabilities>();
const inflight = new Map<string, Promise<AcpAgentCapabilities>>();

function key(kind: RunnerKind, binPath?: string, extraArgs?: readonly string[]): string {
  return `${kind}\0${binPath ?? ''}\0${JSON.stringify(extraArgs ?? [])}`;
}

function persistedPath(cacheDir: string, cacheKey: string): string {
  return path.join(cacheDir, `${createHash('sha256').update(cacheKey).digest('hex')}.json`);
}

async function readPersisted(
  cacheDir: string | undefined,
  cacheKey: string,
): Promise<AcpAgentCapabilities | undefined> {
  if (!cacheDir) return undefined;
  try {
    const parsed = JSON.parse(
      await fs.readFile(persistedPath(cacheDir, cacheKey), 'utf8'),
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const caps = parsed as AcpAgentCapabilities;
    return typeof caps.reachable === 'boolean' && Array.isArray(caps.configOptions)
      ? caps
      : undefined;
  } catch {
    return undefined;
  }
}

async function writePersisted(
  cacheDir: string | undefined,
  cacheKey: string,
  caps: AcpAgentCapabilities,
): Promise<void> {
  if (!cacheDir) return;
  await fs.mkdir(cacheDir, { recursive: true });
  const target = persistedPath(cacheDir, cacheKey);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(caps, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
}

/**
 * Return cached capabilities. Probes only when `refresh` is true (Settings
 * "Refresh" / `?refresh=1`) — never on a cold status poll, because spawning
 * every installed agent on every Settings open is too expensive.
 */
export async function resolveAcpCapabilities(
  kind: RunnerKind,
  opts?: { binPath?: string; extraArgs?: string[]; refresh?: boolean; cacheDir?: string },
): Promise<AcpAgentCapabilities | undefined> {
  const k = key(kind, opts?.binPath, opts?.extraArgs);
  if (!opts?.refresh) {
    const cached = cache.get(k);
    if (cached) return cached;
    const persisted = await readPersisted(opts?.cacheDir, k);
    if (persisted) cache.set(k, persisted);
    return persisted;
  }

  const existing = inflight.get(k);
  if (existing) return existing;

  const run = (async (): Promise<AcpAgentCapabilities> => {
    try {
      const config = acpConfigFor(kind, {
        ...(opts?.binPath ? { binPath: opts.binPath } : {}),
        ...(opts?.extraArgs?.length ? { extraArgs: opts.extraArgs } : {}),
      });
      const caps = await probeAcpCapabilities(config, { timeoutMs: 10_000 });
      cache.set(k, caps);
      await writePersisted(opts?.cacheDir, k, caps);
      return caps;
    } finally {
      inflight.delete(k);
    }
  })();

  inflight.set(k, run);
  return run;
}

/** Test helper. */
export function clearCapabilitiesCache(): void {
  cache.clear();
  inflight.clear();
}
