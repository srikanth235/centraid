// One poll for every status bar on screen, and none while the app is away.
//
// `ReplicaStatusBar` renders on sixteen screens and each copy used to own a 5 s
// `setInterval` that opened the intent outbox. A native stack keeps the screens
// below the top one mounted, so the phone was running a handful of redundant
// SQLite reads every five seconds — including all night, because nothing was
// listening to `AppState`. The queue is device-global, so one ticker can serve
// every subscriber, and a backgrounded app has nobody to show the answer to.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

export interface PendingChange {
  id: string;
  vaultId: string;
  vaultLabel: string;
  status: string;
  label: string;
  reason?: string;
  kind: "replica" | "placement";
  /** Which app issued the write, so one app's list marks only its own rows. */
  appId?: string;
  /** The rows this unsettled write projected into (./pending-rows). */
  rowIds?: string[];
}

/** The one method the ticker needs; the mounted session satisfies it. */
export interface PendingChangeSource {
  pendingChanges: () => Promise<PendingChange[]>;
}

const PENDING_CHANGES_POLL_MS = 5_000;

const NONE: PendingChange[] = [];

class PendingChangesTicker {
  #listeners = new Set<() => void>();
  #snapshot: PendingChange[] = NONE;
  #source: PendingChangeSource | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #appStateSub: { remove: () => void } | undefined;
  #inFlight = false;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    this.#attach();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#detach();
    };
  };

  getSnapshot = (): PendingChange[] => this.#snapshot;

  setSource(source: PendingChangeSource | undefined): void {
    if (source === this.#source) return;
    this.#source = source;
    this.#publish(NONE);
    void this.refresh();
  }

  refresh = async (): Promise<void> => {
    const source = this.#source;
    if (!source || this.#inFlight) return;
    this.#inFlight = true;
    const pending = await source.pendingChanges().finally(() => {
      this.#inFlight = false;
    });
    if (source === this.#source) this.#publish(pending);
  };

  #attach(): void {
    this.#appStateSub ??= AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void this.refresh();
        this.#startTimer();
      } else this.#stopTimer();
    });
    if (AppState.currentState === "active") {
      void this.refresh();
      this.#startTimer();
    }
  }

  #detach(): void {
    this.#stopTimer();
    this.#appStateSub?.remove();
    this.#appStateSub = undefined;
  }

  #startTimer(): void {
    if (this.#timer || this.#listeners.size === 0) return;
    this.#timer = setInterval(
      () => void this.refresh(),
      PENDING_CHANGES_POLL_MS
    );
  }

  #stopTimer(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #publish(next: PendingChange[]): void {
    // `useSyncExternalStore` compares by identity, so an unchanged queue must
    // keep the same array or every status bar re-renders on every tick.
    if (next.length === 0 && this.#snapshot.length === 0) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}

const ticker = new PendingChangesTicker();

export function usePendingChanges(source: PendingChangeSource | undefined): {
  pending: PendingChange[];
  refresh: () => void;
} {
  useEffect(() => {
    ticker.setSource(source);
  }, [source]);
  const pending = useSyncExternalStore(ticker.subscribe, ticker.getSnapshot);
  const refresh = useCallback(() => void ticker.refresh(), []);
  return { pending, refresh };
}
