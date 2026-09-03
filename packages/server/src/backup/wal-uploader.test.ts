import { describe, expect, test } from "vitest";

import type { VaultPlane } from "../serve/vault-plane.js";
import { discardWalFiles } from "./wal-uploader.js";

describe("wal-uploader", () => {
  test("discardWalFiles is a no-op when the plane has no shipper", () => {
    const plane = { walShipper: null } as unknown as VaultPlane;
    expect(discardWalFiles(plane)).toStrictEqual({
      uploaded: 0,
      bytes: 0,
      discarded: 0,
      markerTips: {},
    });
  });

  test("discardWalFiles holes the stream BEFORE deleting the files it drops", () => {
    const events: string[] = [];
    const items = [
      { kind: "segment" as const, addr: { db: "vault" as const }, file: "/a" },
      { kind: "closer" as const, closer: { db: "vault" as const }, file: "/b" },
      { kind: "marker" as const, marker: {}, file: "/c" },
    ];
    const plane = {
      walShipper: {
        listUploadable: () => items,
        noteStreamDiscarded: () => events.push("holed"),
        noteUploaded: (item: { kind: string }) =>
          events.push(`dropped:${item.kind}`),
      },
    } as unknown as VaultPlane;
    const result = discardWalFiles(plane);
    expect(result).toStrictEqual({
      uploaded: 0,
      bytes: 0,
      discarded: 3,
      markerTips: {},
    });
    expect(events).toStrictEqual([
      "holed",
      "dropped:segment",
      "dropped:closer",
      "dropped:marker",
    ]);
  });

  test("nothing to drop leaves the stream unholed", () => {
    const events: string[] = [];
    const plane = {
      walShipper: {
        listUploadable: () => [],
        noteStreamDiscarded: () => events.push("holed"),
        noteUploaded: () => events.push("uploaded"),
      },
    } as unknown as VaultPlane;
    expect(discardWalFiles(plane).discarded).toBe(0);
    expect(events).toStrictEqual([]);
  });
});
