// The DOM skeleton's numbers are the shared model's numbers (#765).
//
// A stylesheet cannot import, so `react/styles/pageSkeleton.module.css` spells
// the bone sequence and the breath as CSS while `@centraid/design/blocks`
// holds them as values for the React Native lowering. That is one fact in two
// notations, which is exactly the shape drift takes — so this test reads the
// stylesheet and pins it to the model. Change the model and this fails until
// the CSS follows.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  boneDelay,
  boneWidths,
  SKELETON_PULSE_HIGH,
  SKELETON_PULSE_LOW,
  SKELETON_PULSE_MS,
  SKELETON_ROWS,
  SKELETON_STAGGER_MS,
} from "@centraid/design/blocks";

const css = readFileSync(
  path.join(import.meta.dirname, "..", "styles", "pageSkeleton.module.css"),
  "utf8"
);

/** The `inline-size` a given row's bone is given, as a number. `nth-child(6)`
 *  and beyond are not enumerated: they inherit the base rule. */
function widthForRow(row: number): number {
  const rule = new RegExp(
    String.raw`nth-child\(${String(row)}\)::after\s*\{[^}]*inline-size:\s*(?<width>\d+)%`,
    "u"
  ).exec(css);
  const base = /::after\s*\{[^}]*inline-size:\s*(?<width>\d+)%/u.exec(css);
  return Number(rule?.groups?.width ?? base?.groups?.width);
}

describe("pageSkeleton.module.css", () => {
  it("steps its bones on the shared sequence", () => {
    const drawn = Array.from({ length: SKELETON_ROWS }, (_unused, index) =>
      widthForRow(index + 1)
    );
    expect(drawn).toStrictEqual([...boneWidths(SKELETON_ROWS)]);
  });

  it("staggers the breath on the shared step", () => {
    const step = /--skel-step:\s*(?<ms>\d+)ms/u.exec(css);
    expect(Number(step?.groups?.ms)).toBe(SKELETON_STAGGER_MS);
    // The CSS multiplies the step by the row's index; the model states the
    // product directly. Same arithmetic, checked at the last enumerated row.
    const last = new RegExp(
      String.raw`nth-child\(${String(SKELETON_ROWS)}\)\s*\{[^}]*calc\(var\(--skel-step\)\s*\*\s*(?<n>\d+)\)`,
      "u"
    ).exec(css);
    expect(Number(last?.groups?.n) * SKELETON_STAGGER_MS).toBe(
      boneDelay(SKELETON_ROWS - 1)
    );
  });

  it("breathes between the shared opacities, over the shared duration", () => {
    const duration = /animation:\s*pageSkeletonPulse\s*(?<s>[\d.]+)s/u.exec(
      css
    );
    expect(Number(duration?.groups?.s) * 1000).toBe(SKELETON_PULSE_MS);
    const opacities = [...css.matchAll(/opacity:\s*(?<value>[\d.]+)/gu)].map(
      (match) => Number(match.groups?.value)
    );
    expect(opacities).toContain(SKELETON_PULSE_HIGH);
    expect(opacities).toContain(SKELETON_PULSE_LOW);
    // The keyframe RESTS at the high value, so a collapsed animation under
    // reduced motion renders a still, legible bone rather than a half-faded one.
    expect(opacities[0]).toBe(SKELETON_PULSE_HIGH);
  });
});
