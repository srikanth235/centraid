import { glob, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Derivation locks for the two registry blocks report v2 renders from
 * (#839 Wave 5, gaps G13/G15/G16).
 *
 * Grid E (join laws + simulation) and grid G (journeys with budget vs actual)
 * are lists of lanes. A list of lanes that is merely *written down* is the
 * exact failure gap G15 names: the day a lane dies, a hand-maintained list
 * quietly loses a row and the report goes green by subtraction. So neither
 * block is trusted on its own word — every row here is pinned to something
 * outside the matrix that would have to be edited in the same breath:
 *
 *   joinLaws  → the owning suite's own `test(...)` declarations. A declared
 *               law must name a test that exists in its owner file, and the
 *               owner's test COUNT must equal the number of laws declared
 *               against it. Deleting a join law fails this validator; adding
 *               one without declaring it fails it too.
 *
 *   journeys  → the suite runner's own `FLOWS` array and `BUDGET_MS` constant,
 *               plus the flows directory on disk. A suite's declared flow list
 *               must equal its runner's, the declared budget must equal the
 *               runner's ceiling, and the union across suites must equal every
 *               `flows/*.mjs` file that exists. A journey cannot vanish from
 *               the report without failing here first.
 *
 * Pure over an injected `readSource`, so the fail paths are unit-testable
 * without a repo on disk (see `validate-report-registries.test.mjs`).
 */

/** Journey flows live here; the completeness lock enumerates this directory. */
const JOURNEY_FLOW_GLOB = "tests/agent-e2e-mobile/flows/*.mjs";

/**
 * Every `test(...)` / `test.each(...)(...)` / `it(...)` title declared in a
 * suite source, in file order.
 *
 * Deliberately line-anchored rather than a general expression parser: a title
 * is always the first string literal on (or just after) the line that opens
 * the declaration, and anchoring keeps a `test` mentioned inside a comment or
 * a string from counting as a declaration.
 *
 * @param {string} source Suite file contents.
 * @returns {string[]} Declared test titles, in order.
 */
export function declaredTestTitles(source) {
  const lines = String(source ?? "").split("\n");
  const titles = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*(?:test|it)(?:\.each\(|\.for\(|\()/u.test(lines[index])) continue;
    // The title is the first double-quoted literal at or after the opening
    // line; `test(\n  "name",` and `test("name", …)` are both idiomatic here.
    const window = lines.slice(index, index + 3).join("\n");
    const match = /"(?<title>(?:[^"\\]|\\.)*)"/u.exec(window);
    if (match?.groups?.title) titles.push(match.groups.title);
  }
  return titles;
}

/**
 * The `FLOWS` array literal a Maestro suite runner drives, as basenames.
 * @param {string} source Runner file contents.
 * @returns {string[] | null} Flow basenames, or null when no array is found.
 */
export function runnerFlowList(source) {
  // LINE-ANCHORED (#890). The unanchored form matched a runner's own header
  // comment where it explains that its `const FLOWS = [ … ]` array is what the
  // registry derives from — taking the ellipsis as the body and reporting an
  // empty flow list, so a suite would appear to have lost every member because
  // somebody documented it. A declaration is at column zero; a mention is not.
  const match = /^const FLOWS = \[(?<body>[^\]]*)\]/mu.exec(
    String(source ?? "")
  );
  if (!match) return null;
  return [...match.groups.body.matchAll(/"(?<file>[^"]+)"/gu)].map(
    (entry) => entry.groups.file
  );
}

/**
 * The aggregate wall-clock ceiling a Maestro suite runner enforces, in minutes.
 * @param {string} source Runner file contents.
 * @returns {number | null} Minutes, or null when no ceiling is declared.
 */
export function runnerBudgetMinutes(source) {
  const match = /const BUDGET_MS = (?<minutes>[\d_]+) \* 60_000/u.exec(
    String(source ?? "")
  );
  return match ? Number(match.groups.minutes.replaceAll("_", "")) : null;
}

/** Read a repo-relative source, or null when it does not exist. */
function sourceReader(cwd) {
  return (relative) =>
    readFile(path.join(cwd, relative), "utf8").catch(() => null);
}

/**
 * Validate `matrix.joinLaws` against the suites that own the laws.
 * @param {object} matrix Parsed test matrix.
 * @param {(file: string) => string|null} read Pre-loaded source reader.
 * @param {Set<string>} flowIds Every canonical flow id in the matrix.
 * @returns {string[]} Errors; empty means the block is derived.
 */
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
    // The count lock is what makes lane death loud: a law deleted from the
    // suite leaves a declaration behind, and a law added to the suite has no
    // declaration — both land here rather than silently changing grid E.
    if (titles.length !== owned.length) {
      errors.push(
        `${owner} declares ${titles.length} test(s) but joinLaws claims ${owned.length}; grid E would render a stale lane list`
      );
    }
  }
  return errors;
}

