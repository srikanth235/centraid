#!/usr/bin/env node
// Mobile agent-e2e flow linter — catches Maestro assertions that pass while
// observing nothing, and typed input that is never verified (issue #483).
//
// Why this exists: getting the `mobile-e2e` lane green (#474/#478) surfaced six
// defects that share ONE shape — a step that was green while observing nothing,
// or red for a reason unrelated to its stated claim. Two of those shapes are
// mechanical and recur, so they are automated here rather than left to review:
//
//   RULE input-asserted   Every `inputText:` must be followed, in the same
//     YAML block, by an `assertVisible`/`extendedWaitUntil` that observes the
//     value that was typed. A gateway URL typed into an unfocused field, or a
//     keystroke eaten by the iOS keyboard-onboarding sheet ("h7.0.0.1:18789"),
//     both persisted silently — the flow only redboxed two steps later on an
//     assertion that looked unrelated. Asserting the field's value at the field
//     fails AT the field, where the cause is obvious.
//
//   RULE route-name       No `assertVisible`/`assertNotVisible`/`extendedWaitUntil`
//     may key on a bare tab-bar label or route name (Home/Photos/Docs/Agenda/
//     Settings/Apps). The tab bar renders those labels on EVERY screen, so
//     `tapOn "Docs.*"` + `assertVisible "Docs"` passes even when the tap did
//     nothing; and `assertNotVisible "Apps"` (a route name that is never visible
//     text) passes on every screen in the app. Assert on a string the screen
//     alone publishes — a heading or an accessibilityLabel.
//
// The two rules the issue lists that are NOT mechanically decidable — "every
// tapOn is anchored so it cannot match help copy" and "every asserted string is
// one the product deliberately publishes" — stay in the review checklist in
// tests/agent-e2e-mobile/AGENTS.md. This linter enforces the decidable subset.
//
// Escape hatch: a step legitimately exempt from a rule carries, on its own line
// or the line above, `# e2e-lint-allow: <rule> — <reason>` where <rule> is
// `unasserted-input` or `route-name` — a marker naming anything else suppresses
// NOTHING and is a dead comment (photos-search carried `input-observed`, a rule
// that never existed, for its whole life; #842 W0.4 removed it). The throwaway
// keystroke that provokes the keyboard sheet and the secret token (whose value
// cannot be asserted) are the exemptions today; each says why.
//
// Following scripts/lint-css-classes.mjs and lint-types.sh: a silent no-op is a
// FAILURE. Its roster is discovered from disk (see SCAN_DIRS) so a flow can
// never escape by being new; if a discovered flow yields zero steps, the step
// grammar is stale, not clean — and a self-test of its own rules runs first so
// the linter cannot rot into always-passing.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { FLOW_CATALOG } from "../tests/agent-e2e-mobile/ci-flow-catalog.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

// The roster is DISCOVERED, never hand-listed. A hardcoded list is a silent
// escape hatch: the five `photos-*` flows landed after the list was written and
// went unlinted for their whole life (#842 W0.4). Every `.mjs` under these two
// directories is scanned, so a flow file dropped on disk is linted the moment it
// exists — no linter edit, nothing to forget.
//
//   flows/   one journey each; all of them embed Maestro YAML.
//   lib/     the harness helpers (configureGateway/restart/first-run) that emit
//            YAML on a flow's behalf. Members with no YAML at all (spawn, metro,
//            …) are scanned too and simply contribute zero steps — cheap, and it
//            means a helper that GROWS a YAML snippet is covered from day one.
const SCAN_DIRS = [
  "tests/agent-e2e-mobile/flows",
  "tests/agent-e2e-mobile/lib",
];

// These are the only mobile Maestro execution surfaces. Keep this list small
// and explicit: a new runner must be added here before a catalog entry can
// claim it, so adding a file without wiring it into CI cannot look like
// coverage.
export const CANONICAL_SURFACES = Object.freeze({
  workflow: ".github/workflows/e2e.yml",
  androidRunner: "apps/mobile/scripts/android-emulator-e2e.sh",
  suiteRunners: Object.freeze({
    photos: "tests/agent-e2e-mobile/run-photos-suite.mjs",
    "home-apps": "tests/agent-e2e-mobile/run-home-apps-suite.mjs",
  }),
});

const RUNNER_SUITES = new Set(Object.keys(CANONICAL_SURFACES.suiteRunners));
const DIRECT_SUITES = new Set(["lane-a", "standalone"]);

