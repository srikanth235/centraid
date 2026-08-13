/*
 * Adaptive peer maintenance. Since #750 there is ONE queue to drain — the
 * share outbox (`share_effects`) — instead of a per-lifecycle drainer for
 * give bytes and another for refusal relays; the commons sweep and the route
 * re-announcement remain their own concerns.
 */

import type {
  Credential,
  Gateway as VaultGateway,
  ShareVaultRef,
  VaultDb,
} from "@centraid/vault";

import type { GatewayDatabase } from "./gateway-db.js";
import { sweepPeerCommons } from "./peer-commons-sweep.js";
import type { PeerDial } from "./peer-edge-give-client.js";
import { drainShareEffects } from "./share-effect-executor.js";
import type { VaultLinksStore } from "./vault-links-store.js";

const DEFAULT_ROW_LIMIT = 25;
const DEFAULT_ACTIVE_MS = 5_000;
const DEFAULT_IDLE_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

export interface PeerPlaneSweepOptions {
  db: GatewayDatabase;
  links: VaultLinksStore;
  vaultFor: (vaultId: string) => ShareVaultRef | undefined;
  commonsVaults?: () => readonly {
    vaultId: string;
    db: VaultDb;
    gateway?: VaultGateway;
    credential?: Credential;
  }[];
  dial: () => PeerDial | undefined;
  /**
   * Re-announce this gateway's EndpointId to linked peers when it changed
   * and some peer has not heard it yet (issue #750 invariant 3 — the retry
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
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const schedule = (delayMs: number): void => {
    if (!running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), delayMs);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (options.shouldDefer?.()) {
      schedule(idleMs);
      return;
    }
    const dial = options.dial();
    try {
      // Route announcements first: a peer that moved cannot be dialed for
      // pulls/refusals until IT has re-asserted to us, but our own move must
      // not wait behind this tick's other work either way.
      if (options.announceRoutes) await options.announceRoutes();
      const [effects, commons] = await Promise.all([
        drainShareEffects(
          {
            db: options.db,
            links: options.links,
            vaultFor: options.vaultFor,
            ...(dial ? { dial } : {}),
          },
          { limit: rowLimit }
        ),
        options.commonsVaults
          ? sweepPeerCommons({
              vaults: options.commonsVaults(),
              links: options.links,
              ...(dial ? { dial } : {}),
              ...(options.logger ? { logger: options.logger } : {}),
              limit: rowLimit,
            })
          : Promise.resolve({ progressed: 0 }),
      ]);
      const progressed =
        effects.done.length > 0 ||
        effects.abandoned.length > 0 ||
        commons.progressed > 0;
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
