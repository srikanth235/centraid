/*
 * In-memory cache of `probeAcpCapabilities` results, keyed by harness kind +
 * effective launch overrides. Settings reads serve the cache; `?refresh=1`
 * forces a re-probe.
 * Probes are expensive (spawn + initialize), so we never run them on every
 * status poll.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { HarnessKind } from "@centraid/server/engine";

import { acpConfigFor } from "../../registry.js";
import { probeAcpCapabilities } from "./probe-capabilities.js";
import type { AcpHarnessCapabilities } from "./probe-capabilities.js";

export { type AcpHarnessCapabilities } from "./probe-capabilities.js";

const cache = new Map<string, AcpHarnessCapabilities>();
const inflight = new Map<string, Promise<AcpHarnessCapabilities>>();

/**
 * How long a snapshot counts as evidence of the CURRENT host state. Sign-ins
 * expire, CLIs get upgraded, plans change — so a day-old `authRequired: true`
 * is history, not a verdict. Past the TTL a snapshot is still returned (so
 * Settings can render something) but marked `stale`, and any caller that
 * probes on demand re-probes instead of trusting it.
 */
export const CAPABILITIES_TTL_MS = 24 * 60 * 60 * 1000;

function isExpired(caps: AcpHarnessCapabilities, now: number): boolean {
  return (
    !Number.isFinite(caps.probedAt) || now - caps.probedAt > CAPABILITIES_TTL_MS
  );
}

function key(
  kind: HarnessKind,
  binPath?: string,
  extraArgs?: readonly string[]
): string {
  return `${kind}\0${binPath ?? ""}\0${JSON.stringify(extraArgs ?? [])}`;
}

function persistedPath(cacheDir: string, cacheKey: string): string {
  return path.join(
    cacheDir,
    `${createHash("sha256").update(cacheKey).digest("hex")}.json`
  );
}

async function readPersisted(
  cacheDir: string | undefined,
  cacheKey: string
): Promise<AcpHarnessCapabilities | undefined> {
  if (!cacheDir) return undefined;
  try {
    const parsed = JSON.parse(
      await fs.readFile(persistedPath(cacheDir, cacheKey), "utf8")
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    const caps = parsed as AcpHarnessCapabilities;
    return typeof caps.reachable === "boolean" &&
      Array.isArray(caps.configOptions)
      ? caps
      : undefined;
  } catch {
    return undefined;
  }
}

async function writePersisted(
  cacheDir: string | undefined,
  cacheKey: string,
  caps: AcpHarnessCapabilities
): Promise<void> {
  if (!cacheDir) return;
  await fs.mkdir(cacheDir, { recursive: true });
  const target = persistedPath(cacheDir, cacheKey);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(caps, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
}

/**
 * Return cached capabilities.
 *
 * - `refresh` (Settings "Refresh" / `?refresh=1`) always re-probes, and that
 *   explicit owner action is the one place the probe's live diagnostic prompt
 *   runs by default — it burns a real provider turn.
 * - Otherwise the memory then the persisted snapshot is served; a snapshot
 *   past `CAPABILITIES_TTL_MS` comes back marked `stale`.
 * - `probeIfMissing` lets a readiness check (preflight) probe when nothing
 *   usable is cached, WITHOUT the live prompt unless asked for.
 *
 * Never probes on a plain cold status poll: spawning every installed harness on
 * every Settings open is too expensive.
 */
export async function resolveAcpCapabilities(
  kind: HarnessKind,
  opts?: {
    binPath?: string;
    extraArgs?: string[];
    refresh?: boolean;
    cacheDir?: string;
    /** Probe when no fresh snapshot is cached (default: false). */
    probeIfMissing?: boolean;
    /** Run the probe's live diagnostic prompt (default: `refresh`). */
    probeLivePrompt?: boolean;
  }
): Promise<AcpHarnessCapabilities | undefined> {
  const k = key(kind, opts?.binPath, opts?.extraArgs);
  const livePrompt = opts?.probeLivePrompt ?? opts?.refresh === true;
  if (!opts?.refresh) {
    const now = Date.now();
    let known = cache.get(k);
    if (!known) {
      const persisted = await readPersisted(opts?.cacheDir, k);
      if (persisted) {
        cache.set(k, persisted);
        known = persisted;
      }
    }
    if (known && !isExpired(known, now)) return known;
    if (!opts?.probeIfMissing)
      return known ? { ...known, stale: true } : undefined;
  }

  const existing = inflight.get(k);
  if (existing) return existing;

  const run = (async (): Promise<AcpHarnessCapabilities> => {
    try {
      const config = acpConfigFor(kind, {
        ...(opts?.binPath ? { binPath: opts.binPath } : {}),
        ...(opts?.extraArgs?.length ? { extraArgs: opts.extraArgs } : {}),
      });
      const caps = await probeAcpCapabilities(config, {
        timeoutMs: 10_000,
        ...(livePrompt ? { probeLivePrompt: true } : {}),
      });
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
