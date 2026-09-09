// The generator's own tests (#1005).
//
// Three properties matter and only these three: it reproduces a checked-in
// record byte for byte, it is stable across runs in the same tree, and its
// digest arithmetic is the same arithmetic the vendored bash uses. A generator
// that drifts on any of them turns every rule downstream into noise.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
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
import { treeSource } from "./lib/git.mjs";
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

test("a --range record is a function of the range, not of the checkout", async (t) => {
  // The defect this replaces: the corpus and the branch name came out of the
  // working tree, so the fixture was green on the branch that recorded it and
  // red everywhere else (R-1005-27). Proved from a detached worktree at HEAD,
  // whose branch is nobody's and whose receipts are then dirtied by hand.
  // A named path rather than a mkdtemp: the law's tests run with no product
  // helpers on hand, and the worktree it holds has to be removable by name
  // when a previous run died before its `after` hook.
  const probe = path.join(tmpdir(), `arrival-probe-${process.pid}`);
  rmSync(probe, { recursive: true, force: true });
  execFileSync("git", ["worktree", "add", "--detach", "--quiet", probe, "HEAD"], { cwd: ROOT });
  // The generator under test is this working copy's, not HEAD's: the property
  // is about the code as it stands, and a probe that could only ever test the
  // last commit would go red on the commit that fixes it.
  cpSync(HERE, path.join(probe, ".governance", "law"), {
    recursive: true,
    filter: (from) => !from.includes(`${path.sep}node_modules`) && !from.includes(`${path.sep}out`),
  });
  t.after(() => {
    execFileSync("git", ["worktree", "remove", "--force", probe], { cwd: ROOT });
    rmSync(probe, { recursive: true, force: true });
  });
  // The law's pinned install is not copied — it is borrowed, so the probe is a
  // second checkout of the code and not a second `npm ci`.
  symlinkSync(path.join(HERE, "node_modules"), path.join(probe, ".governance/law/node_modules"), "dir");
  const out = path.join(probe, "arrival.probe.json");
  const generateThere = () => {
    execFileSync("node", [path.join(probe, ".governance/law/arrival.mjs"), "--range", RANGE, "--out", out], {
      cwd: probe,
      stdio: "ignore",
    });
    return readFileSync(out, "utf8");
  };
  const fixture = readFileSync(FIXTURE, "utf8");
  assert.equal(generateThere(), fixture, "a detached checkout on no branch records the same bytes");
  // A dirty working copy of a receipt is not part of the range and must not
  // reach the record.
  const receipt = path.join(probe, "receipts", "issue-972.md");
  writeFileSync(receipt, `${readFileSync(receipt, "utf8")}\n## A section nobody committed\n`);
  assert.equal(generateThere(), fixture, "an edited receipt in the working copy changed the record");
  assert.equal(JSON.parse(fixture).range.onDefaultBranch, null, "a range run knows no branch");
  assert.ok(!fixture.includes('"branch"'), "the record names no branch");
});

