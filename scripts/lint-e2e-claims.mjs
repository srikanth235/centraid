import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { flowPath, loadRoster } from "../tests/agent-e2e-mobile/lib/roster.mjs";

const FLOWS_DIR = "tests/agent-e2e-mobile/flows";
const PINS = "tests/agent-e2e-mobile/flows/claim-pins.json";

const CLAIM = /^\*\*Claim:\*\*\s*(?<claim>\S.*)$/mu;

const MAX_CLAIM = 400;

const MIN_CLAIM = 40;

export function discoverFlows(entries) {
  const flows = entries
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => name.slice(0, -".mjs".length))
    .sort();
  return flows.length > 0 ? flows : undefined;
}

export function claimOf(source) {
  return CLAIM.exec(source ?? "")?.groups?.claim?.trim();
}

export function lintClaims({ flows, docs, pins, rostered = {} }) {
  const errors = [];
  const pinned = new Set(pins);
  for (const flow of flows) {
    const claim = claimOf(docs[flow]);
    const isPinned = pinned.has(flow);
    const declared = rostered[flow];
    if (declared === undefined)
      errors.push(
        `${flow}: no row in tests/agent-e2e-mobile/roster.json — a flow nobody rostered is a flow nobody schedules`
      );
    else if (claim !== undefined && claim !== declared)
      errors.push(
        `${flow}: the '**Claim:**' line in ${flow}.md does not match roster.json's \`claim\`. The roster is the source; copy its sentence, or change the roster and copy it here.`
      );
    if (claim === undefined) {
      if (!isPinned)
        errors.push(
          `${flow}: no '**Claim:**' line in ${flow}.md — say what merges wrongly if this flow passes when it should not, or delete the flow`
        );
      continue;
    }
    if (isPinned)
      errors.push(
        `${flow}: declares a claim but is still pinned — remove it from ${PINS}`
      );
    if (claim.length < MIN_CLAIM)
      errors.push(
        `${flow}: claim is ${claim.length} characters; under ${MIN_CLAIM} it restates the flow's name rather than what it catches`
      );
    if (claim.length > MAX_CLAIM)
      errors.push(
        `${flow}: claim is ${claim.length} characters, over ${MAX_CLAIM} — the rest of the doc is for describing the flow`
      );
  }
  for (const pin of pins)
    if (!flows.includes(pin))
      errors.push(
        `${pin}: pinned in ${PINS} but no such flow — remove the pin`
      );
  return errors;
}

export function lintRatchet(pins, baseline) {
  const added = pins.filter((pin) => !baseline.includes(pin));
  return added.length === 0
    ? []
    : [
        `${PINS} grew by ${added.join(", ")} — the pin list is down-only. A new device flow states its claim; it does not join the backlog.`,
      ];
}

function selfTest() {
  const cases = [
    {
      name: "a declared claim passes",
      input: {
        flows: ["a"],
        docs: {
          a: "# a\n\n**Claim:** the write round-trips and survives a process death mid-write.\n",
        },
        pins: [],
      },
      errors: 0,
    },
    {
      name: "a missing doc fails",
      input: { flows: ["a"], docs: {}, pins: [] },
      errors: 1,
    },
    {
      name: "a doc with no claim fails",
      input: { flows: ["a"], docs: { a: "# a\n\nsome prose\n" }, pins: [] },
      errors: 1,
    },
    {
      name: "a pin absorbs a missing claim",
      input: { flows: ["a"], docs: {}, pins: ["a"] },
      errors: 0,
    },
    {
      name: "a stale pin on a flow that now declares one fails",
      input: {
        flows: ["a"],
        docs: {
          a: "**Claim:** the write round-trips and survives a process death mid-write.",
        },
        pins: ["a"],
      },
      errors: 1,
    },
    {
      name: "a pin for a deleted flow fails",
      input: { flows: [], docs: {}, pins: ["gone"] },
      errors: 1,
    },
    {
      name: "a one-word claim fails",
      input: { flows: ["a"], docs: { a: "**Claim:** it works." }, pins: [] },
      errors: 1,
    },
  ];
  for (const testCase of cases) {
    const errors = lintClaims({
      rostered: Object.fromEntries(
        (testCase.input.flows ?? []).map((flow) => [
          flow,
          claimOf(testCase.input.docs?.[flow]) ?? null,
        ])
      ),
      ...testCase.input,
    });
    if (errors.length !== testCase.errors)
      throw new Error(
        `self-test '${testCase.name}': expected ${testCase.errors} error(s), got ${errors.length} — ${errors.join("; ")}`
      );
  }
  if (lintRatchet(["a", "b"], ["a"]).length !== 1)
    throw new Error("self-test: a grown pin list must fail the ratchet");
  if (lintRatchet(["a"], ["a", "b"]).length !== 0)
    throw new Error("self-test: a shrunk pin list must pass the ratchet");
}

function main() {
  selfTest();
  const entries = readdirSync(FLOWS_DIR);
  const flows = discoverFlows(entries);
  if (flows === undefined) {
    console.error(
      `::error::lint-e2e-claims: found no flows under ${FLOWS_DIR}. Refusing to pass — an empty roster is how this linter would rot into always-passing.`
    );
    process.exit(1);
  }
  const docs = {};
  for (const flow of flows) {
    try {
      docs[flow] = readFileSync(path.join(FLOWS_DIR, `${flow}.md`), "utf8");
    } catch {
      // Intentionally empty.
    }
  }
  const pinned = JSON.parse(readFileSync(PINS, "utf8"));
  const roster = loadRoster();
  const rostered = Object.fromEntries(
    flows
      .map((flow) => [flow, roster.flows?.[flowPath(`${flow}.mjs`)]?.claim])
      .filter(([, claim]) => claim !== undefined)
  );
  const errors = [
    ...lintClaims({ flows, docs, pins: pinned.flows, rostered }),
    ...lintRatchet(pinned.flows, pinned.baseline),
  ];
  for (const error of errors)
    console.error(`::error::lint-e2e-claims: ${error}`);
  if (errors.length > 0) process.exit(1);
  const stated = flows.length - pinned.flows.length;
  console.log(
    `lint-e2e-claims: ${stated}/${flows.length} device flow(s) state their claim; ${pinned.flows.length} pinned (down-only)`
  );
}

if (import.meta.filename === process.argv[1]) main();
