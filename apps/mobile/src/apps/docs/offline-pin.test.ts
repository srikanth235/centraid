// Docs' "available offline" nouns (#883 C6). The React half is not exercised
// here; what is pinned is which documents even HAVE a pin, and that a stored
// one reads without the gateway.

import { beforeEach, describe, expect, test, vi } from "vitest";

import type { MobileDriveDoc } from "./docs-projection";
import { docContentRef, INLINE_REASON, pinnedDocUri } from "./offline-pin";

const store = {
  offlineContentUri: vi.fn<(ref: unknown) => string | undefined>(
    () => undefined
  ),
};

vi.mock(import("../../lib/gateway"), () => ({ authHeader: () => ({}) }));
vi.mock(import("../../kit/fetch-gate/network"), () => ({
  currentNetworkType: async () => "WIFI",
}));
vi.mock(import("../../kit/fetch-gate"), () => ({
  ensureOfflineContent: vi.fn<() => Promise<never>>(),
  isPinned: vi.fn<() => boolean>(() => false),
  offlineContentUri: (ref: unknown) => store.offlineContentUri(ref),
  releaseOfflineContent: vi.fn<() => void>(),
}));

function doc(overrides: Partial<MobileDriveDoc> = {}): MobileDriveDoc {
  return {
    document_id: "doc-1",
    content_id: "content-1",
    title: "Lease",
    media_type: "application/pdf",
    byte_size: 1_000,
    poster_uri: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    folder_id: null,
    starred: false,
    trashed: false,
    purge_at: null,
    tags: [],
    custody_state: null,
    shared_with: null,
    folderGone: false,
    canWrite: true,
    scopeLabels: [],
    raw: {},
    ...overrides,
  } as MobileDriveDoc;
}

describe("Docs offline pins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.offlineContentUri.mockReturnValue(undefined);
  });

  describe("which documents have a ref", () => {
    test("the row's own scope wins over the focused vault", () => {
      expect(
        docContentRef(doc({ raw: { __centraidScopeId: "vault-b" } }), "vault-a")
      ).toStrictEqual({ contentId: "content-1", scopeId: "vault-b" });
    });

    test("the focused vault is the fallback, not the answer", () => {
      expect(docContentRef(doc(), "vault-a")).toStrictEqual({
        contentId: "content-1",
        scopeId: "vault-a",
      });
    });

    test("no scope at all is no ref — content ids collide across vaults", () => {
      expect(docContentRef(doc(), undefined)).toBeNull();
    });

    test("a document with no content row has nothing to pin", () => {
      const bodiless = doc();
      delete (bodiless as { content_id?: string }).content_id;
      expect(docContentRef(bodiless, "vault-a")).toBeNull();
    });

    test("an absent document is not an error", () => {
      expect(docContentRef(undefined, "vault-a")).toBeNull();
    });
  });

  describe("reading a pinned document", () => {
    test("stored bytes answer from disk", () => {
      store.offlineContentUri.mockReturnValue("file:///durable/content-1");
      expect(pinnedDocUri(doc(), "vault-a")).toBe("file:///durable/content-1");
    });

    test("an unpinned document has no local uri — absent, not empty", () => {
      expect(pinnedDocUri(doc(), "vault-a")).toBeUndefined();
    });

    test("a document with no ref never reaches the store at all", () => {
      pinnedDocUri(doc(), undefined);
      expect(store.offlineContentUri).not.toHaveBeenCalled();
    });
  });

  describe("the case a pin would not change", () => {
    test("an inline body is already offline, and the copy says so", () => {
      // The control must not offer to "make available offline" something the
      // replica already carries: a toggle that changes nothing is the defect.
      expect(INLINE_REASON).toContain("already opens offline");
    });
  });
});
