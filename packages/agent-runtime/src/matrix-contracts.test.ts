import { RUNNER_KINDS } from "@centraid/app-engine";
/**
 * Matrix cell agent-runtime.contracts (#535 coverable-today).
 * Registry shape is the public contract every runner kind must satisfy.
 */
import { describe, expect, test } from "vitest";

import { RUNNER_BACKENDS, getRunnerBackend } from "./registry.ts";

describe("matrix-contracts", () => {
  test("every RunnerKind has a backend with kind/label/minVersion/runTurn contract", () => {
    for (const kind of RUNNER_KINDS) {
      const backend = getRunnerBackend(kind);
      expect(backend).toBe(RUNNER_BACKENDS[kind]);
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
    expect(Object.keys(RUNNER_BACKENDS).sort()).toStrictEqual(
      [...RUNNER_KINDS].sort()
    );
  });
});
