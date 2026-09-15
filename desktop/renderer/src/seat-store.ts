/*
 * Everything the screens read, as one external store (#1020 lane F).
 *
 * `React.useSyncExternalStore` and not an effect that calls `setState`: the
 * seat is an external system that **pushes** — main holds the socket and
 * broadcasts the four states, so subscribing is the right shape and an effect
 * that set state synchronously would cascade a render per message. The store
 * also puts every decision in a plain object with no React in it, which is why
 * `seat-store.test.ts` can drive the whole load path against a fake bridge.
 *
 * One snapshot for all of it, for the same reason the sidecar sends the four
 * states as one message: a screen drawn from a half-updated pair is a screen
 * drawn from a state that never existed.
 */

import type { SeatState } from "../../electron/src/main/seat-state-core.js";
import { foldDashboard, foldPhotos } from "./apps/tally/fold.js";
import type { Page, PhotoTile, TallyDashboard } from "./apps/tally/fold.js";

/** The surface the preload exposes. */
export interface CentraidApi {
  page: (input: {
    statement: string;
    limit: number;
    after?: { sort_key: string; pk: string };
  }) => Promise<Page>;
  getSeatState: () => Promise<SeatState | undefined>;
  onSeatState: (callback: (state: SeatState) => void) => () => void;
  getSeatFailure: () => Promise<{
    loopBroken: boolean;
    message: string;
  } | null>;
  retrySeat: () => Promise<unknown>;
}

export interface Snapshot {
  state?: SeatState;
  /** Why the seat is not running, when it is not. */
  failure?: string;
  dashboard?: TallyDashboard;
  photos?: PhotoTile[];
  /** One line per statement the seat refused, so a screen can say which. */
  refusals: string[];
  /** Whether a load is in flight. */
  loading: boolean;
}

/** v0's `MAX_PAGE_ROWS`. A ceiling that clamps rather than refuses. */
export const PAGE_LIMIT = 200;

const TALLY_STATEMENTS = [
  "tally.vault",
  "tally.friends",
  "tally.groups",
  "tally.circles",
  "tally.circleMembers",
  "tally.expenses",
  "tally.settlements",
  "tally.obligations",
] as const;

const PHOTO_STATEMENTS = [
  "photos.assets",
  "photos.content",
  "photos.representations",
] as const;

/** Every statement the shell reads, so the drift test has one list. */
export const STATEMENTS: readonly string[] = [
  ...TALLY_STATEMENTS,
  ...PHOTO_STATEMENTS,
];

export interface SeatStore {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => Snapshot;
  /** Re-read every page. Returns when the load has settled. */
  load: () => Promise<void>;
  retry: () => Promise<void>;
}

const EMPTY: Snapshot = { refusals: [], loading: false };

export function createSeatStore(api: CentraidApi | undefined): SeatStore {
  let snapshot: Snapshot = EMPTY;
  const listeners = new Set<() => void>();
  let started = false;

  const publish = (next: Partial<Snapshot>): void => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };

  const load = async (): Promise<void> => {
    if (!api) return;
    publish({ loading: true });
    const refusals: string[] = [];
    const pages = await Promise.all(
      STATEMENTS.map(async (statement) => {
        try {
          return await api.page({ statement, limit: PAGE_LIMIT });
        } catch (error) {
          // A REFUSAL IS NOT AN EMPTY PAGE. Answering `{rows: []}` here is
          // exactly how a seat that cannot see the vault tells the member it is
          // empty, so the reason is kept and the screen says which read failed.
          refusals.push(
            `${statement}: ${error instanceof Error ? error.message : String(error)}`
          );
          return undefined;
        }
      })
    );
    const at = (statement: string): Page | undefined =>
      pages[STATEMENTS.indexOf(statement)];
    const anyTally = TALLY_STATEMENTS.some((name) => at(name) !== undefined);
    const assets = at("photos.assets");
    publish({
      loading: false,
      refusals,
      ...(anyTally
        ? {
            dashboard: foldDashboard({
              vault: at("tally.vault"),
              friends: at("tally.friends"),
              groups: at("tally.groups"),
              circles: at("tally.circles"),
              circleMembers: at("tally.circleMembers"),
              expenses: at("tally.expenses"),
              settlements: at("tally.settlements"),
              obligations: at("tally.obligations"),
            }),
          }
        : { dashboard: undefined }),
      ...(assets
        ? {
            photos: foldPhotos({
              assets,
              content: at("photos.content"),
              representations: at("photos.representations"),
            }),
          }
        : { photos: undefined }),
    });
  };

  const start = (): void => {
    if (started || !api) return;
    started = true;
    void api.getSeatState().then((first) => {
      if (first) publish({ state: first });
    });
    void api.getSeatFailure().then((why) => publish({ failure: why?.message }));
    void load();
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      start();
      // The push subscription lives for as long as the store has a listener:
      // main broadcasts on every change, and a state that arrived while
      // nothing was listening is superseded by the next one anyway.
      const unsubscribePush = api?.onSeatState((state) => {
        publish({ state });
      });
      return () => {
        listeners.delete(listener);
        unsubscribePush?.();
      };
    },
    // A STABLE OBJECT between publishes: `useSyncExternalStore` compares
    // snapshots by identity and a fresh object every call is an infinite
    // render loop.
    snapshot: () => snapshot,
    load,
    retry: async () => {
      if (!api) return;
      publish({ failure: undefined });
      try {
        await api.retrySeat();
      } catch (error) {
        publish({
          failure: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      await load();
    },
  };
}