// Vitest/node:test siblings are excluded by rule: `*.test.mjs` files assert the
// linter's and the harness's behaviour with deliberately-violating FIXTURES, so
// linting them would flag strings that exist precisely to be flagged.
const isTestFile = (name) => name.endsWith(".test.mjs");

// Individually excluded files, each with the reason it cannot be linted. EMPTY
// today, and it should stay that way: the honest fix for a file this linter
// misreads is a rule that understands it, not an exemption. Anything added here
// needs a comment naming what about the file defeats the step grammar.
const EXCLUDED = new Set();

/** The files to lint, relative to `root`, discovered from disk. Exported so the
 * unit tests can hold the roster against the directory listing itself — the
 * proof that a new flow cannot escape the linter by being new. */
export function discoverFiles(root = ROOT) {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const names = readdirSync(path.resolve(root, dir)).sort();
    for (const name of names) {
      if (!name.endsWith(".mjs") || isTestFile(name)) continue;
      const rel = `${dir}/${name}`;
      if (EXCLUDED.has(rel)) continue;
      files.push(rel);
    }
  }
  return files;
}

const isFlowFile = (rel) => rel.startsWith(`${SCAN_DIRS[0]}/`);

/** Read the surfaces used by the catalog reachability check. Missing files are
 * represented as null so the linter can report a useful wiring error instead
 * of throwing before it explains which surface disappeared. */
