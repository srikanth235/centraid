#!/usr/bin/env node
// THE REACHABILITY HALF of the mobile e2e wiring linter (#890 W0, #915 Wave 2).
//
// Split out of `scripts/lint-e2e-wiring.mjs`, which crossed the repo's god-file
// ceiling when Wave 2 taught it to resolve a rung/platform selector through the
// roster. The SHAPE of the split follows `lint-e2e-wiring.cases.mjs`'s: the
// parsers move, the rule engine and its self-test stay, and every function here
// is re-exported from the linter so its unit spec and any other caller import
// from one place.
//
// Everything in this file answers ONE question: given the shipped workflow YAML
// and the shipped shell scripts, which journeys does each declared lane
// actually run? It is derived, never hand-kept — a hand-kept list is the thing
// that drifted and made this linter necessary.

import { readdirSync } from "node:fs";
import path from "node:path";

import { flowsFor, suiteSpec } from "../tests/agent-e2e-mobile/lib/roster.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOBILE_DIR = "tests/agent-e2e-mobile";
const FLOWS_DIR = `${MOBILE_DIR}/flows`;
const ROSTER_PATH = `${MOBILE_DIR}/roster.json`;

/** Strip `#` comments from a YAML or shell source so prose cannot count as
 * wiring. A `#` inside a quoted string is not a comment, but no invocation line
 * in these files puts one there, and treating it as one would only ever make
 * this linter STRICTER (it would see fewer invocations and fail louder). */
export function stripComments(text) {
  return text
    .split("\n")
    .map((line) => {
      const hash = line.indexOf("#");
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join("\n");
}

/** Every `.mjs` flow file on disk, repo-relative. Discovered, never listed. */
export function discoverFlows(root = ROOT) {
  return readdirSync(path.resolve(root, FLOWS_DIR))
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
    .sort()
    .map((name) => `${FLOWS_DIR}/${name}`);
}

/** Is `rel` a suite runner — `run-*.mjs` at the mobile directory ROOT? The
 * shape is the contract: a runner sits beside `flows/`, declares one `FLOWS`
 * array, and schedules journeys. Anything under `lib/` is machinery a lane may
 * legitimately `node`-run (the CI gateway and its readiness probe) and owes no
 * roster. */
export function isRunnerPath(rel) {
  return /^tests\/agent-e2e-mobile\/run-[\w.-]+\.mjs$/u.test(rel);
}

/** Every `run-*-suite.mjs` runner on disk, repo-relative. */
export function discoverRunners(root = ROOT) {
  return readdirSync(path.resolve(root, MOBILE_DIR))
    .filter(
      (name) => /^run-.*\.mjs$/u.test(name) && !name.endsWith(".test.mjs")
    )
    .sort()
    .map((name) => `${MOBILE_DIR}/${name}`);
}

/**
 * The block of a workflow YAML belonging to one job key. Jobs sit at two-space
 * indent under `jobs:`; the block runs to the next two-space key. Text-level,
 * like scripts/test-report/validate-nightly-wiring.mjs, because the shipped YAML
 * is the artifact under test and a YAML parser would let a `!!merge` or an
 * anchor hide an invocation this must see.
 */
export function jobBlock(yaml, job) {
  const lines = yaml.split("\n");
  const start = lines.indexOf(`  ${job}:`);
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/u.test(lines[i])) return lines.slice(start, i).join("\n");
  }
  return lines.slice(start).join("\n");
}

const INVOKE_RE =
  /\bnode\s+(?:--[\w-]+(?:=\S+)?\s+)*(?<target>tests\/agent-e2e-mobile\/[\w./-]+\.mjs)/gu;

/** Direct `node tests/agent-e2e-mobile/*.mjs` invocations in a source chunk,
 * each with THE WHOLE LINE it appeared on. The line is what carries
 * `--rung/--platform/--suite`, and #915 Wave 2 made those flags the wiring: a
 * target alone can no longer say what a lane schedules. */
export function directInvocations(chunk) {
  return [...stripComments(chunk).matchAll(INVOKE_RE)].map((m) => ({
    target: m.groups.target,
    line: lineAt(m.input, m.index),
  }));
}

/** The whole line an index falls on. */
function lineAt(text, index) {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end);
}

/** The selector an invocation carries, when it is a roster invocation.
 *
 * `node tests/agent-e2e-mobile/run-roster.mjs --rung 4 --platform android`
 * — flags on the invocation line itself, which is what makes the wiring
 * readable by a text-scanning gate (see this file's header).
 */
export function invocationSelector(line) {
  const rung = /--rung\s+(?<rung>\d+)/u.exec(line);
  const platform = /--platform\s+(?<platform>[\w-]+)/u.exec(line);
  const suite = /--suite\s+(?<suite>[\w.-]+)/u.exec(line);
  if (!rung || !platform) return undefined;
  return {
    rung: Number(rung.groups.rung),
    platform: platform.groups.platform,
    ...(suite ? { suite: suite.groups.suite } : {}),
  };
}

