/*
 * Gateway instance lease — detects a second gateway pointed at the same
 * vault root (issue #351, tier 1: "one gateway per user" is an owner-stated
 * topology, not an enforced one). A copied vault directory, or a CLI daemon
 * and a desktop embed both aimed at the same `paths.vaultDir`, can corrupt
 * data via cross-copy SQLite WAL semantics — silently, because nothing today
 * records who's serving.
 *
 * A JSON lease file (`LEASE_FILE_NAME`) sits at the vault registry root,
 * sibling to the per-vault subdirectories — `VaultRegistry.scan()` already
 * skips non-directory entries there, so this file is invisible to vault
 * mounting. It carries `{ instanceId, pid, hostname, startedAt, renewedAt }`
 * for the process currently claiming it.
 *
 * Split-brain philosophy (mirrors the backup protocol's generation
 * fencing, `backup-service.ts`): make conflicts LOUD, never auto-resolve.
 *   - At `start()` (and every renew tick), a FRESH (`renewedAt` within
 *     `LEASE_FRESH_WINDOW_MS`) lease owned by a DIFFERENT instance flips
 *     the `instance` health component to `error` and is never
 *     clobber-written — we keep serving (a second gateway must never brick
 *     the first) and keep polling, but stop rewriting the file until the
 *     conflict clears on its own (the rival's lease goes stale or is
 *     removed).
 *   - A STALE lease (crashed owner — no `stop()` ran, so nothing removed
 *     it) is reclaimed cleanly: this is the deliberate trade-off for
 *     `LEASE_FRESH_WINDOW_MS` — a killed process's slot looks "possibly
 *     still live" for up to that long after its last renew.
 *   - `stop()` removes the file ONLY if it still names this instance —
 *     shutting down mid-conflict must not evict whoever is actually
 *     holding it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RuntimeLogger } from '@centraid/app-engine';
import type { HealthRegistry } from './health-registry.js';

export const LEASE_FILE_NAME = 'gateway.lease';

/** How often a live instance rewrites its own `renewedAt` into the lease file. */
export const LEASE_RENEW_INTERVAL_MS = 30_000;

/**
 * A lease last renewed within this window is treated as belonging to a
 * still-running process. Wider than `LEASE_RENEW_INTERVAL_MS` to give one
 * missed tick of slack before a lease is called stale — this IS the
 * crash-detection latency trade-off: a killed process's lease can look
 * "live" (and block a would-be second instance from reclaiming it) for up
 * to this long after its last renew.
 */
export const LEASE_FRESH_WINDOW_MS = 90_000;

export interface LeaseRecord {
  instanceId: string;
  pid: number;
  hostname: string;
  /** ISO timestamp of this instance's first successful claim. */
  startedAt: string;
  /** ISO timestamp of the most recent renew. */
  renewedAt: string;
}

export interface GatewayInstanceLeaseOptions {
  /** Vault registry root — the lease file lives at `<rootDir>/gateway.lease`. */
  rootDir: string;
  health: HealthRegistry;
  logger: RuntimeLogger;
  /** Clock override (tests). */
  now?: () => number;
  /** Identity overrides (tests) — default to a fresh UUID / the real pid + hostname. */
  instanceId?: string;
  pid?: number;
  hostname?: string;
}

export class GatewayInstanceLease {
  readonly instanceId: string;

  private readonly leasePath: string;
  private readonly health: HealthRegistry;
  private readonly logger: RuntimeLogger;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly hostname: string;
  private readonly startedAtIso: string;
  private timer: NodeJS.Timeout | undefined;
  /** True once a fresh foreign lease is in play — renew backs off to
   *  read-only checks while this holds (never clobber-write a live rival). */
  private conflicted = false;

  constructor(options: GatewayInstanceLeaseOptions) {
    this.leasePath = path.join(options.rootDir, LEASE_FILE_NAME);
    this.health = options.health;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.instanceId = options.instanceId ?? crypto.randomUUID();
    this.pid = options.pid ?? process.pid;
    this.hostname = options.hostname ?? os.hostname();
    this.startedAtIso = new Date(this.now()).toISOString();
  }