export function readCanonicalSurfaces(root = ROOT) {
  const read = (rel) => {
    try {
      return readFileSync(path.resolve(root, rel), "utf8");
    } catch {
      return null;
    }
  };
  return {
    workflow: read(CANONICAL_SURFACES.workflow),
    androidRunner: read(CANONICAL_SURFACES.androidRunner),
    suiteRunners: Object.fromEntries(
      Object.entries(CANONICAL_SURFACES.suiteRunners).map(([suite, rel]) => [
        suite,
        read(rel),
      ])
    ),
  };
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Match a committed path or a quoted basename. Suite runners use basenames
 * when they join each file to their shared flows directory; direct runners use
 * the repository-relative path. Comments are removed before matching so a
 * retired flow mentioned in prose cannot satisfy the ownership contract. */
function references(source, rel) {
  if (typeof source !== "string") return false;
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(?:#|\/\/)/u.test(line))
    .join("\n");
  if (code.includes(rel)) return true;
  const basename = path.basename(rel);
  return new RegExp(`["']${escapeRegExp(basename)}["']`, "u").test(code);
}

/** Validate the flow roster and prove every CI-owned flow is reachable from
 * the canonical platform surface it claims. Exported so tests can exercise
 * the fail paths with synthetic rosters and surface text. */
export function validateFlowCatalog({
  root = ROOT,
  files = discoverFiles(root),
  catalog = FLOW_CATALOG,
  surfaces = readCanonicalSurfaces(root),
} = {}) {
  const errors = [];
  const discovered = new Set(files.filter(isFlowFile));
  const declared = new Set(
    Object.keys(catalog).filter((rel) => rel.startsWith(`${SCAN_DIRS[0]}/`))
  );

  for (const rel of [...discovered].sort()) {
    if (!declared.has(rel))
      errors.push(`flow is not classified in ci-flow-catalog.mjs: ${rel}`);
  }
  for (const rel of [...declared].sort()) {
    if (!discovered.has(rel))
      errors.push(`catalog flow does not exist on disk: ${rel}`);
  }

  for (const [rel, entry] of Object.entries(catalog)) {
    if (!rel.startsWith(`${SCAN_DIRS[0]}/`)) {
      errors.push(`catalog entry is outside the mobile flow directory: ${rel}`);
      continue;
    }
    if (!entry || typeof entry !== "object") {
      errors.push(`catalog entry is not an object: ${rel}`);
      continue;
    }
    if (entry.ownership === "manual") {
      if (typeof entry.reason !== "string" || !entry.reason.trim())
        errors.push(`manual flow has no reason: ${rel}`);
      if (entry.platforms !== undefined || entry.suite !== undefined)
        errors.push(`manual flow must not declare CI metadata: ${rel}`);
      continue;
    }
    if (entry.ownership !== "ci") {
      errors.push(`flow ownership must be ci or manual: ${rel}`);
      continue;
    }
    if (
      !Array.isArray(entry.platforms) ||
      entry.platforms.length === 0 ||
      new Set(entry.platforms).size !== entry.platforms.length ||
      entry.platforms.some((platform) => !["ios", "android"].includes(platform))
    ) {
      errors.push(`CI flow must declare unique ios/android platforms: ${rel}`);
    }
    if (typeof entry.suite !== "string" || !entry.suite.trim()) {
      errors.push(`CI flow must declare a suite: ${rel}`);
      continue;
    }
    if (!RUNNER_SUITES.has(entry.suite) && !DIRECT_SUITES.has(entry.suite)) {
      errors.push(`CI flow declares an unknown suite "${entry.suite}": ${rel}`);
      continue;
    }

    for (const platform of entry.platforms ?? []) {
      const surface =
        platform === "ios" ? surfaces.workflow : surfaces.androidRunner;
      const surfaceLabel =
        platform === "ios"
          ? CANONICAL_SURFACES.workflow
          : CANONICAL_SURFACES.androidRunner;
      if (surface == null) {
        errors.push(`missing ${platform} canonical surface ${surfaceLabel}`);
        continue;
      }
      if (RUNNER_SUITES.has(entry.suite)) {
        const runner = CANONICAL_SURFACES.suiteRunners[entry.suite];
        if (!references(surface, runner)) {
          errors.push(
            `${rel} is not reachable on ${platform}: ${surfaceLabel} does not invoke ${runner}`
          );
          continue;
        }
        const runnerSource = surfaces.suiteRunners?.[entry.suite];
        if (runnerSource == null) {
          errors.push(`missing canonical suite runner ${runner}`);
        } else if (!references(runnerSource, rel)) {
          errors.push(
            `${rel} is not referenced by canonical suite runner ${runner}`
          );
        }
      } else if (!references(surface, rel)) {
        errors.push(
          `${rel} is not referenced by the ${platform} canonical surface ${surfaceLabel}`
        );
      }
    }
  }
  return errors;
}

// Tab-bar labels + route names. These come from apps/mobile/App.tsx (Tab.Screen
// tabBarLabel / name) — the label is drawn in the tab bar on every screen, and
// "Apps" is the route name behind the "Home" tab and is never visible text. An
// assertion on any of these cannot distinguish one screen from another. Keep in
// sync with the navigator; drift only ever makes this MORE permissive, which a
// stale-list review will catch when a renamed tab stops being flagged.
const ROUTE_NAMES = new Set([
  "Home",
  "Photos",
  "Docs",
  "Agenda",
  "Settings",
  "Apps",
]);

// Maestro commands this linter reasons about. Others (takeScreenshot, hideKeyboard,
// scrollUntilVisible, runFlow, back, …) are stepped over.
const INPUT_CMDS = new Set(["inputText"]);
const ASSERT_CMDS = new Set([
  "assertVisible",
  "assertNotVisible",
  "extendedWaitUntil",
]);
const CLEAR_CMDS = new Set(["launchApp"]); // may reset a field's content (clearState)
const ALL_CMDS = new Set([
  ...INPUT_CMDS,
  ...ASSERT_CMDS,
  ...CLEAR_CMDS,
  "tapOn",
  "eraseText",
  "stopApp",
]);

const STEP_RE = /^(?<indent>\s*)-\s+(?<cmd>[A-Za-z]+)\s*:?(?<rest>.*)$/u;

/** Pull the primary matcher value out of a step: the inline value, or the
 * `text:`/`visible:` child a line or two below. Returns the raw token — the
 * contents of a "quoted" literal, or a `${interpolation}` verbatim — or null. */
function stepValue(lines, i) {
  const m = STEP_RE.exec(lines[i]);
  if (!m?.groups) return null;
  const inline = (m.groups.rest ?? "").trim();
  const fromInline = literalOrInterp(inline);
  if (fromInline != null) return fromInline;
  // Block form: scan the immediate children for `text:` / `visible:`.
  const baseIndent = (m.groups.indent ?? "").length;
  for (let j = i + 1; j < lines.length && j <= i + 4; j += 1) {
    const child = /^\s*(?:text|visible)\s*:(?<rest>.*)$/u.exec(lines[j]);
    if (!child) {
      // Stop at a dedent back to sibling level — we have left this step.
      if (
        /^\s*-\s/u.test(lines[j]) &&
        (lines[j].match(/^\s*/u)[0].length ?? 0) <= baseIndent
      )
        break;
      continue;
    }
    const v = literalOrInterp((child.groups?.rest ?? "").trim());
    if (v != null) return v;
    // `visible:` with a nested `text:` on the following line.
  }
  return null;
}

/** A `"literal"` → its inner text; a `${expr}` → the expr verbatim; else null. */
function literalOrInterp(s) {
  if (!s) return null;
  const q = /^"(?<inner>[^"]*)"/u.exec(s);
  if (q) return q.groups?.inner ?? null;
  const sq = /^'(?<inner>[^']*)'/u.exec(s);
  if (sq) return sq.groups?.inner ?? null;
  if (s.startsWith("${")) return s; // interpolation — compared by identity
  return null;
}

