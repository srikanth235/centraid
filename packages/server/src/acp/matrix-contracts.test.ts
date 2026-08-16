/**
 * Matrix cell agent-runtime.contracts (#535 coverable-today).
 * Registry shape is the public contract every harness kind must satisfy.
 */
import { describe, expect, test } from "vitest";

import { HARNESS_KINDS } from "@centraid/server/engine";

import { HARNESSES, getHarness } from "./registry.ts";

describe("matrix-contracts", () => {
  test("every HarnessKind has a harness with kind/label/minVersion/runTurn contract", () => {
    for (const kind of HARNESS_KINDS) {
      const harness = getHarness(kind);
      expect(harness).toBe(HARNESSES[kind]);
      expect(harness.kind).toBe(kind);
      expect(harness.label.length).toBeGreaterThan(0);
      expect(harness.minVersion).toStrictEqual(
        expect.objectContaining({
          major: expect.any(Number),
          minor: expect.any(Number),
          patch: expect.any(Number),
        })
      );
      expect(harness.runTurn).toBeTypeOf("function");
      expect(harness.enumerateModels).toBeTypeOf("function");
      expect(harness.installHint.length).toBeGreaterThan(0);
    }
  });

  test("unknown kind is not silently present in the registry table", () => {
    expect(Object.keys(HARNESSES).sort()).toStrictEqual(
      [...HARNESS_KINDS].sort((a, b) => a.localeCompare(b))
    );
  });
});