  /** Whether the most recent check found a live, foreign lease (tests + diagnostics). */
  isConflicted(): boolean {
    return this.conflicted;
  }

  /**
   * Claim/renew the lease now, then start the renew timer. Never throws —
   * a lease conflict is a loud health signal, not a startup failure (a
   * second gateway must never brick the first).
   */
  start(): void {
    this.checkAndRenew();
    this.timer = setInterval(() => this.checkAndRenew(), LEASE_RENEW_INTERVAL_MS);
    this.timer.unref();
  }

  /**
   * Stop the renew timer and remove the lease file — but ONLY if it still
   * names this instance. A conflicted shutdown (someone else holds it) or
   * a race with another writer must never evict the actual owner.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    try {
      const existing = this.readLease();
      if (existing?.instanceId === this.instanceId) fs.unlinkSync(this.leasePath);
    } catch {
      // Best-effort — a leftover lease just ages out past LEASE_FRESH_WINDOW_MS.
    }
  }

  /**
   * Read the file, judge freshness/ownership, and either renew our own
   * write or flip the `instance` health component to error without
   * writing. Runs once synchronously at `start()` and on every renew tick.
   */
  private checkAndRenew(): void {
    const nowMs = this.now();
    let existing: LeaseRecord | undefined;
    try {
      existing = this.readLease();
    } catch (err) {
      // A corrupt/unreadable lease file must not brick startup — treat it
      // like an absent lease (safe to reclaim) but log so it isn't silent.
      this.logger.warn(
        `gateway-instance-lease: could not read ${this.leasePath}: ` +
          `${err instanceof Error ? err.message : String(err)} — treating as absent`,
      );
    }

    const isOurs = existing?.instanceId === this.instanceId;
    const isFresh =
      existing !== undefined && nowMs - Date.parse(existing.renewedAt) < LEASE_FRESH_WINDOW_MS;

    if (existing && !isOurs && isFresh) {
      // A live rival — whether discovered at boot or because someone
      // force-rewrote the file out from under us mid-run. Loud, never
      // auto-resolved: flip red and stop, don't clobber their write.
      this.conflicted = true;
      this.health.reportError(
        'instance',
        'another gateway appears to be running against this vault root: ' +
          `pid ${existing.pid} on host ${existing.hostname} (instance ${existing.instanceId})`,
      );
      return;
    }

    // Ours, absent, or stale (crashed owner past LEASE_FRESH_WINDOW_MS) —
    // safe to (re)claim. `startedAt` stays pinned to this process's first
    // claim; only `renewedAt` moves on repeat ticks.
    const reclaimedFromPid = existing !== undefined && !isOurs ? existing.pid : undefined;
    const wasConflicted = this.conflicted;
    this.conflicted = false;
    const record: LeaseRecord = {
      instanceId: this.instanceId,
      pid: this.pid,
      hostname: this.hostname,
      startedAt: this.startedAtIso,
      renewedAt: new Date(nowMs).toISOString(),
    };
    try {
      fs.mkdirSync(path.dirname(this.leasePath), { recursive: true });
      fs.writeFileSync(this.leasePath, JSON.stringify(record));
    } catch (err) {
      this.health.reportError(
        'instance',
        `could not write instance lease: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (wasConflicted) {
      this.logger.info('gateway-instance-lease: conflict cleared — reclaimed the lease');
    }
    this.health.reportOk(
      'instance',
      reclaimedFromPid !== undefined
        ? `reclaimed a stale lease from a crashed instance (was pid ${reclaimedFromPid})`
        : 'lease held',
    );
  }

  private readLease(): LeaseRecord | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(this.leasePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    const parsed = JSON.parse(raw) as Partial<LeaseRecord>;
    if (
      typeof parsed.instanceId === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.hostname === 'string' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.renewedAt === 'string'
    ) {
      return parsed as LeaseRecord;
    }
    throw new Error('malformed lease file');
  }
}
