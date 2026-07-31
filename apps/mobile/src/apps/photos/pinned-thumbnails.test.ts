import { describe, expect, test } from "vitest";

import {
  pinnedThumbnailCandidates,
  pinnedThumbnailSignature,
} from "./pinned-thumbnails";
import type { PhotoAsset } from "./timeline-model";

const GATEWAY = "https://gateway.example";

const asset = (id: string, fields: Partial<PhotoAsset> = {}): PhotoAsset => ({
  id,
  contentId: `content-${id}`,
  uri: id,
  previewUri: id,
  originalUri: id,
  capturedAt: "2025-07-16T10:00:00.000Z",
  kind: "photo",
  favorite: false,
  archived: false,
  deleted: false,
  backupState: "backed-up",
  source: "replica",
  scopeIds: ["vault-a"],
  ...fields,
});

describe("pinned thumbnail candidate signature", () => {
  test("an unchanged snapshot keeps the same signature across new array identities", () => {
    const first = pinnedThumbnailSignature(GATEWAY, [asset("a"), asset("b")]);
    const second = pinnedThumbnailSignature(GATEWAY, [asset("a"), asset("b")]);
    expect(second).toBe(first);
  });

  test("adding, removing or re-scoping a photo changes the signature", () => {
    const base = pinnedThumbnailSignature(GATEWAY, [asset("a")]);
    expect(
      pinnedThumbnailSignature(GATEWAY, [asset("a"), asset("b")])
    ).not.toBe(base);
    expect(pinnedThumbnailSignature(GATEWAY, [])).not.toBe(base);
    expect(
      pinnedThumbnailSignature(GATEWAY, [
        asset("a", { scopeIds: ["vault-a", "vault-b"] }),
      ])
    ).not.toBe(base);
  });

  test("favourite and capture time are part of the identity", () => {
    const base = pinnedThumbnailSignature(GATEWAY, [asset("a")]);
    expect(
      pinnedThumbnailSignature(GATEWAY, [asset("a", { favorite: true })])
    ).not.toBe(base);
    expect(
      pinnedThumbnailSignature(GATEWAY, [
        asset("a", { capturedAt: "2024-01-01T00:00:00.000Z" }),
      ])
    ).not.toBe(base);
  });

  test("re-pairing to a different gateway changes the signature", () => {
    const rows = [asset("a")];
    expect(pinnedThumbnailSignature("https://other.example", rows)).not.toBe(
      pinnedThumbnailSignature(GATEWAY, rows)
    );
  });

  test("rows that cannot be pinned do not move the signature", () => {
    const base = pinnedThumbnailSignature(GATEWAY, [asset("a")]);
    expect(
      pinnedThumbnailSignature(GATEWAY, [
        asset("a"),
        asset("device", { source: "device" }),
        asset("unbacked", { contentId: undefined }),
      ])
    ).toBe(base);
  });
});

describe("pinned thumbnail candidates", () => {
  test("emits one candidate per scope and asks the gateway for a thumb", () => {
    const candidates = pinnedThumbnailCandidates(GATEWAY, [
      asset("a", { scopeIds: ["vault-a", "vault b"] }),
    ]);
    expect(candidates.map((candidate) => candidate.scopeId)).toStrictEqual([
      "vault-a",
      "vault b",
    ]);
    expect(candidates[0]?.uri).toBe(
      `${GATEWAY}/centraid/_gateway/blobs/vault-a/content-a?variant=thumb`
    );
    // A scope id is user-supplied and lands in a path segment.
    expect(candidates[1]?.uri).toContain("/blobs/vault%20b/");
  });

  test("a video pins its poster frame rather than a thumbnail", () => {
    const [candidate] = pinnedThumbnailCandidates(GATEWAY, [
      asset("v", { kind: "video" }),
    ]);
    expect(candidate?.uri).toContain("variant=poster");
  });

  test("device-only and unbacked rows produce no candidates", () => {
    expect(
      pinnedThumbnailCandidates(GATEWAY, [
        asset("device", { source: "device" }),
        asset("unbacked", { contentId: undefined }),
      ])
    ).toStrictEqual([]);
  });

  test("an asset with no scopes produces no candidates", () => {
    expect(
      pinnedThumbnailCandidates(GATEWAY, [asset("a", { scopeIds: undefined })])
    ).toStrictEqual([]);
  });
});
