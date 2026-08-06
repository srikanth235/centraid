// The Photos v4 handoff's three new shared roles (CHANGELOG v4 - Photos.md
// §B): `--stage` / `--on-stage` are the opaque media ground for a viewer, a
// slideshow and an editor — deliberately the SAME literal in both themes,
// because the media ground does not follow the theme. `--stage-line` is the
// hairline ON the stage, where `--line` is invisible. `--skel` is the ground
// a tile paints before its bytes arrive, and DOES flip with the theme like
// every other surface role.
import { describe, expect, test } from "vitest";

import { toBlueprintCss } from "./blueprint.js";
import { contrastRatio } from "./color.js";
import { toCss } from "./css.js";
import { toNativeTheme } from "./native.js";
import { declarations } from "./oklab.js";
import { NATIVE_COLOR_ROLE_MAP, ROLE_REGISTRY } from "./roles.js";
import {
  ON_STAGE,
  STAGE,
  STAGE_LINE,
  STAGE_SUNKEN,
  themes,
} from "./themes/index.js";

const AA_BODY = 4.5;

describe("stage and skel roles", () => {
  test("the stage constants are the exact handoff literals", () => {
    expect(STAGE).toBe("#0B0B0B");
    expect(ON_STAGE).toBe("#EDEDEC");
    expect(STAGE_LINE).toBe("#2A2A29");
    // The stage's own sunken rung — handoff v4 line 4479, `sunken:'#1A1A19'`.
    expect(STAGE_SUNKEN).toBe("#1A1A19");
  });

  test("--skel differs per theme, matching the handoff's two values", () => {
    expect(themes.light.skel).toBe("#E4E3E0");
    expect(themes.dark.skel).toBe("#1E1E1D");
  });

  test("every new role is registered with a total lowering", () => {
    for (const css of [
      "--stage",
      "--on-stage",
      "--stage-line",
      "--stage-sunken",
      "--skel",
    ] as const) {
      const role = ROLE_REGISTRY[css];
      if (!role) throw new Error(`missing role ${css}`);
      expect(role.by.shell.kind).not.toBe("unsupported");
      expect(role.by.blueprint.kind).not.toBe("unsupported");
      expect(role.by.native.kind).not.toBe("unsupported");
    }
  });

  describe.each([
    ["shell", toCss(), "[data-theme='dark']"],
    ["blueprint", toBlueprintCss(), ":root[data-theme='dark']"],
  ] as const)("%s emitter", (_name, css, darkSelector) => {
    const light = declarations(css, ":root");
    const dark = { ...light, ...declarations(css, darkSelector) };

    test("--stage, --on-stage and --stage-line are the same literal in both themes", () => {
      for (const token of [
        "--stage",
        "--on-stage",
        "--stage-line",
        "--stage-sunken",
      ] as const) {
        expect(light[token], `light ${token}`).toBeDefined();
        expect(dark[token], `dark ${token}`).toBe(light[token]);
      }
      expect(light["--stage"]).toBe(STAGE);
      expect(light["--on-stage"]).toBe(ON_STAGE);
      expect(light["--stage-line"]).toBe(STAGE_LINE);
      expect(light["--stage-sunken"]).toBe(STAGE_SUNKEN);
    });

    test("--skel flips per theme, unlike the stage roles", () => {
      expect(light["--skel"]).toBe(themes.light.skel);
      expect(dark["--skel"]).toBe(themes.dark.skel);
      expect(dark["--skel"]).not.toBe(light["--skel"]);
    });

    test("--on-stage clears AA body text on --stage", () => {
      expect(
        contrastRatio(light["--on-stage"] ?? "", light["--stage"] ?? "")
      ).toBeGreaterThanOrEqual(AA_BODY);
    });

    test("--stage-line is a decorative hairline, distinguishable from --stage but not held to a text floor", () => {
      // Same job as --line on the page ramp (also un-floored in the
      // registry): a subtle rule, not a boundary a control depends on.
      const ratio = contrastRatio(
        light["--stage-line"] ?? "",
        light["--stage"] ?? ""
      );
      expect(ratio).toBeGreaterThan(1);
      expect(light["--stage-line"]).not.toBe(light["--stage"]);
    });

    test("--skel never collides with --bg-elev — an absence is not a card", () => {
      expect(light["--skel"]).not.toBe(light["--bg-elev"]);
      expect(dark["--skel"]).not.toBe(dark["--bg-elev"]);
    });
  });

  test.each(["light", "dark"] as const)(
    "native %s theme carries the stage and skel roles",
    (scheme) => {
      const colors = toNativeTheme(scheme).colors;
      expect(colors.stage).toBe(STAGE);
      expect(colors.onStage).toBe(ON_STAGE);
      expect(colors.stageLine).toBe(STAGE_LINE);
      expect(colors.stageSunken).toBe(STAGE_SUNKEN);
      expect(colors.skel).toBe(themes[scheme].skel);
    }
  );

  test("the native color role map resolves every new field to a real role", () => {
    for (const field of [
      "stage",
      "onStage",
      "stageLine",
      "stageSunken",
      "skel",
    ] as const) {
      const css = NATIVE_COLOR_ROLE_MAP[field];
      expect(css, field).toBeDefined();
      expect(ROLE_REGISTRY[css]?.by.native.kind).not.toBe("unsupported");
    }
  });
});
