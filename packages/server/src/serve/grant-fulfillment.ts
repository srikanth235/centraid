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
  vaultFor: (vaultId: string) => VaultDb | undefined;
  logger?: { warn: (message: string) => void };
}

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
  if (cached && touched && !touched.has(AUTHORITY_ENTITY)) return cached;
  const built = buildIndex(origin);
  byVault.set(vaultId, built);
  return built;
}

export type GrantFulfillmentReport =
  | { grantId: string; outcome: "fulfilled"; result: GrantFulfillmentResult }
  | { grantId: string; outcome: "failed"; reason: string };

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

function liveGrantSubjects(
  origin: VaultDb
): { subjectType: ShareableItemType; subjectId: string }[] {
  return (
    origin.vault
      .prepare(
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
