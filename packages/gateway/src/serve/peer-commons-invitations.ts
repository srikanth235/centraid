import type { GatewayDatabase } from "./gateway-db.js";
import { invitePeerToCommons } from "./peer-commons-client.js";
import type { PeerDial } from "./peer-edge-give-client.js";
import { ShareEffectsStore } from "./share-effects.js";
import type { VaultLinksStore } from "./vault-links-store.js";

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60 * 1000;

/** Drain Commons invitations through the same bounded sharing-effect runner. */
export async function drainCommonsInvitationEffects(input: {
  db: GatewayDatabase;
  links: VaultLinksStore;
  dial: PeerDial;
  limit: number;
  now?: () => number;
}): Promise<{ delivered: string[] }> {
  const effects = new ShareEffectsStore(input.db);
  const now = input.now ?? Date.now;
  const delivered: string[] = [];
  for (const effect of effects.list({
    kind: "deliver-commons-invitation",
    active: true,
    dueAt: now(),
    limit: input.limit,
  })) {
    if (effect.kind !== "deliver-commons-invitation") continue;
    const link = input.links.peerForVault(
      effect.peerVaultId,
      effect.localVaultId
    );
    if (
      !link ||
      link.linkId !== effect.payload.linkId ||
      effect.localVaultId !== effect.payload.stewardVaultId ||
      effect.peerVaultId !== effect.payload.memberVaultId
    ) {
      effects.transition(effect.effectId, "denied");
      continue;
    }
    effects.transition(effect.effectId, "running");
    // oxlint-disable-next-line no-await-in-loop -- preserve durable effect order and the exact bounded row limit
    const accepted = await invitePeerToCommons({
      dial: input.dial,
      route: link.route,
      invitation: {
        grantId: effect.payload.grantId,
        stewardVaultId: effect.payload.stewardVaultId,
        memberVaultId: effect.payload.memberVaultId,
        memberPartyId: effect.payload.memberPartyId,
        capability: effect.payload.capability,
        containerType: effect.payload.containerType,
        containerId: effect.payload.containerId,
        ...(effect.payload.containerLabel
          ? { containerLabel: effect.payload.containerLabel }
          : {}),
        currentSizeBytes: effect.payload.currentSizeBytes,
        ...(effect.payload.maxSizeBytes === undefined
          ? {}
          : { maxSizeBytes: effect.payload.maxSizeBytes }),
      },
    });
    if (accepted) {
      effects.transition(effect.effectId, "executed", { attempted: true, now });
      delivered.push(effect.effectId);
      continue;
    }
    const delay = Math.min(
      RETRY_MAX_MS,
      RETRY_BASE_MS * 2 ** Math.min(effect.attempts, 5)
    );
    effects.transition(effect.effectId, "parked", {
      attempted: true,
      retryAt: now() + delay,
      now,
    });
  }
  return { delivered };
}
