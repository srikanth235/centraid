#!/usr/bin/env node
// The gate-class register is a contract, not documentation (#915 Wave 4).
//
// Three things drift apart the moment nobody checks them: the `check:push`
// argument list, `scripts/ci/gate-classes.json`, and the weekly
// `.github/workflows/hygiene.yml`. A hygiene gate that quietly reappears in
// `check:push` re-charges every push for it; one that leaves `check:push`
// without arriving in the weekly lane is enforced NOWHERE, which is the exact
// failure the #782 comment block in ci.yml exists to prevent. This file is
// what makes that impossible to do by accident.
/* oxlint-disable vitest/no-import-node-test -- (#1018) node --test lane, not a vitest suite */
/* oxlint-disable vitest/prefer-importing-vitest-globals -- (#1018) node --test lane, not a vitest suite */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { HYGIENE_GATES } from "../hygiene-lane.ts";
import { PRODUCT_GATES } from "../lint-product.ts";
import { STATIC_TIER } from "./gate-stamp.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const root = path.resolve(import.meta.dirname, "../..");
const read = (rel: string): string =>
  readFileSync(path.join(root, rel), "utf8");

const pkgRaw: unknown = JSON.parse(read("package.json"));
const classesRaw: unknown = JSON.parse(read("scripts/ci/gate-classes.json"));
const hygieneWorkflow = read(".github/workflows/hygiene.yml");

if (!isRecord(pkgRaw) || !isRecord(pkgRaw.scripts)) {
  throw new Error("package.json scripts missing");
}
if (!isRecord(classesRaw)) {
  throw new Error("gate-classes.json is not an object");
}

const pkgScripts = pkgRaw.scripts;
const scripts = new Set(
  Object.entries(pkgScripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name]) => name)
);
const classified = Object.entries(classesRaw).filter(
  ([key]) => !key.startsWith("_")
);
const checkPushRaw = pkgScripts["check:push"];
if (typeof checkPushRaw !== "string") {
  throw new Error("check:push missing");
}
const checkPushGates = checkPushRaw
  .split(/\s+/u)
  .slice(2)
  .filter((token) => !token.startsWith("--"));

function asClassRow(value: unknown): {
  class: unknown;
  rung: unknown;
  why: unknown;
  door: unknown;
} {
  if (!isRecord(value)) {
    return {
      class: undefined,
      rung: undefined,
      why: undefined,
      door: undefined,
    };
  }
  return {
    class: value.class,
    rung: value.rung,
    why: value.why,
    door: value.door,
  };
}

test("check:push names at most 25 gates", () => {
  assert.ok(
    checkPushGates.length <= 25,
    `check:push names ${checkPushGates.length} gates (#915 Wave 4 caps it at 25)`
  );
  assert.equal(new Set(checkPushGates).size, checkPushGates.length);
});

test("the branch tier is a subset of the full tier, and every member is static", () => {
  const staticRaw = pkgScripts["check:push:static"];
  if (typeof staticRaw !== "string") {
    throw new Error("check:push:static missing");
  }
  const staticGates = staticRaw
    .split(/\s+/u)
    .slice(2)
    .filter((token) => !token.startsWith("--"));
  assert.ok(staticGates.length > 0, "check:push:static names no gate");
  for (const gate of staticGates) {
    assert.ok(
      checkPushGates.includes(gate),
      `${gate} is in the branch tier but not in the full tier — the branch tier may only ever be a subset`
    );
    assert.ok(
      STATIC_TIER.includes(gate),
      `${gate} is in the branch tier but is not tree-determined (scripts/ci/gate-stamp.ts STATIC_TIER)`
    );
  }
});

test("every gate in check:push is classified", () => {
  for (const gate of checkPushGates) {
    assert.ok(
      classesRaw[gate],
      `${gate} is in check:push but not in gate-classes.json`
    );
  }
});

test("every classified gate is a real root script with a class, a rung and a reason", () => {
  for (const [gate, rowRaw] of classified) {
    const row = asClassRow(rowRaw);
    assert.ok(
      scripts.has(gate),
      `gate-classes.json names ${gate}, which package.json does not`
    );
    assert.ok(
      row.class === "product" ||
        row.class === "contract" ||
        row.class === "hygiene",
      `${gate} has class ${String(row.class)}`
    );
    assert.ok(
      typeof row.rung === "number" &&
        Number.isInteger(row.rung) &&
        row.rung >= 0 &&
        row.rung <= 5,
      `${gate} rung`
    );
    assert.ok(
      typeof row.why === "string" && row.why.length > 20,
      `${gate} needs a one-line reason for its class`
    );
  }
});

