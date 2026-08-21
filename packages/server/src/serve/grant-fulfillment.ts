/*
 * The host seam for the grant plane's fulfillment engine (issue #825).
 *
 * The engine in `@centraid/vault` knows how to keep one grant true; it does
 * not know which vaults this host has mounted, and it must not. This file is
 * the join: it turns the gateway's vault registry into the engine's `seatFor`
 * and drives the two host-level questions —
 *
 *   - a SUBJECT changed, so every live grant over it has work to do;
 *   - a grant was REVOKED, so its removal has to go out.
 *
 * One audience must never cost another. A grant that fails — a subject over
 * its ceiling, an audience vault that will not open — is reported as a failure
 * for THAT grant and the pass carries on, because the alternative is one
 * unreachable peer silently stalling every other person's copy.
 *
 * Delivery is best-effort by nature and the report says so plainly: nothing
 * here retries, waits, or promotes a `remove_sent` into a `removed`. What the
 * host could do, it did; the fulfillment rows are the durable record of the
 * rest.
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

/** What the host can reach right now. */
export interface GrantFulfillmentHost {
  /** The mounted vault for a gateway vault id, or `undefined` when it is not
   *  mounted here — a fact about this host, never about the grant. */
  vaultFor: (vaultId: string) => VaultDb | undefined;
  logger?: { warn: (message: string) => void };
}

/** One grant's pass. `failed` carries the reason instead of throwing it. */
export type GrantFulfillmentReport =
  | { grantId: string; outcome: "fulfilled"; result: GrantFulfillmentResult }
  | { grantId: string; outcome: "failed"; reason: string };

/**
 * A whole pass, and whether it could run at all.
 *
 * `unmounted` is NOT an empty `reports` list. "This host cannot see the origin
 * vault" and "the origin vault has no grants over this subject" are different
 * facts, and a caller that renders them the same would tell an owner their
 * share reached nobody when the truth is that nobody looked. Every read on
 * this seam keeps the two apart, all the way out to the route's wire shape.
 */
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

/** One grant's pass, isolated: its failure is reported, never thrown on. */
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

/**
 * Carry a subject's current truth to every live grant over it. Called after
 * the subject changed — a photo added to a shared album, a document edited —
 * which is the whole of "view grants sync forward".
 */
export function fulfillGrantsForSubject(input: {
  host: GrantFulfillmentHost;
  /** The vault the subject lives in, and its gateway id. */
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

/**
 * One named grant's pass — what a share gesture runs the instant it is made,
 * so the owner's answer carries where their share actually got to rather than
 * a promise that some later sweep will look.
 */
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

/**
 * Send one revoked grant's removal out to the audience vaults it was
 * delivered to. The store dated the revocation already; this is the delivery
 * half, and it is the only thing that ever writes `removed`.
 */
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
 * ── The subject-change doorbell ────────────────────────────────────────────
 *
 * A grant is not a snapshot (ruling G-membership), so the audience's copy has
 * to follow the origin's edits. The gateway's post-commit doorbell is the
 * signal available for that, and it names committed ENTITY TYPES — never rows.
 * That is why the pass below is over every live grant SUBJECT in the vault
 * rather than the types that were written: a photo added to a shared album
 * commits the membership row, not the album, and narrowing by type would drop
 * exactly the case the ruling exists to guarantee.
 *
 * Re-projection is idempotent in OUTCOME, not free and not invisible: each
 * pass scrubs and re-projects every live grant's closure, so row ids stay
 * stable but the audience's change stream sees a full delete-then-insert.
 * The doorbell also rings on EVERY provenance commit, not only on commons
 * commands the way `recompileCommonsGrants` does, and the first ring of a
 * window runs its pass inline on the committing request's path. A vault with
 * no live grants pays one indexed read and stops, which is the overwhelming
 * majority of commits; the rest is v1's accepted cost of keeping a standing
 * grant true without a diff the engine deliberately does not keep.
 */

/** Distinct live grant subjects in one vault, oldest grant first. */
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

/**
 * Bring every live grant in one vault back up to the origin's current truth.
 * Failure-isolated per grant by `passOne`, so one unreachable audience or one
 * over-ceiling subject never stops the others.
 */
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
  /** A vault just committed; its grants may have work to do. */
  ring: (vaultId: string) => void;
  /** Drop every open coalescing window (gateway shutdown). */
  stop: () => void;
}

/**
 * Coalesce commit doorbells per vault. A burst of writes — an import, a
 * document being typed into — must not run one whole re-projection pass per
 * commit, so the first ring passes immediately and the rest of the window
 * collapses into a single trailing pass.
 *
 * Every pass is swallowed on failure by construction: a doorbell that threw
 * would turn a committed vault write into an apparent failure, and the grant
 * plane's durable state (the fulfillment rows) is what actually records where
 * delivery stands.
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
