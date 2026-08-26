// Band claim/hand-back latch (#712): shared web-shell key namespace, survives relaunch, keyed per app.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Store } from "../../storage";
import type { BandOwner } from "./band-owner";
import {
  BAND_CLAIMING_APPS,
  DEFAULT_BAND_OWNER,
  asBandOwner,
  bandOwnerKey,
  writeBandOwner,
} from "./band-owner";

const device = new Map<string, string>();
vi.mock(
  import("@react-native-async-storage/async-storage"),
  () =>
    ({
      default: {
        clear: async () => {
          device.clear();
        },
        getItem: async (key: string) => device.get(key) ?? null,
        removeItem: async (key: string) => {
          device.delete(key);
        },
        setItem: async (key: string, value: string) => {
          device.set(key, value);
        },
      },
    }) as never
);

/** The store's warm cache, as the hook's hydrate leaves it. */
const currentOwner = (appId: string): BandOwner =>
  asBandOwner(Store.get(bandOwnerKey(appId), DEFAULT_BAND_OWNER));

const raw = (appId: string): Promise<string | null> =>
  AsyncStorage.getItem(`centraid.v1.shell.bandOwner.${appId}`);

describe("the band-owner latch", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    await Promise.all(
      ["photos", "docs", "notes"].map((app) =>
        Store.hydrate(bandOwnerKey(app), DEFAULT_BAND_OWNER)
      )
    );
  });

  it("shares the web shell's key namespace, not a Photos-owned one", () => {
    // Photos-owned keys would force the frame to import an app — a boundary
    // check-import-boundaries.ts forbids.
    expect(bandOwnerKey("photos")).toBe("shell.bandOwner.photos");
    expect(bandOwnerKey("docs")).toBe("shell.bandOwner.docs");
  });

  it("defaults to the app's own band", () => {
    expect(DEFAULT_BAND_OWNER).toBe("app");
    expect(currentOwner("photos")).toBe("app");
  });

  it("narrows anything the store hands back — JSON is not a union", () => {
    expect(asBandOwner("host")).toBe("host");
    expect(asBandOwner("app")).toBe("app");
    expect(asBandOwner(undefined)).toBe("app");
    expect(asBandOwner({ owner: "host" })).toBe("app");
  });

  it("survives a relaunch — the answer is written, not held in memory", async () => {
    writeBandOwner("photos", "host");
    await expect(raw("photos")).resolves.toBe('"host"');
    await expect(
      Store.hydrate(bandOwnerKey("photos"), DEFAULT_BAND_OWNER)
    ).resolves.toBe("host");
    expect(currentOwner("photos")).toBe("host");
  });

  it("is keyed per app — one answer says nothing about the next app", async () => {
    // SHELL behaviour: `notes` is an arbitrary next claiming app — why the latch takes an appId.
    writeBandOwner("photos", "host");
    await Store.hydrate(bandOwnerKey("docs"), DEFAULT_BAND_OWNER);
    expect(currentOwner("docs")).toBe("app");
    await expect(raw("docs")).resolves.toBeNull();

    writeBandOwner("docs", "host");
    writeBandOwner("photos", "app");
    expect(currentOwner("docs")).toBe("host");
    expect(currentOwner("photos")).toBe("app");
    expect(currentOwner("notes")).toBe("app");
  });

  it("names the claiming apps the settings list offers", () => {
    // Hand-maintained roster (no "who claimed" channel); notes absent — claims no band.
    expect(BAND_CLAIMING_APPS.map((app) => app.id)).toStrictEqual([
      "photos",
      "docs",
      "people",
      "agenda",
      "tasks",
      "locker",
      "tally",
    ]);
    for (const app of BAND_CLAIMING_APPS) {
      expect(app.name.length).toBeGreaterThan(0);
      expect(bandOwnerKey(app.id)).toContain("shell.bandOwner.");
    }
  });
});
