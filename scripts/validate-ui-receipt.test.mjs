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

// A data client is not a surface (#931), the #930 refinement applied to the
// other over-broad half of the predicate. It is an EXCLUSION of the subtrees
// that render nothing, not an allowlist of the ones that do: most of what a
// member reads in this package lives outside `src/react/**`, so an allowlist
// would have stopped watching it without anyone noticing. These cases pin the
// files that must stay surfaces.
test("UI receipt evidence: a packages/client drawing change still demands a screenshot", () => {
  for (const file of [
    "packages/client/src/react/Shell.tsx",
    "packages/client/src/react/screens/Home.tsx",
    "packages/client/src/styles.css",
    // None of these is under src/react/, and every one of them draws:
    // the single spelling of every Home string, innerHTML'd SVG, the token
    // CSS applied before first paint, and the shell document itself.
    "packages/client/src/home-copy.ts",
    "packages/client/src/icons.ts",
    "packages/client/src/theme-vars.ts",
    "packages/client/src/index.html",
    // Copy, not transport: it carries an "Undo" action label.
    "packages/client/src/status-channel.ts",
    // Swept up by a broader pattern and carved back out, because each holds
    // copy composed for a member: the #883 C6 rebootstrap notice strings,
    // `RECOVERY_REFUSALS` ("the member reads a reason, not a code"), and the
    // Web Push body a member reads on a lock screen.
    "packages/client/src/replica/rebootstrap-copy.ts",
    "packages/client/src/gateway-client-edges.ts",
    "packages/client/src/gateway-client-push.ts",
    // react/blueprints/ is excluded BY FILE NAME, never as a folder: this one
    // posts status a member reads.
    "packages/client/src/react/blueprints/centraid-inline.ts",
  ]) {
    assert.deepEqual(
      validateUiReceipt({
        changed: [file, receipt],
        readText: () => "## User impact\n\nFirst-run: unchanged.\n",
      }),
      [DEMANDS_EVIDENCE],
      file
    );
  }
});

test("UI receipt evidence: a packages/client data-client change needs no screenshot", () => {
  assert.deepEqual(
    validateUiReceipt({
      changed: [
        "packages/client/src/gateway-client-conversation-history.ts",
        "packages/client/src/gateway-client.ts",
        "packages/client/src/replica/apply.ts",
        "packages/client/src/turn-stream.ts",
        "packages/client/src/version-handshake.ts",
        // The inline query engine: #922 wave 1's ctx-core refactor moves query
        // planning between modules that render nothing. One exact name — a
        // wildcard here would exempt files nobody can read yet.
        "packages/client/src/react/blueprints/inlineQueryCtx.ts",
        receipt,
      ],
      readText: () => "",
    }),
    []
  );
});

// #988 — a file on no import edge that draws nothing is not a surface. The
// manifest case is the one that bit: two strings in People's `app.json` (a dead
// `dpv:` purpose and a description sentence) demanded a screenshot of a screen
// that had not moved, and re-validated every screenshot the change set named.
test("UI receipt evidence: a file on no import edge needs no screenshot", () => {
  for (const file of [
    "packages/blueprints/apps/locker/README.md",
    "packages/client/src/react/CSS-CONVENTIONS.md",
    "packages/blueprints/apps/locker/tsconfig.yml",
    // A provider under the replica store: it renders no pixels and reads no
    // stylesheet, so a change to it photographs nothing.
    "packages/client/src/replica/ReplicaProvider.tsx",
  ]) {
    assert.deepEqual(
      validateUiReceipt({
        changed: [file, receipt],
        readText: () => "",
      }),
      [],
      file
    );
  }
});

// An app manifest is NOT exempt, whatever its extension says. `app.json`'s
// `description` is copied into the generated packages/blueprints/manifest.json,
// mapped to `desc` in react/shell/useShellApps.ts and `blurb` in
// react/shell/routes/homeData.ts, and painted by react/ui/AppCard.tsx on the
// Home tile — member copy that happens to live in JSON.
test("UI receipt evidence: a blueprint app's manifest and drawing files are surfaces", () => {
  for (const file of [
    "packages/blueprints/apps/people/app.json",
    "packages/blueprints/apps/people/app-root.tsx",
    "packages/blueprints/apps/people/Chrome.module.css",
  ]) {
    assert.deepEqual(
      validateUiReceipt({
        changed: [file, receipt],
        readText: () => "## User impact\n\nFirst-run: unchanged.\n",
      }),
      [DEMANDS_EVIDENCE],
      file
    );
  }
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
