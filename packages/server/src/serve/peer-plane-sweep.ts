import type {
  Credential,
  Gateway as VaultGateway,
  ShareVaultRef,
  VaultDb,
} from "@centraid/vault";

import { unrefTimer } from "../lib/unref-timer.js";
import type { GatewayDatabase } from "./gateway-db.js";
import { sweepPeerCommons } from "./peer-commons-sweep.js";
import type { PeerDial } from "./peer-link-client.js";
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
  partyIdFor: (vaultId: string) => string | undefined;
  commonsVaults?: () => readonly {
    vaultId: string;
    db: VaultDb;
    gateway?: VaultGateway;
    credential?: Credential;
  }[];
  dial: () => PeerDial | undefined;
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
      if (options.announceRoutes) await options.announceRoutes();
      const effects = drainShareEffects(
        {
          db: options.db,
          vaultFor: options.vaultFor,
          partyIdFor: options.partyIdFor,
        },
        { limit: rowLimit }
      );
      const commons = options.commonsVaults
        ? await sweepPeerCommons({
            vaults: options.commonsVaults(),
            links: options.links,
            ...(dial ? { dial } : {}),
            ...(options.logger ? { logger: options.logger } : {}),
            limit: rowLimit,
          })
        : { progressed: 0 };
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
