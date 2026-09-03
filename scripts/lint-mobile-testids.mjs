#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

import { loadRoster } from "../tests/agent-e2e-mobile/lib/roster.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

const JOURNEY_DIR = "tests/agent-e2e-mobile/flows";
const FLOW_DIRS = [JOURNEY_DIR, "tests/agent-e2e-mobile/lib"];

const SOURCE_DIR = "apps/mobile/src";
const VOCABULARY = "apps/mobile/src/kit/test-ids.ts";

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo"]);
const SKIP_SOURCE = /\.test\.[jt]sx?$|(?:^|\/)test\//u;
const SOURCE_EXT = /\.tsx?$/u;

export function discoverFlowFiles(root = ROOT) {
  const files = [];
  for (const dir of FLOW_DIRS) {
    const abs = path.resolve(root, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs).sort()) {
      if (!name.endsWith(".mjs") || name.endsWith(".test.mjs")) continue;
      files.push(`${dir}/${name}`);
    }
  }
  return files;
}

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

const OPEN_RE =
  /^\s*(?:export const (?<root>\w+) = )?(?<key>\w+)?:?\s*Object\.freeze\(\{\s*$/u;
const ENTRY_RE = /^\s*(?<key>\w+):\s*"(?<value>[^"]+)",?\s*$/u;
const CLOSE_RE = /^\s*\}\),?;?\s*$/u;

export function parseVocabulary(text) {
  const ids = [];
  const prefixes = [];
  const lines = text.split("\n");
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

export function templateLines(text) {
  const out = [];
  let inside = false;
  for (const [index, line] of text.split("\n").entries()) {
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

export function collectFlowIds(text) {
  const found = [];
  let chunks = 0;
  for (const { line, text: body } of templateLines(text)) {
    if (/^\s*---\s*$/u.test(body)) chunks += 1;
    SELECTOR_RE.lastIndex = 0;
    let match;
    while ((match = SELECTOR_RE.exec(body))) {
      const value = match.groups?.dq ?? match.groups?.sq ?? "";
      if (value === "" || value.includes("${")) continue;
      found.push({ id: value, line });
    }
  }
  return { ids: found, chunks };
}

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
      if (crossedStep) break;
      crossedStep = true;
      continue;
    }
    if (!crossedStep && /^\s+\S+\s*:/u.test(raw)) continue;
    break;
  }
  return false;
}

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

if (import.meta.url === `file://${process.argv[1]}`) main();
