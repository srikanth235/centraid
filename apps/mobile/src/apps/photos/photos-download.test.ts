// The phone's download path, which #883 C6 replaced `NO_DOWNLOAD_REASON` with.
// The engine is mocked: what is pinned here is that Photos hands it the right
// refs, that a batch is serial, and that a mixed outcome is stated in full
// rather than reported as a success.

import { beforeEach, describe, expect, test, vi } from "vitest";

import type { OfflineContentOutcome } from "../../kit/fetch-gate/download";
import {
  batchDownload,
  downloadStatus,
  downloadableAssets,
} from "./photos-selection-writes";
import type { VaultAsset } from "./photos-selection-writes";

const engine = {
  ensureOfflineContent:
    vi.fn<(input: unknown) => Promise<OfflineContentOutcome>>(),
};

vi.mock(import("../../kit/fetch-gate/download"), () => ({
  ensureOfflineContent: (input: unknown) => engine.ensureOfflineContent(input),
}));

function asset(overrides: Partial<VaultAsset> & { id: string }): VaultAsset {
  return {
    assetId: `asset-${overrides.id}`,
    contentId: `content-${overrides.id}`,
    sourceVaultId: "vault-1",
    originalUri: `https://gw.test/blobs/vault-1/content-${overrides.id}`,
    uri: "",
    previewUri: "",
    kind: "photo",
    favorite: false,
    archived: false,
    deleted: false,
    backupState: "backed-up",
    source: "replica",
    ...overrides,
  } as VaultAsset;
}

describe("the phone's download path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engine.ensureOfflineContent.mockResolvedValue({
      status: "stored",
      uri: "file:///x",
      pinned: true,
    });
  });

  describe("what can be downloaded", () => {
    test("a camera-roll-only row has nothing on the gateway to fetch", () => {
      const deviceOnly = asset({ id: "a" });
      delete (deviceOnly as { contentId?: string }).contentId;
      expect(downloadableAssets([deviceOnly])).toStrictEqual([]);
    });

    test("a row with no source vault is not addressable", () => {
      const orphan = asset({ id: "b" });
      delete (orphan as { sourceVaultId?: string }).sourceVaultId;
      expect(downloadableAssets([orphan])).toStrictEqual([]);
    });

    test("a vault row with bytes on the gateway is downloadable", () => {
      expect(downloadableAssets([asset({ id: "c" })])).toHaveLength(1);
    });
  });

  describe("the batch", () => {
    test("each asset becomes a scoped, PINNED ref — a download is not a cache", async () => {
      const inputs: unknown[] = [];
      engine.ensureOfflineContent.mockImplementation(async (input) => {
        inputs.push(input);
        return { status: "stored", uri: "file:///x", pinned: true };
      });
      await batchDownload(downloadableAssets([asset({ id: "a" })]), {
        headers: { Authorization: "Bearer t" },
      });
      expect(inputs).toStrictEqual([
        {
          pin: true,
          ref: { contentId: "content-a", scopeId: "vault-1" },
          url: "https://gw.test/blobs/vault-1/content-a",
          headers: { Authorization: "Bearer t" },
        },
      ]);
    });

    test("downloads run one at a time — one store, one radio", async () => {
      let inFlight = 0;
      let overlapped = false;
      let started = 0;
      engine.ensureOfflineContent.mockImplementation(async () => {
        started += 1;
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        await Promise.resolve();
        inFlight -= 1;
        return { status: "stored", uri: "file:///x", pinned: true };
      });
      const summary = await batchDownload(
        downloadableAssets([
          asset({ id: "a" }),
          asset({ id: "b" }),
          asset({ id: "c" }),
        ]),
        { headers: {} }
      );
      expect(overlapped).toBe(false);
      expect(started).toBe(3);
      expect(summary.stored).toBe(3);
    });

    test("a metered refusal is counted, not treated as a failure", async () => {
      engine.ensureOfflineContent.mockResolvedValue({ status: "needs-choice" });
      const summary = await batchDownload(
        downloadableAssets([asset({ id: "a" }), asset({ id: "b" })]),
        { headers: {}, networkType: "CELLULAR" }
      );
      expect(summary).toStrictEqual({
        needsChoice: 2,
        stored: 0,
        unavailable: 0,
      });
    });

    test("a mixed batch keeps every count and the first refusal's sentence", async () => {
      engine.ensureOfflineContent
        .mockResolvedValueOnce({ status: "stored", uri: "f", pinned: true })
        .mockResolvedValueOnce({
          status: "unavailable",
          reason: "the gateway said no",
        });
      const summary = await batchDownload(
        downloadableAssets([asset({ id: "a" }), asset({ id: "b" })]),
        { headers: {} }
      );
      expect(summary.stored).toBe(1);
      expect(summary.unavailable).toBe(1);
      expect(summary.reason).toBe("the gateway said no");
    });
  });

  describe("what the member is told", () => {
    test("a partly-failed batch is never reported as a plain success", () => {
      const line = downloadStatus({
        stored: 3,
        needsChoice: 0,
        unavailable: 1,
        reason: "the gateway said no",
      });
      expect(line).toContain("3 originals are on this phone");
      expect(line).toContain("1 could not be downloaded");
      expect(line).toContain("the gateway said no");
    });

    test("a held batch says what the second tap will cost", () => {
      expect(
        downloadStatus({ stored: 0, needsChoice: 2, unavailable: 0 })
      ).toContain("metered");
    });

    test("one original reads as one, not as a plural", () => {
      expect(
        downloadStatus({ stored: 1, needsChoice: 0, unavailable: 0 })
      ).toContain("1 original is");
    });

    test("an empty batch says why rather than claiming a download", () => {
      expect(
        downloadStatus({ stored: 0, needsChoice: 0, unavailable: 0 })
      ).toContain("Nothing in this selection");
    });
  });
});
