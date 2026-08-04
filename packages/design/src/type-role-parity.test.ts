// Shared type roles may adapt units per surface, but family and weight are
// semantic meaning and therefore cannot drift between CSS lowerings.

import { describe, expect, test } from "vitest";

import { toBlueprintCss } from "./blueprint.js";
import { toCss } from "./css.js";
import { type } from "./typography.js";

interface Shorthand {
  family: string;
  lineHeight: string;
  size: string;
  weight: string;
}

function rootProps(css: string): Record<string, string> {
  const start = css.indexOf(":root {");
  const body = start < 0 ? "" : css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const match of body.matchAll(
    /^\s*(?<prop>--[\w-]+):\s*(?<value>.+);$/gmu
  )) {
    const { prop, value } = match.groups ?? {};
    if (prop && value) out[prop] = value;
  }
  return out;
}

function parse(value: string): Shorthand {
  const match =
    /^(?<weight>\d{3}) (?<size>[^ ]+)\/(?<lineHeight>[^ ]+) var\((?<family>--[\w-]+)\)$/u.exec(
      value
    );
  if (!match?.groups) throw new Error(`${value} is not a type shorthand`);
  return {
    family: match.groups.family ?? "",
    lineHeight: match.groups.lineHeight ?? "",
    size: match.groups.size ?? "",
    weight: match.groups.weight ?? "",
  };
}

const shell = rootProps(toCss());
const blueprint = rootProps(toBlueprintCss());
const shared = Object.keys(type).map(
  (key) =>
    `--t-${key.replace(/(?<l>[a-z])(?<u>[A-Z])/gu, "$<l>-$<u>").toLowerCase()}`
);

describe("type role parity across emitters", () => {
  test("every shared role is published by both emitters", () => {
    for (const name of shared) {
      expect(shell[name], `${name} shell`).toBeDefined();
      const blueprintRole = blueprint[name];
      expect(blueprintRole === undefined, `${name} blueprint support`).toBe(
        name === "--t-hero" || name === "--t-greeting"
      );
    }
  });

  test.each(
    shared.filter((name) => name !== "--t-hero" && name !== "--t-greeting")
  )("%s keeps family genus and weight", (name) => {
    const a = parse(shell[name] ?? "");
    const b = parse(blueprint[name] ?? "");
    expect({ family: a.family, weight: a.weight }).toStrictEqual({
      family: b.family,
      weight: b.weight,
    });
  });

  test("the blueprint adapts units while retaining the semantic body role", () => {
    expect(shell["--t-body"]).toContain("15px/22px");
    expect(blueprint["--t-body"]).toContain("0.9375rem/1.4666666666666666");
    expect(parse(shell["--t-body"] ?? "").weight).toBe("400");
    expect(parse(blueprint["--t-body"] ?? "").weight).toBe("400");
  });
});
