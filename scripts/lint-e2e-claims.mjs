// EVERY DEVICE FLOW NAMES ITS CLAIM (#905).
//
// Device E2E is the most expensive and least reliable instrument in this repo.
// The only thing that keeps such a suite from rotting into a slow duplicate of
// the unit tests is a rule with teeth: a flow must be able to answer "what
// merges wrongly if this passes when it shouldn't?" — and a flow that cannot
// answer it should be deleted rather than run for years.
//
// The convention already existed and was almost entirely unobserved. When this
// linter was written, ONE flow of twenty-two carried a `**Claim:**` line
// (`pairing-canary.md`); five had no companion doc at all. `cold-start` was one
// of the five, and it is the cautionary case: it asserts only
// `HOME_READY_MARKER`, which `demo-corpus.mjs` documents as rendering in BOTH
// the DayOne branch and the LauncherGrid branch. On run 33469364358 it passed —
// median 16074 ms — against a Home carrying "Nothing in here yet" and not one
// launcher tile, while three sibling flows failed on that same screen. A flow
// whose claim nobody had to write down had quietly stopped making one.
//
// THE PIN LIST IS DOWN-ONLY, like `tests/comment-density-ratchet.json`. A gate
// that lands with a backlog is not a weakened gate; a gate whose backlog is
// allowed to grow is. Adding a flow to `claim-pins.json` fails this linter —
// only removals are accepted — so the only way to add a device flow is to say
// what it catches.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const FLOWS_DIR = "tests/agent-e2e-mobile/flows";
const PINS = "tests/agent-e2e-mobile/flows/claim-pins.json";

/** The line a doc must carry. Bold so it survives a reader skimming, and
 *  prefix-anchored so prose that merely mentions a claim cannot satisfy it. */
const CLAIM = /^\*\*Claim:\*\*\s*(?<claim>\S.*)$/mu;

/** Short enough that it is a claim and not a design doc. A sentence that needs
 *  more than this is describing the flow, which the rest of the doc is for. */
const MAX_CLAIM = 400;

/** A claim has to say what breaks, so it cannot be a restatement of the name. */
const MIN_CLAIM = 40;

/**
 * Flow slugs, discovered — never hand-listed, so a new flow is covered the day
 * it lands. Returns `undefined` rather than `[]` when the directory yields
 * nothing, because an empty roster is how a text-scanning linter rots into
 * always-passing.
 */
export function discoverFlows(entries) {
  const flows = entries
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => name.slice(0, -".mjs".length))
    .sort();
  return flows.length > 0 ? flows : undefined;
}

/** The claim a doc declares, or `undefined`. */
export function claimOf(source) {
  return CLAIM.exec(source ?? "")?.groups?.claim?.trim();
}

/**
 * Every violation, as printable strings. Pure: the caller does the reading, so
 * the rules are testable on inline fixtures before they touch the tree.
 */
export function lintClaims({ flows, docs, pins }) {
  const errors = [];
  const pinned = new Set(pins);
  for (const flow of flows) {
    const claim = claimOf(docs[flow]);
    const isPinned = pinned.has(flow);
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

/** The pin list may only shrink. */
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
    const errors = lintClaims(testCase.input);
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
      /* a flow with no doc is a violation, reported below */
    }
  }
  const pinned = JSON.parse(readFileSync(PINS, "utf8"));
  const errors = [
    ...lintClaims({ flows, docs, pins: pinned.flows }),
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
