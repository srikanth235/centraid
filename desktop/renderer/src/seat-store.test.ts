import { describe, expect, it, vi } from "vitest";

import type { SeatState } from "../../electron/src/main/seat-state-core.js";
import type { Page } from "./apps/tally/fold.js";
import { createSeatStore, PAGE_LIMIT, STATEMENTS } from "./seat-store.js";
import type { CentraidApi } from "./seat-store.js";

const settled: SeatState = {
  availability: "local",
  durability: "settled",
  pending_work: { outbox: 0, behind: 0, stalled: false },
  connectivity: "online",
  mode: "replicated",
  at_ms: 1,
};

const page = (columns: string[], rows: unknown[][]): Page => ({
  columns,
  rows,
});

function fakeApi(
  overrides: Partial<CentraidApi> & {
    pages?: Record<string, Page>;
    refuse?: Record<string, string>;
  } = {}
): CentraidApi & { asked: string[]; pushed: (state: SeatState) => void } {
  const asked: string[] = [];
  let push: ((state: SeatState) => void) | undefined;
  const api: CentraidApi & {
    asked: string[];
    pushed: (state: SeatState) => void;
  } = {
    asked,
    pushed: (state) => push?.(state),
    page: async (input) => {
      asked.push(`${input.statement}@${input.limit}`);
      const refusal = overrides.refuse?.[input.statement];
      if (refusal) throw new Error(refusal);
      return overrides.pages?.[input.statement] ?? page([], []);
    },
    getSeatState: async () => settled,
    getSeatFailure: async () => null,
    onSeatState: (callback) => {
      push = callback;
      return () => {
        push = undefined;
      };
    },
    retrySeat: async () => ({ ok: true }),
    ...overrides,
  };
  return api;
}

describe("the store", () => {
  it("hands out a stable snapshot object between publishes", () => {
    const store = createSeatStore(undefined);
    // `useSyncExternalStore` compares by identity: a fresh object every call is
    // an infinite render loop.
    expect(store.snapshot()).toBe(store.snapshot());
  });

  it("reads every statement the screens need, once, at the page limit", async () => {
    const api = fakeApi();
    const store = createSeatStore(api);
    await store.load();
    expect(api.asked).toStrictEqual(
      STATEMENTS.map((statement) => `${statement}@${PAGE_LIMIT}`)
    );
    expect(new Set(api.asked).size).toBe(STATEMENTS.length);
  });

  it("starts on the first subscriber and notifies it", async () => {
    const api = fakeApi();
    const store = createSeatStore(api);
    const listener = vi.fn<() => void>();
    const unsubscribe = store.subscribe(listener);
    await vi.waitFor(() => {
      expect(store.snapshot().state).toStrictEqual(settled);
    });
    // A LISTENER TAKES NO ARGUMENTS: `useSyncExternalStore` calls it to say
    // "read the snapshot again", so what is asserted is that it fired.
    expect(listener).toHaveBeenCalledWith();
    unsubscribe();
  });

  it("takes a pushed state, and stops taking them once unsubscribed", async () => {
    const api = fakeApi();
    const store = createSeatStore(api);
    const unsubscribe = store.subscribe(() => undefined);
    await store.load();
    const offline: SeatState = {
      ...settled,
      connectivity: "offline",
      durability: "local-only",
      at_ms: 2,
    };
    api.pushed(offline);
    expect(store.snapshot().state).toStrictEqual(offline);
    unsubscribe();
    api.pushed(settled);
    // The push subscription went with the listener, so the snapshot is the
    // last state the store was actually told about.
    expect(store.snapshot().state).toStrictEqual(offline);
  });

  /** The three-state read law, at the store: a refusal is not an empty page. */
  it("keeps the reason a statement was refused, and folds no dashboard from it", async () => {
    const api = fakeApi({
      refuse: Object.fromEntries(
        STATEMENTS.map((statement) => [
          statement,
          "refused: this is a thin seat",
        ])
      ),
    });
    const store = createSeatStore(api);
    await store.load();
    const snapshot = store.snapshot();
    expect(snapshot.dashboard).toBeUndefined();
    expect(snapshot.photos).toBeUndefined();
    expect(snapshot.refusals).toHaveLength(STATEMENTS.length);
    expect(snapshot.refusals[0]).toContain("thin seat");
  });

  it("folds a dashboard from the statements that DID answer, and names the rest", async () => {
    const api = fakeApi({
      pages: {
        "tally.vault": page(
          ["vault_id", "self_party_id", "base_currency"],
          [["v-1", "p-1", "GBP"]]
        ),
        "tally.friends": page(["friend_id", "party_id"], [["f-1", "p-2"]]),
      },
      refuse: { "tally.expenses": "refused: the reader pool is busy" },
    });
    const store = createSeatStore(api);
    await store.load();
    const snapshot = store.snapshot();
    expect(snapshot.dashboard?.baseCurrency).toBe("GBP");
    expect(snapshot.dashboard?.friendCount).toBe(1);
    // The ledger did NOT answer, so the count is zero AND the refusal is
    // recorded — a screen that showed "0 expenses" with no note would be
    // asserting something nobody knows.
    expect(snapshot.dashboard?.expenseCount).toBe(0);
    expect(snapshot.refusals).toHaveLength(1);
    expect(snapshot.refusals[0]).toContain("tally.expenses");
  });

  it("builds photo tiles with centraid:// urls from three pages", async () => {
    const digest = "e".repeat(64);
    const api = fakeApi({
      pages: {
        "photos.assets": page(
          ["asset_id", "content_id", "kind"],
          [["a-1", "c-1", "photo"]]
        ),
        "photos.content": page(["content_id", "sha256"], [["c-1", digest]]),
        "photos.representations": page(
          ["representation_id", "content_id", "media_type"],
          [["r-1", "c-1", "image/jpeg"]]
        ),
      },
    });
    const store = createSeatStore(api);
    await store.load();
    expect(store.snapshot().photos).toStrictEqual([
      {
        assetId: "a-1",
        contentId: "c-1",
        kind: "photo",
        title: undefined,
        capturedAt: undefined,
        src: `centraid://blob/${digest}`,
        mediaType: "image/jpeg",
        width: undefined,
        height: undefined,
        durationSeconds: undefined,
      },
    ]);
  });

  it("surfaces the seat's failure sentence, and clears it on a retry", async () => {
    const api = fakeApi({
      getSeatFailure: async () => ({
        loopBroken: true,
        message: "The Centraid seat process failed 3 times in 120 seconds",
      }),
    });
    const store = createSeatStore(api);
    store.subscribe(() => undefined);
    await vi.waitFor(() => {
      expect(store.snapshot().failure).toContain("3 times");
    });
    await store.retry();
    expect(store.snapshot().failure).toBeUndefined();
  });

  it("puts a failed retry's reason back on the screen rather than swallowing it", async () => {
    const api = fakeApi({
      retrySeat: async () => {
        throw new Error("the seat binary would not start: ENOENT");
      },
    });
    const store = createSeatStore(api);
    await store.retry();
    expect(store.snapshot().failure).toContain("ENOENT");
  });

  it("does nothing at all without a bridge, rather than throwing", async () => {
    const store = createSeatStore(undefined);
    const unsubscribe = store.subscribe(() => undefined);
    await store.load();
    await store.retry();
    expect(store.snapshot()).toStrictEqual({ refusals: [], loading: false });
    unsubscribe();
  });
});
