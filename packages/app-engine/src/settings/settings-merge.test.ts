import { describe, expect, it } from "vitest";

import { buildSettingsInject } from "./settings-merge.js";

describe(buildSettingsInject, () => {
  it("routes known keys to the right bucket", () => {
    const out = buildSettingsInject([
      { theme: "dark", bgL: 5, density: "comfy" },
    ]);
    expect(out.dataAttrs).toStrictEqual({ theme: "dark", density: "comfy" });
    expect(out.cssVars).toStrictEqual({ "bg-l": "5%" });
  });

  it("drops unknown keys silently", () => {
    const out = buildSettingsInject([
      { theme: "dark", somethingElse: "value" },
    ]);
    expect(out.dataAttrs).toStrictEqual({ theme: "dark" });
    expect(out.cssVars).toStrictEqual({});
  });

  it("bakes no surface-temperature attribute — dark has one ramp", () => {
    // The knob was removed for parity with the light theme (#608). Neither the
    // old boolean `coolCast` nor the three-position `surfaceTemp` may smear an
    // attribute onto <html> any more.
    for (const v of ["cool", "neutral", "warm", true, "tepid"]) {
      expect(buildSettingsInject([{ surfaceTemp: v }]).dataAttrs).toStrictEqual(
        {}
      );
    }
    expect(buildSettingsInject([{ coolCast: false }]).dataAttrs).toStrictEqual(
      {}
    );
  });

  it("coerces numeric bgL into a percentage string", () => {
    expect(buildSettingsInject([{ bgL: 12 }]).cssVars).toStrictEqual({
      "bg-l": "12%",
    });
    expect(buildSettingsInject([{ bgL: "7" }]).cssVars).toStrictEqual({
      "bg-l": "7%",
    });
  });

  it("drops invalid bgL values", () => {
    expect(buildSettingsInject([{ bgL: "abc" }]).cssVars).toStrictEqual({});
    expect(buildSettingsInject([{ bgL: NaN }]).cssVars).toStrictEqual({});
  });

  it("layers later wins, undefined/null falls through", () => {
    const out = buildSettingsInject([
      { theme: "dark", density: "compact" },
      { theme: "light" },
      { density: undefined },
    ]);
    expect(out.dataAttrs.theme).toBe("light");
    expect(out.dataAttrs.density).toBe("compact");
  });

  it("null in a later layer also falls through", () => {
    const out = buildSettingsInject([{ theme: "dark" }, { theme: null }]);
    // null is intentionally treated as "no value" so the previous layer wins.
    // (Removal at the source is the UserStore's setPrefs({k: null}) deletion,
    //  not a layer-merge concern.)
    expect(out.dataAttrs.theme).toBe("dark");
  });

  it("empty layers produce empty result", () => {
    const out = buildSettingsInject([]);
    expect(out.dataAttrs).toStrictEqual({});
    expect(out.cssVars).toStrictEqual({});
  });

  it("skips undefined layer entries", () => {
    const out = buildSettingsInject([undefined, { theme: "dark" }, undefined]);
    expect(out.dataAttrs.theme).toBe("dark");
  });

  it("routes dynamic app-namespace keys to data attrs by default", () => {
    const out = buildSettingsInject([
      { appFont: "serif", appWidth: "wide", appCornerRadius: "pill" },
    ]);
    expect(out.dataAttrs).toStrictEqual({
      "app-font": "serif",
      "app-width": "wide",
      "app-corner-radius": "pill",
    });
    expect(out.cssVars).toStrictEqual({});
  });

  it("routes Color/Accent-suffixed app keys to CSS vars", () => {
    const out = buildSettingsInject([
      { appColor: "#5847e0", appAccent: "#2EA098" },
    ]);
    expect(out.cssVars).toStrictEqual({
      "app-color": "#5847e0",
      "app-accent": "#2EA098",
    });
    expect(out.dataAttrs).toStrictEqual({});
  });

  it("ignores bare `app` and `apps` (not the namespace prefix)", () => {
    const out = buildSettingsInject([{ app: "x", apps: "y", appFoo: "z" }]);
    expect(out.dataAttrs).toStrictEqual({ "app-foo": "z" });
  });
});
