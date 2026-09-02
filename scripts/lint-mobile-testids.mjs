#!/usr/bin/env node
// The testID contract, held from both ends (issue #890 W2).
//
// Why this exists: a Maestro `id:` selector and the `testID` that answers it sit
// in two trees that nothing links. Either half can move alone and stay green —
// a flow naming an id no screen renders never matches (and `assertNotVisible`
// on it PASSES, forever), and a `testID` nothing selects is dead weight that
// reads like coverage. Both failures are silent on a device and free to catch
// statically, so they are caught here, in seconds, with no simulator:
//
//   RULE missing-id    Every id a committed flow references exists in
//     `apps/mobile/src` — as an entry in `apps/mobile/src/kit/test-ids.ts`
//     (exact, or under a declared FAMILY prefix), or as a literal `testID` value
//     in production source. This half keeps a rename honest: renaming a handle
//     without renaming its selectors fails the PR that does it, not the nightly
//     two weeks later.
//
//   RULE unapplied-id  Every id declared in `test-ids.ts` is applied somewhere
//     in `apps/mobile/src`, by its accessor (`TEST_IDS.photos.grid`) or its
//     literal — the same defect arriving from the other side. A declared FAMILY
//     prefix counts as applied when its own accessor is referenced, since its
//     members are built at render time.
//
// WHAT THIS CANNOT SEE, said plainly: it matches text, not a render tree — a
// `testID` on an element that never mounts still reads as applied. That claim
// belongs to the device layer; this is the cheap tripwire in front of it,
// exactly as `lint-e2e-flows.mjs` is for vacuous assertions.
//
// Following lint-e2e-flows.mjs and lint-css-classes.mjs: A SILENT NO-OP IS A
// FAILURE. Zero flow files, zero Maestro YAML chunks, zero ids referenced, zero
// source files, or an empty vocabulary each FAIL rather than pass — every one is
// the shape this linter takes once its own discovery or grammar has gone stale,
// and "we found nothing to check" must never read as "nothing is wrong". The
// roster is discovered from disk, never hand-listed, so a flow cannot escape by
// being new, and a self-test of both rules runs first on inline fixtures so the
// linter cannot rot into always-passing.
//
// Escape hatch: `# testid-lint-allow: missing-id — <reason>` on a flow's own
// line or in the comment block above its step, for a flow that legitimately
// selects an id living outside `apps/mobile/src` (a native module's own handle).
// THERE ARE NONE TODAY and there should not be: an id the phone does not render
// is a selector that matches nothing. `unapplied-id` takes no marker — the
// honest fix for an entry nothing renders is to apply it or delete it.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

import { loadRoster } from "../tests/agent-e2e-mobile/lib/roster.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

// DISCOVERED, never hand-listed — the lesson of #842 W0.4, where five flows
// landed after a hardcoded roster was written and went unlinted for their whole
// life. `lib/` is scanned too: the harness helpers emit YAML on a flow's behalf
// (`configureGateway` selects `onboarding-connect`).
/** The journeys the roster prices. Held against `roster.json` in `main`. */
const JOURNEY_DIR = "tests/agent-e2e-mobile/flows";
const FLOW_DIRS = [JOURNEY_DIR, "tests/agent-e2e-mobile/lib"];

/** Production mobile source. The vocabulary lives here too. */
const SOURCE_DIR = "apps/mobile/src";
const VOCABULARY = "apps/mobile/src/kit/test-ids.ts";

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo"]);
// Tests and the test harness are not shipped UI: counting a fixture's `testID`
// as "applied" would let a handle no screen renders pass rule 2 on the strength
// of its own unit test.
const SKIP_SOURCE = /\.test\.[jt]sx?$|(?:^|\/)test\//u;
const SOURCE_EXT = /\.tsx?$/u;

/** Flow + helper files to scan, relative to `root`, discovered from disk. */
export function discoverFlowFiles(root = ROOT) {
  const files = [];
  for (const dir of FLOW_DIRS) {
    const abs = path.resolve(root, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs).sort()) {
      // `*.test.mjs` siblings assert harness behaviour with deliberately
      // violating fixtures — same carve-out as lint-e2e-flows.mjs.
      if (!name.endsWith(".mjs") || name.endsWith(".test.mjs")) continue;
      files.push(`${dir}/${name}`);
    }
  }
  return files;
}

