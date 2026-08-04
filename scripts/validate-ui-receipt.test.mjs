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
