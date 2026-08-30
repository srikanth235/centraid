// The engine's ORDER — the part an app must not reinvent. The byte store is
// mocked here on purpose: what is under test is which step runs when, not
// where the file lands (`content-store.test.ts` owns that).

import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  ensureOfflineContent,
  OFFLINE_UNREACHABLE_REASON,
  releaseOfflineContent,
} from "./download";
import type { ContentEvictionPlan } from "./eviction";
import {
  hydratePinnedContent,
  isPinned,
  listPinnedContent,
  unpinContent,
} from "./pin";

const store = {
  offlineContentUri: vi.fn<(ref: unknown) => string | undefined>(
    () => undefined
  ),
  storeOfflineContent: vi.fn<
    (...args: unknown[]) => Promise<{ uri: string; bytes: number } | undefined>
  >(async () => ({ uri: "file:///durable/doc-a", bytes: 10 })),
  enforceOfflineContentBudget: vi.fn<() => ContentEvictionPlan>(() => ({
    evict: [],
    keptBytes: 0,
    pinnedBytes: 0,
    overBudgetBy: 0,
  })),
  touchOfflineContent: vi.fn<(ref: unknown) => void>(),
  removeOfflineContent: vi.fn<(ref: unknown) => void>(),
};

vi.mock(import("./content-store"), () => ({
  enforceOfflineContentBudget: (...args: unknown[]) =>
    store.enforceOfflineContentBudget(...(args as [])),
  offlineContentUri: (ref: unknown) => store.offlineContentUri(ref),
  removeOfflineContent: (ref: unknown) => store.removeOfflineContent(ref),
  storeOfflineContent: (...args: unknown[]) =>
    store.storeOfflineContent(...args),
  touchOfflineContent: (ref: unknown) => store.touchOfflineContent(ref),
}));
vi.mock(
  import("@react-native-async-storage/async-storage"),
  () =>
    ({
      default: {
        getItem: vi.fn<() => Promise<string | null>>(async () => null),
        removeItem: vi.fn<() => Promise<void>>(async () => undefined),
        setItem: vi.fn<() => Promise<void>>(async () => undefined),
      },
    }) as never
);

const REF = { scopeId: "vault-1", contentId: "doc-a" };
const BASE = {
  ref: REF,
  url: "https://gateway.test/blobs/vault-1/doc-a",
  headers: {},
};

/** A stored ref becomes readable — the store's real post-download behaviour. */
function storeSucceeds(): void {
  let present = false;
  store.offlineContentUri.mockImplementation(() =>
    present ? "file:///durable/doc-a" : undefined
  );
  store.storeOfflineContent.mockImplementation(async () => {
    present = true;
    return { uri: "file:///durable/doc-a", bytes: 10 };
  });
}

describe("the pin/download engine", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    storeSucceeds();
    await hydratePinnedContent();
    for (const ref of listPinnedContent()) unpinContent(ref);
  });

  describe("local bytes first", () => {
    test("a stored ref answers from disk with no fetch, even offline and metered", async () => {
      store.offlineContentUri.mockReturnValue("file:///durable/doc-a");
      const outcome = await ensureOfflineContent({
        ...BASE,
        online: false,
        networkType: "CELLULAR",
      });
      expect(outcome).toStrictEqual({
        pinned: false,
        status: "stored",
        uri: "file:///durable/doc-a",
      });
      expect(store.storeOfflineContent).not.toHaveBeenCalled();
    });

    test("reading a stored ref touches it, so live bytes leave the eviction tail", async () => {
      const touched: unknown[] = [];
      store.touchOfflineContent.mockImplementation((ref) => {
        touched.push(ref);
      });
      store.offlineContentUri.mockReturnValue("file:///durable/doc-a");
      await ensureOfflineContent(BASE);
      expect(touched).toStrictEqual([REF]);
    });
  });

  describe("the gate", () => {
    test("a metered connection with no answer holds off and asks", async () => {
      const outcome = await ensureOfflineContent({
        ...BASE,
        networkType: "CELLULAR",
      });
      expect(outcome).toStrictEqual({ status: "needs-choice" });
      expect(store.storeOfflineContent).not.toHaveBeenCalled();
    });

    test("an answered metered fetch proceeds", async () => {
      const outcome = await ensureOfflineContent({
        ...BASE,
        networkType: "CELLULAR",
        consented: true,
      });
      expect(outcome).toMatchObject({ status: "stored" });
    });

    test("unmetered fetches never ask", async () => {
      const outcome = await ensureOfflineContent({
        ...BASE,
        networkType: "WIFI",
      });
      expect(outcome).toMatchObject({ status: "stored" });
    });
  });

  describe("absent is never empty", () => {
    test("offline with nothing stored says why", async () => {
      const outcome = await ensureOfflineContent({ ...BASE, online: false });
      expect(outcome).toStrictEqual({
        reason: OFFLINE_UNREACHABLE_REASON,
        status: "unavailable",
      });
    });

    test("an unresolvable url is the same refusal, not a silent nothing", async () => {
      const outcome = await ensureOfflineContent({ ...BASE, url: null });
      expect(outcome).toStrictEqual({
        reason: OFFLINE_UNREACHABLE_REASON,
        status: "unavailable",
      });
    });

    test("a failed download carries a sentence", async () => {
      store.storeOfflineContent.mockResolvedValue(undefined);
      const outcome = await ensureOfflineContent(BASE);
      expect(outcome.status).toBe("unavailable");
      expect("reason" in outcome ? outcome.reason.length : 0).toBeGreaterThan(
        0
      );
    });

    // An UNPINNED download big enough to blow the budget on its own is evicted
    // by the pass that follows it. Saying "stored" there would promise bytes
    // that are already gone.
    test("a download the budget pass immediately reclaims is not reported stored", async () => {
      store.offlineContentUri.mockReturnValue(undefined);
      const outcome = await ensureOfflineContent(BASE);
      expect(outcome.status).toBe("unavailable");
    });
  });

  describe("pinning", () => {
    test("a pin is durable before the bytes arrive, so a failed fetch retries later", async () => {
      store.storeOfflineContent.mockResolvedValue(undefined);
      await ensureOfflineContent({ ...BASE, pin: true });
      expect(isPinned(REF)).toBe(true);
    });

    test("the budget pass runs after a download, never before it", async () => {
      await ensureOfflineContent({ ...BASE, pin: true });
      const storedAt = store.storeOfflineContent.mock.invocationCallOrder[0];
      const budgetAt =
        store.enforceOfflineContentBudget.mock.invocationCallOrder[0];
      expect(storedAt).toBeGreaterThan(0);
      expect(budgetAt).toBeGreaterThan(storedAt!);
    });

    test("releasing a pin takes its bytes with it", () => {
      const removed: unknown[] = [];
      store.removeOfflineContent.mockImplementation((ref) => {
        removed.push(ref);
      });
      releaseOfflineContent(REF);
      expect(isPinned(REF)).toBe(false);
      expect(removed).toStrictEqual([REF]);
    });
  });
});
