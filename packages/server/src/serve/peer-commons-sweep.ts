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

const NOTEWORTHY_PRESENCE = new Set([
  "degraded",
  "absent",
  "link-down",
  "parked",
]);

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
  gateway?: VaultGateway;
  credential?: Credential;
}

export const COMMONS_SWEEP_BACKOFF_BASE_MS = 30 * 1000;
export const COMMONS_SWEEP_BACKOFF_MAX_MS = 60 * 60 * 1000;

/** Backoff off RECORDED absence evidence (#750 defect e). Epoch ms before
 *  which not to dial, or undefined when it is worth trying now. */
function stewardBackoffUntil(
  db: VaultDb,
  grantId: string,
  memberVaultId: string
): number | undefined {
  // One reader of `share_commons_steward_contact` — never re-derive here.
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
  logger?: { warn: (message: string) => void };
}): Promise<{ progressed: number }> {
  let progressed = 0;
  const mountedById = new Map(
    input.vaults.map((vault) => [vault.vaultId, vault] as const)
  );
  for (const local of input.vaults) {
    if (progressed >= input.limit) break;
    // Before this seat's retry pass, so a request past its review window
    // goes terminal (#731 goal 2).
    expireParkedCommonsIntents({
      seat: local.db.vault,
      now: input.now ?? new Date().toISOString(),
    });
    // A card must never cost the sweep its real work: log, never throw.
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
    // Later intents for the same grant skip a dial already known dead.
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
            // Already committed on an attempt that may have died before
            // fan-out: rebuild seats first.
            compileCommons({
              steward: mountedSteward.db,
              stewardVaultId: stewardId,
              grantId: intent.grant_id,
              seats,
              now,
              // Crash repair: reconcile from the closure, not a tail whose
              // replay may already have committed.
              forceFullProjection: true,
            });
          }
          // Repeat the exact-id update so crash replay also goes terminal.
          settleCommonsIntent({
            seat: local.db.vault,
            intentId: intent.intent_id,
            status: "executed",
            now,
          });
        } else {
          // A refusal is itself an ordered Commons operation.
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
      // Absence-evidence backoff (#750 defect e), per intent per grant.
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
        // No edit to the command fixes this: the vault identity is not the
        // one this commons pinned (#750).
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
        .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
        .get() as { self_party_id: string } | undefined;
      if (localOwner?.self_party_id === grant.stewardPartyId) continue;
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
