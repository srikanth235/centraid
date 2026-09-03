import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { contrastRatio } from "./color.js";
import { toNativeTheme } from "./native.js";
import {
  NATIVE_COLOR_ROLE_MAP,
  ROLE_REGISTRY,
  assertNativeColorRoleContract,
} from "./roles.js";
import { type } from "./typography.js";

describe("Expo reachability", () => {
  const SRC = path.resolve(import.meta.dirname);
  const DOM_GLOBALS =
    /\b(?:document|customElements|HTMLElement|ResizeObserver|FileReader|MutationObserver|localStorage)\b/u;

  function resolveSpec(dir: string, spec: string): string {
    const base = path.resolve(dir, spec.replace(/\.js$/u, ""));
    for (const candidate of [`${base}.ts`, path.join(base, "index.ts")])
      if (existsSync(candidate)) return candidate;
    throw new Error(`unresolvable design specifier: ${spec} from ${dir}`);
  }

  function reachableFrom(entry: string, seen = new Set<string>()): string[] {
    if (seen.has(entry)) return [];
    seen.add(entry);
    const source = readFileSync(entry, "utf8");
    const dir = path.dirname(entry);
    for (const match of source.matchAll(
      /from\s+"(?<spec>\.[^"]*)"|import\s+"(?<bare>\.[^"]*)"/gu
    )) {
      const spec = match.groups?.spec ?? match.groups?.bare;
      if (!spec) continue;
      reachableFrom(resolveSpec(dir, spec), seen);
    }
    return [...seen];
  }

  test("nothing the root barrel reaches touches a DOM global", () => {
    for (const file of reachableFrom(path.join(SRC, "index.ts"))) {
      const body = readFileSync(file, "utf8")
        .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
        .replaceAll(/\/\/.*$/gmu, "");
      expect(body, path.relative(SRC, file)).not.toMatch(DOM_GLOBALS);
    }
  });

  test("the root barrel does not re-export the element layer", () => {
    const barrel = readFileSync(path.join(SRC, "index.ts"), "utf8");
    expect(barrel).not.toContain("./elements");
  });
});

describe("native product-grammar lowering", () => {
  test("every emitted native color is backed by a renderable role", () => {
    const theme = toNativeTheme("light");
    expect(() => assertNativeColorRoleContract(theme.colors)).not.toThrow();

    for (const [field, css] of Object.entries(NATIVE_COLOR_ROLE_MAP)) {
      const role = ROLE_REGISTRY[css];
      if (!role) throw new Error(`Missing role ${css}`);
      expect(role.by.native.kind).not.toBe("unsupported");
      expect(field in theme.colors).toBe(true);
    }
  });

  test("lowers the v10 attention tone on both native themes", () => {
    expect(toNativeTheme("light").colors).toMatchObject({
      attention: "#8A6520",
    });
    expect(toNativeTheme("dark").colors).toMatchObject({
      attention: "#D8A64E",
    });
  });

  test("light native solved values stay equal to the registry cells", () => {
    const colors = toNativeTheme("light").colors;
    for (const field of [
      "accentText",
      "accentDeepHover",
      "appIdentityText",
      "focusRingColor",
      "scrim",
      "stageSunken",
      "textInv",
    ] as const) {
      const role = ROLE_REGISTRY[NATIVE_COLOR_ROLE_MAP[field]];
      if (!role) throw new Error(`Missing role for ${field}`);
      expect(role.by.native.value, field).toBe(colors[field]);
    }
  });

  test("native carries the whole ramp — no profile-only type role", () => {
    const nativeType = toNativeTheme("light").type;
    expect(Object.keys(nativeType).sort()).toStrictEqual(
      Object.keys(type).sort()
    );
    expect("hero" in nativeType).toBe(false);
    expect("greeting" in nativeType).toBe(false);
  });

  test("the numeric register is tabular on native too", () => {
    expect(toNativeTheme("light").type.mono.variantNumeric).toBe(
      "tabular-nums"
    );
    expect(toNativeTheme("light").type.eyebrow.textTransform).toBe("uppercase");
  });

  test("the ink fill has a hover step that moves AWAY from its ink", () => {
    for (const scheme of ["light", "dark"] as const) {
      const colors = toNativeTheme(scheme).colors;
      expect(colors.accentDeepHover, scheme).not.toBe(colors.accentFill);
      expect(
        contrastRatio(colors.textInv, colors.accentDeepHover),
        scheme
      ).toBeGreaterThanOrEqual(
        contrastRatio(colors.textInv, colors.accentFill)
      );
    }
  });

  test("on-accent is the theme's inverse ink, not a light-mode constant", () => {
    for (const scheme of ["light", "dark"] as const) {
      const colors = toNativeTheme(scheme).colors;
      expect(colors.onAccent, scheme).toBe(colors.textInv);
    }
    expect(toNativeTheme("light").colors.onAccent).not.toBe(
      toNativeTheme("dark").colors.onAccent
    );
  });

  test("the native rule is a FULL point, not the platform hairline", () => {
    for (const scheme of ["light", "dark"] as const) {
      expect(toNativeTheme(scheme).borders.hairline, scheme).toBe(1);
    }
  });

  test("the page margin is lowered, and is NOT a spacing rung", () => {
    for (const scheme of ["light", "dark"] as const) {
      expect(toNativeTheme(scheme).pageMargin, scheme).toBe(18);
    }
    expect(Object.values(toNativeTheme("light").spacing)).not.toContain(18);
  });

  test("the scrim is the handoff's veil, not a heavier cold plate", () => {
    expect(toNativeTheme("light").colors.scrim).toBe("rgba(26,24,21,0.3)");
    expect(toNativeTheme("dark").colors.scrim).toBe("rgba(0,0,0,0.62)");
  });

  test("the stage carries its own sunken rung, one literal in both themes", () => {
    for (const scheme of ["light", "dark"] as const) {
      expect(toNativeTheme(scheme).colors.stageSunken, scheme).toBe("#1A1A19");
    }
    expect(toNativeTheme("light").colors.stageSunken).not.toBe(
      toNativeTheme("light").colors.stageLine
    );
  });

  test("the phone resolves the one touch type table", () => {
    const nativeType = toNativeTheme("light").type;
    expect(nativeType.display.fontSize).toBe(27);
    expect(nativeType.reading.fontSize).toBe(17);
    expect(nativeType.body.fontSize).toBe(type.body.size + 2);
  });

  test("rejects missing native fields and unsupported native roles", () => {
    const theme = toNativeTheme("light");
    const missingField = { ...theme.colors } as Partial<typeof theme.colors>;
    delete missingField.accent;
    expect(() => assertNativeColorRoleContract(missingField)).toThrow(
      "accent is missing from the native color emitter"
    );

    const accent = ROLE_REGISTRY["--accent"];
    if (!accent) throw new Error("missing --accent test fixture");
    const original = accent.by.native;
    try {
      accent.by.native = { kind: "unsupported", reason: "test fixture" };
      expect(() => assertNativeColorRoleContract(theme.colors)).toThrow(
        "accent is not backed by a native lowering for --accent"
      );
    } finally {
      accent.by.native = original;
    }
  });
});
