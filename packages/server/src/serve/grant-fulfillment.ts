/*
 * Host seam for the fulfillment engine (#825): the engine must NOT learn which
 * vaults this host mounted. One audience never costs another — a failing grant
 * is that grant's failure. Nothing here retries or promotes `remove_sent`.
 */

import {
  createGrantProjectionMemory,
  fulfillShareGrant,
  listShareGrantsForSubject,
  propagateShareGrantRevocation,
  readShareGrant,
  subjectWokenBy,
  wakeTypesForSubjectTypes,
  writeReceipt,
} from "@centraid/vault";
import type {
  GrantFulfillmentResult,
  GrantFulfillmentStep,
  GrantProjectionMemory,
  GrantRemovalResult,
  ShareableItemType,
  VaultDb,
} from "@centraid/vault";

import { unrefTimer } from "../lib/unref-timer.js";
import { raiseShareReceivedNotice } from "./share-notices.js";

export interface GrantFulfillmentHost {
  /** `undefined` is a fact about this HOST, never about the grant. */
  vaultFor: (vaultId: string) => VaultDb | undefined;
  logger?: { warn: (message: string) => void };
}

/*
 * Ruling V-delivery: the loop's decision state is derived into HOST MEMORY,
 * keyed by host so it dies with the process, not with a member's data.
 * `delivered_at` (#846) is the one durable fact.
 */

const AUTHORITY_ENTITY = "share.authority";

interface GrantSubjectIndex {
  subjects: readonly { subjectType: ShareableItemType; subjectId: string }[];
  wake: ReadonlySet<string>;
}

const INDEXES = new WeakMap<
  GrantFulfillmentHost,
  Map<string, GrantSubjectIndex>
>();
const MEMORIES = new WeakMap<GrantFulfillmentHost, GrantProjectionMemory>();

function memoryFor(host: GrantFulfillmentHost): GrantProjectionMemory {
  let memory = MEMORIES.get(host);
  if (!memory) {
    memory = createGrantProjectionMemory();
    MEMORIES.set(host, memory);
  }
  return memory;
}

function buildIndex(origin: VaultDb): GrantSubjectIndex {
  const subjects = liveGrantSubjects(origin);
  return {
    subjects,
    wake: wakeTypesForSubjectTypes(
      new Set(subjects.map((subject) => subject.subjectType))
    ),
  };
}

/**
 * Rebuilt only when the plane moved: one door writes grants (ruling V-writer)
 * and commits `share.authority`, so a commit not naming it cannot have changed
 * which subjects are granted.
 */
function indexFor(
  host: GrantFulfillmentHost,
  vaultId: string,
  origin: VaultDb,
  touched: ReadonlySet<string> | undefined
): GrantSubjectIndex {
  let byVault = INDEXES.get(host);
  if (!byVault) {
    byVault = new Map();
    INDEXES.set(host, byVault);
  }
  const cached = byVault.get(vaultId);
  // No hint is "something changed and nobody said what": rebuild.
  if (cached && touched && !touched.has(AUTHORITY_ENTITY)) return cached;
  const built = buildIndex(origin);
  byVault.set(vaultId, built);
  return built;
}

export type GrantFulfillmentReport =
  | { grantId: string; outcome: "fulfilled"; result: GrantFulfillmentResult }
  | { grantId: string; outcome: "failed"; reason: string };

/** `unmounted` is NOT an empty `reports` list: collapsing them tells an owner
 *  their share reached nobody when nobody looked. */
export type GrantFulfillmentPass =
  | { origin: "mounted"; reports: readonly GrantFulfillmentReport[] }
  | { origin: "unmounted"; reason: string };

export type GrantRemovalReport =
  | { grantId: string; outcome: "propagated"; result: GrantRemovalResult }
  | { grantId: string; outcome: "failed"; reason: string };

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unmounted(vaultId: string): { origin: "unmounted"; reason: string } {
  return {
    origin: "unmounted",
    reason: `origin vault ${vaultId} is not mounted on this host`,
  };
}

/** The audience learns about a share ONCE, at its first arrival (V-notice). */
function announceFirstDeliveries(
  input: {
    host: GrantFulfillmentHost;
    origin: VaultDb;
    originVaultId: string;
    grantId: string;
    subjectLabel?: string;
    now: string;
  },
  result: GrantFulfillmentResult
): void {
  const first = result.steps.filter(
    (step): step is GrantFulfillmentStep & { peerVaultId: string } =>
      step.firstDelivery === true && step.peerVaultId !== undefined
  );
  if (first.length === 0) return;
  const grant = readShareGrant(input.origin.vault, input.grantId);
  if (!grant) return;
  for (const step of first) {
    const seat = input.host.vaultFor(step.peerVaultId);
    if (!seat) continue;
    raiseShareReceivedNotice({
      origin: input.origin,
      originVaultId: input.originVaultId,
      seat,
      grantId: input.grantId,
      granterPartyId: grant.grantedBy,
      subjectType: grant.subjectType,
      ...(input.subjectLabel === undefined
        ? {}
        : { subjectLabel: input.subjectLabel }),
      now: input.now,
    });
  }
}

