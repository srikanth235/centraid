/** Bounded member→steward intent delivery and steward→member catch-up. */

import {
  commonsSeats,
  compileCommons,
  executeCommonsCommand,
  expireParkedCommonsIntents,
  readCommonsGrant,
  settleCommonsIntent,
  signCommonsIntent,
} from "@centraid/vault";
import type {
  Credential,
  Gateway as VaultGateway,
  VaultDb,
} from "@centraid/vault";

import {
  isCommonsIdentityRefusal,
  raiseCommonsIdentityNotice,
  raiseCommonsNotices,
} from "./commons-notices.js";
import type { CommonsStewardStatus } from "./commons-observability.js";
import { readCommonsStewardStatus } from "./commons-observability.js";
import {
  pullPeerCommons,
  sendPeerCommonsCommand,
} from "./peer-commons-client.js";
import type { PeerDial } from "./peer-link-client.js";
import type { VaultLinksStore } from "./vault-links-store.js";

/** Presences worth a log line — a closed episode or a healthy laptop-closed
 *  gap is not, an escalating or parked one is (#731). */
const NOTEWORTHY_PRESENCE = new Set([
  "degraded",
  "absent",
  "link-down",
  "parked",
]);

/**
 * Surface a degraded/absent/link-down/parked steward instead of dropping
 * `pullPeerCommons`'s status on the floor — `recordCommonsPull` already
 * persisted it durably (diagnostics + the recovery route read it back), this
 * is only the sweep's own log line so it shows up in the tail without an
 * operator having to query vault.db.
 */
function logStewardConcern(
  logger: { warn: (message: string) => void } | undefined,
  memberVaultId: string,
  status: CommonsStewardStatus
): void {
  if (!logger || !NOTEWORTHY_PRESENCE.has(status.presence)) return;
  const detail =
    status.presence === "parked"
      ? `fault ${status.fault ?? "unknown"}`
      : `silent ${status.silentForMs ?? 0}ms, ${status.consecutiveFailures} consecutive failures`;
  logger.warn(
    `commons steward ${status.presence} for grant ${status.grantId} (member ${memberVaultId}${status.stewardVaultId ? `, steward ${status.stewardVaultId}` : ""}) — ${detail}`
  );
}

export interface MountedCommonsVault {
  vaultId: string;
  db: VaultDb;
  /** Present for a fully mounted vault; omitted by narrow peer-only fixtures. */
  gateway?: VaultGateway;
  /** Host-held owner credential. It never crosses a member/app boundary. */
  credential?: Credential;
}

/** First retry delay after one failed dial; doubles per consecutive failure. */
export const COMMONS_SWEEP_BACKOFF_BASE_MS = 30 * 1000;
/** Ceiling: even a long-absent steward is re-probed at least hourly. */
export const COMMONS_SWEEP_BACKOFF_MAX_MS = 60 * 60 * 1000;

/**
 * Exponential per-grant backoff off the RECORDED absence evidence (#750
 * defect e). `share_commons_steward_contact` — written by every pull through
 * `recordCommonsPull` — already carries consecutive failures and the last
 * attempt time; the sweep consults it instead of serially dialing an absent
 * steward for every intent of every grant on every tick. Returns the epoch ms
 * before which this grant's steward should NOT be dialed, or undefined when
 * the evidence says it is worth trying now.
 */
function stewardBackoffUntil(
  db: VaultDb,
  grantId: string,
  memberVaultId: string
): number | undefined {
  // One reader of `share_commons_steward_contact`, not two: the observability
  // module owns how a contact row becomes a status, and the sweep asks it
  // rather than re-deriving "is this steward absent" from the raw columns. A
  // second local reading of the same evidence is how two answers to one
  // question drift apart.
  const status = readCommonsStewardStatus({
    db: db.vault,
    grantId,
    memberVaultId,
  });
  if (
    status.lastOutcome !== "unreachable" ||
    status.consecutiveFailures < 1 ||
    !status.lastAttemptAt
  )
    return undefined;
  const attempted = Date.parse(status.lastAttemptAt);
  if (!Number.isFinite(attempted)) return undefined;
  const backoff = Math.min(
    COMMONS_SWEEP_BACKOFF_BASE_MS * 2 ** (status.consecutiveFailures - 1),
    COMMONS_SWEEP_BACKOFF_MAX_MS
  );
  return attempted + backoff;
}