test("--staged reads the index, so the hook judges the commit being written", async () => {
  // The pre-commit rung carries no commit message, so the index read cannot be
  // keyed on `--message-file`: without `--staged` the hook would judge HEAD and
  // a staged hand edit to a managed file would sail through (R-1005-27).
  const staged = await buildArrival({ range: RANGE, staged: true });
  assert.equal(typeof staged.range.onDefaultBranch, "boolean", "the hook may know the trunk");
  const corpus = staged.registries.receipts.files.map((row) => row.path);
  const tracked = execFileSync("git", ["ls-files", "--", "receipts"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => file.endsWith(".md"));
  assert.deepEqual(corpus, tracked, "the staged corpus is the index's, not the range head's");
  assert.equal(staged.managedTree.kitVersion, "0.15.0", "and so is the managed tree");
  // The default stays the range: the same call without the flag is the fixture.
  const ranged = await buildArrival({ range: RANGE });
  assert.equal(ranged.range.onDefaultBranch, null);
  assert.notDeepEqual(ranged.registries.receipts.files.map((row) => row.path), corpus);
});

test("the record has every section, including the ones no rule reads yet", () => {
  const arrival = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.equal(arrival.schema, 6);
  for (const key of ["range", "commits", "files", "law", "managedTree", "waivers", "registries", "gates", "ci"]) {
    assert.ok(key in arrival, `arrival.json has no ${key}`);
  }
  assert.equal(arrival.pending, null, "no --message-file means no pending commit");
  assert.deepEqual(Object.keys(arrival.ci).sort(), ["issueExists", "issueIsProposal", "prAuthorIsOwner"]);
  // The law's own declarations travel in the record, so the rules that judge
  // an amendment or a citation read one document rather than re-opening the
  // pack files with a second parser.
  for (const key of ["domains", "rules", "rulesAtBase"]) {
    assert.ok(key in arrival.law, `arrival.law has no ${key}`);
  }
  assert.ok(
    arrival.law.domains.some((domain) => domain.id === "the-law"),
    "the law is its own doctrine domain"
  );
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
  // The managed tree is read at the range's head, so "the current tree" is a
  // question about HEAD and the range has to say so (R-1005-27).
  const { managedTree } = await buildArrival({ range: "HEAD~1..HEAD" });
  // No pack locks digests any more at HEAD — the vendored one was ported and
  // deleted —
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
  // The corpus is the one at the range's head: a receipt written after
  // #1002 merged is not part of what #1002 arrived with.
  const theirs = files.find((row) => row.path === "receipts/issue-996-one-vault-every-seat.md");
  assert.ok(theirs, "the range's own receipt is tracked");
  assert.equal(theirs.verification.hasFence, true);
  assert.ok(
    !files.some((row) => row.path === "receipts/issue-1005-governance-constitution.md"),
    "a receipt that did not exist at the head is not in the corpus"
  );
  assert.equal(change.completed, true, "a range with a base and no commit in flight is a PR");
  assert.equal(typeof change.touchesReceipt, "boolean");
  // The record holds no fact about the checkout that generated it.
  assert.deepEqual(Object.keys(change), ["completed", "touchesReceipt"]);
});

test("the managed tree carries the pinned kit version and each file's stamp", async () => {
  // At #1002's head the kit was 0.15.0's predecessor, and that is the point:
  // the section reports the tree the range ends at, not whatever is installed
  // in this checkout (R-1005-27).
  const { managedTree } = await buildArrival({ range: RANGE });
  assert.equal(managedTree.kitVersion, "0.14.0");
  const runSh = managedTree.files.find((row) => row.path === ".governance/run.sh");
  assert.equal(runSh.marker, "0.14.0", "run.sh carries the kit's managed stamp");
  assert.equal((await buildArrival({ range: "HEAD~1..HEAD" })).managedTree.kitVersion, "0.15.0");
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
  // The docket did not exist on either side of #1002 — it is #1005's own
  // institution — so the register reads as "not yet established" for this
  // range, whatever the checkout replaying it happens to carry (R-1005-27).
  assert.equal(docket.exists, false);
  assert.deepEqual(docket.rows, []);
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
  const atHead = collectDocket(null, treeSource("HEAD"));
  assert.equal(atHead.path, ".governance/law/docket.json");
  assert.equal(atHead.exists, true, "the docket is committed at HEAD");
  assert.deepEqual(atHead.rowsOnBase, [], "no range, no baseline ids");
  assert.equal(collectDocket(range, treeSource(range.head)).exists, false);
});

test("a receipt row carries its issue, whether a ruling is in it, and any cost", () => {
  const arrival = JSON.parse(readFileSync(FIXTURE, "utf8"));
  // The registry is the whole tracked corpus at the range's head, so a receipt
  // from an unrelated issue is in it — and nothing in #1002's range touched it,
  // which is the field the registry rules read.
  const other = arrival.registries.receipts.files.find(
    (row) => row.path === "receipts/issue-972.md"
  );
  assert.equal(other.issue, 972);
  assert.equal(other.touched, false);
  const sample = arrival.registries.receipts.files.find((row) => row.issue === 996);
  assert.ok(sample, "issue #996 has a receipt");
  assert.equal(sample.recordsRuling, true, "the #996 receipt records rulings");
  assert.ok(sample.cost === null || typeof sample.cost === "string");
  for (const row of arrival.registries.receipts.files) {
    assert.equal(typeof row.touched, "boolean");
    assert.ok(row.issue === null || Number.isInteger(row.issue));
  }
});