// #1005 gave the law's rules a `door` — where a finding is answerable and who
// can act on it — and the same question is the one this register answers with
// `rung`. Two vocabularies for one question is how a gate ends up enforced
// somewhere nobody looks, so the field is shared and the two are held in step
// here. `.governance/law/eslint.config.mjs` reads the same field and refuses a
// value outside the vocabulary.
const DOORS = ["hook", "window", "owner"];

const doorForRung = (rung: number): string =>
  rung <= 1 ? "hook" : rung === 2 ? "window" : "owner";

test("every gate declares a door, in the rules' vocabulary, matching its rung", () => {
  for (const [gate, rowRaw] of classified) {
    const row = asClassRow(rowRaw);
    assert.ok(
      typeof row.door === "string" && DOORS.includes(row.door),
      `${gate} declares door ${JSON.stringify(row.door)}; the vocabulary is ${DOORS.join(", ")}`
    );
    assert.equal(
      row.door,
      typeof row.rung === "number" ? doorForRung(row.rung) : undefined,
      `${gate} is rung ${String(row.rung)} but door ${String(row.door)} — a gate is answerable where its rung runs it`
    );
  }
  assert.match(
    String(classesRaw._comment ?? ""),
    /door/u,
    "the register's own comment must explain the door field"
  );
});

test("hygiene gates left check:push and arrived in the weekly lane", () => {
  const hygiene = classified
    .filter(([, row]) => asClassRow(row).class === "hygiene")
    .map(([gate]) => gate);
  assert.ok(hygiene.length > 0, "the register classifies no gate as hygiene");
  for (const gate of hygiene) {
    assert.ok(
      !checkPushGates.includes(gate),
      `${gate} is hygiene-class but still charged to every push`
    );
    assert.ok(
      HYGIENE_GATES.includes(gate),
      `${gate} is hygiene-class but the weekly lane does not run it — it would be enforced nowhere`
    );
    assert.equal(
      asClassRow(classesRaw[gate]).rung,
      5,
      `${gate} is hygiene-class, so it belongs to rung 5`
    );
  }
  assert.deepEqual(
    [...HYGIENE_GATES].sort(),
    [...hygiene].sort(),
    "the weekly lane and the hygiene class must name the same gates"
  );
});

test("every gate the weekly lane runs exists in package.json", () => {
  for (const gate of HYGIENE_GATES) {
    assert.ok(
      scripts.has(gate),
      `hygiene lane runs ${gate}, which package.json does not define`
    );
  }
  for (const match of hygieneWorkflow.matchAll(
    /bun run (?<gate>[a-z0-9:-]+)/gu
  )) {
    const gate = match.groups?.["gate"];
    if (gate === undefined) continue;
    assert.ok(
      scripts.has(gate),
      `hygiene.yml runs ${gate}, which package.json does not define`
    );
  }
  assert.match(
    hygieneWorkflow,
    /bun run hygiene:lane/u,
    "hygiene.yml must drive the lane through hygiene:lane so the membership has one home"
  );
});

test("the lint:product bundle holds classified, non-hygiene gates and duplicates none of check:push", () => {
  assert.ok(
    PRODUCT_GATES.length >= 30,
    `the bundle replaces ${PRODUCT_GATES.length} names; #915 asks for at least 30`
  );
  assert.equal(new Set(PRODUCT_GATES).size, PRODUCT_GATES.length);
  for (const gate of PRODUCT_GATES) {
    assert.ok(
      scripts.has(gate),
      `lint:product runs ${gate}, which package.json does not define`
    );
    const row = asClassRow(classesRaw[gate]);
    assert.ok(classesRaw[gate], `${gate} is bundled but unclassified`);
    assert.notEqual(
      row.class,
      "hygiene",
      `${gate} is hygiene-class; it belongs to the weekly lane, not the push bundle`
    );
    assert.ok(
      !checkPushGates.includes(gate),
      `${gate} is both bundled into lint:product and named separately in check:push`
    );
  }
  assert.ok(
    checkPushGates.includes("lint:product"),
    "check:push must run the bundle"
  );
});