const isInterp = (v) => v != null && v.startsWith("${");
/** Strip a trailing Maestro regex `.*` and surrounding whitespace for the
 * route-name exact match ("Docs.*" is still an assertion on the Docs label). */
const asPlain = (v) => (isInterp(v) ? v : v.replace(/\.\*$/u, "").trim());

/** Does a later assertion `a` observe the value `typed`? Interpolations match by
 * identity (same `${expr}`); literals match if the assertion's text contains the
 * typed literal (typing "http://x" is proven by asserting a string with it). */
function observes(typed, a) {
  if (a == null) return false;
  if (isInterp(typed)) return a === typed;
  if (isInterp(a)) return false;
  return a.includes(typed);
}

/** Is `step at line i` exempted from `rule` by an `# e2e-lint-allow:` marker on
 * its own line or in the block of comment lines immediately above it? Scans
 * upward across contiguous `#` comment (and blank) lines — a reason can wrap
 * onto more than one line — and stops at the first line that is neither. */
function isAllowed(lines, i, rule) {
  const marker = new RegExp(`#\\s*e2e-lint-allow:\\s*${rule}\\b`, "u");
  if (marker.test(lines[i])) return true;
  for (let j = i - 1; j >= 0; j -= 1) {
    const t = lines[j].trim();
    if (t === "") continue;
    if (!t.startsWith("#")) break; // left the comment block above the step
    if (marker.test(lines[j])) return true;
  }
  return false;
}

/**
 * Lint one flow source. Pure — takes text, returns findings + a step count so
 * the caller can enforce the silent-no-op guard. Exported for the self-test.
 */
export function lintFlowSource(text) {
  const lines = text.split("\n");
  const findings = [];
  // Parse the ordered list of Maestro steps we care about.
  const steps = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = STEP_RE.exec(lines[i]);
    if (!m?.groups) continue;
    const cmd = m.groups.cmd;
    if (!ALL_CMDS.has(cmd)) continue;
    steps.push({ i, cmd, value: stepValue(lines, i) });
  }

  for (let s = 0; s < steps.length; s += 1) {
    const step = steps[s];

    // RULE route-name — an assertion keyed on a bare tab/route label.
    if (ASSERT_CMDS.has(step.cmd) && step.value != null) {
      const plain = asPlain(step.value);
      if (ROUTE_NAMES.has(plain) && !isAllowed(lines, step.i, "route-name")) {
        findings.push({
          line: step.i + 1,
          rule: "route-name",
          message:
            `${step.cmd} keys on "${plain}", a tab-bar label / route name drawn on every ` +
            `screen — it passes even when navigation did nothing. Assert a string this ` +
            `screen alone publishes (a heading or accessibilityLabel).`,
        });
      }
    }

    // RULE input-asserted — a typed value never observed before it could be wiped.
    if (INPUT_CMDS.has(step.cmd) && step.value != null) {
      if (isAllowed(lines, step.i, "unasserted-input")) continue;
      let observed = false;
      for (let t = s + 1; t < steps.length; t += 1) {
        const later = steps[t];
        // A clearState launch wipes the field — stop looking past it.
        if (later.cmd === "launchApp") {
          const block = lines.slice(later.i, later.i + 4).join("\n");
          if (/clearState:\s*true/u.test(block)) break;
        }
        if (ASSERT_CMDS.has(later.cmd) && observes(step.value, later.value)) {
          observed = true;
          break;
        }
      }
      if (!observed) {
        const shown = isInterp(step.value) ? step.value : `"${step.value}"`;
        findings.push({
          line: step.i + 1,
          rule: "unasserted-input",
          message:
            `inputText ${shown} is never asserted — nothing proves it landed in the field. ` +
            `Follow it with assertVisible on that value, or mark it ` +
            `\`# e2e-lint-allow: unasserted-input — <reason>\` if the value cannot be observed.`,
        });
      }
    }
  }

  return { findings, steps: steps.length };
}

