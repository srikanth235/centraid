/** Bounded member→steward intent delivery and steward→member catch-up. */

import {
  commonsSeats,
  compileCommons,
  executeCommonsCommand,
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
  pullPeerCommons,
  sendPeerCommonsCommand,
} from "./peer-commons-client.js";
import type { PeerDial } from "./peer-edge-give-client.js";
import type { VaultLinksStore } from "./vault-links-store.js";

export interface MountedCommonsVault {
  vaultId: string;
  db: VaultDb;
  /** Present for a fully mounted vault; omitted by narrow peer-only fixtures. */
  gateway?: VaultGateway;
  /** Host-held owner credential. It never crosses a member/app boundary. */
  credential?: Credential;
}

interface PendingIntent {
  intent_id: string;
  grant_id: string;
  actor_party_id: string;
  command: string;
  input_json: string;
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
}): Promise<{ progressed: number }> {
  let progressed = 0;
  const mountedById = new Map(
    input.vaults.map((vault) => [vault.vaultId, vault] as const)
  );
  for (const local of input.vaults) {
    if (progressed >= input.limit) break;
    const intents = local.db.vault
      .prepare(
        `SELECT intent_id, grant_id, actor_party_id, command, input_json
           FROM share_commons_intent
          WHERE status IN ('pending','parked')
          ORDER BY created_at, intent_id LIMIT ?`
      )
      .all(input.limit - progressed) as unknown as PendingIntent[];
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
        }
        progressed += 1;
        continue;
      }
      const link = stewardId
        ? input.links.peerForVault(stewardId, local.vaultId)
        : undefined;
      if (!stewardId || !link || !input.dial) continue;
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
        await pullPeerCommons({
          dial: input.dial,
          route: link.route,
          stewardVaultId: stewardId,
          memberVaultId: local.vaultId,
          grantId: intent.grant_id,
          seat: local.db,
          now,
        });
        progressed += 1;
      } else if (answer.state === "refused") {
        settleCommonsIntent({
          seat: local.db.vault,
          intentId: intent.intent_id,
          status: "denied",
          reason: answer.reason,
          now,
        });
        progressed += 1;
      }
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
      // oxlint-disable-next-line no-await-in-loop -- serial pulls keep the shared progress limit exact and the grant order deterministic
      const result = await pullPeerCommons({
        dial: input.dial,
        route: link.route,
        stewardVaultId: stewardId,
        memberVaultId: local.vaultId,
        grantId: grant.grantId,
        seat: local.db,
        now: input.now,
      });
      if (result.state === "current") progressed += 1;
    }
  }
  return { progressed };
}
