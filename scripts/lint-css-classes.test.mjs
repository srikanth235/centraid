import assert from "node:assert/strict";
// oxlint-disable-next-line no-restricted-imports -- (#781) node --test lane: the kit's tempDir() registers a vitest afterAll at import time and throws here; removal is registered at creation via t.after below.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { lintCssClasses } from "./lint-css-classes.mjs";

const TARGET = "src";

function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "centraid-css-classes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

test("a className with a backing CSS rule passes", (t) => {
  const root = fixture(t, {
    "src/Card.module.css": ".card { color: red; }\n",
    "src/Card.tsx":
      'import styles from "./Card.module.css";\nexport const C = () => <div className={styles.card} />;\n',
  });
  const result = lintCssClasses(root, [TARGET]);
  assert.deepEqual(result.findings, []);
  assert.equal(result.modulesResolved, 1);
});

test("a className with no backing CSS rule is reported", (t) => {
  const root = fixture(t, {
    "src/Card.module.css": ".card { color: red; }\n",
    "src/Card.tsx":
      'import styles from "./Card.module.css";\nexport const C = () => <div className={styles.ghost} />;\n',
  });
  assert.deepEqual(lintCssClasses(root, [TARGET]).findings, [
    "src/Card.tsx:styles.ghost — no .ghost rule in Card.module.css",
  ]);
});

test("a class named only inside a CSS comment does not count as defined", (t) => {
  const root = fixture(t, {
    "src/Card.module.css":
      "/* .card is coming soon */\n.other { color: red; }\n",
    "src/Card.tsx":
      'import styles from "./Card.module.css";\nexport const C = () => <div className={styles.card} />;\n',
  });
  assert.deepEqual(lintCssClasses(root, [TARGET]).findings, [
    "src/Card.tsx:styles.card — no .card rule in Card.module.css",
  ]);
});

test("an import that does not resolve is reported", (t) => {
  const root = fixture(t, {
    "src/Card.tsx":
      'import styles from "./Missing.module.css";\nexport const C = () => <div className={styles.card} />;\n',
  });
  assert.deepEqual(lintCssClasses(root, [TARGET]).findings, [
    "src/Card.tsx — import './Missing.module.css' does not resolve",
  ]);
});

test("computed access is reported as unverifiable", (t) => {
  const root = fixture(t, {
    "src/Card.module.css": ".card { color: red; }\n",
    "src/Card.tsx":
      'import styles from "./Card.module.css";\nexport const C = (k) => <div className={styles[k]} />;\n',
  });
  const result = lintCssClasses(root, [TARGET]);
  assert.deepEqual(result.dynamic, [
    "src/Card.tsx — styles[…] computed access is unverifiable",
  ]);
  assert.deepEqual(result.findings, []);
});

test("the import line and comment lines never self-match as reads", (t) => {
  const root = fixture(t, {
    "src/Card.module.css": ".card { color: red; }\n",
    "src/Card.tsx":
      'import styles from "./Card.module.css";\n// styles.legacy was removed\nexport const C = () => <div className={styles.card} />;\n',
  });
  assert.deepEqual(lintCssClasses(root, [TARGET]).findings, []);
});

test("a missing TARGETS directory is surfaced, not silently skipped", (t) => {
  const root = fixture(t, { "README.md": "empty\n" });
  assert.equal(lintCssClasses(root, [TARGET]).missingTarget, TARGET);
});

test("a tree with no CSS-module imports reports zero resolved modules", (t) => {
  const root = fixture(t, {
    "src/plain.tsx": "export const C = () => null;\n",
  });
  const result = lintCssClasses(root, [TARGET]);
  assert.equal(result.filesScanned, 1);
  assert.equal(result.modulesResolved, 0);
});

test("node_modules and dist are not scanned", (t) => {
  const root = fixture(t, {
    "src/keep.tsx": "export const C = () => null;\n",
    "src/node_modules/dep/index.tsx": "export const D = () => null;\n",
    "src/dist/bundle.tsx": "export const E = () => null;\n",
  });
  assert.equal(lintCssClasses(root, [TARGET]).filesScanned, 1);
});
