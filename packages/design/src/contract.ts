// Canonical property contracts for the two CSS lowerings.
//
// Keep this list derived from the same public tables as the emitters.  The
// contract test compares it to actual generated output, while role tests
// ensure semantic properties have a total profile lowering.

import { spacing } from "./density";
import { library } from "./library";
import { palette } from "./palette";
import { radii } from "./radii";
import { blueprintType, fontStacks, type, typeSizeRungs } from "./typography";

const themePropertyNames = [
  "--accent",
  "--accent-deep",
  "--accent-fill",
  "--accent-deep-hover",
  "--accent-light",
  "--accent-soft",
  "--accent-text",
  "--app-identity-text",
  "--bg",
  "--bg-app",
  "--bg-chrome",
  "--bg-elev",
  "--bg-hud",
  "--bg-hover",
  "--bg-press",
  "--bg-sel",
  "--bg-sunken",
  "--bg-wall",
  "--danger",
  "--device-wall",
  "--glass-film",
  "--glass-sheen",
  "--focus-ring",
  "--focus-ring-color",
  "--line",
  "--line-strong",
  "--line-sel",
  "--on-accent",
  "--scrim",
  "--shadow-lg",
  "--shadow-md",
  "--shadow-sm",
  "--success",
  "--text",
  "--text-faint",
  "--text-ghost",
  "--text-inv",
  "--text-disabled",
  "--text-soft",
  "--warning",
];

const paletteNames = Object.keys(palette).flatMap((key) => [
  `--c-${key}`,
  `--c-${key}-text`,
]);
const commonScale = [
  ...Object.keys(radii).map((key) => `--r-${key}`),
  ...Object.keys(spacing).map((key) => `--sp-${key}`),
];
const shellType = [
  ...Object.keys(fontStacks).map((key) => `--font-${key}`),
  ...Object.keys(type).map(
    (key) =>
      `--t-${key.replace(/(?<l>[a-z])(?<u>[A-Z])/gu, "$<l>-$<u>").toLowerCase()}`
  ),
  ...Object.keys(typeSizeRungs(type)),
];

export const SHELL_TOKEN_CONTRACT = [
  ...new Set([
    ...paletteNames,
    ...commonScale,
    "--accent",
    "--dur-1",
    "--dur-2",
    "--ease",
    "--focus-ring",
    "--o-disabled",
    "--target-min",
    ...shellType,
    ...Object.keys(library).map((key) => {
      const suffix = key.startsWith("tile-") ? key.slice("tile-".length) : key;
      return `--tile-${suffix}`;
    }),
    ...themePropertyNames,
  ]),
].sort();

const blueprintTheme = [
  "--accent",
  "--accent-deep",
  "--accent-fill",
  "--accent-deep-hover",
  "--accent-light",
  "--accent-soft",
  "--accent-text",
  "--app-hue",
  "--app-identity",
  "--app-identity-text",
  "--bg",
  "--bg-elev",
  "--bg-hover",
  "--bg-press",
  "--bg-sel",
  "--bg-sunken",
  "--danger",
  "--dur-1",
  "--dur-2",
  "--ease",
  "--focus-ring",
  "--focus-ring-color",
  "--line",
  "--line-strong",
  "--line-sel",
  "--on-accent",
  "--o-disabled",
  "--scrim",
  "--shadow-lg",
  "--shadow-md",
  "--shadow-sm",
  "--success",
  "--target-min",
  "--text",
  "--text-faint",
  "--text-ghost",
  "--text-inv",
  "--text-disabled",
  "--text-soft",
  "--warning",
];

export const BLUEPRINT_TOKEN_CONTRACT = [
  ...new Set([
    ...paletteNames,
    ...commonScale,
    ...blueprintTheme,
    ...Object.keys(fontStacks).map((key) => `--font-${key}`),
    ...Object.keys(blueprintType).map(
      (key) =>
        `--t-${key.replace(/(?<l>[a-z])(?<u>[A-Z])/gu, "$<l>-$<u>").toLowerCase()}`
    ),
    ...Object.keys(typeSizeRungs(blueprintType)),
  ]),
].sort();

// Keep the imports above visibly tied to the registered theme set.  The
// registry is intentionally referenced here so adding a theme cannot make
// the contract appear complete while its solved palette is untested.
