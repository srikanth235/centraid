#!/usr/bin/env node

import path from "node:path";

import { collectModel, parseFlags } from "./generate.mjs";
import { renderReport } from "./render/index.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURES = path.join(ROOT, "scripts/test-report/fixtures");

export const REQUIRED_SECTIONS = Object.freeze([
  ['id="verdict"', "§0 verdict lamp"],
  ['id="ship"', "§1 blockers"],
  ['id="changed"', "§2 since yesterday"],
  ['id="owes"', "§3 attention queue"],
  ['id="lanes"', "§4 lane health"],
  ['id="journeys"', "§5 journeys"],
  ['id="product"', "§6 coverage"],
  ['id="promises"', "§7 promises × surfaces"],
  ['id="adversaries"', "§8 adversaries"],
  ['id="trends"', "§9 trends"],
  ['id="evidence"', "§10 evidence"],
  ['id="read"', "§11 how to read this"],
]);

export function fixtureOptions(overrides = {}) {
  return parseFlags(
    [
      "--evidence",
      overrides.evidence ?? path.join(FIXTURES, "evidence"),
      "--evidence-previous",
      path.join(FIXTURES, "evidence-previous"),
      "--candidate",
      path.join(FIXTURES, "candidate.json"),
      "--claims",
      path.join(FIXTURES, "claims.json"),
      "--history",
      path.join(FIXTURES, "history"),
      "--scope",
      "nightly",
      "--output",
      path.join(ROOT, "dist/test-report-smoke"),
    ],
    {}
  );
}

export async function renderFixture(overrides = {}) {
  const model = await collectModel(
    fixtureOptions(overrides),
    new Date("2026-09-02T07:12:00Z")
  );
  return { model, html: renderReport(model) };
}

export async function smokeFailures() {
  const failures = [];
  const { model, html } = await renderFixture();

  for (const [marker, name] of REQUIRED_SECTIONS) {
    if (!html.includes(marker))
      failures.push(`${name} did not render (${marker})`);
  }
  if (model.validationErrors.length > 0) {
    failures.push(
      `fixture root produced ${model.validationErrors.length} validation errors: ${model.validationErrors.join("; ")}`
    );
  }
  if (!html.includes("HOLD"))
    failures.push("the fixture root's S2 red did not reach the verdict lamp");
  if (!/class="pill parked"/u.test(html))
    failures.push("the parked lane did not render as parked");
  if (!/no evidence/u.test(html))
    failures.push("the silent lane did not render as no evidence");
  if (/<style>\s*<\/style>/u.test(html) || !html.includes("--nw-ground")) {
    failures.push("the page carries no design-system sheet");
  }
  if (/url\((?!data:)/u.test(html))
    failures.push("the page fetches something at runtime");

  const parkedOnly = await renderFixture({
    evidence: path.join(FIXTURES, "evidence-parked-only"),
  });
  if (parkedOnly.model.verdict.verdict === "SHIPPABLE") {
    failures.push(
      "a night whose only evidence is a park rendered as SHIPPABLE"
    );
  }
  if (!/class="pill parked"/u.test(parkedOnly.html)) {
    failures.push("the parked-only root did not render a parked pill");
  }
  return failures;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  const failures = await smokeFailures();
  if (failures.length > 0) {
    for (const failure of failures)
      process.stderr.write(`report:smoke: ${failure}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `report:smoke: all ${REQUIRED_SECTIONS.length} sections render from the fixture root\n`
    );
  }
}
