// Canonical property contracts for the two CSS lowerings.
//
// Semantic names come from the role registry.  The only names kept beside
// that registry are mechanical scales and host adapters: they do not carry a
// second color or type vocabulary.  This keeps a new role visible to both
// emitters and makes a removed role fail the contract test immediately.

import { spacing } from "./density";
import { library } from "./library";
import { palette } from "./palette";
import { radii } from "./radii";
import { ADAPTERS, contractForProfile } from "./roles";
import {
  blueprintType,
  fontStacks,
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
    ...commonScale,
    ...typeNames(type),
    ...Object.keys(typeSizeRungs(type)),
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
