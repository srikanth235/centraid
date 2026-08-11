/**
 * Matrix cell agent-runtime.contracts (#535 coverable-today).
 * Registry shape is the public contract every harness kind must satisfy.
 */
import { describe, expect, test } from "vitest";

import { HARNESS_KINDS } from "@centraid/app-engine";

import { HARNESSES, getHarness } from "./registry.ts";

describe("matrix-contracts", () => {
  test("every HarnessKind has a backend with kind/label/minVersion/runTurn contract", () => {
    for (const kind of HARNESS_KINDS) {
      const backend = getHarness(kind);
      expect(backend).toBe(HARNESSES[kind]);
      expect(backend.kind).toBe(kind);
      expect(backend.label.length).toBeGreaterThan(0);
      expect(backend.minVersion).toStrictEqual(
        expect.objectContaining({
          major: expect.any(Number),
          minor: expect.any(Number),
          patch: expect.any(Number),
        })
      );
      expect(backend.runTurn).toBeTypeOf("function");
      expect(backend.enumerateModels).toBeTypeOf("function");
      expect(backend.installHint.length).toBeGreaterThan(0);
    }
  });

  test("unknown kind is not silently present in the registry table", () => {
    expect(Object.keys(HARNESSES).sort()).toStrictEqual(
      [...HARNESS_KINDS].sort((a, b) => a.localeCompare(b))
    );
  });
});
