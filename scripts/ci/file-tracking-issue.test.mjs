import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSearchQuery,
  fileTrackingIssue,
  findExactTitleNumber,
  parseArgs,
  parseExistingNumber,
  updateTrackingIssue,
} from "./file-tracking-issue.mjs";

function fakeGh(replies) {
  const calls = [];
  const queue = [...replies];
  const run = (argv) => {
    calls.push(argv);
    return queue.shift() ?? { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const ok = { status: 0, stdout: "", stderr: "" };
const fail = { status: 1, stdout: "", stderr: "boom" };

test("parseArgs requires title, search and body-file", () => {
  assert.throws(() => parseArgs(["--title", "x"]), /--search is required/u);
  const parsed = parseArgs([
    "--title",
    "T",
    "--search",
    "S",
    "--body-file",
    "/tmp/b",
  ]);
  assert.equal(parsed.title, "T");
});

test("parseArgs rejects unknown flags instead of ignoring them", () => {
  assert.throws(
    () =>
      parseArgs([
        "--title",
        "T",
        "--search",
        "S",
        "--body-file",
        "/b",
        "--labl",
        "x",
      ]),
    /unknown flag `--labl`/u
  );
});

test("parseArgs rejects a flag whose value is another flag", () => {
  assert.throws(
    () => parseArgs(["--title", "--search", "--body-file", "/b"]),
    /--title needs a value/u
  );
});

test("search is restricted to titles", () => {
  assert.equal(
    buildSearchQuery("[nightly] e2e lane red"),
    "in:title [nightly] e2e lane red"
  );
});

test("parseExistingNumber treats empty and literal null as no match", () => {
  assert.equal(parseExistingNumber(""), null);
  assert.equal(parseExistingNumber("  \n"), null);
  assert.equal(parseExistingNumber("null"), null);
  assert.equal(parseExistingNumber(undefined), null);
  assert.equal(parseExistingNumber("556"), 556);
});

test("comments on an existing open issue rather than opening a duplicate", () => {
  const gh = fakeGh([{ status: 0, stdout: "556\n", stderr: "" }, ok]);
  const result = fileTrackingIssue({
    run: gh.run,
    title: "T",
    search: "S",
    body: "B",
  });
  assert.deepEqual(result, { ok: true, action: "comment", number: 556 });
  assert.equal(gh.calls[1][0], "issue");
  assert.equal(gh.calls[1][1], "comment");
  assert.equal(gh.calls[1][2], "556");
});

test("a failed comment is reported as not-ok, never swallowed", () => {
  const gh = fakeGh([{ status: 0, stdout: "556", stderr: "" }, fail]);
  const result = fileTrackingIssue({
    run: gh.run,
    title: "T",
    search: "S",
    body: "B",
  });
  assert.equal(result.ok, false);
  assert.equal(result.number, 556);
});

test("creates a labelled issue when no open one matches", () => {
  const gh = fakeGh([{ status: 0, stdout: "", stderr: "" }, ok]);
  const result = fileTrackingIssue({
    run: gh.run,
    title: "T",
    search: "S",
    body: "B",
    label: "tech-debt",
  });
  assert.deepEqual(result, { ok: true, action: "create", labelled: true });
  assert.ok(gh.calls[1].includes("--label"));
});

test("falls back to an unlabelled create when the label does not exist", () => {
  const gh = fakeGh([{ status: 0, stdout: "", stderr: "" }, fail, ok]);
  const result = fileTrackingIssue({
    run: gh.run,
    title: "T",
    search: "S",
    body: "B",
    label: "nope",
  });
  assert.deepEqual(result, { ok: true, action: "create", labelled: false });
  assert.equal(gh.calls.length, 3);
  assert.ok(!gh.calls[2].includes("--label"));
});

test("reports failure when even the unlabelled create fails", () => {
  const gh = fakeGh([{ status: 0, stdout: "", stderr: "" }, fail, fail]);
  const result = fileTrackingIssue({
    run: gh.run,
    title: "T",
    search: "S",
    body: "B",
    label: "l",
  });
  assert.equal(result.ok, false);
  assert.equal(result.action, "create");
});

test("a failed search opens a new issue rather than going silent", () => {
  const gh = fakeGh([fail, ok]);
  const result = fileTrackingIssue({
    run: gh.run,
    title: "T",
    search: "S",
    body: "B",
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, "create");
});

test("--update is a boolean flag and does not consume the next token", () => {
  const parsed = parseArgs([
    "--update",
    "--title",
    "T",
    "--search",
    "S",
    "--body-file",
    "/b",
  ]);
  assert.equal(parsed.update, true);
  assert.equal(parsed.title, "T");
});

test("findExactTitleNumber ignores a near-match from the fuzzy search", () => {
  const stdout = JSON.stringify([
    { number: 1, title: "[nightly] lane red — mobile-e2e-ios-smoke" },
    { number: 2, title: "[nightly] lane red — mobile-e2e-ios" },
  ]);
  assert.equal(
    findExactTitleNumber(stdout, "[nightly] lane red — mobile-e2e-ios"),
    2
  );
  assert.equal(
    findExactTitleNumber(stdout, "[nightly] lane red — web-e2e"),
    null
  );
});

test("findExactTitleNumber survives an empty or unparseable listing", () => {
  assert.equal(findExactTitleNumber("", "T"), null);
  assert.equal(findExactTitleNumber("not json", "T"), null);
  assert.equal(findExactTitleNumber("{}", "T"), null);
});

test("update mode rewrites the matching issue body rather than commenting", () => {
  const gh = fakeGh([
    {
      status: 0,
      stdout: JSON.stringify([{ number: 77, title: "T" }]),
      stderr: "",
    },
    ok,
  ]);
  const result = updateTrackingIssue({
    run: gh.run,
    title: "T",
    search: "S",
    body: "today",
  });
  assert.deepEqual(result, { ok: true, action: "edit", number: 77 });
  assert.deepEqual(gh.calls[1], ["issue", "edit", "77", "--body", "today"]);
});

test("update mode creates when no open issue carries the exact title", () => {
  const gh = fakeGh([
    {
      status: 0,
      stdout: JSON.stringify([{ number: 9, title: "other" }]),
      stderr: "",
    },
    ok,
  ]);
  const result = updateTrackingIssue({
    run: gh.run,
    title: "T",
    search: "S",
    body: "B",
    label: "tech-debt",
  });
  assert.deepEqual(result, { ok: true, action: "create", labelled: true });
});

test("update mode reports a failed edit rather than swallowing it", () => {
  const gh = fakeGh([
    {
      status: 0,
      stdout: JSON.stringify([{ number: 5, title: "T" }]),
      stderr: "",
    },
    fail,
  ]);
  const result = updateTrackingIssue({
    run: gh.run,
    title: "T",
    search: "S",
    body: "B",
  });
  assert.equal(result.ok, false);
  assert.equal(result.action, "edit");
  assert.equal(result.number, 5);
});
