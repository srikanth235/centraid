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
// `unasserted-input` or `route-name`. The throwaway keystroke that provokes the
// keyboard sheet and the secret token (whose value cannot be asserted) are the
// only two exemptions today; each says why.
//
// Following scripts/lint-css-classes.mjs and lint-types.sh: a silent no-op is a
// FAILURE. If this ever scans zero steps, its file list or step grammar is
// stale, not clean — and a self-test of its own rules runs first so the linter
// cannot rot into always-passing.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

// Every file that embeds Maestro YAML in a template literal. The flows plus the
// harness helpers (configureGateway/restart) that emit YAML on their behalf.
// A flow that lives elsewhere is unchecked — add it here, exactly like
// lint-css-classes.mjs's TARGETS.
const FILES = [
  'tests/agent-e2e-mobile/flows/home-loads.mjs',
  'tests/agent-e2e-mobile/flows/native-v0-resilience.mjs',
  'tests/agent-e2e-mobile/flows/template-gate.mjs',
  'tests/agent-e2e-mobile/lib/harness.mjs',
];

// Tab-bar labels + route names. These come from apps/mobile/App.tsx (Tab.Screen
// tabBarLabel / name) — the label is drawn in the tab bar on every screen, and
// "Apps" is the route name behind the "Home" tab and is never visible text. An
// assertion on any of these cannot distinguish one screen from another. Keep in
// sync with the navigator; drift only ever makes this MORE permissive, which a
// stale-list review will catch when a renamed tab stops being flagged.
const ROUTE_NAMES = new Set(['Home', 'Photos', 'Docs', 'Agenda', 'Settings', 'Apps']);

// Maestro commands this linter reasons about. Others (takeScreenshot, hideKeyboard,
// scrollUntilVisible, runFlow, back, …) are stepped over.
const INPUT_CMDS = new Set(['inputText']);
const ASSERT_CMDS = new Set(['assertVisible', 'assertNotVisible', 'extendedWaitUntil']);
const CLEAR_CMDS = new Set(['launchApp']); // may reset a field's content (clearState)
const ALL_CMDS = new Set([
  ...INPUT_CMDS,
  ...ASSERT_CMDS,
  ...CLEAR_CMDS,
  'tapOn',
  'eraseText',
  'stopApp',
]);

const STEP_RE = /^(\s*)-\s+([A-Za-z]+)\s*:?(.*)$/;

/** Pull the primary matcher value out of a step: the inline value, or the
 * `text:`/`visible:` child a line or two below. Returns the raw token — the
 * contents of a "quoted" literal, or a `${interpolation}` verbatim — or null. */
function stepValue(lines, i) {
  const m = STEP_RE.exec(lines[i]);
  if (!m) return null;
  const inline = m[3].trim();
  const fromInline = literalOrInterp(inline);
  if (fromInline != null) return fromInline;
  // Block form: scan the immediate children for `text:` / `visible:`.
  const baseIndent = m[1].length;
  for (let j = i + 1; j < lines.length && j <= i + 4; j += 1) {
    const child = /^(\s*)(text|visible)\s*:(.*)$/.exec(lines[j]);
    if (!child) {
      // Stop at a dedent back to sibling level — we have left this step.
      if (/^\s*-\s/.test(lines[j]) && (lines[j].match(/^\s*/)[0].length ?? 0) <= baseIndent) break;
      continue;
    }
    const v = literalOrInterp(child[3].trim());
    if (v != null) return v;
    // `visible:` with a nested `text:` on the following line.
  }
  return null;
}

/** A `"literal"` → its inner text; a `${expr}` → the expr verbatim; else null. */
function literalOrInterp(s) {
  if (!s) return null;
  const q = /^"([^"]*)"/.exec(s);
  if (q) return q[1];
  const sq = /^'([^']*)'/.exec(s);
  if (sq) return sq[1];
  if (s.startsWith('${')) return s; // interpolation — compared by identity
  return null;
}

const isInterp = (v) => v != null && v.startsWith('${');
/** Strip a trailing Maestro regex `.*` and surrounding whitespace for the
 * route-name exact match ("Docs.*" is still an assertion on the Docs label). */
const asPlain = (v) => (isInterp(v) ? v : v.replace(/\.\*$/, '').trim());

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
  const marker = new RegExp(`#\\s*e2e-lint-allow:\\s*${rule}\\b`);
  if (marker.test(lines[i])) return true;
  for (let j = i - 1; j >= 0; j -= 1) {
    const t = lines[j].trim();
    if (t === '') continue;
    if (!t.startsWith('#')) break; // left the comment block above the step
    if (marker.test(lines[j])) return true;
  }
  return false;
}

/**
 * Lint one flow source. Pure — takes text, returns findings + a step count so
 * the caller can enforce the silent-no-op guard. Exported for the self-test.
 */
