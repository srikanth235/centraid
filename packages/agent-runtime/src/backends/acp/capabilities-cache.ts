/*
 * In-memory cache of `probeAcpCapabilities` results, keyed by runner kind +
 * bin path. Settings reads serve the cache; `?refresh=1` forces a re-probe.
 * Probes are expensive (spawn + initialize), so we never run them on every
 * status poll.
 */

import type { RunnerKind } from '@centraid/app-engine';
import { acpConfigFor } from '../../registry.js';
import { probeAcpCapabilities, type AcpAgentCapabilities } from './probe-capabilities.js';

export type { AcpAgentCapabilities };

const cache = new Map<string, AcpAgentCapabilities>();
const inflight = new Map<string, Promise<AcpAgentCapabilities>>();

function key(kind: RunnerKind, binPath?: string): string {
  return `${kind}\0${binPath ?? ''}`;
}

/**
 * Return cached capabilities. Probes only when `refresh` is true (Settings
 * "Refresh" / `?refresh=1`) — never on a cold status poll, because spawning
 * every installed agent on every Settings open is too expensive.
 */
export async function resolveAcpCapabilities(
  kind: RunnerKind,
  opts?: { binPath?: string; refresh?: boolean },
): Promise<AcpAgentCapabilities | undefined> {
  const k = key(kind, opts?.binPath);
  if (!opts?.refresh) {
    return cache.get(k);
  }

  const existing = inflight.get(k);
  if (existing) return existing;

  const run = (async (): Promise<AcpAgentCapabilities> => {
    try {
      const config = acpConfigFor(kind, {
        ...(opts?.binPath ? { binPath: opts.binPath } : {}),
      });
      const caps = await probeAcpCapabilities(config, { timeoutMs: 10_000 });
      cache.set(k, caps);
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
