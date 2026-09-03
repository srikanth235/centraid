// Fail-path proof for `bun run check:ui-receipt`.
//
// `node:test`, not vitest: this file was written with vitest imports and named
// by no runner, so its cases never executed (#930). It joins the `scripts:test`
// list rather than gaining a vitest project of its own, which is the runner the
// other pure `scripts/*.test.mjs` gates use — same pattern as
// scripts/lint-law-registry.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";

import { validateUiReceipt } from "./validate-ui-receipt.mjs";

const uiFile = "packages/client/src/react/Shell.tsx";
const receipt = "receipts/issue-679-quality-gates.md";
const DEMANDS_EVIDENCE =
  "user-facing changes require `## User impact`, a `First-run:` note, and a screenshot path emitted by a changed e2e harness under artifacts/e2e/ui-impact/";

test("UI receipt evidence: rejects screenshot paths without an e2e emitter", () => {
  const errors = validateUiReceipt({
    changed: [uiFile, receipt],
    readText: () =>
      "## User impact\n\nFirst-run: unchanged.\n\n![](artifacts/e2e/ui-impact/missing.png)",
  });
  assert.ok(
    errors.includes(
      "artifacts/e2e/ui-impact/missing.png has no changed e2e harness emitter (the harness must name the ui-impact directory, filename, and screenshot call)"
    )
  );
});

test("UI receipt evidence: a blueprint app's .tsx still demands a screenshot", () => {
  assert.deepEqual(
    validateUiReceipt({
      changed: ["packages/blueprints/apps/locker/app-root.tsx", receipt],
      readText: () => "## User impact\n\nFirst-run: unchanged.\n",
    }),
    [DEMANDS_EVIDENCE]
  );
});

test("UI receipt evidence: a blueprint app's stylesheet still demands a screenshot", () => {
  assert.deepEqual(
    validateUiReceipt({
      changed: ["packages/blueprints/apps/locker/Chrome.module.css", receipt],
      readText: () => "## User impact\n\nFirst-run: unchanged.\n",
    }),
    [DEMANDS_EVIDENCE]
  );
});

// A suite is not a surface (#930): splitting an over-long test file must not
// require photographing a screen that did not move. `states.test.tsx` is in
// the list because the exemption is the FILENAME, not the extension.
test("UI receipt evidence: a test-only change under a blueprint app needs no screenshot", () => {
  assert.deepEqual(
    validateUiReceipt({
      changed: [
        "packages/blueprints/apps/locker/queries.test.ts",
        "packages/blueprints/apps/locker/queries-reveal-access.test.ts",
        "packages/blueprints/apps/locker/queries.test-fixtures.ts",
        "packages/blueprints/apps/locker/states.test.tsx",
        receipt,
      ],
      readText: () => "",
    }),
    []
  );
});

test("UI receipt evidence: accepts a path emitted by a changed e2e harness", () => {
  assert.deepEqual(
    validateUiReceipt({
      changed: [uiFile, "apps/desktop/tests/e2e/ui.spec.ts", receipt],
      readText: (file) =>
        file === receipt
          ? "## User impact\n\nFirst-run: unchanged.\n\n![](artifacts/e2e/ui-impact/679.png)"
          : file.endsWith("ui.spec.ts")
            ? 'const dir = "artifacts/e2e/ui-impact"; await page.screenshot({ path: dir + "/679.png" });'
            : "",
    }),
    []
  );
});