/** Production `.ts`/`.tsx` under `apps/mobile/src`, relative to `root`. */
export function discoverSourceFiles(root = ROOT, dir = SOURCE_DIR) {
  const out = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs).sort()) {
      if (SKIP_DIRS.has(entry)) continue;
      const child = path.resolve(abs, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      const rel = path.relative(root, child).replaceAll("\\", "/");
      if (SOURCE_EXT.test(rel) && !SKIP_SOURCE.test(rel)) out.push(rel);
    }
  };
  const base = path.resolve(root, dir);
  if (existsSync(base)) walk(base);
  return out;
}

// ── the vocabulary ─────────────────────────────────────────────────────────
// Parsed line-by-line rather than with a TS parser: the file is a literal object
// by construction (that is what makes it a vocabulary), and a regex reader keeps
// this script dependency-free like its siblings. A shape it cannot read yields
// zero entries, which the empty-vocabulary guard turns into a failure.

const OPEN_RE =
  /^\s*(?:export const (?<root>\w+) = )?(?<key>\w+)?:?\s*Object\.freeze\(\{\s*$/u;
const ENTRY_RE = /^\s*(?<key>\w+):\s*"(?<value>[^"]+)",?\s*$/u;
const CLOSE_RE = /^\s*\}\),?;?\s*$/u;

/**
 * Read `test-ids.ts` into the two declared sets. Exported so the sibling test
 * can drive it on fixtures.
 *
 * @returns `{ ids, prefixes }`, each `{ value, accessor, line }[]` — `accessor`
 *   is the dotted path a component references (`TEST_IDS.photos.grid`), which
 *   is how rule 2 recognises an entry as applied.
 */
export function parseVocabulary(text) {
  const ids = [];
  const prefixes = [];
  const lines = text.split("\n");
  /** @type {string[]} */
  let trail = [];
  let rootName = "";
  for (const [index, line] of lines.entries()) {
    const open = OPEN_RE.exec(line);
    if (open?.groups) {
      if (open.groups.root) {
        rootName = open.groups.root;
        trail = [rootName];
      } else if (open.groups.key && trail.length > 0) {
        trail.push(open.groups.key);
      }
      continue;
    }
    if (CLOSE_RE.test(line)) {
      trail.pop();
      continue;
    }
    const entry = ENTRY_RE.exec(line);
    if (!entry?.groups || trail.length === 0) continue;
    const record = {
      value: entry.groups.value,
      accessor: [...trail, entry.groups.key].join("."),
      line: index + 1,
    };
    (rootName.includes("PREFIX") ? prefixes : ids).push(record);
  }
  return { ids, prefixes };
}

// ── the flows ──────────────────────────────────────────────────────────────

/**
 * The template-literal REGIONS of a `.mjs` flow, by line. Every Maestro chunk
 * here is a backtick template (it interpolates `ctx.state.appId`) and every
 * non-Maestro `id:` is a plain JS object literal — `lib/failure-class.mjs` names
 * its failure classes that way — so isolating template bodies is what keeps a JS
 * field from being read as a selector. Parity per line, not a character scanner:
 * nothing here nests a backtick inside a `${…}`, and a file that starts doing so
 * flips parity and yields FEWER ids, which the zero-ids and zero-chunks guards
 * turn into a failure rather than a quiet pass.
 */
