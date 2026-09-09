// The generator's own tests (#1005).
//
// Three properties matter and only these three: it reproduces a checked-in
// record byte for byte, it is stable across runs in the same tree, and its
// digest arithmetic is the same arithmetic the vendored bash uses. A generator
// that drifts on any of them turns every rule downstream into noise.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildArrival,
  collectDocket,
  collectDocument,
  collectWaivers,
  collectWaiversFromLines,
  estateClassifier,
  isLedger,
  judgeSection,
  documentIntegrityRules,
  extractReceiptSection,
  extractSection,
  main,
  parseManagedDigests,
  parseNameStatus,
  parsePacksLock,
  serialize,
} from "./arrival.mjs";
import { dirDigest } from "./lib/digest.mjs";
import { RECORDED_PATHS } from "./digest.mjs";
import { oldRunnerRevision } from "./parity.mjs";

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
async function generate() {
  const out = path.join(HERE, "out", "arrival.test.json");
  await main(["--range", RANGE, "--out", out]);
  return readFileSync(out, "utf8");
}

test("the generator reproduces the checked-in fixture byte for byte", async () => {
  assert.equal(await generate(), readFileSync(FIXTURE, "utf8"));
});

test("two runs over the same range in the same tree are byte-identical", async () => {
  assert.equal(await generate(), await generate());
});

test("the record has every section, including the ones no rule reads yet", () => {
  const arrival = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.equal(arrival.schema, 4);
  for (const key of ["range", "commits", "files", "law", "managedTree", "waivers", "registries", "gates", "ci"]) {
    assert.ok(key in arrival, `arrival.json has no ${key}`);
  }
  assert.equal(arrival.pending, null, "no --message-file means no pending commit");
  assert.deepEqual(Object.keys(arrival.ci).sort(), ["issueExists", "issueIsProposal", "prAuthorIsOwner"]);
});

