// THE BAND CAN BE CLAIMED AND HANDED BACK (issue #712 E3).
//
// `setBandOwner` had no caller on either client: the frame honoured a
// preference the member had no way to express. These assert the latch itself —
// the key namespace it now shares with the web shell, that a write survives a
// relaunch, and that it is keyed PER APP rather than being Photos behaviour
// wearing a general name.

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

// A REAL in-memory device store, not a stubbed-out one. The claim under test
// is that the answer OUTLIVES the process, and a mock whose `getItem` always
// returns null can only ever prove that nothing crashed.
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

/** What a surface would paint right now — the store's warm cache, read the
 *  way the hook's own hydrate leaves it. */
const currentOwner = (appId: string): BandOwner =>
  asBandOwner(Store.get(bandOwnerKey(appId), DEFAULT_BAND_OWNER));

const raw = (appId: string): Promise<string | null> =>
  AsyncStorage.getItem(`centraid.v1.shell.bandOwner.${appId}`);

describe("the band-owner latch", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    // The Store keeps a synchronous in-memory cache; a fresh hydrate per test
    // is what a relaunch does.
    await Promise.all(
      ["photos", "docs", "notes"].map((app) =>
        Store.hydrate(bandOwnerKey(app), DEFAULT_BAND_OWNER)
      )
    );
  });

  it("shares the web shell's key namespace, not a Photos-owned one", () => {
    // The reconciliation itself (see band-owner.ts's header): mobile used to
    // spell this `photos.bandOwner.<appId>` from inside the Photos app, which
    // meant the frame could not read its own preference without importing an
    // app — a boundary `scripts/check-import-boundaries.ts` forbids.
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
    // A relaunch: the in-memory cache is gone and the value is re-hydrated
    // from device storage, which is the only place it could have survived.
    await expect(
      Store.hydrate(bandOwnerKey("photos"), DEFAULT_BAND_OWNER)
    ).resolves.toBe("host");
    expect(currentOwner("photos")).toBe("host");
  });

  it("is keyed per app — one answer says nothing about the next app", async () => {
    // SHELL BEHAVIOUR, NOT PHOTOS BEHAVIOUR. Photos is the only app claiming a
    // band today (`BAND_CLAIMING_APPS`), so the second and third ids here are
    // arbitrary ones standing in for the next app that claims — which is the
    // guarantee the latch makes and the reason it takes an `appId` at all.
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
    // A limitation stated rather than hidden: mobile has no channel a frame
    // could ask "who has claimed", so the roster is hand-maintained. This
    // fails the moment it drifts from one row without someone deciding to.
    expect(BAND_CLAIMING_APPS.map((app) => app.id)).toStrictEqual(["photos"]);
    for (const app of BAND_CLAIMING_APPS) {
      expect(app.name.length).toBeGreaterThan(0);
      expect(bandOwnerKey(app.id)).toContain("shell.bandOwner.");
    }
  });
});