/**
 * Validate `matrix.journeys` against the suite runners and the flows on disk.
 * @param {object} matrix Parsed test matrix.
 * @param {(file: string) => string|null} read Pre-loaded source reader.
 * @param {Set<string>} flowIds Every canonical flow id in the matrix.
 * @param {string[]} flowFiles Every journey flow file that exists on disk.
 * @returns {string[]} Errors; empty means the block is derived.
 */
function validateJourneys(matrix, read, flowIds, flowFiles) {
  const errors = [];
  const suites = matrix.journeys?.suites;
  if (!Array.isArray(suites) || !suites.length) {
    return ["matrix has no journeys registry (grid G has nothing to derive)"];
  }
  const flowsById = new Map(
    (matrix.flows ?? []).map((flow) => [flow.id, flow])
  );
  const declaredOwners = new Set();
  const seenSuites = new Set();
  for (const suite of suites) {
    if (seenSuites.has(suite.id))
      errors.push(`duplicate journey suite id ${suite.id}`);
    seenSuites.add(suite.id);
    for (const entry of suite.flows ?? []) {
      if (declaredOwners.has(entry.owner)) {
        errors.push(`journey flow declared twice: ${entry.owner}`);
      }
      declaredOwners.add(entry.owner);
      if (read(entry.owner) == null) {
        errors.push(`journey flow owner does not exist: ${entry.owner}`);
      }
      if (entry.flow == null) continue;
      const flow = flowsById.get(entry.flow);
      if (!flow) {
        errors.push(
          `journey ${suite.id}/${entry.id} references unknown flow ${entry.flow}`
        );
      } else if (flow.owner !== entry.owner) {
        errors.push(
          `journey ${suite.id}/${entry.id} claims flow ${entry.flow}, which is owned by ${flow.owner}`
        );
      }
    }
    if (suite.runner == null) {
      // An unbudgeted suite is an honest state, not an escape hatch: it may
      // not also claim a budget it has no runner to enforce.
      if (suite.budgetMinutes != null || suite.budgetDoc != null) {
        errors.push(
          `journey suite ${suite.id} declares a budget but no runner to enforce it`
        );
      }
      continue;
    }
    const runner = read(suite.runner);
    if (runner == null) {
      errors.push(`journey suite runner does not exist: ${suite.runner}`);
      continue;
    }
    const runnerFlows = runnerFlowList(runner);
    if (runnerFlows) {
      const declared = (suite.flows ?? []).map((entry) =>
        path.posix.basename(entry.owner)
      );
      if (declared.join(",") !== runnerFlows.join(",")) {
        errors.push(
          `journey suite ${suite.id} flow list [${declared.join(", ")}] does not match its runner's [${runnerFlows.join(", ")}]`
        );
      }
    } else {
      errors.push(`journey suite runner declares no FLOWS: ${suite.runner}`);
    }
    const budget = runnerBudgetMinutes(runner);
    if (budget == null) {
      errors.push(
        `journey suite runner declares no BUDGET_MS: ${suite.runner}`
      );
    } else if (budget !== suite.budgetMinutes) {
      errors.push(
        `journey suite ${suite.id} declares a ${suite.budgetMinutes}-minute budget; ${suite.runner} enforces ${budget}`
      );
    }
    if (suite.budgetDoc && read(suite.budgetDoc) == null) {
      errors.push(`journey budget doc does not exist: ${suite.budgetDoc}`);
    }
  }
  // Completeness: every journey on disk owes a row, and no row may name a
  // journey that is gone. This is the zero-grey lock for grid G.
  for (const file of flowFiles) {
    if (!declaredOwners.has(file)) {
      errors.push(
        `journey flow exists on disk but no journeys suite declares it: ${file}`
      );
    }
  }
  return errors;
}

/** Every repo-relative file the two registry blocks name. */
function referencedFiles(matrix) {
  return new Set(
    [
      ...(matrix.joinLaws ?? []).map((law) => law.owner),
      ...(matrix.journeys?.suites ?? []).flatMap((suite) => [
        suite.runner,
        suite.budgetDoc,
        ...(suite.flows ?? []).map((entry) => entry.owner),
      ]),
    ].filter((file) => typeof file === "string")
  );
}

/**
 * Validate both report-v2 registry blocks.
 *
 * Every file the blocks name is read once, in parallel, before any rule runs,
 * so the rules themselves stay synchronous and the whole pass costs one round
 * of I/O — the same shape `matrix-grades.mjs` uses for the same reason.
 *
 * @param {object} matrix Parsed test matrix.
 * @param {object} [options] `root` (repo root) or `readSource` + `flowFiles`.
 * @returns {Promise<string[]>} Errors; empty means both blocks are derived.
 */
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
  return [
    ...validateJoinLaws(matrix, read, flowIds),
    ...validateJourneys(matrix, read, flowIds, flowFiles),
  ];
}
