import { describe, expect, test } from "vitest";

import {
  checkImportBoundary,
  isForbiddenImport,
} from "./check-import-boundary.mjs";

describe("server import-boundary", () => {
  test("the shipped engine and automation trees have no forbidden imports", () => {
    const result = checkImportBoundary();
    expect(result.violations).toStrictEqual([]);
    expect(result.ok).toBe(true);
  });

  test("engine → acp or automation is forbidden", () => {
    expect(isForbiddenImport("engine", "@centraid/server/acp")).toBe(true);
    expect(isForbiddenImport("engine", "@centraid/server/automation")).toBe(
      true
    );
    expect(isForbiddenImport("engine", "../acp/runtime.js")).toBe(true);
    expect(isForbiddenImport("engine", "@centraid/server/engine")).toBe(false);
  });

  test("automation → acp is forbidden; engine is allowed", () => {
    expect(isForbiddenImport("automation", "@centraid/server/acp")).toBe(true);
    expect(isForbiddenImport("automation", "@centraid/server/engine")).toBe(
      false
    );
  });

  test("a temporary forbidden import fails the shipped checker", () => {
    const result = checkImportBoundary({
      extraFiles: [
        {
          tree: "engine",
          file: "packages/server/src/engine/__fixture__.ts",
          source: 'import { runTurn } from "@centraid/server/acp";\n',
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((line) => line.includes("acp"))).toBe(true);
  });
});
