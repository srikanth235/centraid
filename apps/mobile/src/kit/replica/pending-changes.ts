import { useCallback, useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import type { PendingChangeStatus } from "../../lib/replica/multi-vault-session";

export interface PendingChange {
  id: string;
  vaultId: string;
  vaultLabel: string;
  status: PendingChangeStatus;
  label: string;
  appId?: string;
  action?: string;
  reason?: string;
  attempts?: number;
  enqueuedAt?: string;
  expectedVersion?: number;
  actualVersion?: number;
  kind: "replica" | "placement";
}

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
