#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const SCREENSHOT_RE = /artifacts\/e2e\/ui-impact\/[^\s)]+\.png/giu;

/*
 * A blueprint app's SUITE is not one of its surfaces (#930). Every other path
 * this gate watches is something a member can see; `queries.test.ts` and the
 * `*.test-fixtures.ts` module it reads are not, and the only exit from this
 * gate is a screenshot emitted by a changed e2e harness — so before this, a
 * change that split an over-long test file (or merely deleted a comment in
 * one) had to photograph a screen that had not moved. The component,
 * stylesheet and handler files beside them are still user-facing, which the
 * cases in validate-ui-receipt.test.mjs pin.
 */
const TEST_FILE_RE = /(?:\.test|\.test-fixtures)\.[^./]+$/u;

/*
 * A DATA CLIENT is not a surface either (#931), the same refinement #930 made
 * one commit earlier for a blueprint app's suite. Watching the whole of
 * `packages/client` meant that escaping a raw NUL in an attachment-URL cache
 * key — two characters, in a module with no DOM — demanded a screenshot of a
 * screen that had not moved, emitted by an e2e harness the change had no reason
 * to touch, in an environment that may have no browser at all.
 *
 * IT IS AN EXCLUSION LIST, NOT AN ALLOWLIST, and that is the whole design. The
 * drawing surface of this package is not `src/react/**`: `home-copy.ts` is the
 * single spelling of every Home string, `icons.ts` is innerHTML'd SVG,
 * `theme-vars.ts` is the token CSS applied before first paint, `index.html` is
 * the shell document, and the eight other `*-copy.ts` modules are the words a
 * member reads. An allowlist would have dropped every one of them silently,
 * which is how a gate stops enforcing. So the default stays what it was —
 * everything under `packages/client` is a surface — and only subtrees READ and
 * confirmed to render nothing are named below. Adding a path here is a claim
 * about a specific file; the surrounding cases in validate-ui-receipt.test.mjs
 * pin what must stay outside it.
 *
 * The screenshot requirement itself is untouched: this narrows WHICH files are
 * surfaces, not what a surface change owes.
 */
const CLIENT_NOT_A_SURFACE = [
  // The replica store and its transport: no DOM, no copy, no markup.
  /^packages\/client\/src\/replica\//u,
  // The renderer-side HTTP client hub and its per-surface modules, plus the
  // credential handover, the SSE/turn streams, the change feeds, the protocol
  // handshake and the device compute/blob sources beside them. Each was read
  // for DOM calls, markup and user-visible strings before being named here.
  /^packages\/client\/src\/gateway-client[\w.-]*\.ts$/u,
  /^packages\/client\/src\/(?:gateway-auth|turn-stream|vault-change-feed|vault-change-sse|version-handshake|device-blob-source|device-enrichment-worker|device-roster)\.ts$/u,
];

/** Does this path draw something a member can see? */
function isClientSurface(file) {
  if (!file.startsWith("packages/client/")) return false;
  return !CLIENT_NOT_A_SURFACE.some((pattern) => pattern.test(file));
}

export function validateUiReceipt({ changed, readText }) {
  const touchesUi = changed.some(
    (file) =>
      isClientSurface(file) ||
      /^apps\/[^/]+\/.*\.(?:tsx|css)$/u.test(file) ||
      (file.startsWith("packages/blueprints/apps/") && !TEST_FILE_RE.test(file))
  );
  if (!touchesUi) return [];
  const errors = [];
  const receipts = changed.filter((file) =>
    /^receipts\/issue-\d+-.*\.md$/u.test(file)
  );
  for (const file of receipts) {
    const text = readText(file);
    if (!/^## User impact\s*$/mu.test(text) || !/first[- ]run:/iu.test(text))
      continue;
    for (const screenshot of text.match(SCREENSHOT_RE) ?? []) {
      const filename = path.basename(screenshot);
      const emitter = changed.find((candidate) => {
        if (!/(?:e2e|agent-e2e).*(?:spec\.ts|\.mjs)$/u.test(candidate))
          return false;
        const source = readText(candidate);
        return (
          source.includes("artifacts/e2e/ui-impact") &&
          source.includes(filename) &&
          /(?:page\.)?screenshot\s*\(/u.test(source)
        );
      });
      if (emitter) return [];
      errors.push(
        `${screenshot} has no changed e2e harness emitter (the harness must name the ui-impact directory, filename, and screenshot call)`
      );
    }
  }
  if (!errors.length)
    errors.push(
      "user-facing changes require `## User impact`, a `First-run:` note, and a screenshot path emitted by a changed e2e harness under artifacts/e2e/ui-impact/"
    );
  return errors;
}

if (process.argv[1] === import.meta.filename) {
  const changed = [
    ...execFileSync("git", ["diff", "--name-only", "origin/main", "--"], {
      cwd: root,
      encoding: "utf8",
    }).split("\n"),
    ...execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
    }).split("\n"),
  ].filter(Boolean);
  // `git diff --name-only` lists deletions too; a receipt renamed away (a
  // waived doc-integrity migration) must not crash the gate — the surviving
  // receipt is the one that carries the evidence.
  const present = changed.filter((file) => existsSync(path.join(root, file)));
  const errors = validateUiReceipt({
    changed: present,
    readText: (file) => readFileSync(path.join(root, file), "utf8"),
  });
  if (errors.length) {
    for (const error of errors) console.error(`UI receipt gate: ${error}`);
    process.exit(1);
  }
  console.log("UI receipt gate: evidence verified");
}