// ---- self-test: the linter's own rules, exercised before it judges the repo.
// A linter that silently stops enforcing is worse than no linter; this makes
// its rules executable spec. Runs on every invocation (µs), fails loudly.
function selfTest() {
  const cases = [
    {
      name: "route-name assertion flagged",
      src: '- tapOn:\n    text: "Docs.*"\n- assertVisible: "Docs"\n',
      want: ["route-name"],
    },
    {
      name: "screen-unique assertion clean",
      src: '- tapOn:\n    text: "Docs.*"\n- assertVisible: "Add document or folder"\n',
      want: [],
    },
    {
      name: "unasserted literal input flagged",
      src: '- inputText: "hello"\n- tapOn: "Save"\n',
      want: ["unasserted-input"],
    },
    {
      name: "asserted literal input clean",
      src: '- inputText: "hello"\n- assertVisible:\n    text: "hello"\n',
      want: [],
    },
    {
      name: "interpolated input asserted by same token clean",
      // The `${…}` here MUST stay an uninterpolated literal — the linter compares
      // interpolation tokens by identity, so this fixture feeds it the raw token.
      // oxlint-disable-next-line no-template-curly-in-string
      src: "- inputText: ${JSON.stringify(url)}\n- assertVisible:\n    text: ${JSON.stringify(url)}\n",
      want: [],
    },
    {
      name: "assertion after clearState does not count",
      src: '- inputText: "hello"\n- launchApp:\n    clearState: true\n- assertVisible: "hello"\n',
      want: ["unasserted-input"],
    },
    {
      name: "allow-annotation on line above suppresses",
      src: '# e2e-lint-allow: unasserted-input — throwaway\n- inputText: "x"\n- tapOn: "Save"\n',
      want: [],
    },
    {
      name: "route-name allow-annotation suppresses",
      src: '# e2e-lint-allow: route-name — deliberate\n- assertVisible: "Docs"\n',
      want: [],
    },
  ];
  for (const c of cases) {
    const got = lintFlowSource(c.src)
      .findings.map((f) => f.rule)
      .sort();
    const want = [...c.want].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.error(
        `FAIL — lint-e2e-flows self-test "${c.name}": expected [${want}], got [${got}]`
      );
      process.exit(1);
    }
  }
}

function main() {
  selfTest();
  const files = discoverFiles();
  const catalogErrors = validateFlowCatalog({ files });
  if (catalogErrors.length > 0) {
    console.error(
      "\nFAIL — mobile Maestro flow catalog is incomplete or unwired:\n"
    );
    for (const error of catalogErrors) console.error(`  ${error}`);
    process.exit(1);
  }
  let stepsScanned = 0;
  let filesScanned = 0;
  const findings = [];
  const emptyFlows = [];
  for (const rel of files) {
    filesScanned += 1;
    const { findings: fs, steps } = lintFlowSource(
      readFileSync(path.resolve(ROOT, rel), "utf8")
    );
    stepsScanned += steps;
    if (steps === 0 && isFlowFile(rel)) emptyFlows.push(rel);
    for (const f of fs) findings.push({ file: rel, ...f });
  }

  // Silent-no-op guards (see header). Discovery removed the stale-list failure
  // mode, so what is left to catch is a stale step GRAMMAR: a journey file this
  // linter can no longer parse reads as "clean" and must read as broken.
  if (filesScanned === 0) {
    console.error(
      `FAIL — discovered zero files under ${SCAN_DIRS.join(", ")}. ` +
        `The scan directories moved; fix SCAN_DIRS in this linter.`
    );
    process.exit(1);
  }
  if (emptyFlows.length > 0) {
    console.error(
      `\nFAIL — flow file(s) matched zero Maestro steps; the step grammar is stale, not clean:\n`
    );
    for (const rel of emptyFlows) console.error(`  ${rel}`);
    process.exit(1);
  }
  if (stepsScanned === 0) {
    console.error(
      `FAIL — scanned ${filesScanned} file(s) but matched zero Maestro steps. ` +
        `The step grammar is stale, not clean.`
    );
    process.exit(1);
  }

  if (findings.length > 0) {
    console.error(
      `\nFAIL — ${findings.length} agent-e2e flow assertion(s) observe the wrong thing:\n`
    );
    for (const f of findings) {
      console.error(
        `  ${path.relative(ROOT, path.resolve(ROOT, f.file))}:${f.line} [${f.rule}]`
      );
      console.error(`    ${f.message}\n`);
    }
    console.error(
      `See tests/agent-e2e-mobile/AGENTS.md "Flow authoring rules" and issue #483.\n`
    );
    process.exit(1);
  }

  console.log(
    `ok   e2e-flows — ${stepsScanned} Maestro step(s) across ${filesScanned} file(s), no vacuous assertions`
  );
}

// Run as a CLI; stay importable (selfTest/lintFlowSource) without side effects.
if (import.meta.url === `file://${process.argv[1]}`) main();
