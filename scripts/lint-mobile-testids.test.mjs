import assert from "node:assert/strict";
// oxlint-disable-next-line no-restricted-imports -- (#890) node --test lane: the kit's tempDir() registers a vitest afterAll at import time and throws here; removal is registered at creation via t.after below.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectFlowIds,
  discoverFlowFiles,
  discoverSourceFiles,
  isAllowed,
  lintTestIds,
  parseVocabulary,
  templateLines,
} from "./lint-mobile-testids.mjs";

const chunk = (body) => `await ctx.run(\`appId: x\n---\n${body}\n\`);`;

const VOCABULARY_SRC = [
  "export const TEST_IDS = Object.freeze({",
  "  home: Object.freeze({",
  '    band: "home-band",',
  "  }),",
  "});",
  "export const TEST_ID_PREFIXES = Object.freeze({",
  '  homeTile: "home-tile-",',
  "});",
].join("\n");

const vocabulary = () => parseVocabulary(VOCABULARY_SRC);

const APPLIED = [
  { rel: "a.tsx", text: "<View testID={TEST_IDS.home.band} />" },
  // oxlint-disable-next-line no-template-curly-in-string
  { rel: "b.tsx", text: "testID={`${TEST_ID_PREFIXES.homeTile}${id}`}" },
];

function fixtureRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), "centraid-testid-lint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const rules = (result) => result.findings.map((finding) => finding.rule).sort();

test("a referenced-but-absent id fails", () => {
  const result = lintTestIds({
    flows: [{ rel: "f.mjs", text: chunk('- tapOn:\n    id: "home-nope"') }],
    vocabulary: vocabulary(),
    sources: APPLIED,
  });
  assert.deepEqual(rules(result), ["missing-id"]);
  assert.match(result.findings[0].message, /no screen in apps\/mobile\/src/u);
});

test("an inline id selector is caught too, not just the block form", () => {
  const result = lintTestIds({
    flows: [
      {
        rel: "f.mjs",
        text: chunk(
          '- swipe:\n    from: { id: "home-nope" }\n    direction: LEFT'
        ),
      },
    ],
    vocabulary: vocabulary(),
    sources: APPLIED,
  });
  assert.deepEqual(rules(result), ["missing-id"]);
});

test("a declared-but-unapplied id fails", () => {
  const result = lintTestIds({
    flows: [{ rel: "f.mjs", text: chunk('- tapOn:\n    id: "home-band"') }],
    vocabulary: vocabulary(),
    sources: [APPLIED[1]],
  });
  assert.deepEqual(rules(result), ["unapplied-id"]);
  assert.match(
    result.findings[0].message,
    /nothing in apps\/mobile\/src applies it/u
  );
});

test("a declared-but-unapplied FAMILY PREFIX fails", () => {
  const result = lintTestIds({
    flows: [{ rel: "f.mjs", text: chunk('- tapOn:\n    id: "home-band"') }],
    sources: [APPLIED[0]],
    vocabulary: vocabulary(),
  });
  assert.deepEqual(rules(result), ["unapplied-id"]);
  assert.match(result.findings[0].message, /home-tile-/u);
});