export function lintFlowSource(text) {
  const lines = text.split('\n');
  const findings = [];
  // Parse the ordered list of Maestro steps we care about.
  const steps = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = STEP_RE.exec(lines[i]);
    if (!m) continue;
    const cmd = m[2];
    if (!ALL_CMDS.has(cmd)) continue;
    steps.push({ i, cmd, value: stepValue(lines, i) });
  }

  for (let s = 0; s < steps.length; s += 1) {
    const step = steps[s];

    // RULE route-name — an assertion keyed on a bare tab/route label.
    if (ASSERT_CMDS.has(step.cmd) && step.value != null) {
      const plain = asPlain(step.value);
      if (ROUTE_NAMES.has(plain) && !isAllowed(lines, step.i, 'route-name')) {
        findings.push({
          line: step.i + 1,
          rule: 'route-name',
          message:
            `${step.cmd} keys on "${plain}", a tab-bar label / route name drawn on every ` +
            `screen — it passes even when navigation did nothing. Assert a string this ` +
            `screen alone publishes (a heading or accessibilityLabel).`,
        });
      }
    }

    // RULE input-asserted — a typed value never observed before it could be wiped.
    if (INPUT_CMDS.has(step.cmd) && step.value != null) {
      if (isAllowed(lines, step.i, 'unasserted-input')) continue;
      let observed = false;
      for (let t = s + 1; t < steps.length; t += 1) {
        const later = steps[t];
        // A clearState launch wipes the field — stop looking past it.
        if (later.cmd === 'launchApp') {
          const block = lines.slice(later.i, later.i + 4).join('\n');
          if (/clearState:\s*true/.test(block)) break;
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
          rule: 'unasserted-input',
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
      name: 'route-name assertion flagged',
      src: '- tapOn:\n    text: "Docs.*"\n- assertVisible: "Docs"\n',
      want: ['route-name'],
    },
    {
      name: 'screen-unique assertion clean',
      src: '- tapOn:\n    text: "Docs.*"\n- assertVisible: "Add document or folder"\n',
      want: [],
    },
    {
      name: 'unasserted literal input flagged',
      src: '- inputText: "hello"\n- tapOn: "Save"\n',
      want: ['unasserted-input'],
    },
    {
      name: 'asserted literal input clean',
      src: '- inputText: "hello"\n- assertVisible:\n    text: "hello"\n',
      want: [],
    },
    {
      name: 'interpolated input asserted by same token clean',
      // The `${…}` here MUST stay an uninterpolated literal — the linter compares
      // interpolation tokens by identity, so this fixture feeds it the raw token.
      // oxlint-disable-next-line no-template-curly-in-string
      src: '- inputText: ${JSON.stringify(url)}\n- assertVisible:\n    text: ${JSON.stringify(url)}\n',
      want: [],
    },
    {
      name: 'assertion after clearState does not count',
      src: '- inputText: "hello"\n- launchApp:\n    clearState: true\n- assertVisible: "hello"\n',
      want: ['unasserted-input'],
    },
    {
      name: 'allow-annotation on line above suppresses',
      src: '# e2e-lint-allow: unasserted-input — throwaway\n- inputText: "x"\n- tapOn: "Save"\n',
      want: [],
    },
    {
      name: 'route-name allow-annotation suppresses',
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
        `FAIL — lint-e2e-flows self-test "${c.name}": expected [${want}], got [${got}]`,
      );
      process.exit(1);
    }
  }
}

function main() {
  selfTest();
  let stepsScanned = 0;
  let filesScanned = 0;
  const findings = [];
  for (const rel of FILES) {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) {
      console.error(`FAIL — listed flow file is missing: ${rel}. Update FILES in this linter.`);
      process.exit(1);
    }
    filesScanned += 1;
    const { findings: fs, steps } = lintFlowSource(readFileSync(abs, 'utf8'));
    stepsScanned += steps;
    for (const f of fs) findings.push({ file: rel, ...f });
  }

  // Silent-no-op guard (see header).
  if (stepsScanned === 0) {
    console.error(
      `FAIL — scanned ${filesScanned} file(s) but matched zero Maestro steps. ` +
        `The step grammar or FILES list is stale, not clean.`,
    );
    process.exit(1);
  }

  if (findings.length > 0) {
    console.error(
      `\nFAIL — ${findings.length} agent-e2e flow assertion(s) observe the wrong thing:\n`,
    );
    for (const f of findings) {
      console.error(`  ${relative(ROOT, resolve(ROOT, f.file))}:${f.line} [${f.rule}]`);
      console.error(`    ${f.message}\n`);
    }
    console.error(`See tests/agent-e2e-mobile/AGENTS.md "Flow authoring rules" and issue #483.\n`);
    process.exit(1);
  }

  console.log(
    `ok   e2e-flows — ${stepsScanned} Maestro step(s) across ${filesScanned} file(s), no vacuous assertions`,
  );
}

// Run as a CLI; stay importable (selfTest/lintFlowSource) without side effects.
if (import.meta.url === `file://${process.argv[1]}`) main();
