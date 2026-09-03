#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const SCAN_DIRS = [
  "tests/agent-e2e-mobile/flows",
  "tests/agent-e2e-mobile/lib",
];

const isTestFile = (name) => name.endsWith(".test.mjs");

const EXCLUDED = new Set();

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

const ROUTE_NAMES = new Set([
  "Home",
  "Photos",
  "Docs",
  "Agenda",
  "Settings",
  "Apps",
]);

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

function stepValue(lines, i) {
  const m = STEP_RE.exec(lines[i]);
  if (!m?.groups) return null;
  const inline = (m.groups.rest ?? "").trim();
  const fromInline = literalOrInterp(inline);
  if (fromInline != null) return fromInline;
  const baseIndent = (m.groups.indent ?? "").length;
  for (let j = i + 1; j < lines.length && j <= i + 4; j += 1) {
    const child = /^\s*(?:text|visible)\s*:(?<rest>.*)$/u.exec(lines[j]);
    if (!child) {
      if (
        /^\s*-\s/u.test(lines[j]) &&
        (lines[j].match(/^\s*/u)[0].length ?? 0) <= baseIndent
      )
        break;
      continue;
    }
    const v = literalOrInterp((child.groups?.rest ?? "").trim());
    if (v != null) return v;
  }
  return null;
}

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
const asPlain = (v) => (isInterp(v) ? v : v.replace(/\.\*$/u, "").trim());

function observes(typed, a) {
  if (a == null) return false;
  if (isInterp(typed)) return a === typed;
  if (isInterp(a)) return false;
  return a.includes(typed);
}

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

const TILE_RE = /(?:Open\s+[A-Z][a-zA-Z]*\s*\.\*|home-tile-[a-z]+)/gu;

const LAUNCHER_WAIT = "AWAIT_LAUNCHER";

export function launcherAwaitFindings(text) {
  const findings = [];
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

export function lintFlowSource(text) {
  const lines = text.split("\n");
  const findings = [];
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

    if (INPUT_CMDS.has(step.cmd) && step.value != null) {
      if (isAllowed(lines, step.i, "unasserted-input")) continue;
      let observed = false;
      for (let t = s + 1; t < steps.length; t += 1) {
        const later = steps[t];
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

if (import.meta.url === `file://${process.argv[1]}`) main();
