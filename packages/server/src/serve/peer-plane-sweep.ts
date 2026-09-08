/*
 * Adaptive peer maintenance. #750's ONE-queue rule — one drain per tick rather
 * than a drainer per lifecycle — still governs, but the queue it named is gone:
 * `share_effects` and the whole share outbox were deleted with the give-plane
 * residue (#928 AP-give-residue), a same-owner placement being one call
 * (`placeItemsInVault`) rather than a durable obligation to retry.
 *
 * What this tick drains now is the SUBSCRIPTION sweep (#929) — the peer-routed
 * shapes an origin owes its audiences — beside the route re-announcement, which
 * has always been its own concern. Both dial; neither is an outbox.
 */

import type { ShareVaultRef, VaultDb } from "@centraid/vault";

import { unrefTimer } from "../lib/unref-timer.js";
import type { GatewayDatabase } from "./gateway-db.js";
import type { PeerDial } from "./peer-link-client.js";
import { sweepShareSubscriptions } from "./share-subscription-sweep.js";
import type { VaultLinksStore } from "./vault-links-store.js";

const DEFAULT_ROW_LIMIT = 25;
const DEFAULT_ACTIVE_MS = 5_000;
const DEFAULT_IDLE_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

export interface PeerPlaneSweepOptions {
  db: GatewayDatabase;
  links: VaultLinksStore;
  vaultFor: (vaultId: string) => ShareVaultRef | undefined;
  /** The vaults whose peer-routed subscriptions this tick may drain (#929). */
  subscriptionVaults?: () => readonly { vaultId: string; db: VaultDb }[];
  dial: () => PeerDial | undefined;
  /**
   * Re-announce this gateway's EndpointId to linked peers when it changed
   * and some peer has not heard it yet (#750 invariant 3 — the retry
   * half of `announceLocalRoutes`; the eager half runs at endpoint start).
   * Must never throw for a network condition.
   */
  announceRoutes?: () => Promise<unknown>;
  rowLimit?: number;
  idleIntervalMs?: number;
  activeIntervalMs?: number;
  shouldDefer?: () => boolean;
  logger?: { warn: (message: string) => void };
}

export interface PeerPlaneSweep {
  start: () => void;
  stop: () => void;
  /** Doorbell only: durable rows remain the source of truth. */
  nudge: () => void;
  runOnce: () => Promise<void>;
}

export function createPeerPlaneSweep(
  options: PeerPlaneSweepOptions
): PeerPlaneSweep {
  const idleMs = options.idleIntervalMs ?? DEFAULT_IDLE_MS;
  const activeMs = options.activeIntervalMs ?? DEFAULT_ACTIVE_MS;
  const rowLimit = options.rowLimit ?? DEFAULT_ROW_LIMIT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const schedule = (delayMs: number): void => {
    if (!running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), delayMs);
    unrefTimer(timer);
  };

  const tick = async (): Promise<void> => {
    if (options.shouldDefer?.()) {
      schedule(idleMs);
      return;
    }
    const dial = options.dial();
    try {
      // Route announcements first: a peer that moved cannot be dialed for a
      // delivery until IT has re-asserted to us, and our own move must not
      // wait behind this tick's other work either way.
      if (options.announceRoutes) await options.announceRoutes();
      // The peer-routed half of a subscription (#929): the pass that started
      // it left the row pending because a dial has no business on a commit
      // path, and this is what rings the audience.
      let delivered = 0;
      if (options.subscriptionVaults && dial)
        for (const origin of options.subscriptionVaults()) {
          // oxlint-disable-next-line no-await-in-loop -- (#929) one origin never costs another: a stalled dial must not fan out across every mounted vault at once
          const steps = await sweepShareSubscriptions({
            origin: origin.db,
            originVaultId: origin.vaultId,
            dial,
            routeTo: (audienceVaultId) =>
              options.links.peerForVault(audienceVaultId, origin.vaultId)
                ?.route,
            now: () => new Date().toISOString(),
            limit: rowLimit,
          });
          delivered += steps.filter(
            (step) => step.result.outcome !== "unreachable"
          ).length;
        }
      const progressed = delivered > 0;
      schedule(progressed ? activeMs : idleMs);
    } catch (error) {
      options.logger?.warn(
        `peer plane sweep failed: ${error instanceof Error ? error.message : String(error)}`
      );
      schedule(Math.min(idleMs * 2, MAX_BACKOFF_MS));
    }
  };

  return {
    start(): void {
      if (!running) {
        running = true;
        schedule(0);
      }
    },
    stop(): void {
      running = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    nudge(): void {
      if (running) schedule(0);
    },
    runOnce: tick,
  };
}