test("a clean tree passes, and a family member resolves through its prefix", () => {
  const result = lintTestIds({
    flows: [
      {
        rel: "f.mjs",
        text: chunk(
          '- tapOn:\n    id: "home-band"\n- tapOn:\n    id: "home-tile-photos"'
        ),
      },
    ],
    vocabulary: vocabulary(),
    sources: APPLIED,
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.referenced, 2);
  assert.equal(result.chunks, 1);
});

test("an id spelled as a literal in source resolves without a vocabulary entry", () => {
  const result = lintTestIds({
    flows: [
      { rel: "f.mjs", text: chunk('- copyTextFrom:\n    id: "legacy-id"') },
    ],
    vocabulary: vocabulary(),
    sources: [...APPLIED, { rel: "c.tsx", text: 'testID="legacy-id"' }],
  });
  assert.deepEqual(rules(result), []);
});

test("the allow marker suppresses missing-id, above the step and on the line", () => {
  const above = lintTestIds({
    flows: [
      {
        rel: "f.mjs",
        text: chunk(
          "# testid-lint-allow: missing-id — lives in a native module\n" +
            '- tapOn:\n    id: "home-nope"'
        ),
      },
    ],
    vocabulary: vocabulary(),
    sources: APPLIED,
  });
  assert.deepEqual(rules(above), []);

  const onLine = lintTestIds({
    flows: [
      {
        rel: "f.mjs",
        text: chunk(
          '- tapOn:\n    id: "home-nope" # testid-lint-allow: missing-id — why'
        ),
      },
    ],
    vocabulary: vocabulary(),
    sources: APPLIED,
  });
  assert.deepEqual(rules(onLine), []);
});

test("a marker naming another rule is a dead comment, not an exemption", () => {
  const result = lintTestIds({
    flows: [
      {
        rel: "f.mjs",
        text: chunk(
          "# testid-lint-allow: unapplied-id — wrong rule\n" +
            '- tapOn:\n    id: "home-nope"'
        ),
      },
    ],
    vocabulary: vocabulary(),
    sources: APPLIED,
  });
  assert.deepEqual(rules(result), ["missing-id"]);
});

test("isAllowed does not reach back past the previous step", () => {
  const text = chunk(
    "# testid-lint-allow: missing-id — belongs to the step below it\n" +
      '- tapOn:\n    id: "first"\n- tapOn:\n    id: "second"'
  );
  const { ids } = collectFlowIds(text);
  assert.equal(ids.length, 2);
  assert.equal(isAllowed(text, ids[0].line, "missing-id"), true);
  assert.equal(isAllowed(text, ids[1].line, "missing-id"), false);
});

test("a JS object's `id:` field is not read as a Maestro selector", () => {
  const { ids, chunks } = collectFlowIds(
    'const classes = [{ id: "chunk-timeout-before-any-assertion" }];'
  );
  assert.deepEqual(ids, []);
  assert.equal(chunks, 0);
});

test("an interpolated selector is claimed neither way", () => {
  const { ids } = collectFlowIds(
    // oxlint-disable-next-line no-template-curly-in-string
    chunk('- extendedWaitUntil:\n    visible:\n      id: "${marker}"')
  );
  assert.deepEqual(ids, []);
});

test("templateLines isolates the template body from the surrounding JS", () => {
  const body = templateLines(
    "const a = 1;\nconst y = `line\nmore`;\nconst b = 2;"
  )
    .map((entry) => entry.text.trim())
    .join("|");
  assert.match(body, /line/u);
  assert.match(body, /more/u);
  assert.doesNotMatch(body, /const b/u);
});

test("parseVocabulary reads nested groups into dotted accessors", () => {
  const parsed = parseVocabulary(
    [
      "export const TEST_IDS = Object.freeze({",
      "  photos: Object.freeze({",
      '    grid: "photos-grid",',
      "  }),",
      "});",
      "export const TEST_ID_PREFIXES = Object.freeze({",
      "  band: Object.freeze({",
      '    docs: "docs-band-",',
      "  }),",
      "});",
    ].join("\n")
  );
  assert.deepEqual(
    parsed.ids.map((entry) => [entry.value, entry.accessor]),
    [["photos-grid", "TEST_IDS.photos.grid"]]
  );
  assert.deepEqual(
    parsed.prefixes.map((entry) => [entry.value, entry.accessor]),
    [["docs-band-", "TEST_ID_PREFIXES.band.docs"]]
  );
});

test("a vocabulary shape the reader cannot parse yields zero entries", () => {
  assert.deepEqual(
    parseVocabulary("export const TEST_IDS = { a: 1 };").ids,
    []
  );
});

test("guard: zero flow files discovered when the scan directory is gone", (t) => {
  assert.deepEqual(discoverFlowFiles(fixtureRoot(t)), []);
});

test("guard: zero source files discovered when the source tree is gone", (t) => {
  assert.deepEqual(discoverSourceFiles(fixtureRoot(t)), []);
});

test("guard: zero Maestro chunks when the template grammar goes stale", () => {
  const result = lintTestIds({
    flows: [
      { rel: "f.mjs", text: 'await ctx.run("appId: x\\n---\\n- tapOn: A");' },
    ],
    vocabulary: vocabulary(),
    sources: APPLIED,
  });
  assert.equal(result.chunks, 0);
  assert.equal(result.referenced, 0);
});

test("guard: zero id selectors when every flow has gone back to copy", () => {
  const result = lintTestIds({
    flows: [{ rel: "f.mjs", text: chunk('- assertVisible: "Go to today"') }],
    vocabulary: vocabulary(),
    sources: APPLIED,
  });
  assert.equal(result.chunks, 1);
  assert.equal(result.referenced, 0);
});

test("discovery finds every committed flow and skips its *.test.mjs siblings", (t) => {
  const root = fixtureRoot(t);
  mkdirSync(path.join(root, "tests/agent-e2e-mobile/flows"), {
    recursive: true,
  });
  mkdirSync(path.join(root, "tests/agent-e2e-mobile/lib"), { recursive: true });
  writeFileSync(path.join(root, "tests/agent-e2e-mobile/flows/new.mjs"), "");
  writeFileSync(
    path.join(root, "tests/agent-e2e-mobile/flows/new.test.mjs"),
    ""
  );
  writeFileSync(path.join(root, "tests/agent-e2e-mobile/flows/new.md"), "");
  assert.deepEqual(discoverFlowFiles(root), [
    "tests/agent-e2e-mobile/flows/new.mjs",
  ]);
});

test("source discovery skips tests and the test harness, which are not shipped UI", (t) => {
  const root = fixtureRoot(t);
  mkdirSync(path.join(root, "apps/mobile/src/test"), { recursive: true });
  mkdirSync(path.join(root, "apps/mobile/src/kit"), { recursive: true });
  writeFileSync(path.join(root, "apps/mobile/src/kit/Real.tsx"), "");
  writeFileSync(path.join(root, "apps/mobile/src/kit/Real.test.tsx"), "");
  writeFileSync(path.join(root, "apps/mobile/src/test/stub.tsx"), "");
  assert.deepEqual(discoverSourceFiles(root), ["apps/mobile/src/kit/Real.tsx"]);
});