export function templateLines(text) {
  const out = [];
  let inside = false;
  for (const [index, line] of text.split("\n").entries()) {
    // A line's own backticks toggle the state; the part of the line that is
    // inside the template is what gets scanned.
    const ticks = (line.match(/(?<!\\)`/gu) ?? []).length;
    if (inside) out.push({ line: index + 1, text: line });
    if (ticks % 2 === 1) {
      if (!inside) out.push({ line: index + 1, text: line });
      inside = !inside;
    }
  }
  return out;
}

const SELECTOR_RE = /\bid\s*:\s*(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)')/gu;

/**
 * Every Maestro `id:` selector a flow names — block form (`- tapOn:` then a
 * `id: "x"` child) and inline form (`from: { id: "x" }`) alike, since both are
 * the same token once the template body is isolated.
 *
 * `chunks` counts Maestro documents (a `---` separator inside a template): the
 * grammar-staleness guard, mirroring lint-e2e-flows.mjs's step count.
 */
export function collectFlowIds(text) {
  const found = [];
  let chunks = 0;
  for (const { line, text: body } of templateLines(text)) {
    if (/^\s*---\s*$/u.test(body)) chunks += 1;
    SELECTOR_RE.lastIndex = 0;
    let match;
    while ((match = SELECTOR_RE.exec(body))) {
      const value = match.groups?.dq ?? match.groups?.sq ?? "";
      // An interpolated selector resolves at run time (`id: "${marker}"` in
      // scroll-frames.mjs picks its surface per phase); nothing static can say
      // which id it names, so it is not claimed either way.
      if (value === "" || value.includes("${")) continue;
      found.push({ id: value, line });
    }
  }
  return { ids: found, chunks };
}

/**
 * Is the selector on line `line` exempted from `rule`? The marker may sit on the
 * selector's own line or in the comment block above the STEP that carries it —
 * an `id:` is a child key, so "the line above" is the command, not a comment.
 * The upward walk therefore crosses the step's remaining child keys and its one
 * `- command:` header, then requires contiguous `#` comments (a reason can wrap)
 * and stops at the first line that is neither. Same marker shape as
 * lint-e2e-flows.mjs's `# e2e-lint-allow:`.
 */
export function isAllowed(text, line, rule) {
  const lines = text.split("\n");
  const marker = new RegExp(`#\\s*testid-lint-allow:\\s*${rule}\\b`, "u");
  if (marker.test(lines[line - 1] ?? "")) return true;
  let crossedStep = false;
  for (let i = line - 2; i >= 0; i -= 1) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) {
      if (marker.test(raw)) return true;
      continue;
    }
    if (/^\s*-\s/u.test(raw)) {
      // The step's own header. One is the step being annotated; a second means
      // we have walked into the step before it, which this marker does not own.
      if (crossedStep) break;
      crossedStep = true;
      continue;
    }
    // A sibling child key of the same step (`text:`, `enabled:`, …).
    if (!crossedStep && /^\s+\S+\s*:/u.test(raw)) continue;
    break;
  }
  return false;
}

// ── the two rules ──────────────────────────────────────────────────────────

/**
 * Hold the two ends of the contract against each other. Pure: the caller reads
 * the disk, this decides. Exported so the sibling test can drive both rules on
 * fixtures without a tree. `flows` and `sources` are `{ rel, text }[]`; sources
 * EXCLUDE the vocabulary file, which declares the ids and so cannot also be the
 * witness that they are applied.
 */
export function lintTestIds({ flows, vocabulary, sources }) {
  const findings = [];
  const declared = new Set(vocabulary.ids.map((entry) => entry.value));
  const applied = sources.map((file) => file.text).join("\n");
  let referenced = 0;
  let chunks = 0;

  for (const flow of flows) {
    const { ids, chunks: flowChunks } = collectFlowIds(flow.text);
    chunks += flowChunks;
    referenced += ids.length;
    for (const { id, line } of ids) {
      const known =
        declared.has(id) ||
        vocabulary.prefixes.some((entry) => id.startsWith(entry.value)) ||
        // A handle predating the vocabulary is still a real handle: FrameProbe's
        // `perf-*` pair is spelled in its own module. A literal in production
        // source proves the id exists; it is just not part of the vocabulary.
        applied.includes(`"${id}"`);
      if (known || isAllowed(flow.text, line, "missing-id")) continue;
      findings.push({
        file: flow.rel,
        line,
        rule: "missing-id",
        message:
          `selects id "${id}", which no screen in apps/mobile/src renders. ` +
          `A selector that matches nothing never fails an assertVisible loudly ` +
          `— and passes assertNotVisible forever. Add the handle to ` +
          `${VOCABULARY} and apply it, or fix the spelling.`,
      });
    }
  }

  for (const entry of [...vocabulary.ids, ...vocabulary.prefixes]) {
    if (
      applied.includes(entry.accessor) ||
      applied.includes(`"${entry.value}"`)
    )
      continue;
    findings.push({
      file: VOCABULARY,
      line: entry.line,
      rule: "unapplied-id",
      message:
        `declares "${entry.value}" but nothing in apps/mobile/src applies it ` +
        `(neither \`${entry.accessor}\` nor the literal). A vocabulary entry no ` +
        `screen renders is a selector that will silently never match — apply it ` +
        `or delete it.`,
    });
  }

  return { findings, referenced, chunks };
}

// ── self-test: the linter's own rules, exercised before it judges the repo ──
// A linter that silently stops enforcing is worse than none; these fixtures make
// both rules executable spec. Runs on every invocation (µs) and fails loudly.
// The guards, the family-prefix path and the grammar readers are covered more
// thoroughly by the sibling `lint-mobile-testids.test.mjs`; what runs HERE is
// the minimum that proves the two rules still fire at the point of use.
function selfTest() {
  const vocabulary = parseVocabulary(
    [
      "export const TEST_IDS = Object.freeze({",
      "  home: Object.freeze({",
      '    band: "home-band",',
      "  }),",
      "});",
      "export const TEST_ID_PREFIXES = Object.freeze({",
      '  homeTile: "home-tile-",',
      "});",
    ].join("\n")
  );
  const applied = [
    { rel: "a.tsx", text: "<View testID={TEST_IDS.home.band} />" },
    // The `${…}` MUST stay uninterpolated: it is the accessor a component writes
    // to build a family member, which is exactly what rule 2 looks for.
    // oxlint-disable-next-line no-template-curly-in-string
    { rel: "b.tsx", text: "testID={`${TEST_ID_PREFIXES.homeTile}${id}`}" },
  ];
  const chunk = (body) => ({
    rel: "flow.mjs",
    text: "await ctx.run(`appId: x\n---\n" + body + "\n`);",
  });

  const cases = [
    {
      name: "clean tree passes both rules",
      flows: [chunk('- tapOn:\n    id: "home-band"')],
      sources: applied,
      want: [],
    },
    {
      name: "referenced-but-absent id fails",
      flows: [chunk('- tapOn:\n    id: "home-nope"')],
      sources: applied,
      want: ["missing-id"],
    },
    {
      name: "declared-but-unapplied id fails",
      flows: [chunk('- tapOn:\n    id: "home-band"')],
      sources: [applied[1]],
      want: ["unapplied-id"],
    },
    {
      name: "allow marker suppresses missing-id",
      flows: [
        chunk(
          "# testid-lint-allow: missing-id — lives in a native module\n" +
            '- tapOn:\n    id: "home-nope"'
        ),
      ],
      sources: applied,
      want: [],
    },
    {
      // `lib/failure-class.mjs` names its failure classes `{ id: "…" }` in plain
      // JS; reading one as a selector would fail the lane on a file that selects
      // nothing at all.
      name: "a JS object's id: field is not a Maestro selector",
      flows: [{ rel: "flow.mjs", text: 'const c = { id: "chunk-timeout" };' }],
      sources: applied,
      want: [],
    },
  ];

  for (const testCase of cases) {
    const got = lintTestIds({
      flows: testCase.flows,
      vocabulary,
      sources: testCase.sources,
    })
      .findings.map((finding) => finding.rule)
      .sort();
    const want = [...testCase.want].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.error(
        `FAIL — lint-mobile-testids self-test "${testCase.name}": expected [${want}], got [${got}]`
      );
      process.exit(1);
    }
  }
  // The vocabulary reader is half the linter; a shape it cannot read yields
  // zero entries and every rule then passes vacuously.
  if (vocabulary.ids.length !== 1 || vocabulary.prefixes.length !== 1) {
    console.error(
      `FAIL — lint-mobile-testids self-test "vocabulary reader": expected 1 id ` +
        `and 1 prefix, got ${vocabulary.ids.length} and ${vocabulary.prefixes.length}`
    );
    process.exit(1);
  }
}

function fail(message) {
  console.error(`FAIL — ${message}`);
  process.exit(1);
}

function main() {
  selfTest();

  const flowRels = discoverFlowFiles();
  const sourceRels = discoverSourceFiles();

  // Silent-no-op guards (see header). Each of these is what this linter looks
  // like once its discovery or its grammar has gone stale.
  if (flowRels.length === 0)
    fail(
      `discovered zero flow files under ${FLOW_DIRS.join(", ")}. ` +
        `The scan directories moved; fix FLOW_DIRS in this linter.`
    );
  if (sourceRels.length === 0)
    fail(
      `discovered zero source files under ${SOURCE_DIR}. ` +
        `The mobile source tree moved; fix SOURCE_DIR in this linter.`
    );

  // THE ROSTER IS THE SINGLE SOURCE (#915 Wave 2), and this linter's discovery
  // is held against it rather than replaced by it. Discovery is what catches a
  // flow that landed after a list was written (#842 W0.4); the roster is what
  // catches a journey that was rostered and then deleted, or renamed on one
  // side only. Reading only the roster would lose the first; reading only the
  // directory would lose the second. Both, and they must agree.
  const rosterFlows = new Set(Object.keys(loadRoster().flows ?? {}));
  const scanned = new Set(
    flowRels.filter((rel) => rel.startsWith(`${JOURNEY_DIR}/`))
  );
  for (const rel of [...scanned].sort())
    if (!rosterFlows.has(rel))
      fail(
        `${rel} is on disk but has no tests/agent-e2e-mobile/roster.json row, so no ` +
          `rung, no budget and no claim price it. Roster it or delete it.`
      );
  for (const rel of [...rosterFlows].sort())
    if (!scanned.has(rel))
      fail(
        `tests/agent-e2e-mobile/roster.json rosters ${rel}, which this linter never ` +
          `scanned. A roster row for a file that is not there is a claim with no code.`
      );

  const vocabularyPath = path.resolve(ROOT, VOCABULARY);
  if (!existsSync(vocabularyPath))
    fail(`${VOCABULARY} does not exist — the id vocabulary is the contract.`);
  const vocabulary = parseVocabulary(readFileSync(vocabularyPath, "utf8"));
  if (vocabulary.ids.length === 0)
    fail(
      `${VOCABULARY} yielded zero ids. The vocabulary is empty or its shape ` +
        `changed and this linter's reader is stale, not clean.`
    );

  const flows = flowRels.map((rel) => ({
    rel,
    text: readFileSync(path.resolve(ROOT, rel), "utf8"),
  }));
  const sources = sourceRels
    .filter((rel) => rel !== VOCABULARY)
    .map((rel) => ({
      rel,
      text: readFileSync(path.resolve(ROOT, rel), "utf8"),
    }));

  const { findings, referenced, chunks } = lintTestIds({
    flows,
    vocabulary,
    sources,
  });

  if (chunks === 0)
    fail(
      `scanned ${flows.length} flow file(s) and matched zero Maestro YAML ` +
        `chunks. The template grammar is stale, not clean.`
    );
  if (referenced === 0)
    fail(
      `scanned ${chunks} Maestro chunk(s) and matched zero \`id:\` selectors. ` +
        `Either the selector grammar is stale, or every flow has gone back to ` +
        `keying on copy — both are the failure this gate exists to catch.`
    );

  if (findings.length > 0) {
    console.error(
      `\nFAIL — ${findings.length} break(s) in the mobile testID contract:\n`
    );
    for (const finding of findings) {
      console.error(`  ${finding.file}:${finding.line} [${finding.rule}]`);
      console.error(`    ${finding.message}\n`);
    }
    console.error(
      `See ${VOCABULARY} for the vocabulary and its rules, and issue #890.\n`
    );
    process.exit(1);
  }

  console.log(
    `ok   mobile-testids — ${referenced} id selector(s) across ${flows.length} ` +
      `flow file(s) resolve, ${vocabulary.ids.length + vocabulary.prefixes.length} ` +
      `vocabulary entr(ies) applied across ${sources.length} source file(s)`
  );
}

// Run as a CLI; stay importable (the pure functions) without side effects.
if (import.meta.url === `file://${process.argv[1]}`) main();
