import { describe, expect, test } from "vitest";

import { toBlueprintCss } from "./blueprint.js";
import { darkTheme, lightTheme } from "./themes/centraid.js";

type Rgb = readonly [number, number, number];

function hex(value: string): Rgb {
  const match = /^#(?<value>[\da-f]{6})$/iu.exec(value);
  if (!match?.groups?.value) throw new Error(`not a hex colour: ${value}`);
  const valueHex = match.groups.value;
  return [
    Number.parseInt(valueHex.slice(0, 2), 16),
    Number.parseInt(valueHex.slice(2, 4), 16),
    Number.parseInt(valueHex.slice(4, 6), 16),
  ];
}

function alpha(value: string, background: Rgb): Rgb {
  const match = /rgba\((?<r>\d+),(?<g>\d+),(?<b>\d+),(?<a>[\d.]+)\)/u.exec(
    value
  );
  if (!match?.groups) return hex(value);
  const a = Number(match.groups.a);
  return [
    Math.round(Number(match.groups.r) * a + background[0] * (1 - a)),
    Math.round(Number(match.groups.g) * a + background[1] * (1 - a)),
    Math.round(Number(match.groups.b) * a + background[2] * (1 - a)),
  ];
}

function luminance([r, g, b]: Rgb): number {
  const channel = (value: number): number => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: Rgb, background: Rgb): number {
  const one = luminance(foreground);
  const two = luminance(background);
  const lighter = Math.max(one, two);
  const darker = Math.min(one, two);
  return (lighter + 0.05) / (darker + 0.05);
}

function hsl(h: number, s: number, l: number): Rgb {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const segment = h / 60;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  const [r, g, b] =
    segment < 1
      ? [chroma, x, 0]
      : segment < 2
        ? [x, chroma, 0]
        : segment < 3
          ? [0, chroma, x]
          : segment < 4
            ? [0, x, chroma]
            : segment < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = l - chroma / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

describe("text contrast floors", () => {
  test("shell text roles and accent text meet AA or non-text floors", () => {
    const lightBackground = hex(lightTheme.bg);
    const darkBackground = hex("#000000");
    for (const [theme, background] of [
      [lightTheme, lightBackground],
      [darkTheme, darkBackground],
    ] as const) {
      expect(
        contrast(alpha(theme.text, background), background),
        theme.kind
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(alpha(theme.textSoft, background), background),
        theme.kind
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(alpha(theme.textFaint, background), background),
        theme.kind
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrast(alpha(theme.textGhost, background), background),
        theme.kind
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrast(hex(theme.accentText), background),
        `${theme.kind} accent text`
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(hex(theme.success), background),
        `${theme.kind} success`
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrast(hex(theme.danger), background),
        `${theme.kind} danger`
      ).toBeGreaterThanOrEqual(3);
    }
  });

  test("the hue-parameterized blueprint text recipe clears the same floors", () => {
    const css = toBlueprintCss();
    expect(css).toContain("--app-hue: 171;");
    const lightBackground = hsl(171, 0.2, 0.98);
    const darkBackground = hsl(171, 0.12, 0.1);
    for (const [background, roles] of [
      [
        lightBackground,
        [hsl(171, 0.22, 0.13), hsl(171, 0.09, 0.41), hsl(171, 0.08, 0.5)],
      ],
      [
        darkBackground,
        [hsl(171, 0.16, 0.94), hsl(171, 0.09, 0.66), hsl(171, 0.09, 0.55)],
      ],
    ] as const) {
      expect(contrast(roles[0], background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(roles[1], background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(roles[2], background)).toBeGreaterThanOrEqual(3);
    }
  });
});