/** The selector a compatibility shim executes.
 *
 * A shim is one `resolvePlan({ rung, platform, suite })` call and nothing else,
 * so this reads the call rather than the file name: `run-probes-suite.mjs`
 * carries suite `probes-suite` while `run-pr-gate-suite.mjs` carries `pr-gate`,
 * and a linter that guessed from the name would be guessing about the one thing
 * it exists to check. Line-anchored for the same reason `runnerMembers` was: a
 * mention of the call in a header comment is never at column zero.
 */
export function shimSelector(source) {
  const call =
    /^\s*resolvePlan\(\{\s*rung:\s*(?<rung>\d+),\s*platform:\s*"(?<platform>[\w-]+)",\s*suite:\s*"(?<suite>[\w.-]+)"/mu.exec(
      source
    );
  if (!call?.groups) return undefined;
  return {
    rung: Number(call.groups.rung),
    platform: call.groups.platform,
    suite: call.groups.suite,
  };
}

/**
 * The journeys a runner invocation schedules, resolved through the roster.
 *
 * A runner whose selector this cannot read is a FAILURE at the call site, not
 * an empty result — an unreadable runner would silently unschedule its members,
 * which is the exact defect this linter exists to catch.
 */
export function runnerMembers(source, runnerRel, line, roster) {
  const selector =
    (runnerRel.endsWith("/run-roster.mjs")
      ? invocationSelector(line ?? "")
      : shimSelector(source)) ?? shimSelector(source);
  if (!selector) {
    throw new Error(
      `${runnerRel} carries no readable rung/platform selector; the wiring linter ` +
        `cannot tell which journeys it runs. Invoke run-roster.mjs with ` +
        `\`--rung <n> --platform <p> [--suite <s>]\`, or keep a shim whose only ` +
        `statement is \`resolvePlan({ rung, platform, suite })\`.`
    );
  }
  if (selector.suite && !suiteSpec(selector.suite, roster)) {
    throw new Error(
      `${runnerRel} selects suite "${selector.suite}", which ${ROSTER_PATH} does not declare.`
    );
  }
  const members = flowsFor({ ...selector, roster });
  if (members.length === 0) {
    throw new Error(
      `${runnerRel} selects rung ${selector.rung} / ${selector.platform}` +
        `${selector.suite ? ` / ${selector.suite}` : ""}, which the roster resolves to ` +
        `zero journeys. A lane that schedules nothing reads exactly like a lane that passed.`
    );
  }
  return members.map((member) => member.path);
}

/**
 * Resolve every flow each declared lane reaches, transitively through runners.
 *
 * @param lanes roster `lanes` map: id → `{ workflow, job, script?, blocking }`
 * @param readFile `(relPath) => string`
 * @returns `Map<flowRel, Set<laneId>>` plus `Map<runnerRel, Set<laneId>>`
 */
export function resolveReach(lanes, readFile, roster) {
  const flowLanes = new Map();
  const runnerLanes = new Map();
  const add = (map, key, lane) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(lane);
  };

  for (const [laneId, lane] of Object.entries(lanes)) {
    const yaml = readFile(lane.workflow);
    const block = jobBlock(yaml, lane.job);
    if (block == null) {
      throw new Error(
        `lane ${laneId} declares job "${lane.job}" in ${lane.workflow}, which has no such job key`
      );
    }
    // A lane may hand its body to a committed script (the Android emulator
    // action executes `bash apps/mobile/scripts/android-emulator-roster.sh`),
    // in which case the invocations live there, not in the YAML. This is also
    // why the two Android lane shapes are two scripts rather than one script
    // with a suite switch — a script holding every branch would make every lane
    // look like it runs every journey.
    const chunks = [block];
    for (const script of lane.scripts ?? []) {
      if (!block.includes(script)) {
        throw new Error(
          `lane ${laneId} declares script ${script}, which its ${lane.job} job never runs`
        );
      }
      chunks.push(readFile(script));
    }
    const seen = new Set();
    const walk = (chunk) => {
      for (const { target, line } of directInvocations(chunk)) {
        // Keyed on target AND selector: one lane may invoke `run-roster.mjs`
        // twice with two rungs, and de-duping on the path alone would drop the
        // second set of journeys on the floor.
        const key = `${target}\u0000${line.trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (target.startsWith(`${FLOWS_DIR}/`)) {
          add(flowLanes, target, laneId);
          continue;
        }
        // Only a `run-*.mjs` suite runner at the directory root schedules
        // journeys. Everything else a lane node-runs from this tree is
        // machinery, not a roster member — `lib/ci-gateway.mjs` and
        // `lib/ci-gateway-ready.mjs` are the two today — and treating machinery
        // as a runner would demand a selector it has no reason to own.
        if (!isRunnerPath(target)) continue;
        add(runnerLanes, target, laneId);
        for (const member of runnerMembers(
          readFile(target),
          target,
          line,
          roster
        )) {
          add(flowLanes, member, laneId);
        }
      }
    };
    for (const chunk of chunks) walk(chunk);
  }
  return { flowLanes, runnerLanes };
}
