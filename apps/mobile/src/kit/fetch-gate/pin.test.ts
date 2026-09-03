import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  hydratePinnedContent,
  isPinned,
  listPinnedContent,
  pinContent,
  unpinContent,
} from "./pin";

vi.mock(
  import("@react-native-async-storage/async-storage"),
  () =>
    ({
      default: {
        getItem: vi.fn<() => Promise<string | null>>(async () => null),
        removeItem: vi.fn<(key: string) => Promise<void>>(
          async () => undefined
        ),
        setItem: vi.fn<(key: string, value: string) => Promise<void>>(
          async () => undefined
        ),
      },
    }) as never
);

const REF_A = { contentId: "content-a", scopeId: "scope-1" };
const REF_B = { contentId: "content-b", scopeId: "scope-1" };
const REF_A_OTHER_SCOPE = { contentId: "content-a", scopeId: "scope-2" };

describe("pin/unpin", () => {
  beforeEach(async () => {
    await hydratePinnedContent();
    for (const ref of listPinnedContent()) unpinContent(ref);
  });

  test("pinning marks a content ref as pinned", () => {
    pinContent(REF_A);
    expect(isPinned(REF_A)).toBe(true);
    expect(isPinned(REF_B)).toBe(false);
  });

  test("pinning is idempotent", () => {
    pinContent(REF_A);
    pinContent(REF_A);
    expect(
      listPinnedContent().filter((r) => r.contentId === "content-a")
    ).toHaveLength(1);
  });

  test("unpinning removes exactly that ref", () => {
    pinContent(REF_A);
    pinContent(REF_B);
    unpinContent(REF_A);
    expect(isPinned(REF_A)).toBe(false);
    expect(isPinned(REF_B)).toBe(true);
  });

  test("unpinning something never pinned is a no-op, not an error", () => {
    expect(() => unpinContent(REF_A)).not.toThrow();
    expect(isPinned(REF_A)).toBe(false);
  });

  test("content ids are scoped: the same content id in a different scope is a different ref", () => {
    pinContent(REF_A);
    expect(isPinned(REF_A_OTHER_SCOPE)).toBe(false);
    pinContent(REF_A_OTHER_SCOPE);
    expect(listPinnedContent()).toHaveLength(2);
  });
});
