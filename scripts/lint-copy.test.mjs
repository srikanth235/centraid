import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bannedIn,
  capFor,
  compareBudget,
  lintCopy,
  lintString,
  scanStrings,
  totals,
  wordCount,
} from "./lint-copy.mjs";

const rules = (key, value) => lintString(key, value).map((f) => f.rule);

test("wordCount skips dashes and dots and counts a placeholder as one word", () => {
  assert.equal(wordCount("Edited · {when}"), 2);
  assert.equal(wordCount("One — two  three"), 3);
  assert.equal(wordCount(""), 0);
});

test("the plain banned words are caught case-insensitively", () => {
  for (const v of [
    "Please wait",
    "Saved successfully",
    "Simply tap it",
    "Tap in order to save",
    "You can tap it",
    "We're sorry about that",
    "We’re sorry about that",
  ]) {
    assert.deepEqual(rules("X_NOTE", v), ["copy-banned-word"], v);
  }
  assert.deepEqual(rules("X_NOTE", "You can't undo this"), []);
  assert.deepEqual(rules("X_NOTE", "Simplyfied"), []);
});

test("internals jargon is banned, ordinary neighbours are not", () => {
  for (const v of [
    "Secrets stay sealed",
    "Unseal the vault",
    "A receipt was written",
    "The ledger is empty",
    "Draining the queue",
    "A derived index",
    "Kept in memory",
    "Encrypted at rest",
    "Private by design",
    "Call core.open first",
    "A photograph of you",
    "Stays on this device",
  ]) {
    assert.deepEqual(rules("X_NOTE", v), ["copy-banned-word"], v);
  }
  for (const v of [
    "Photo deleted",
    "Changed on another device",
    "The core idea",
    "Sealant",
  ]) {
    assert.deepEqual(rules("X_NOTE", v), [], v);
  }
});

test("gateway is allowed only inside a quoted centraid-gateway command", () => {
  assert.deepEqual(bannedIn("K", "The gateway is gone"), ["gateway"]);
  assert.deepEqual(bannedIn("K", "Run centraid-gateway pair"), ["gateway"]);
  assert.deepEqual(bannedIn("K", "Run “centraid-gateway pair”"), []);
  assert.deepEqual(bannedIn("K", "Run `centraid-gateway pairings revoke`"), []);
  assert.deepEqual(
    bannedIn("K", 'Run "centraid-gateway pair" on the gateway'),
    ["gateway"]
  );
});

test("24 words is allowed only where the member types the recovery key", () => {
  assert.deepEqual(bannedIn("SAVE_BODY", "Write down your 24 words"), ["24 words"]);
  assert.deepEqual(bannedIn("TYPE_BODY", "Type your 24 words"), []);
  assert.deepEqual(bannedIn("ENTER_NOTE", "Enter all 24 words"), []);
  assert.deepEqual(bannedIn("PAIR_WORDS_NOTE", "The 24 words"), []);
  assert.deepEqual(bannedIn("COUNT_ONE", "There are 24 words"), []);
  assert.deepEqual(
    bannedIn("REKEY_BODY", "Type the 24 words of your recovery key"),
    []
  );
});

test("a dot-join is exempt as short metadata and flagged as two thoughts", () => {
  assert.deepEqual(rules("X_META", "Edited · 3 days ago"), []);
  assert.deepEqual(rules("X_META", "Edited · {when} · {who}"), []);
  assert.deepEqual(
    rules("X_META", "Titles are browsable · a secret is only opened when you unlock"),
    ["copy-dot-join"]
  );
  assert.deepEqual(
    rules("X_META", "Titles are browsable. A secret opens when you unlock"),
    []
  );
});

test("caps follow the key suffix and the first matching class wins", () => {
  assert.equal(capFor("LOCK_NO_WORDS_ACTION").max, 4);
  assert.equal(capFor("SAVE"), null);
  assert.equal(capFor("ROW_DETAIL").max, 12);
  assert.equal(capFor("X_BODY").max, 25);
  assert.equal(capFor("X_FAILED").max, 25);
  assert.equal(capFor("X_TITLE").max, 6);
  assert.equal(capFor("TITLE").max, 6);
  assert.equal(capFor("X_TITLES"), null);
  assert.equal(capFor("RETITLE"), null);

  const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  assert.deepEqual(rules("A_ACTION", words(4)), []);
  assert.deepEqual(rules("A_ACTION", words(5)), ["copy-over-budget"]);
  assert.deepEqual(rules("A_NOTE", words(12)), []);
  assert.deepEqual(rules("A_NOTE", words(13)), ["copy-over-budget"]);
  assert.deepEqual(rules("A_BODY", words(25)), []);
  assert.deepEqual(rules("A_BODY", words(26)), ["copy-over-budget"]);
  assert.deepEqual(rules("A_TITLE", words(7)), ["copy-over-budget"]);
  assert.deepEqual(rules("A_OTHER", words(40)), []);
  assert.deepEqual(rules("A_BODY", "Save {name} to {place} now"), []);
});

test("a string counts once per rule however often it offends", () => {
  const found = scanStrings({
    A_NOTE: "Please simply wait",
    B_NOTE: "Fine",
    C_NOTE: 3,
  });
  assert.deepEqual(
    found.map((f) => [f.key, f.rule]),
    [["A_NOTE", "copy-banned-word"]]
  );
});

test("compareBudget flags growth, new files and unlowered budgets", () => {
  const measured = { r: { "a.json": 3, "b.json": 1, "new.json": 1 } };
  const budget = { r: { "a.json": 2, "b.json": 2, "gone.json": 1 } };
  const { over, under } = compareBudget(measured, budget);
  assert.deepEqual(
    over.map((o) => o.file),
    ["a.json", "new.json"]
  );
  assert.deepEqual(
    under.map((u) => u.file),
    ["b.json", "gone.json"]
  );
});

test("totals sums each rule", () => {
  assert.deepEqual(totals({ r: { a: 2, b: 3 }, s: { a: 1 } }), { r: 5, s: 1 });
});

test("lintCopy reads strings only and honours the budget", () => {
  const root = mkdtempSync(path.join(tmpdir(), "copy-lint-"));
  try {
    mkdirSync(path.join(root, "copy"));
    writeFileSync(
      path.join(root, "copy/a.json"),
      JSON.stringify({
        $comment: "Please ignore this successfully",
        app: "a",
        strings: { X_NOTE: "Please wait", X_TITLE: "Fine" },
        routes: { R: "Please, simply, in order to" },
      })
    );
    writeFileSync(path.join(root, "copy/notes.txt"), "not json");

    const ok = lintCopy(root, { "copy-banned-word": { "copy/a.json": 1 } });
    assert.deepEqual([ok.over, ok.under, ok.missing], [[], [], []]);

    const grew = lintCopy(root, {});
    assert.equal(grew.over.length, 1);

    const stale = lintCopy(root, { "copy-banned-word": { "copy/a.json": 2 } });
    assert.equal(stale.under.length, 1);

    assert.deepEqual(lintCopy(path.join(root, "nowhere"), {}).missing, ["copy"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
