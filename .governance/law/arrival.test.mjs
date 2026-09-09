// The generator's own tests (#1005).
//
// Three properties matter and only these three: it reproduces a checked-in
// record byte for byte, it is stable across runs in the same tree, and its
// digest arithmetic is the same arithmetic the vendored bash uses. A generator
// that drifts on any of them turns every rule downstream into noise.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildArrival,
  collectWaivers,
  documentIntegrityRules,
  extractSection,
  main,
  parseManagedDigests,
  parseNameStatus,
  parsePacksLock,
  serialize,
} from "./arrival.mjs";
import { dirDigest } from "./lib/digest.mjs";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..", "..");
/** #1002's squash commit — one commit, 1022 files, and it moved the law. */
const RANGE = "bb964a7e..3df6d552";
const FIXTURE = path.join(HERE, "fixtures", "arrival", `${RANGE}.json`);

/**
 * Generate the record for RANGE into the law's own (git-ignored) output tree.
 *
 * Deliberately not a temp directory: the generator's whole claim is that the
 * same range in the same tree produces the same bytes, so writing to the same
 * place twice is the test, and `out/` is already ignored and disposable.
 *
 * @returns {string} The file's contents.
 */
function generate() {
  const out = path.join(HERE, "out", "arrival.test.json");
  main(["--range", RANGE, "--out", out]);
  return readFileSync(out, "utf8");
}

test("the generator reproduces the checked-in fixture byte for byte", () => {
  assert.equal(generate(), readFileSync(FIXTURE, "utf8"));
});

test("two runs over the same range in the same tree are byte-identical", () => {
  assert.equal(generate(), generate());
});

test("the record has every section, including the ones no rule reads yet", () => {
  const arrival = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.equal(arrival.schema, 2);
  for (const key of ["range", "commits", "files", "law", "managedTree", "waivers", "registries", "gates", "ci"]) {
    assert.ok(key in arrival, `arrival.json has no ${key}`);
  }
  assert.equal(arrival.pending, null, "no --message-file means no pending commit");
  assert.deepEqual(Object.keys(arrival.ci).sort(), ["issueExists", "issueIsProposal", "prAuthorIsOwner"]);
});

test("the JS directory digest is the vendored bash digest, byte for byte", () => {
  const digestSh = ".governance/packs/governance-kit/audit/directives/managed-tree-integrity/lib/digest.sh";
  for (const directive of ["commit-message-format", "doc-integrity", "managed-tree-integrity", "receipt-per-issue"]) {
    const dir = `.governance/packs/governance-kit/audit/directives/${directive}`;
    const fromBash = execFileSync(
      "bash",
      ["-c", `source ${digestSh}; mti_dir_digest ${dir}`],
      { cwd: ROOT, encoding: "utf8" }
    ).trim(); // awk's `print` adds the newline; the digest is the hex alone.
    assert.equal(dirDigest(path.join(ROOT, dir)), fromBash, `${directive} digests differ`);
  }
});

test("every managed unit in the current tree records what it actually is", () => {
  const { managedTree } = buildArrival({ range: RANGE });
  assert.ok(managedTree.packs.length > 0, "no locked pack directives found");
  for (const row of managedTree.packs) {
    assert.equal(row.actual, row.recorded, `${row.id}/${row.directive} has drifted`);
  }
  assert.ok(managedTree.files.length > 0, "no managed files found");
  for (const row of managedTree.files) {
    assert.equal(row.actual, row.recorded, `${row.path} has drifted`);
  }
});

test("the law section names what moved when the law's own digest moves", () => {
  const arrival = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.notEqual(arrival.law.digestAtBase, arrival.law.digestAtHead);
  assert.ok(arrival.law.changed.length > 0, "the digest moved but nothing is named");
  for (const file of arrival.law.changed) {
    assert.ok(
      arrival.files.some((row) => row.path === file),
      `${file} is named as changed law but is not in the change set`
    );
  }
});