/**
 * Every ROSTER CHANGE (V-receipts). `masked` is the member's own refusal inside
 * a circle they granted (V-mask); `departed` is a peer still holding a
 * delivered copy this pass no longer reaches.
 */
function receiptRosterDrift(
  input: { origin: VaultDb; grantId: string; now: string },
  result: GrantFulfillmentResult
): void {
  const { masked, departed } = result.drift;
  if (masked.length === 0 && departed.length === 0) return;
  writeReceipt(input.origin.audit, {
    grantId: input.grantId,
    invocationId: null,
    action: "act share.fulfill",
    objectType: "share.authority",
    objectId: input.grantId,
    purpose: null,
    decision: "allow",
    detail: {
      rosterDrift: true,
      ...(masked.length > 0 ? { maskedParties: [...masked] } : {}),
      ...(departed.length > 0 ? { departedPeers: [...departed] } : {}),
      observedAt: input.now,
    },
  });
}

function passOne(input: {
  host: GrantFulfillmentHost;
  origin: VaultDb;
  originVaultId: string;
  grantId: string;
  subjectLabel?: string;
  now: string;
}): GrantFulfillmentReport {
  try {
    const result = fulfillShareGrant({
      origin: input.origin,
      originVaultId: input.originVaultId,
      grantId: input.grantId,
      seatFor: (vaultId) => input.host.vaultFor(vaultId),
      now: input.now,
      memory: memoryFor(input.host),
    });
    announceFirstDeliveries(input, result);
    receiptRosterDrift(input, result);
    return { grantId: input.grantId, outcome: "fulfilled", result };
  } catch (error) {
    const reason = reasonOf(error);
    input.host.logger?.warn(
      `share grant ${input.grantId} could not be fulfilled — ${reason}`
    );
    return { grantId: input.grantId, outcome: "failed", reason };
  }
}

export function fulfillGrantsForSubject(input: {
  host: GrantFulfillmentHost;
  originVaultId: string;
  subjectType: ShareableItemType;
  subjectId: string;
  subjectLabel?: string;
  now: string;
}): GrantFulfillmentPass {
  const origin = input.host.vaultFor(input.originVaultId);
  if (!origin) return unmounted(input.originVaultId);
  return {
    origin: "mounted",
    reports: listShareGrantsForSubject(
      origin.vault,
      input.subjectType,
      input.subjectId
    ).map((grant) =>
      passOne({
        host: input.host,
        origin,
        originVaultId: input.originVaultId,
        grantId: grant.grantId,
        ...(input.subjectLabel === undefined
          ? {}
          : { subjectLabel: input.subjectLabel }),
        now: input.now,
      })
    ),
  };
}

/** The ONLY writer of `removed`. */
export function propagateGrantRemoval(input: {
  host: GrantFulfillmentHost;
  originVaultId: string;
  grantId: string;
  now: string;
}): GrantRemovalReport {
  const origin = input.host.vaultFor(input.originVaultId);
  if (!origin)
    return {
      grantId: input.grantId,
      outcome: "failed",
      reason: `origin vault ${input.originVaultId} is not mounted on this host`,
    };
  try {
    return {
      grantId: input.grantId,
      outcome: "propagated",
      result: propagateShareGrantRevocation({
        origin,
        originVaultId: input.originVaultId,
        grantId: input.grantId,
        seatFor: (vaultId) => input.host.vaultFor(vaultId),
        now: input.now,
        memory: memoryFor(input.host),
      }),
    };
  } catch (error) {
    const reason = reasonOf(error);
    input.host.logger?.warn(
      `share grant ${input.grantId} removal could not be propagated — ${reason}`
    );
    return { grantId: input.grantId, outcome: "failed", reason };
  }
}

/*
 * A grant is not a snapshot (G-membership): the doorbell names committed ENTITY
 * TYPES, never rows, so a pass covers every live grant SUBJECT — a photo added
 * to a shared album commits the membership row, not the album.
 */

function liveGrantSubjects(
  origin: VaultDb
): { subjectType: ShareableItemType; subjectId: string }[] {
  return (
    origin.vault
      .prepare(
        // Share subjects only: the plane also answers for the member's own
        // devices and engines (#883), which no audience vault receives.
        `SELECT DISTINCT subject_type, subject_id FROM share_authority
          WHERE revoked_at IS NULL AND decision = 'granted'
            AND principal_kind IN ('person','circle')
          ORDER BY subject_type, subject_id`
      )
      .all() as { subject_type: string; subject_id: string }[]
  ).map((row) => ({
    subjectType: row.subject_type as ShareableItemType,
    subjectId: row.subject_id,
  }));
}

/** Ruling V-delivery: the loop owns removal, so a revoke is not a
 *  request-path errand. */
