/*
 * The host seam for the grant fulfillment engine (#825). The engine must NOT
 * learn which vaults this host mounted; this file is the join, turning the
 * vault registry into `seatFor`. One audience must never cost another: a
 * failing grant is reported as that grant's failure and the pass carries on.
 * Delivery is best-effort — nothing here retries or promotes `remove_sent`.
 */

import {
  fulfillShareGrant,
  listShareGrantsForSubject,
  propagateShareGrantRevocation,
} from "@centraid/vault";
import type {
  GrantFulfillmentResult,
  GrantRemovalResult,
  ShareableItemType,
  VaultDb,
} from "@centraid/vault";

export interface GrantFulfillmentHost {
  /** `undefined` is a fact about this HOST, never about the grant. */
  vaultFor: (vaultId: string) => VaultDb | undefined;
  logger?: { warn: (message: string) => void };
}

export type GrantFulfillmentReport =
  | { grantId: string; outcome: "fulfilled"; result: GrantFulfillmentResult }
  | { grantId: string; outcome: "failed"; reason: string };

/** `unmounted` is NOT an empty `reports` list, and collapsing the two tells an
 * owner their share reached nobody when nobody looked. */
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

function passOne(input: {
  host: GrantFulfillmentHost;
  origin: VaultDb;
  originVaultId: string;
  grantId: string;
  subjectLabel?: string;
  now: string;
}): GrantFulfillmentReport {
  try {
    return {
      grantId: input.grantId,
      outcome: "fulfilled",
      result: fulfillShareGrant({
        origin: input.origin,
        originVaultId: input.originVaultId,
        grantId: input.grantId,
        seatFor: (vaultId) => input.host.vaultFor(vaultId),
        ...(input.subjectLabel === undefined
          ? {}
          : { subjectLabel: input.subjectLabel }),
        now: input.now,
      }),
    };
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

/** Run by the share gesture itself, so its answer is where the share got to. */
export function fulfillGrant(input: {
  host: GrantFulfillmentHost;
  originVaultId: string;
  grantId: string;
  subjectLabel?: string;
  now: string;
}): GrantFulfillmentPass {
  const origin = input.host.vaultFor(input.originVaultId);
  if (!origin) return unmounted(input.originVaultId);
  return {
    origin: "mounted",
    reports: [
      passOne({
        host: input.host,
        origin,
        originVaultId: input.originVaultId,
        grantId: input.grantId,
        ...(input.subjectLabel === undefined
          ? {}
          : { subjectLabel: input.subjectLabel }),
        now: input.now,
      }),
    ],
  };
}

/** The delivery half of a revocation, and the ONLY writer of `removed`. */
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
 * ─── the subject-change doorbell ───
 *
 * A grant is not a snapshot (ruling G-membership). The doorbell names committed
 * ENTITY TYPES, never rows, so the pass MUST cover every live grant SUBJECT:
 * a photo added to a shared album commits the membership row, not the album.
 * Re-projection is idempotent in OUTCOME, not free — the audience's change
 * stream sees a delete-then-insert.
 */

function liveGrantSubjects(
  origin: VaultDb
): { subjectType: ShareableItemType; subjectId: string }[] {
  return (
    origin.vault
      .prepare(
        `SELECT DISTINCT subject_type, subject_id FROM share_grant
          WHERE revoked_at IS NULL ORDER BY subject_type, subject_id`
      )
      .all() as { subject_type: string; subject_id: string }[]
  ).map((row) => ({
    subjectType: row.subject_type as ShareableItemType,
    subjectId: row.subject_id,
  }));
}

/** Failure-isolated by `passOne`: one bad audience stops nothing. */
export function refreshGrantsAfterCommit(input: {
  host: GrantFulfillmentHost;
  originVaultId: string;
  now: string;
}): GrantFulfillmentPass {
  const origin = input.host.vaultFor(input.originVaultId);
  if (!origin) return unmounted(input.originVaultId);
  const reports: GrantFulfillmentReport[] = [];
  for (const subject of liveGrantSubjects(origin)) {
    const pass = fulfillGrantsForSubject({
      host: input.host,
      originVaultId: input.originVaultId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      now: input.now,
    });
    if (pass.origin === "mounted") reports.push(...pass.reports);
  }
  return { origin: "mounted", reports };
}

export interface GrantRefreshDoorbell {
  ring: (vaultId: string) => void;
  stop: () => void;
}

/**
 * The first ring passes immediately and the rest of the window collapses into
 * one trailing pass. Failures are swallowed by construction: a doorbell that
 * threw would turn a committed vault write into an apparent failure.
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
    { timer: NodeJS.Timeout; pending: boolean }
  >();
  const pass = (vaultId: string): void => {
    try {
      refreshGrantsAfterCommit({
        host: input.host,
        originVaultId: vaultId,
        now: clock(),
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
      pass(vaultId);
      arm(vaultId);
    }, windowMs);
    timer.unref();
    windows.set(vaultId, { timer, pending: false });
  };
  return {
    ring: (vaultId) => {
      const open = windows.get(vaultId);
      if (open) {
        open.pending = true;
        return;
      }
      pass(vaultId);
      arm(vaultId);
    },
    stop: () => {
      for (const open of windows.values()) clearTimeout(open.timer);
      windows.clear();
    },
  };
}