test("name-status parsing keeps a rename's destination and never mis-splits", () => {
  assert.deepEqual(parseNameStatus("M\0b.txt\0A\0a.txt\0"), [
    { path: "a.txt", status: "A" },
    { path: "b.txt", status: "M" },
  ]);
  assert.deepEqual(parseNameStatus("R100\0old name.txt\0new name.txt\0"), [
    { path: "new name.txt", status: "R" },
  ]);
  assert.deepEqual(parseNameStatus(""), []);
});

test("the lockfile and install-manifest readers read only their own blocks", () => {
  const packs = parsePacksLock(readFileSync(path.join(ROOT, ".governance/packs.lock"), "utf8"));
  assert.ok(packs.some((pack) => pack.id === "srikanth235/centraid"));
  const audit = packs.find((pack) => pack.id === "governance-kit/audit");
  assert.deepEqual(Object.keys(audit.digest).sort(), [
    "commit-message-format",
    "doc-integrity",
    "managed-tree-integrity",
    "receipt-per-issue",
  ]);
  const managed = parseManagedDigests(readFileSync(path.join(ROOT, ".governance/install.yaml"), "utf8"));
  assert.deepEqual(Object.keys(managed).sort(), [
    ".github/workflows/governance.yml",
    ".governance/lib.sh",
    ".governance/run.sh",
  ]);
});

test("serialize is pretty JSON with exactly one trailing newline", () => {
  const text = serialize({ schema: 1 });
  assert.equal(text, '{\n  "schema": 1\n}\n');
});

test("a waiver needs a reason, and doc-integrity's needs a path as well", () => {
  const commits = [
    {
      sha: "abc",
      subject: "feat: x (#1)",
      body: [
        "governance: allow-receipt-per-issue release commit",
        "<!-- governance: allow-doc-integrity COSTS.md coordinated rewrite -->",
        "governance: allow-doc-integrity COSTS.md",
        "governance: allow-commit-message-format ",
      ].join("\n"),
      parents: [],
      files: [],
    },
  ];
  const waivers = collectWaivers(commits, { message: "governance: allow-doc-integrity QUALITY.md why", files: [] });
  assert.deepEqual(waivers, [
    { directive: "receipt-per-issue", path: null, reason: "release commit", source: "commit:abc" },
    { directive: "doc-integrity", path: "COSTS.md", reason: "coordinated rewrite", source: "commit:abc" },
    { directive: "doc-integrity", path: "QUALITY.md", reason: "why", source: "pending" },
  ].sort((a, b) => (`${a.source} ${a.directive} ${a.path ?? ""}` < `${b.source} ${b.directive} ${b.path ?? ""}` ? -1 : 1)));
});

test("the doc-integrity rule set carries the ported overlay and always the receipts row", () => {
  const rules = documentIntegrityRules();
  const rendered = rules.map((rule) => [rule.mode, rule.target, rule.argument].filter(Boolean).join(" "));
  for (const expected of [
    "frozen-files receipts/*.md",
    "frozen-section CONSTITUTION.md Evolution Log",
    "frozen-files COSTS.md",
    "frozen-files STEERING.md",
    "frozen-section QUALITY.md Resolved",
  ]) {
    assert.ok(rendered.includes(expected), `the rule set has lost '${expected}'`);
  }
});

test("section extraction reads any heading level and stops at the next heading", () => {
  const document = ["# Title", "intro", "## Resolved", "- one", "", "- two", "### Later", "- three"].join("\n");
  assert.deepEqual(extractSection(document, "Resolved"), ["- one", "", "- two"]);
  assert.deepEqual(extractSection(document, "Nothing"), []);
});

test("the frozen registry covers every rule target that exists at the baseline", () => {
  const { registries } = buildArrival({ range: RANGE });
  const paths = new Set(registries.frozen.map((row) => row.path));
  assert.ok(paths.has("CONSTITUTION.md"), "CONSTITUTION.md is a frozen-section target");
  assert.ok(paths.has("COSTS.md"));
  assert.ok(paths.has("QUALITY.md"));
  assert.ok(
    registries.frozen.some((row) => row.path.startsWith("receipts/") && row.mode === "frozen-files"),
    "receipts are frozen files"
  );
  for (const row of registries.frozen) {
    assert.ok(["frozen-files", "append-only", "frozen-section"].includes(row.mode));
    assert.equal(typeof row.baseSha, "string");
  }
});
