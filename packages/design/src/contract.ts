import { spacing, subBase } from "./density";
import { library } from "./library";
import { palette } from "./palette";
import { radii } from "./radii";
import { ADAPTERS, contractForProfile } from "./roles";
import {
  blueprintType,
  fontStacks,
  remSizeScale,
  type,
  typeModifiers,
  typeSizeRungs,
} from "./typography";

const paletteNames = Object.keys(palette).flatMap((key) => [
  `--c-${key}`,
  `--c-${key}-text`,
]);

const commonScale = [
  ...Object.keys(radii).map((key) => `--r-${key}`),
  ...Object.keys(spacing).map((key) => `--sp-${key}`),
  ...Object.keys(subBase).map((key) => `--sp-${key}`),
];

const typeNames = (scale: Record<string, unknown>): string[] => [
  ...Object.keys(fontStacks).map((key) => `--font-${key}`),
  ...Object.keys(scale).map(
    (key) =>
      `--t-${key.replace(/(?<lower>[a-z])(?<upper>[A-Z])/gu, "$<lower>-$<upper>").toLowerCase()}`
  ),
];

const adapterNames = (profile: "blueprint" | "shell"): string[] =>
  Object.values(ADAPTERS)
    .filter((adapter) =>
      (adapter.profiles as readonly string[]).includes(profile)
    )
    .map((adapter) => adapter.css);

export const SHELL_TOKEN_CONTRACT = [
  ...new Set([
    ...paletteNames,
    "--app-mark-hue",
    "--app-mark-ink",
    "--app-mark-size",
    "--app-mark-tint",
    ...commonScale,
    ...typeNames(type),
    ...Object.keys(typeSizeRungs(remSizeScale(type))),
    ...Object.keys(typeModifiers(type)),
    ...Object.keys(library).map((key) => {
      const suffix = key.startsWith("tile-") ? key.slice("tile-".length) : key;
      return `--tile-${suffix}`;
    }),
    ...contractForProfile("shell"),
    ...adapterNames("shell"),
  ]),
].sort();

export const BLUEPRINT_TOKEN_CONTRACT = [
  ...new Set([
    ...paletteNames,
    ...commonScale,
    ...typeNames(blueprintType),
    ...Object.keys(typeSizeRungs(blueprintType)),
    ...Object.keys(typeModifiers(type)),
    ...contractForProfile("blueprint"),
    ...adapterNames("blueprint"),
  ]),
].sort();
