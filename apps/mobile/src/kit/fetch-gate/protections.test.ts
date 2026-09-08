// THE SEAM HAD NO SUPPLIER (#996 R25).
//
// `planContentEviction` has refused to evict bytes a queued intent needs since
// wave 2, and `storedContentEntries` has taken the answer as a callback. What
// nothing did was ANSWER: `ensureOfflineContent` called the budget sweep with
// no protections at all, so in production the predicate was absent, every
// entry read `referencedByPendingIntent: false`, and the LRU was free to
// delete the one copy of bytes the member's own queued write is waiting on.

import { beforeEach, describe, expect, test, vi } from "vitest";

import type { ContentEvictionPlan } from "./eviction";
import {
  clearContentProtections,
  contentProtections,
  protectedByPendingWork,
  setContentProtections,
} from "./protections";

const store = {
  offlineContentUri: vi.fn<(ref: unknown) => string | undefined>(
    () => undefined
  ),
  storeOfflineContent: vi.fn<
    (...args: unknown[]) => Promise<{ uri: string; bytes: number } | undefined>
  >(async () => ({ uri: "file:///durable/photo-a", bytes: 10 })),
  enforceOfflineContentBudget: vi.fn<
    (...args: unknown[]) => ContentEvictionPlan
  >(() => ({ evict: [], keptBytes: 0, pinnedBytes: 0, overBudgetBy: 0 })),
  touchOfflineContent: vi.fn<(ref: unknown) => void>(),
  removeOfflineContent: vi.fn<(ref: unknown) => void>(),
};

vi.mock(import("./content-store"), () => ({
  enforceOfflineContentBudget: (...args: unknown[]) =>
    store.enforceOfflineContentBudget(...args),
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

const REF = { scopeId: "vault-1", contentId: "content-a" };

describe("content protections", () => {
  beforeEach(() => {
    clearContentProtections();
    store.enforceOfflineContentBudget.mockClear();
  });

  test("an unregistered store protects pins and nothing else", () => {
    expect(contentProtections()).toStrictEqual({});
    expect(protectedByPendingWork(REF)).toBe(false);
  });

  test("the download path hands the registered answers to the sweep", async () => {
    setContentProtections({
      referencedByPendingIntent: (ref) => ref.contentId === "content-a",
    });
    const { ensureOfflineContent } = await import("./download");
    await ensureOfflineContent({
      ref: REF,
      url: "https://gateway.example/content-a",
      headers: {},
      online: true,
      consented: true,
      budgetBytes: 100,
    });
    const [, protections] =
      store.enforceOfflineContentBudget.mock.calls[0] ?? [];
    // The whole point: the sweep is told, on the same call that could delete
    // these bytes, that a queued intent is still waiting on them.
    expect(
      (
        protections as {
          referencedByPendingIntent?: (ref: typeof REF) => boolean;
        }
      )?.referencedByPendingIntent?.(REF)
    ).toBe(true);
  });

  test("a closed seat stops protecting what its queue used to need", () => {
    setContentProtections({ capturedHere: () => true });
    expect(protectedByPendingWork(REF)).toBe(true);
    clearContentProtections();
    expect(protectedByPendingWork(REF)).toBe(false);
  });
});
