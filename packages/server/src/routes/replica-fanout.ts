// One commit registration and one projection per generation, fanned to every
// replica subscriber (#883 C2). THE MEMO KEY MUST DETERMINE THE ANSWER: a new
// input to `projectReplicaPage` that misses `memoKey` serves one subscriber's
// page to all. The clock is bounded by the generation bump and the TTL.
//
// `deviceId` is deliberately NOT in the key (#922 A4). A projection is
// device-neutral by construction — the one device-specific part, an intent's
// outcome, is resolved by `applyReplicaIntentOutcomes` on top of the shared
// page — so N identically-authorized devices in a household cost ONE
// projection per commit instead of N. Any future device-specific input to
// `projectReplicaPage` must go back into the key or be layered the same way.

import type { DatabaseSync } from "node:sqlite";

import { subscribeReplicaCommits } from "@centraid/vault";
import type { ReplicaCursor } from "@centraid/vault";

import {
  applyReplicaIntentOutcomes,
  projectReplicaPage,
} from "./replica-projection.js";
import type {
  ReplicaProjectedPage,
  ReplicaProjectionOptions,
} from "./replica-projection.js";
import type { ReplicaShapeAccess } from "./replica-shape.js";

export const PROJECTION_MEMO_TTL_MS = 1_000;

export const PROJECTION_MEMO_MAX_ENTRIES = 64;

export type ReplicaHubAccess = ReplicaShapeAccess & { deviceId?: string };

interface MemoEntry {
  generation: number;
  computedAt: number;
  page: ReplicaProjectedPage;
}

function memoKey(
  access: ReplicaHubAccess,
  since: ReplicaCursor,
  limit: number,
  doorbellOnly: boolean
): string {
  return JSON.stringify([
    access.canWrite,
    access.rememberDevice,
    access.appId ?? null,
    since.epoch,
    since.seq,
    limit,
    doorbellOnly,
  ]);
}

export class ReplicaProjectionHub {
  private generation = 0;
  private readonly memo = new Map<string, MemoEntry>();
  private readonly listeners = new Set<() => void>();
  private unsubscribeCommits: (() => void) | undefined;

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now
  ) {}

  currentGeneration(): number {
    return this.generation;
  }

  subscriberCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.unsubscribeCommits ??= subscribeReplicaCommits(this.db, () => {
      this.generation += 1;
      this.memo.clear();
      for (const each of this.listeners) each();
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      this.unsubscribeCommits?.();
      this.unsubscribeCommits = undefined;
      this.memo.clear();
    };
  }

  /**
   * The returned page is SHARED across subscribers — read it, never mutate.
   * The device's intent outcomes are layered on a copy; the memoized page
   * itself stays device-neutral.
   */
  project(
    access: ReplicaHubAccess,
    since: ReplicaCursor,
    limit: number,
    options: ReplicaProjectionOptions = {}
  ): ReplicaProjectedPage {
    const doorbellOnly = options.doorbellOnly ?? false;
    const key = memoKey(access, since, limit, doorbellOnly);
    const now = this.now();
    const cached = this.memo.get(key);
    if (
      cached &&
      cached.generation === this.generation &&
      now - cached.computedAt < PROJECTION_MEMO_TTL_MS
    ) {
      return applyReplicaIntentOutcomes(this.db, cached.page, access);
    }
    const page = projectReplicaPage(this.db, access, since, limit, options);
    // Re-set moves the key to the end of insertion order, so eviction drops
    // the least recently computed.
    this.memo.delete(key);
    this.memo.set(key, { generation: this.generation, computedAt: now, page });
    while (this.memo.size > PROJECTION_MEMO_MAX_ENTRIES) {
      const oldest = this.memo.keys().next();
      if (oldest.done) break;
      this.memo.delete(oldest.value);
    }
    return applyReplicaIntentOutcomes(this.db, page, access);
  }
}

const hubs = new WeakMap<DatabaseSync, ReplicaProjectionHub>();

export function replicaProjectionHub(db: DatabaseSync): ReplicaProjectionHub {
  let hub = hubs.get(db);
  if (!hub) {
    hub = new ReplicaProjectionHub(db);
    hubs.set(db, hub);
  }
  return hub;
}
