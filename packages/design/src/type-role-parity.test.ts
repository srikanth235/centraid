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
  test("every role is published by BOTH emitters", () => {
    // The Binding Layer's ramp is the same on every profile, so there are no
    // shell-only roles: `--t-hero` and `--t-greeting` are not in the scale,
    // because the app surface cannot render them.
    for (const name of shared) {
      expect(shell[name], `${name} shell`).toBeDefined();
      expect(blueprint[name], `${name} blueprint`).toBeDefined();
    }
    expect(shared).not.toContain("--t-hero");
    expect(shared).not.toContain("--t-greeting");
  });

  test.each(shared)("%s keeps family genus and weight", (name) => {
    const a = parse(shell[name] ?? "");
    const b = parse(blueprint[name] ?? "");
    expect({ family: a.family, weight: a.weight }).toStrictEqual({
      family: b.family,
      weight: b.weight,
    });
  });

  test("the shell and blueprint both adapt units host-relatively", () => {
    // The shell now lowers to `rem` too (#708): 15px / 22px ÷ 16.
    expect(shell["--t-body"]).toContain("0.9375rem/1.375rem");
    // The blueprint's line-height stays a unitless ratio (÷ the role's own
    // size, not the root) rather than a second `rem` value — a deliberate
    // divergence the role-parity law permits, since it gates family and
    // weight, not size (see typography.ts's `toBlueprintStyle`).
    expect(blueprint["--t-body"]).toContain("0.9375rem/1.4666666666666666");
    expect(parse(shell["--t-body"] ?? "").weight).toBe("400");
    expect(parse(blueprint["--t-body"] ?? "").weight).toBe("400");
  });
});
