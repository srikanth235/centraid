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
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { HYGIENE_GATES } from "../hygiene-lane.mjs";
import { PRODUCT_GATES } from "../lint-product.mjs";
import { STATIC_TIER } from "./gate-stamp.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const pkg = JSON.parse(read("package.json"));
const classes = JSON.parse(read("scripts/ci/gate-classes.json"));
const hygieneWorkflow = read(".github/workflows/hygiene.yml");

const scripts = new Set(Object.keys(pkg.scripts));
const classified = Object.entries(classes).filter(
  ([key]) => !key.startsWith("_")
);
const checkPushGates = pkg.scripts["check:push"]
  .split(/\s+/u)
  .slice(2)
  .filter((token) => !token.startsWith("--"));

test("check:push names at most 25 gates", () => {
  assert.ok(
    checkPushGates.length <= 25,
    `check:push names ${checkPushGates.length} gates (#915 Wave 4 caps it at 25)`
  );
  assert.equal(new Set(checkPushGates).size, checkPushGates.length);
});

test("the branch tier is a subset of the full tier, and every member is static", () => {
  const staticGates = pkg.scripts["check:push:static"]
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
      `${gate} is in the branch tier but is not tree-determined (scripts/ci/gate-stamp.mjs STATIC_TIER)`
    );
  }
});

test("every gate in check:push is classified", () => {
  for (const gate of checkPushGates) {
    assert.ok(
      classes[gate],
      `${gate} is in check:push but not in gate-classes.json`
    );
  }
});

test("every classified gate is a real root script with a class, a rung and a reason", () => {
  for (const [gate, row] of classified) {
    assert.ok(
      scripts.has(gate),
      `gate-classes.json names ${gate}, which package.json does not`
    );
    assert.ok(
      ["product", "contract", "hygiene"].includes(row.class),
      `${gate} has class ${row.class}`
    );
    assert.ok(
      Number.isInteger(row.rung) && row.rung >= 0 && row.rung <= 5,
      `${gate} rung`
    );
    assert.ok(
      typeof row.why === "string" && row.why.length > 20,
      `${gate} needs a one-line reason for its class`
    );
  }
});

test("hygiene gates left check:push and arrived in the weekly lane", () => {
  const hygiene = classified
    .filter(([, row]) => row.class === "hygiene")
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
      classes[gate].rung,
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
  for (const { groups } of hygieneWorkflow.matchAll(
    /bun run (?<gate>[a-z0-9:-]+)/gu
  )) {
    assert.ok(
      scripts.has(groups.gate),
      `hygiene.yml runs ${groups.gate}, which package.json does not define`
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
    assert.ok(classes[gate], `${gate} is bundled but unclassified`);
    assert.notEqual(
      classes[gate].class,
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
