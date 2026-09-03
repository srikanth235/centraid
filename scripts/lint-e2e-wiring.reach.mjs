#!/usr/bin/env node

import { readdirSync } from "node:fs";
import path from "node:path";

import { flowsFor, suiteSpec } from "../tests/agent-e2e-mobile/lib/roster.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOBILE_DIR = "tests/agent-e2e-mobile";
const FLOWS_DIR = `${MOBILE_DIR}/flows`;
const ROSTER_PATH = `${MOBILE_DIR}/roster.json`;

export function stripComments(text) {
  return text
    .split("\n")
    .map((line) => {
      const hash = line.indexOf("#");
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join("\n");
}

export function discoverFlows(root = ROOT) {
  return readdirSync(path.resolve(root, FLOWS_DIR))
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
    .sort()
    .map((name) => `${FLOWS_DIR}/${name}`);
}

export function isRunnerPath(rel) {
  return /^tests\/agent-e2e-mobile\/run-[\w.-]+\.mjs$/u.test(rel);
}

export function discoverRunners(root = ROOT) {
  return readdirSync(path.resolve(root, MOBILE_DIR))
    .filter(
      (name) => /^run-.*\.mjs$/u.test(name) && !name.endsWith(".test.mjs")
    )
    .sort()
    .map((name) => `${MOBILE_DIR}/${name}`);
}

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

export function directInvocations(chunk) {
  return [...stripComments(chunk).matchAll(INVOKE_RE)].map((m) => ({
    target: m.groups.target,
    line: lineAt(m.input, m.index),
  }));
}

function lineAt(text, index) {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end);
}

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
        const key = `${target}\u0000${line.trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (target.startsWith(`${FLOWS_DIR}/`)) {
          add(flowLanes, target, laneId);
          continue;
        }
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