test("the JS directory digest is the vendored bash digest, byte for byte", () => {
  // The bash original was deleted with its pack (#1005), so it is read back out
  // of history rather than off disk. A reimplementation that is no longer
  // pinned to the thing it reimplemented is a second, quieter answer — and the
  // digests it produces are still recorded in install.yaml today.
  const rev = oldRunnerRevision();
  const digestSh = path.join(HERE, "out", "digest.sh");
  writeFileSync(
    digestSh,
    execFileSync(
      "git",
      ["show", `${rev}:.governance/packs/governance-kit/audit/directives/managed-tree-integrity/lib/digest.sh`],
      { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }
    )
  );
  for (const directory of [".governance/law/lib", ".governance/law/rules", ".githooks"]) {
    const fromBash = execFileSync("bash", ["-c", `source ${digestSh}; mti_dir_digest ${directory}`], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    assert.equal(dirDigest(path.join(ROOT, directory)), fromBash, `${directory} digests differ`);
  }
});

test("every managed unit in the current tree records what it actually is", async () => {
  const { managedTree } = await buildArrival({ range: RANGE });
  // No pack locks digests any more — the vendored one was ported and deleted —
  // so the locked-directive list is legitimately empty and the managed FILES
  // are the whole trust chain: the kit runtime plus the law's own generator.
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
  const local = packs.find((pack) => pack.id === "srikanth235/centraid");
  assert.ok(local, "the repo-local pack is not in the lockfile");
  assert.ok(local.directives.includes("lint-check"), "the directives list is not being read");
  // The local pack records no digests, so it is skipped by the integrity rule
  // exactly as the shell directive skipped it.
  assert.deepEqual(local.digest, {});
  // The same reader over the vendored pack that used to be here, from history.
  const historical = parsePacksLock(
    execFileSync("git", ["show", `${oldRunnerRevision()}:.governance/packs.lock`], {
      cwd: ROOT,
      encoding: "utf8",
    })
  );
  assert.deepEqual(
    Object.keys(historical.find((pack) => pack.id === "governance-kit/audit").digest).sort(),
    ["commit-message-format", "doc-integrity", "managed-tree-integrity", "receipt-per-issue"]
  );
  const managed = parseManagedDigests(readFileSync(path.join(ROOT, ".governance/install.yaml"), "utf8"));
  // The kit's three rows, plus the law generator's own — recorded so a silent
  // edit to the thing that writes the record is refused at the commit hook.
  for (const file of [".github/workflows/governance.yml", ".governance/lib.sh", ".governance/run.sh"]) {
    assert.ok(file in managed, `${file} left managed_digests`);
  }
  for (const file of RECORDED_PATHS) {
    assert.ok(file in managed, `${file} is not recorded in install.yaml`);
  }
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
  assert.deepEqual(
    waivers.map((waiver) => `${waiver.source} ${waiver.directive} ${waiver.path ?? "-"} ${waiver.reason}`),
    [
      "commit:abc commit-message-format - ",
      "commit:abc doc-integrity COSTS.md coordinated rewrite",
      "commit:abc receipt-per-issue - release commit",
      "pending doc-integrity QUALITY.md why",
    ]
  );
  // A bare token still does not waive — the rules filter on `reason !== ""` —
  // but it is RECORDED, because "somebody wrote a waiver that does not work"
  // is a thing the front page should be able to say.
  assert.equal(waivers.find((waiver) => waiver.directive === "commit-message-format").reason, "");
});

test("a waiver reason is a paragraph, not a line", () => {
  // The first parser stopped at the newline and the front page printed half a
  // sentence, which reads as a complete thought and is not one.
  const [waiver] = collectWaivers(
    [
      {
        sha: "abc",
        subject: "feat: x (#1)",
        body: [
          "governance: allow-estate-separation the law's test roster lived in the",
          "product's package.json, and replacing it with a glob is one act.",
          "",
          "Co-Authored-By: somebody <n@example.com>",
        ].join("\n"),
        parents: [],
        files: [],
      },
    ],
    null
  );
  assert.equal(
    waiver.reason,
    "the law's test roster lived in the product's package.json, and replacing it with a glob is one act."
  );
});

test("a waiver written in a file, and an eslint-disable, are waivers too", () => {
  const line = (text) => text;
  const rows = collectWaiversFromLines([
    ["packages/blueprints/apps/photos/Chrome.module.css", [line("  /* governance: allow-no-hardcoded-colors overlay */")]],
    ["CONSTITUTION.md", [line("per-commit waiver `governance: allow-estate-separation <reason>` in the body")]],
    ["receipts/issue-1.md", [line("<!-- eslint-disable law/receipt-per-issue -- docket:D-9 the audit lands at close -->")]],
  ]);
  assert.deepEqual(rows, [
    {
      directive: "receipt-per-issue",
      path: "receipts/issue-1.md",
      reason: "docket:D-9 the audit lands at close",
      source: "disable:receipts/issue-1.md",
      docket: "D-9",
    },
    {
      directive: "no-hardcoded-colors",
      path: "packages/blueprints/apps/photos/Chrome.module.css",
      reason: "overlay",
      source: "file:packages/blueprints/apps/photos/Chrome.module.css",
      docket: null,
    },
  ]);
});

test("the doc-integrity rule set carries the ported overlay and always the receipts row", () => {
  const rules = documentIntegrityRules();
  const rendered = rules.map((rule) => [rule.mode, rule.target, rule.argument].filter(Boolean).join(" "));
  for (const expected of [
    "frozen-files receipts/*.md",
    "frozen-section CONSTITUTION.md Evolution Log",
    "frozen-section QUALITY.md Resolved",
  ]) {
    assert.ok(rendered.includes(expected), `the rule set has lost '${expected}'`);
  }
});

test("the two section extractors differ exactly as the shell pack's two did", () => {
  const document = ["# Title", "intro", "## Resolved", "- one", "", "- two", "### Later", "- three", "## Next", "- four"].join("\n");
  // doc-integrity's: any heading ends the section.
  assert.deepEqual(extractSection(document, "Resolved"), ["- one", "", "- two"]);
  assert.deepEqual(extractSection(document, "Nothing"), []);
  // receipt-per-issue's: only a level-2 heading does, so a receipt organised
  // into `###` sub-sections still has all of its evidence read.
  // The `###` heading line itself is body text to this extractor, exactly as it
  // was to lib.sh's awk, whose boundary pattern is `^##[[:space:]]+`.
  assert.deepEqual(extractReceiptSection(document, "Resolved"), ["- one", "", "- two", "### Later", "- three"]);
  assert.deepEqual(extractReceiptSection(document, "resolved"), ["- one", "", "- two", "### Later", "- three"]);
});

test("the frozen registry covers every rule target that exists at the baseline", async () => {
  const { registries } = await buildArrival({ range: RANGE });
  const paths = new Set(registries.frozen.map((row) => row.path));
  assert.ok(paths.has("CONSTITUTION.md"), "CONSTITUTION.md is a frozen-section target");
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

test("the receipt registry lists every tracked receipt and what this change added", async () => {
  const { registries } = await buildArrival({ range: RANGE });
  const { files, change } = registries.receipts;
  assert.ok(files.length > 100, "the corpus is much larger than this");
  assert.ok(
    files.every((row) => row.path.startsWith("receipts/") && row.path.endsWith(".md")),
    "the registry must hold receipts and nothing else"
  );
  const mine = files.find((row) => row.path === "receipts/issue-1005-governance-constitution.md");
  assert.ok(mine, "this lane's own receipt is tracked");
  assert.deepEqual(mine.headings.slice(0, 2), ["Checklist", "What changed"]);
  assert.equal(mine.verification.hasFence, true);
  assert.equal(typeof change.completedChange, "boolean");
  assert.equal(typeof change.touchesReceipt, "boolean");
});

test("the managed tree carries the pinned kit version and each file's stamp", async () => {
  const { managedTree } = await buildArrival({ range: RANGE });
  assert.equal(managedTree.kitVersion, "0.15.0");
  const runSh = managedTree.files.find((row) => row.path === ".governance/run.sh");
  assert.equal(runSh.marker, "0.15.0", "run.sh carries the kit's managed stamp");
  assert.deepEqual(managedTree.unrecorded, [], "no unrecorded directive folder is installed");
});

test("a pending commit message is read, comment lines dropped, staged set attached", async () => {
  // This path only runs inside the commit-msg hook, which is exactly why it
  // needs a test: a broken import here surfaces as a crashed commit and
  // nothing else.
  const messageFile = path.join(HERE, "out", "arrival.test.msg");
  writeFileSync(messageFile, "feat(governance): a subject (#1005)\n\n# a git comment\nbody line\n");
  const arrival = await buildArrival({ range: RANGE, messageFile });
  assert.equal(arrival.pending.message, "feat(governance): a subject (#1005)\n\nbody line");
  assert.ok(Array.isArray(arrival.pending.files));
});

test("every file row carries an estate, at the commit level and the aggregate", () => {
  const arrival = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const rows = [...arrival.files, ...arrival.commits.flatMap((commit) => commit.files)];
  assert.ok(rows.length > 1000, "#1002's squash is a thousand-file change");
  for (const row of rows) {
    assert.ok(["law", "registry", "territory"].includes(row.estate), `${row.path}: ${row.estate}`);
  }
  const estateOf = (file) => arrival.files.find((row) => row.path === file)?.estate;
  assert.equal(estateOf("tests/inventory.json"), "law");
  assert.equal(estateOf("QUALITY.md"), "registry");
  assert.equal(estateOf("ARCHITECTURE.md"), "territory");
});

test("the docket is registry, not law, even though it lives inside .governance", () => {
  // It matches the law glob `.governance/**` too, and the order is the ruling:
  // a register of exceptions is evidence, never a rule.
  const classify = estateClassifier();
  assert.equal(classify(".governance/law/docket.json"), "registry");
  assert.equal(classify(".governance/law/rules/doc-integrity.mjs"), "law");
  assert.equal(classify("receipts/nested/issue-1.md"), "registry");
  assert.equal(classify("packages/server/src/index.ts"), "territory");
});

test("a ledger's direction is judged against the validator's own table", () => {
  assert.ok(isLedger("tests/floors.json"));
  assert.ok(isLedger(".governance/packs/srikanth235/centraid/directives/x/allowlist.txt"));
  assert.equal(isLedger("tests/claims.json"), false, "claims is law but is not a numeric ledger");
  // `up` is a floor: a number that falls is a widening. `down` is a ceiling.
  assert.equal(judgeSection({ a: 90 }, { a: 80 }, "up"), "widened");
  assert.equal(judgeSection({ a: 90 }, { a: 95 }, "up"), "narrowed");
  assert.equal(judgeSection({ a: 90, b: 10 }, { a: 95, b: 5 }, "up"), "mixed");
  assert.equal(judgeSection({ a: 90 }, { a: 90 }, "up"), "unchanged");
  assert.equal(judgeSection({ a: 5 }, { a: 9 }, "down"), "widened");
  // A knob that disappeared stopped being enforced, which is the loosest move.
  assert.equal(judgeSection({ a: 90 }, {}, "up"), "widened");
  // No declared direction means no verdict, never a silent "narrowed".
  assert.equal(judgeSection({ a: 1 }, { a: 2 }, "register"), "unknown");
});

test("#1002's squash moved a ledger and the record names which and how", () => {
  const arrival = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const inventory = arrival.gates.find((gate) => gate.path === "tests/inventory.json");
  assert.ok(inventory, "tests/inventory.json changed in the range and is a ledger");
  assert.deepEqual(inventory.commits, [arrival.range.head]);
  assert.ok(["widened", "narrowed", "mixed", "unchanged"].includes(inventory.direction));
  assert.ok(
    !arrival.gates.some((gate) => gate.path === "tests/claims.json"),
    "claims.json is law but carries no ratcheted numbers"
  );
});

test("the adjudication documents report what this change ADDED, not that it opened them", () => {
  const arrival = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const { changelog, decisions, docket } = arrival.registries;
  // #1002's squash never touched the changelog — the gap the registry rule is for.
  assert.equal(changelog.touched, false);
  assert.deepEqual(changelog.issues, []);
  assert.equal(decisions.touched, true);
  assert.ok(decisions.issues.includes(996), "the #996 rulings landed in this range");
  // The docket exists in the working tree now; #1002's baseline predates it,
  // which is exactly what `rowsOnBase` is for — every row reads as one this
  // change filed itself.
  assert.equal(docket.exists, true);
  assert.ok(docket.rows.length > 0);
  assert.deepEqual(docket.rowsOnBase, [], "the docket did not exist at #1002's merge-base");
});

test("a document row cites only the issues on added lines", () => {
  const range = { base: "bb964a7e", head: "3df6d552", hasBase: true };
  const row = collectDocument(range, null, "docs/decisions.md");
  assert.equal(row.path, "docs/decisions.md");
  assert.equal(row.lines > 0, true);
  assert.deepEqual(collectDocument(range, null, "CHANGELOG.md"), {
    path: "CHANGELOG.md",
    touched: false,
    issues: [],
    lines: 0,
  });
  assert.equal(collectDocket().path, ".governance/law/docket.json");
  assert.deepEqual(collectDocket().rowsOnBase, [], "no docket at the baseline, no ids");
});

test("a receipt row carries its issue, whether a ruling is in it, and any cost", () => {
  const arrival = JSON.parse(readFileSync(FIXTURE, "utf8"));
  // The registry is the whole tracked corpus, so this lane's own receipt is in
  // it — but nothing in #1002's range touched it, which is the field the
  // registry rules read.
  const mine = arrival.registries.receipts.files.find(
    (row) => row.path === "receipts/issue-1005-governance-constitution.md"
  );
  assert.equal(mine.issue, 1005);
  assert.equal(mine.touched, false);
  const sample = arrival.registries.receipts.files.find((row) => row.issue === 996);
  assert.ok(sample, "issue #996 has a receipt");
  assert.equal(sample.recordsRuling, true, "the #996 receipt records rulings");
  assert.ok(sample.cost === null || typeof sample.cost === "string");
  for (const row of arrival.registries.receipts.files) {
    assert.equal(typeof row.touched, "boolean");
    assert.ok(row.issue === null || Number.isInteger(row.issue));
  }
});
