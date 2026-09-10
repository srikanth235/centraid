// ONE HANDLE, FIVE HOLDERS (#1014, P21). expo-sqlite caches connections by
// database NAME, so boot's reconcile, the Phone storage screen, the media
// producer, the transfer queue and Photos' timeline engine all held the SAME
// handle — and whichever finished first closed it under the others.
// `withDrainLock` serialises drains, and none of those are drains.

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ opens: 0, closes: 0 }));

vi.mock(import("../replica/expo-sqlite-driver"), () => ({
  ExpoSqliteDriver: {
    open: () => {
      H.opens += 1;
      return {
        exec: () => undefined,
        run: () => undefined,
        all: () => [],
        close: () => {
          H.closes += 1;
        },
      };
    },
  } as unknown as typeof import("../replica/expo-sqlite-driver").ExpoSqliteDriver,
}));

vi.mock(import("../../../modules/centraid-storage"), () => ({
  replicaStorageDirectory: () => "/doc/CentraidReplica",
}));

// The one-time recovery of a ledger stranded at the percent-encoded path
// (#1014, R19) reaches the filesystem; this path has nothing to escape, so it
// plans no move — the stub only keeps `react-native` out of the graph.
vi.mock(import("expo-file-system"), () => ({
  File: class {
    readonly exists = false;
  } as unknown as (typeof import("expo-file-system"))["File"],
}));

vi.mock(import("./store"), () => ({
  UploadQueueStore: {
    create: (driver: { close: () => void }) =>
      ({
        close: () => driver.close(),
        pending: () => [],
      }) as unknown as import("./store").UploadQueueStore,
  } as unknown as typeof import("./store").UploadQueueStore,
}));

vi.mock(import("./expo-native"), () => ({
  expoFileSource: (() =>
    undefined) as unknown as typeof import("./expo-native").expoFileSource,
  expoPartPutter: (() => () =>
    undefined) as unknown as typeof import("./expo-native").expoPartPutter,
}));

vi.mock(import("./crypto"), () => ({
  webCryptoUploadCrypto: () =>
    ({}) as unknown as ReturnType<
      typeof import("./crypto").webCryptoUploadCrypto
    >,
}));

vi.mock(import("./native-digest"), () => ({
  createNativeDigest: () =>
    ({}) as unknown as ReturnType<
      typeof import("./native-digest").createNativeDigest
    >,
}));

vi.mock(import("./gateway-client"), () => ({
  httpDirectTransferClient: () =>
    ({}) as unknown as ReturnType<
      typeof import("./gateway-client").httpDirectTransferClient
    >,
}));

vi.mock(import("./upload-notifications"), () => ({
  notifyUploadQueueChanged: () => undefined,
}));

const { UploadQueue, uploadStoreHolders, withUploadQueue } =
  await import("./native-queue");

const OPTIONS = { gatewayBaseUrl: "http://127.0.0.1" };

describe("the shared upload handle", () => {
  beforeEach(() => {
    H.opens = 0;
    H.closes = 0;
  });

  it("is opened once and closed only by the last holder out", () => {
    const timeline = UploadQueue.open(OPTIONS);
    const screen = UploadQueue.open(OPTIONS);
    expect(H.opens).toBe(1);
    expect(uploadStoreHolders()).toBe(2);
    // The screen goes. Photos is still drawing from this handle.
    screen.close();
    expect(H.closes).toBe(0);
    timeline.close();
    expect(H.closes).toBe(1);
    expect(uploadStoreHolders()).toBe(0);
  });

  it("treats a repeated close as the no-op it is", () => {
    const held = UploadQueue.open(OPTIONS);
    const other = UploadQueue.open(OPTIONS);
    held.close();
    held.close();
    // A double close used to decrement someone else's hold.
    expect(H.closes).toBe(0);
    other.close();
    expect(H.closes).toBe(1);
  });

  it("releases through `withUploadQueue` even when the work throws", async () => {
    const held = UploadQueue.open(OPTIONS);
    await expect(
      withUploadQueue(OPTIONS, () => {
        throw new Error("probe failed");
      })
    ).rejects.toThrow("probe failed");
    expect(uploadStoreHolders()).toBe(1);
    expect(H.closes).toBe(0);
    held.close();
    expect(H.closes).toBe(1);
  });
});
