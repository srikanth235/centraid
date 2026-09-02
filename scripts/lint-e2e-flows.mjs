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

/** A launcher-tile reference: the `Open <App>` cover tap every home journey
 *  opens with, in either of the two shapes flows write it — the
 *  `retryableTapCommands("Open Docs.*")` helper call and a bare `tapOn` — plus
 *  the `home-tile-<app>` handle the two probe journeys use instead. */
const TILE_RE = /(?:Open\s+[A-Z][a-zA-Z]*\s*\.\*|home-tile-[a-z]+)/gu;

/** The wait that tells DayOne from a launcher with tiles. Matched by NAME, not
 *  by the id it expands to: the constant is the contract, and a flow that
 *  inlined the id would be one rename away from waiting on nothing. */
const LAUNCHER_WAIT = "AWAIT_LAUNCHER";

/**
 * RULE launcher-await — the #870 rule.
 *
 * `HOME_READY_MARKER` is the band's label and the band renders in BOTH of
 * Home's branches, so a flow that waits only for it cannot tell a Home that has
 * the vault from one that does not. When the replica's clone has not landed,
 * `springboardState` settles every tile `empty`, `Home.tsx` renders `DayOne`,
 * and the very next `Open <App>` tap fails with `Element not found`. That is
 * what the 2026-09-01 nightly said twelve times over — and what it meant was
 * "the corpus arrived after the phone had already cloned" (#905 section E),
 * a sentence no line of that log contained.
 *
 * `AWAIT_LAUNCHER` waits for `home-grid`, which `LauncherGrid` alone publishes,
 * so it is the first thing on screen that separates the branches. #905 added it
 * and applied it to three flows; every other cover-tapping journey still walked
 * into DayOne and blamed a tile. This rule is what makes "apply it where the
 * next act is opening an app" mechanical instead of remembered.
 *
 * Chunk-scoped, because that is the scope the wait has to be in: a wait in an
 * earlier `ctx.run()` is a different Maestro process against a screen that may
 * have changed. Flows that deliberately face an empty vault — a purge, a
 * cleared client — mark the chunk `# e2e-lint-allow: launcher-await — <reason>`,
 * because for them DayOne is the correct screen.
 */
export function launcherAwaitFindings(text) {
  const findings = [];
  // Chunks are the segments between `ctx.run(` calls: one Maestro process each.
  const segments = text.split("ctx.run(");
  let offset = segments[0].length;
  for (const segment of segments.slice(1)) {
    const start = offset + "ctx.run(".length;
    offset = start + segment.length;
    const tile = TILE_RE.exec(segment);
    TILE_RE.lastIndex = 0;
    if (!tile) continue;
    if (/e2e-lint-allow:\s*launcher-await\b/u.test(segment)) continue;
    const waitAt = segment.indexOf(LAUNCHER_WAIT);
    if (waitAt !== -1 && waitAt < tile.index) continue;
    findings.push({
      line: text.slice(0, start + tile.index).split("\n").length,
      rule: "launcher-await",
      message:
        `this chunk reaches the launcher tile \`${tile[0]}\` without waiting for ` +
        `\`${LAUNCHER_WAIT}\` first. HOME_READY_MARKER is the band, and the band renders ` +
        `over DayOne too — so on a phone whose replica has not cloned, this tap fails ` +
        `with \`Element not found\` and names the app instead of the vault (#870). Put ` +
        `\`\${${LAUNCHER_WAIT}}\` before the tap, or mark the chunk ` +
        `\`# e2e-lint-allow: launcher-await — <reason>\` if it deliberately faces an ` +
        `empty vault.`,
    });
  }
  return findings;
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

  findings.push(...launcherAwaitFindings(text));

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
