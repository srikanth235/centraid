import { glob, readFile } from "node:fs/promises";
import path from "node:path";

import { loadRoster, readSuiteRunners } from "./derive.mjs";

const JOURNEY_FLOW_GLOB = "tests/agent-e2e-mobile/flows/*.mjs";

export function declaredTestTitles(source) {
  const lines = String(source ?? "").split("\n");
  const titles = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*(?:test|it)(?:\.each\(|\.for\(|\()/u.test(lines[index])) continue;
    const window = lines.slice(index, index + 3).join("\n");
    const match = /"(?<title>(?:[^"\\]|\\.)*)"/u.exec(window);
    if (match?.groups?.title) titles.push(match.groups.title);
  }
  return titles;
}

export function runnerFlowList(source) {
  const match = /^const FLOWS = \[(?<body>[^\]]*)\]/mu.exec(
    String(source ?? "")
  );
  if (!match) return null;
  return [...match.groups.body.matchAll(/"(?<file>[^"]+)"/gu)].map(
    (entry) => entry.groups.file
  );
}

export function runnerBudgetMinutes(source) {
  const match = /const BUDGET_MS = (?<minutes>[\d_]+) \* 60_000/u.exec(
    String(source ?? "")
  );
  return match ? Number(match.groups.minutes.replaceAll("_", "")) : null;
}

function sourceReader(cwd) {
  return (relative) =>
    readFile(path.join(cwd, relative), "utf8").catch(() => null);
}

function validateJoinLaws(matrix, read, flowIds) {
  const errors = [];
  const laws = matrix.joinLaws;
  if (!Array.isArray(laws) || !laws.length) {
    return ["matrix has no joinLaws registry (grid E has nothing to derive)"];
  }
  const seatIds = new Set((matrix.seats ?? []).map((seat) => seat.id));
  const seen = new Set();
  const byOwner = new Map();
  for (const law of laws) {
    if (seen.has(law.id)) errors.push(`duplicate join law id ${law.id}`);
    seen.add(law.id);
    if (law.flow != null && !flowIds.has(law.flow)) {
      errors.push(`join law ${law.id} references unknown flow ${law.flow}`);
    }
    for (const seat of law.seats ?? []) {
      if (!seatIds.has(seat))
        errors.push(`join law ${law.id} references unknown seat ${seat}`);
    }
    if (!byOwner.has(law.owner)) byOwner.set(law.owner, []);
    byOwner.get(law.owner).push(law);
  }
  if (!laws.some((law) => law.kind === "scripted")) {
    errors.push("joinLaws declares no scripted law (grid E's left half)");
  }
  if (!laws.some((law) => law.kind === "simulation")) {
    errors.push("joinLaws declares no simulation law (grid E's right half)");
  }
  for (const [owner, owned] of byOwner) {
    const source = read(owner);
    if (source == null) {
      errors.push(`join law owner does not exist: ${owner}`);
      continue;
    }
    const titles = declaredTestTitles(source);
    for (const law of owned) {
      if (!titles.includes(law.testName)) {
        errors.push(
          `join law ${law.id} names a test its owner does not declare: "${law.testName}" in ${owner}`
        );
      }
    }
    if (titles.length !== owned.length) {
      errors.push(
        `${owner} declares ${titles.length} test(s) but joinLaws claims ${owned.length}; grid E would render a stale lane list`
      );
    }
  }
  return errors;
}

function validateJourneyCompleteness(suites, flowFiles, roster) {
  const errors = [];
  if (suites.length === 0) {
    return ["the roster declares no suites (§5 would render empty)"];
  }
  const scheduled = new Set();
  const seenSuites = new Set();
  for (const suite of suites) {
    if (seenSuites.has(suite.id)) errors.push(`duplicate suite id ${suite.id}`);
    seenSuites.add(suite.id);
    if (suite.budgetMs == null) {
      errors.push(`roster suite ${suite.id} declares no budgetMs`);
    }
    for (const file of suite.flows) {
      scheduled.add(`tests/agent-e2e-mobile/flows/${file}`);
    }
  }
  for (const file of flowFiles) {
    if (scheduled.has(file)) continue;
    const status = roster.flows?.[file]?.status;
    if (status && status !== "scheduled") continue;
    errors.push(
      `journey flow exists on disk and the roster calls it scheduled, but no roster suite schedules it: ${file}`
    );
  }
  for (const file of scheduled) {
    if (!flowFiles.includes(file)) {
      errors.push(
        `a roster suite schedules ${file}, which does not exist on disk`
      );
    }
  }
  return errors;
}

function referencedFiles(matrix) {
  return new Set(
    (matrix.joinLaws ?? [])
      .map((law) => law.owner)
      .filter((file) => typeof file === "string")
  );
}

export async function validateReportRegistries(matrix, options = {}) {
  const cwd = options.root ?? process.cwd();
  const readSource = options.readSource ?? sourceReader(cwd);
  const wanted = [...referencedFiles(matrix)];
  const [sources, discovered] = await Promise.all([
    Promise.all(wanted.map((file) => readSource(file))),
    options.flowFiles
      ? Promise.resolve(options.flowFiles)
      : Array.fromAsync(glob(JOURNEY_FLOW_GLOB, { cwd })),
  ]);
  const loaded = new Map(wanted.map((file, index) => [file, sources[index]]));
  const read = (file) => loaded.get(file) ?? null;
  const flowFiles = discovered.map((file) => file.replaceAll("\\", "/")).sort();
  const flowIds = new Set((matrix.flows ?? []).map((flow) => flow.id));
  const suites = options.suites ?? readSuiteRunners();
  const roster = options.roster ?? (await loadRoster());
  return [
    ...validateJoinLaws(matrix, read, flowIds),
    ...validateJourneyCompleteness(suites, flowFiles, roster),
  ];
}