function backedOff(
  db: VaultDb,
  grantId: string,
  memberVaultId: string,
  nowMs: number
): boolean {
  const until = stewardBackoffUntil(db, grantId, memberVaultId);
  return until !== undefined && nowMs < until;
}

interface PendingIntent {
  intent_id: string;
  grant_id: string;
  actor_party_id: string;
  command: string;
  input_json: string;
  based_on_sequence: number;
}

function stewardVaultId(db: VaultDb, grantId: string): string | undefined {
  const grant = readCommonsGrant(db.vault, grantId);
  const row = db.vault
    .prepare(
      `SELECT vault_id FROM share_party_vault_binding
        WHERE party_id = ? AND revoked_at IS NULL`
    )
    .get(grant.stewardPartyId) as { vault_id: string } | undefined;
  return row?.vault_id;
}

export async function sweepPeerCommons(input: {
  vaults: readonly MountedCommonsVault[];
  links: VaultLinksStore;
  dial?: PeerDial;
  limit: number;
  now?: string;
  /** Same shape `PeerPlaneSweepOptions.logger` carries (#731). */
  logger?: { warn: (message: string) => void };
}): Promise<{ progressed: number }> {
  let progressed = 0;
  const mountedById = new Map(
    input.vaults.map((vault) => [vault.vaultId, vault] as const)
  );
  for (const local of input.vaults) {
    if (progressed >= input.limit) break;
    // Bounded parked-intent life (issue #731 goal 2): expire before this
    // seat's own retry pass, so a request that has waited past its review
    // window stops being retried and instead surfaces as terminal. Cheap
    // (one indexed UPDATE) and idempotent — the sweep is this overlay's only
    // periodic tick, so this is its natural home rather than a new timer.
    expireParkedCommonsIntents({
      seat: local.db.vault,
      now: input.now ?? new Date().toISOString(),
    });
    // Steward absence and consent-growth are conditions this seat already has
    // the evidence for; the sweep is the periodic tick that turns them into
    // the notices an owner actually sees (issue #750). A card must never cost
    // the sweep its real work, so a failure here is logged, not thrown.
    try {
      raiseCommonsNotices({
        db: local.db,
        vaultId: local.vaultId,
        ...(input.now ? { now: input.now } : {}),
      });
    } catch (error) {
      input.logger?.warn(
        `commons notices for ${local.vaultId} could not be raised: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const intents = local.db.vault
      .prepare(
        `SELECT intent_id, grant_id, actor_party_id, command, input_json,
                based_on_sequence
           FROM share_commons_intent
          WHERE status IN ('queued','parked')
          ORDER BY created_at, intent_id LIMIT ?`
      )
      .all(input.limit - progressed) as unknown as PendingIntent[];
    // Grants whose steward answered "unavailable" THIS tick: later intents for
    // the same grant skip the dial instead of repeating a known-dead call.
    const unreachableThisTick = new Set<string>();
    for (const intent of intents) {
      const stewardId = stewardVaultId(local.db, intent.grant_id);
      const mountedSteward = stewardId ? mountedById.get(stewardId) : undefined;
      if (
        stewardId &&
        mountedSteward?.gateway &&
        mountedSteward.credential &&
        local.db.identitySeed
      ) {
        const commandInput = JSON.parse(intent.input_json) as Record<
          string,
          unknown
        >;
        const now = input.now ?? new Date().toISOString();
        const seats = commonsSeats({
          steward: mountedSteward.db.vault,
          grantId: intent.grant_id,
          stewardVaultId: stewardId,
          vaultFor: (vaultId) => mountedById.get(vaultId)?.db,
          invokeFor: (vaultId, replicaCommand, replicaInput, invocationId) => {
            const mounted = mountedById.get(vaultId);
            if (!mounted?.gateway || !mounted.credential)
              throw new Error(
                `commons replica vault ${vaultId} is not mounted`
              );
            return mounted.gateway.invokeCommonsCanonical(
              mounted.credential,
              {
                command: replicaCommand,
                input: replicaInput,
                purpose: "dpv:ServiceProvision",
                invocationId,
              },
              { idSeed: invocationId }
            );
          },
        });
        const answer = executeCommonsCommand({
          steward: mountedSteward.db,
          gateway: mountedSteward.gateway,
          credential: mountedSteward.credential,
          stewardVaultId: stewardId,
          grantId: intent.grant_id,
          actorPartyId: intent.actor_party_id,
          command: intent.command,
          commandInput,
          seats,
          memberSignature: signCommonsIntent(local.db.identitySeed, {
            grantId: intent.grant_id,
            actorPartyId: intent.actor_party_id,
            command: intent.command,
            commandInput,
            memberVaultId: local.vaultId,
            nonce: intent.intent_id,
          }),
          basedOnSequence: intent.based_on_sequence,
          intentId: intent.intent_id,
          now,
        });
        if (answer.decision.accepted) {
          if (!answer.seats) {
            // The steward already committed this signed nonce on an earlier
            // attempt, but that attempt may have died before fan-out. Rebuild
            // the member seats before making the local intent terminal.
            compileCommons({
              steward: mountedSteward.db,
              stewardVaultId: stewardId,
              grantId: intent.grant_id,
              seats,
              now,
              // Crash repair, not ordinary fan-out: the earlier attempt died
              // at an unknown point, so the seats are reconciled from the
              // closure rather than from a tail whose replay may already have
              // committed.
              forceFullProjection: true,
            });
          }
          // `executeCommonsCommand` normally settles while compiling. Repeat
          // the exact-id update so crash replay through `priorSignedDecision`
          // also reaches the member's durable terminal state.
          settleCommonsIntent({
            seat: local.db.vault,
            intentId: intent.intent_id,
            status: "executed",
            now,
          });
        } else {
          // A refusal is itself an ordered Commons operation. The domain
          // closure did not change, but every joined seat must observe the
          // same log/cursor result as it would over the peer bootstrap rail.
          compileCommons({
            steward: mountedSteward.db,
            stewardVaultId: stewardId,
            grantId: intent.grant_id,
            seats,
            now,
          });
          settleCommonsIntent({
            seat: local.db.vault,
            intentId: intent.intent_id,
            status: "denied",
            ...(answer.decision.reason
              ? { reason: answer.decision.reason }
              : {}),
            now,
          });
          if (isCommonsIdentityRefusal(answer.decision.reason))
            raiseCommonsIdentityNotice({
              db: local.db,
              grantId: intent.grant_id,
              reason: answer.decision.reason!,
              now,
            });
        }
        progressed += 1;
        continue;
      }
      const link = stewardId
        ? input.links.peerForVault(stewardId, local.vaultId)
        : undefined;
      if (!stewardId || !link || !input.dial) continue;
      // Absence-evidence backoff (#750 defect e): a steward the contact
      // record says is unreachable is not dialed again — per intent, per
      // grant — until its exponential window has elapsed.
      if (
        unreachableThisTick.has(intent.grant_id) ||
        backedOff(
          local.db,
          intent.grant_id,
          local.vaultId,
          Date.parse(input.now ?? new Date().toISOString())
        )
      )
        continue;
      const commandInput = JSON.parse(intent.input_json) as Record<
        string,
        unknown
      >;
      const signature = signCommonsIntent(local.db.identitySeed, {
        grantId: intent.grant_id,
        actorPartyId: intent.actor_party_id,
        command: intent.command,
        commandInput,
        memberVaultId: local.vaultId,
        nonce: intent.intent_id,
      });
      // oxlint-disable-next-line no-await-in-loop -- signed intents must reach the steward in their durable created-at order
      const answer = await sendPeerCommonsCommand({
        dial: input.dial,
        route: link.route,
        stewardVaultId: stewardId,
        memberVaultId: local.vaultId,
        grantId: intent.grant_id,
        actorPartyId: intent.actor_party_id,
        command: intent.command,
        commandInput,
        memberSignature: signature,
        basedOnSequence: intent.based_on_sequence,
        intentId: intent.intent_id,
      });
      const now = input.now ?? new Date().toISOString();
      if (answer.state === "executed") {
        settleCommonsIntent({
          seat: local.db.vault,
          intentId: intent.intent_id,
          status: "executed",
          now,
        });
        // oxlint-disable-next-line no-await-in-loop -- catch-up must follow this intent's steward commit before the next intent is attempted
        const catchUp = await pullPeerCommons({
          dial: input.dial,
          route: link.route,
          stewardVaultId: stewardId,
          memberVaultId: local.vaultId,
          grantId: intent.grant_id,
          seat: local.db,
          ...(local.gateway && local.credential
            ? { gateway: local.gateway, credential: local.credential }
            : {}),
          now,
        });
        logStewardConcern(input.logger, local.vaultId, catchUp.steward);
        progressed += 1;
      } else if (answer.state === "refused") {
        settleCommonsIntent({
          seat: local.db.vault,
          intentId: intent.intent_id,
          status: "denied",
          reason: answer.reason,
          now,
        });
        // A refusal the member cannot fix by editing the command: their vault
        // identity is not the one this commons pinned (issue #750). Name it
        // where they will see it, pointing at re-invitation.
        if (isCommonsIdentityRefusal(answer.reason))
          raiseCommonsIdentityNotice({
            db: local.db,
            grantId: intent.grant_id,
            reason: answer.reason!,
            now,
          });
        progressed += 1;
      } else unreachableThisTick.add(intent.grant_id);
    }

    const grants = local.db.vault
      .prepare(
        `SELECT grant_id FROM share_circle_grant
          WHERE plane = 'commons' AND revoked_at IS NULL
          ORDER BY grant_id LIMIT ?`
      )
      .all(input.limit - progressed) as { grant_id: string }[];
    for (const row of grants) {
      if (progressed >= input.limit) break;
      const grant = readCommonsGrant(local.db.vault, row.grant_id);
      const localOwner = local.db.vault
        .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
        .get() as { owner_party_id: string } | undefined;
      if (localOwner?.owner_party_id === grant.stewardPartyId) continue;
      const stewardId = stewardVaultId(local.db, grant.grantId);
      const link = stewardId
        ? input.links.peerForVault(stewardId, local.vaultId)
        : undefined;
      if (!stewardId || !link || !input.dial) continue;
      // Same absence-evidence backoff as the intent lane (#750 defect e).
      if (
        backedOff(
          local.db,
          grant.grantId,
          local.vaultId,
          Date.parse(input.now ?? new Date().toISOString())
        )
      )
        continue;
      // oxlint-disable-next-line no-await-in-loop -- serial pulls keep the shared progress limit exact and the grant order deterministic
      const result = await pullPeerCommons({
        dial: input.dial,
        route: link.route,
        stewardVaultId: stewardId,
        memberVaultId: local.vaultId,
        grantId: grant.grantId,
        seat: local.db,
        ...(local.gateway && local.credential
          ? { gateway: local.gateway, credential: local.credential }
          : {}),
        now: input.now,
      });
      logStewardConcern(input.logger, local.vaultId, result.steward);
      if (result.state === "current") progressed += 1;
    }
  }
  return { progressed };
}
