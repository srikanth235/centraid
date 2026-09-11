// R-NY-1 (#1015): a place screen is a place ROOT only when it stands directly
// on Home. Anything deeper was pushed from somewhere, keeps a back key to what
// is beneath it, and draws no band (root review of lane B: Vault → Copies).
import { describe, expect, it, vi } from "vitest";

import { SHELL_TITLES } from "../shell-copy";
import { bandStack } from "./band-navigation";
import { beneathTitle, placeStanding } from "./place-frame";
import type { FrameNavigator, FrameRoute } from "./place-frame";
import { PLACES } from "./places";

// `shell-places` (the Settings stack's title table) imports the navigator's
// hooks, which this pure rule never calls and the stub tier cannot load.
vi.mock(import("@react-navigation/native"), () => ({}) as never);

function navigator(
  routes: FrameRoute[],
  parent?: FrameNavigator
): FrameNavigator {
  return {
    getParent: () => parent,
    getState: () => ({ index: routes.length - 1, routes }),
  };
}

const home: FrameRoute = { key: "home", name: "Home" };

describe(placeStanding, () => {
  it("makes a place standing on Home a root", () => {
    const stack = navigator([home, { key: "data", name: "Data" }]);
    expect(placeStanding(stack, "data")).toStrictEqual({ root: true });
  });

  it("makes Copies pushed from Vault a sub-page of Vault", () => {
    const vault: FrameRoute = { key: "data", name: "Data" };
    const stack = navigator([home, vault, { key: "dev", name: "Devices" }]);
    const standing = placeStanding(stack, "dev");
    expect(standing).toStrictEqual({ beneath: vault, root: false });
    expect(beneathTitle(vault)).toBe("Vault");
  });

  it("makes the bottom of Settings' stack a root when Settings stands on Home", () => {
    const outer = navigator([home, { key: "set", name: "Settings" }]);
    const inner = navigator([{ key: "ps", name: "PhoneStorage" }], outer);
    expect(placeStanding(inner, "ps")).toStrictEqual({ root: true });
  });

  it("makes a place pushed inside Settings a sub-page of what is beneath", () => {
    const outer = navigator([home, { key: "set", name: "Settings" }]);
    const settingsHome: FrameRoute = { key: "sh", name: "SettingsHome" };
    const inner = navigator(
      [settingsHome, { key: "ps", name: "PhoneStorage" }],
      outer
    );
    expect(placeStanding(inner, "ps")).toStrictEqual({
      beneath: settingsHome,
      root: false,
    });
    expect(beneathTitle(settingsHome)).toBe(SHELL_TITLES.settings);
  });

  it("makes Settings opened over an app a sub-page with no name to say", () => {
    const photos: FrameRoute = { key: "ph", name: "Photos" };
    const outer = navigator([home, photos, { key: "set", name: "Settings" }]);
    const inner = navigator([{ key: "sh", name: "SettingsHome" }], outer);
    expect(placeStanding(inner, "sh")).toStrictEqual({
      beneath: photos,
      root: false,
    });
    expect(beneathTitle(photos)).toBeUndefined();
  });

  it("names Settings' stack by the screen showing in it", () => {
    const needsYou: FrameRoute = {
      key: "set",
      name: "Settings",
      state: { index: 0, routes: [{ key: "ap", name: "Approvals" }] },
    };
    const stack = navigator([home, needsYou, { key: "ins", name: "Insights" }]);
    expect(placeStanding(stack, "ins")).toStrictEqual({
      beneath: needsYou,
      root: false,
    });
    expect(beneathTitle(needsYou)).toBe(SHELL_TITLES.alerts);
  });

  it("makes a place with no Home beneath it (a cold deep link) a root", () => {
    expect(
      placeStanding(navigator([{ key: "data", name: "Data" }]), "data")
    ).toStrictEqual({ root: true });
  });

  it("makes every place the band lands on a root", () => {
    // The band's reset and this rule agree: a tab press never lands on a
    // screen that would then hide the band it was reached by.
    for (const entry of PLACES) {
      if (entry.id === "home") continue;
      const routes = bandStack([home], entry.id).routes.map((route, index) => ({
        ...route,
        key: `r${index}`,
      }));
      expect(placeStanding(navigator(routes), "r1")).toStrictEqual({
        root: true,
      });
    }
  });
});
