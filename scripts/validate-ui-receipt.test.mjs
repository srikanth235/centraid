import { describe, expect, test } from "vitest";

import { validateUiReceipt } from "./validate-ui-receipt.mjs";

const uiFile = "packages/client/src/react/Shell.tsx";
const receipt = "receipts/issue-679-quality-gates.md";
describe("UI receipt evidence", () => {
  test("rejects screenshot paths without an e2e emitter", () => {
    const errors = validateUiReceipt({
      changed: [uiFile, receipt],
      readText: () =>
        "## User impact\n\nFirst-run: unchanged.\n\n![](artifacts/e2e/ui-impact/missing.png)",
    });
    expect(errors).toContain(
      "artifacts/e2e/ui-impact/missing.png has no changed e2e harness emitter (the harness must name the ui-impact directory, filename, and screenshot call)"
    );
  });

  test("a blueprint app's .tsx still demands a screenshot", () => {
    expect(
      validateUiReceipt({
        changed: ["packages/blueprints/apps/locker/app-root.tsx", receipt],
        readText: () => "## User impact\n\nFirst-run: unchanged.\n",
      })
    ).toStrictEqual([
      "user-facing changes require `## User impact`, a `First-run:` note, and a screenshot path emitted by a changed e2e harness under artifacts/e2e/ui-impact/",
    ]);
  });

  test("a blueprint app's stylesheet still demands a screenshot", () => {
    expect(
      validateUiReceipt({
        changed: ["packages/blueprints/apps/locker/Chrome.module.css", receipt],
        readText: () => "## User impact\n\nFirst-run: unchanged.\n",
      })
    ).toStrictEqual([
      "user-facing changes require `## User impact`, a `First-run:` note, and a screenshot path emitted by a changed e2e harness under artifacts/e2e/ui-impact/",
    ]);
  });

  // A suite is not a surface (#930): splitting an over-long test file must not
  // require photographing a screen that did not move. `states.test.tsx` is in
  // the list because the exemption is the FILENAME, not the extension.
  test("a test-only change under a blueprint app needs no screenshot", () => {
    expect(
      validateUiReceipt({
        changed: [
          "packages/blueprints/apps/locker/queries.test.ts",
          "packages/blueprints/apps/locker/queries-reveal-access.test.ts",
          "packages/blueprints/apps/locker/queries.test-fixtures.ts",
          "packages/blueprints/apps/locker/states.test.tsx",
          receipt,
        ],
        readText: () => "",
      })
    ).toStrictEqual([]);
  });

  test("accepts a path emitted by a changed e2e harness", () => {
    expect(
      validateUiReceipt({
        changed: [uiFile, "apps/desktop/tests/e2e/ui.spec.ts", receipt],
        readText: (file) =>
          file === receipt
            ? "## User impact\n\nFirst-run: unchanged.\n\n![](artifacts/e2e/ui-impact/679.png)"
            : file.endsWith("ui.spec.ts")
              ? 'const dir = "artifacts/e2e/ui-impact"; await page.screenshot({ path: dir + "/679.png" });'
              : "",
      })
    ).toStrictEqual([]);
  });
});
