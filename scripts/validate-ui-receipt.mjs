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

export function validateUiReceipt({ changed, readText }) {
  const touchesUi = changed.some(
    (file) =>
      file.startsWith("packages/client/") ||
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
