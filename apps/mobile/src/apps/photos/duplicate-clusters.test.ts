import { describe, expect, it } from "vitest";

import {
  clusterMeta,
  clusterSize,
  clusterWindow,
  duplicateClusters,
} from "./duplicate-clusters";
import type { PhotoAsset } from "./timeline-model";

function asset(overrides: Partial<PhotoAsset> = {}): PhotoAsset {
  return {
    id: "a1",
    uri: "file:///a1.jpg",
    previewUri: "file:///a1.jpg",
    originalUri: "file:///a1.jpg",
    capturedAt: "2026-08-04T10:00:00.000Z",
    kind: "photo",
    favorite: false,
    archived: false,
    deleted: false,
    backupState: "backed-up",
    source: "replica",
    ...overrides,
  };
}

describe(duplicateClusters, () => {
  it("groups copies that share a hash and drops the lone ones", () => {
    const clusters = duplicateClusters([
      asset({ id: "a", phash: "h1" }),
      asset({ id: "b", phash: "h1" }),
      asset({ id: "c", phash: "h2" }),
      asset({ id: "d" }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.key).toBe("h1");
    expect(clusters[0]?.assets.map((a) => a.id)).toStrictEqual(["a", "b"]);
  });

  it("excludes trashed copies, and the cluster with them", () => {
    // A trashed copy has already been decided about. Counting it would offer
    // the member a choice they have made — and a hash whose only survivor is
    // one photograph is not a cluster at all.
    const clusters = duplicateClusters([
      asset({ id: "a", phash: "h1" }),
      asset({ id: "b", phash: "h1", deleted: true }),
    ]);
    expect(clusters).toStrictEqual([]);
  });
});

describe(clusterWindow, () => {
  it("names the span the copies were taken across", () => {
    const window = clusterWindow([
      asset({ capturedAt: "2026-08-04T10:00:00.000Z" }),
      asset({ capturedAt: "2026-08-04T10:00:02.000Z" }),
    ]);
    expect(window).toBe("within 2 seconds");
  });

  it("refuses to report a span it cannot compute", () => {
    expect(
      clusterWindow([
        asset({ capturedAt: "not a date" }),
        asset({ capturedAt: "2026-08-04T10:00:02.000Z" }),
      ])
    ).toBeNull();
  });
});

describe(clusterSize, () => {
  it("averages the recorded sizes", () => {
    expect(
      clusterSize([asset({ fileSize: 1024 }), asset({ fileSize: 3072 })])
    ).toBe("2.0 KB each");
  });

  it("prints nothing when any copy recorded no size", () => {
    // A mean over a partial set claims to describe copies it never measured.
    expect(clusterSize([asset({ fileSize: 1024 }), asset()])).toBeNull();
  });
});

describe(clusterMeta, () => {
  it("joins what is known and omits what is not", () => {
    expect(
      clusterMeta({
        key: "h1",
        assets: [
          asset({ capturedAt: "2026-08-04T10:00:00.000Z", fileSize: 4300000 }),
          asset({ capturedAt: "2026-08-04T10:00:02.000Z", fileSize: 4300000 }),
        ],
      })
    ).toBe("within 2 seconds · 4.1 MB each");
    expect(
      clusterMeta({
        key: "h1",
        assets: [asset({ capturedAt: "x" }), asset({ capturedAt: "y" })],
      })
    ).toBeNull();
  });
});