function pendingRemovals(origin: VaultDb): string[] {
  return (
    origin.vault
      .prepare(
        `SELECT DISTINCT a.authority_id FROM share_authority a
           JOIN share_fulfillment f ON f.grant_id = a.authority_id
          WHERE a.revoked_at IS NOT NULL AND a.decision = 'granted'
            AND a.principal_kind IN ('person','circle')
            AND f.state IN ('awaiting_channel','syncing','delivered')
          ORDER BY a.authority_id`
      )
      .all() as { authority_id: string }[]
  ).map((row) => row.authority_id);
}

/**
 * The delivery loop (ruling V-delivery), failure-isolated by `passOne`. It runs
 * after EVERY commit, so `touched` must make a commit that cannot have moved a
 * granted subject cost NOTHING. Omit it and the loop walks everything.
 */
export function refreshGrantsAfterCommit(input: {
  host: GrantFulfillmentHost;
  originVaultId: string;
  now: string;
  touched?: readonly string[];
}): GrantFulfillmentPass {
  const origin = input.host.vaultFor(input.originVaultId);
  if (!origin) return unmounted(input.originVaultId);
  const touched = input.touched ? new Set(input.touched) : undefined;
  const index = indexFor(input.host, input.originVaultId, origin, touched);
  const planeMoved = touched === undefined || touched.has(AUTHORITY_ENTITY);
  if (index.subjects.length === 0 && !planeMoved)
    return { origin: "mounted", reports: [] };
  if (!planeMoved && !wakes(touched, index.wake))
    return { origin: "mounted", reports: [] };
  const reports: GrantFulfillmentReport[] = [];
  for (const subject of index.subjects) {
    // Per SUBJECT TYPE, not just per plane: a photo commit must not re-walk a
    // shared document.
    if (!planeMoved && touched && !subjectWokenBy(subject.subjectType, touched))
      continue;
    const pass = fulfillGrantsForSubject({
      host: input.host,
      originVaultId: input.originVaultId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      now: input.now,
    });
    if (pass.origin === "mounted") reports.push(...pass.reports);
  }
  // A revoke commits the plane; removal is carried here, not on the gesture.
  if (planeMoved)
    for (const grantId of pendingRemovals(origin))
      propagateGrantRemoval({
        host: input.host,
        originVaultId: input.originVaultId,
        grantId,
        now: input.now,
      });
  return { origin: "mounted", reports };
}

function wakes(
  touched: ReadonlySet<string> | undefined,
  wake: ReadonlySet<string>
): boolean {
  if (!touched) return true;
  for (const entity of touched) if (wake.has(entity)) return true;
  return false;
}

export interface GrantRefreshDoorbell {
  ring: (vaultId: string, touched?: readonly string[]) => void;
  stop: () => void;
}

/**
 * First ring passes immediately; the window collapses into one trailing pass.
 * Failures are swallowed: a doorbell that threw would turn a committed vault
 * write into an apparent failure.
 */
export function createGrantRefreshDoorbell(input: {
  host: GrantFulfillmentHost;
  windowMs?: number;
  now?: () => string;
}): GrantRefreshDoorbell {
  const windowMs = input.windowMs ?? 250;
  const clock = input.now ?? ((): string => new Date().toISOString());
  const windows = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      pending: boolean;
      touched: Set<string> | null;
    }
  >();
  const pass = (vaultId: string, touched: readonly string[] | null): void => {
    try {
      refreshGrantsAfterCommit({
        host: input.host,
        originVaultId: vaultId,
        now: clock(),
        ...(touched === null ? {} : { touched }),
      });
    } catch (error) {
      input.host.logger?.warn(
        `grant refresh for vault ${vaultId} could not run — ${reasonOf(error)}`
      );
    }
  };
  const arm = (vaultId: string): void => {
    const timer = setTimeout(() => {
      const open = windows.get(vaultId);
      windows.delete(vaultId);
      if (!open?.pending) return;
      // Answers for EVERY collapsed ring, so it carries their union.
      pass(vaultId, open.touched === null ? null : [...open.touched]);
      arm(vaultId);
    }, windowMs);
    unrefTimer(timer);
    windows.set(vaultId, { timer, pending: false, touched: new Set() });
  };
  return {
    ring: (vaultId, touched) => {
      const open = windows.get(vaultId);
      if (open) {
        // A GRANT WRITE is not churn: making a member gesture wait behind a
        // burst of content commits reports a sent share as unsent.
        if (touched?.includes(AUTHORITY_ENTITY) === true) {
          pass(vaultId, touched);
          return;
        }
        open.pending = true;
        if (touched === undefined) open.touched = null;
        else if (open.touched !== null)
          for (const entity of touched) open.touched.add(entity);
        return;
      }
      pass(vaultId, touched ?? null);
      arm(vaultId);
    },
    stop: () => {
      for (const open of windows.values()) clearTimeout(open.timer);
      windows.clear();
    },
  };
}
