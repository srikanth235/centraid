import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await mkdtemp(path.join(os.tmpdir(), "centraid-report-"));
const output = path.join(temp, "index.html");
try {
  const perf = path.join(temp, "perf");
  const playwright = path.join(temp, "playwright");
  const vitest = path.join(temp, "vitest.json");
  const markers = path.join(temp, "lane-starts.json");
  await Promise.all([mkdir(perf), mkdir(playwright)]);
  await writeFile(
    path.join(perf, "stale-vault-write.json"),
    JSON.stringify({
      lane: "perf",
      owner: "tests/perf/vault-write.perf.test.ts",
      name: "stale fixture",
      status: "passed",
      measurements: [],
      history: [{ at: "2000-01-01T00:00:00.000Z", value: 1 }],
    })
  );
  await writeFile(
    path.join(playwright, "desktop-playwright.json"),
    JSON.stringify({
      config: {
        rootDir: path.join(rootForFixture(), "apps/desktop/tests/e2e"),
      },
      stats: { startTime: "2000-01-01T00:00:00.000Z" },
      suites: [
        {
          file: "appview-templates-insights.spec.ts",
          specs: [
            { tests: [{ results: [{ status: "passed", duration: 4_242 }] }] },
          ],
        },
      ],
    })
  );
  await writeFile(
    vitest,
    JSON.stringify({
      startTime: Date.parse("2000-01-01T00:00:00.000Z"),
      testResults: [
        {
          name: "packages/client/src/replica/intents.contract.test.ts",
          status: "passed",
          startTime: Date.parse("2000-01-01T00:00:00.000Z"),
          endTime: Date.parse("2000-01-01T00:00:01.000Z"),
          assertionResults: [],
        },
      ],
    })
  );
  const currentRun = new Date().toISOString();
  await writeFile(
    markers,
    JSON.stringify({
      perf: currentRun,
      vitest: currentRun,
      "desktop-playwright": currentRun,
    })
  );
  execFileSync(
    process.execPath,
    [
      "scripts/test-report/generate.mjs",
      "--output",
      output,
      "--perf",
      perf,
      "--playwright",
      playwright,
      "--vitest",
      vitest,
      "--lane-markers",
      markers,
    ],
    { stdio: "inherit" }
  );
  await access(output);
  const html = await readFile(output, "utf8");
  requireAll(html, [
    "Surface × quality dimension",
    "Coverage vs ratchet floor",
    "Environment-gated",
    // The nine-tile hero that labelled this "unproven cells" is gone (#862).
    // The number is not: it is the verdict bar's grey stat, the same
    // GREY_CELL_STATES tally `summary.cellsMissing` reports. Count and word are
    // pinned in one match — a bar that keeps the word and drops the number says
    // nothing, and the stale stat next to it wears the same class.
    /<span class="vstat grey"><b class="num">\d+<\/b>grey<\/span>/u,
    "product failed",
    "partial passed",
    "evidence unmatched",
    "owner silent",
    // The legend is PAINTED since #864: a chip wears the cell's own classes, so
    // it is the treatment rather than a description of one, and it sits above
    // the grid it glosses. Pinned as a class-and-word pair — a chip that keeps
    // its paint and loses its word is the register going silent again — and on
    // the state whose whole point is that both grids now agree about it.
    '<b class="cell gap">no owner</b>',
    '<b class="cell axis-unowned">no owner</b>',
    '<b class="cell axis-bug">product bug</b>',
    "Scenarios · per-app verb ledger",
    /<ul class="legend" aria-label="Cell register">[\s\S]*<div class="gridwrap">/u,
    "owner.latest.status",
    "duration(owner.latest.duration)",
    "report-data",
    '"status":"stale"',
    "Environment-gated matrix owners",
  ]);
  const summaryJson = path.join(path.dirname(output), "summary.json");
  const summaryMd = path.join(path.dirname(output), "summary.md");
  await access(summaryJson);
  await access(summaryMd);
  const summary = JSON.parse(await readFile(summaryJson, "utf8"));
  if (
    typeof summary.cellsFailed !== "number" ||
    typeof summary.cellsMissing !== "number"
  ) {
    throw new Error("summary.json missing cell honesty fields");
  }
  if (!Array.isArray(summary.coverageBelowFloor)) {
    throw new Error("summary.json missing coverageBelowFloor");
  }
  const md = await readFile(summaryMd, "utf8");
  if (
    !md.includes("Test health") ||
    !md.includes("<!-- centraid-test-health-report -->")
  ) {
    throw new Error("summary.md missing marker or title");
  }
  for (const owner of [
    "apps/desktop/tests/e2e/appview-templates-insights.spec.ts",
    "packages/client/src/replica/intents.contract.test.ts",
  ]) {
    if (!html.includes(`"latest":{"owner":"${owner}","status":"stale"`)) {
      throw new Error(`old green evidence did not turn stale for ${owner}`);
    }
  }

  // Unhandled-error signal: success=false + zero failed assertions (EPIPE class).
  const { extractUnhandledErrors, summarizeCellStates } =
    await import("./report-signals.mjs");
  const unhandled = extractUnhandledErrors({
    success: false,
    unhandledErrors: [{ message: "write EPIPE" }],
    testResults: [
      { status: "passed", assertionResults: [{ status: "passed" }] },
    ],
  });
  if (!unhandled.includes("write EPIPE")) {
    throw new Error("extractUnhandledErrors missed explicit unhandledErrors");
  }
  const cellCounts = summarizeCellStates([
    { state: "failed" },
    { state: "missing" },
    { state: "missing" },
  ]);
  if (cellCounts.cellsFailed !== 1 || cellCounts.cellsMissing !== 2) {
    throw new Error("summarizeCellStates must separate failed from missing");
  }

  const {
    REPORT_COMMENT_MARKER,
    coverageScopesBelowFloor,
    publicReportUrl,
    renderSummaryMarkdown,
  } = await import("./summary-markdown.mjs");
  if (
    publicReportUrl({ owner: "o", repo: "r", slot: "main" }) !==
    "https://o.github.io/r/test-report/main/"
  ) {
    throw new Error("publicReportUrl shape wrong");
  }
  if (
    coverageScopesBelowFloor([{ scope: "x", lines: 10, lineFloor: 20 }]).join(
      ","
    ) !== "x"
  ) {
    throw new Error("coverageScopesBelowFloor missed under-floor scope");
  }
  const summaryMdBody = renderSummaryMarkdown(
    {
      failed: 1,
      unhandledErrors: 0,
      cellsFailed: 0,
      cellsMissing: 0,
      coverageBelowFloor: [],
    },
    { reportUrl: "https://example.test/" }
  );
  if (
    !summaryMdBody.includes(REPORT_COMMENT_MARKER) ||
    !summaryMdBody.includes("https://example.test/")
  ) {
    throw new Error("renderSummaryMarkdown missing marker or URL");
  }
  const noPublicUrl = renderSummaryMarkdown({
    failed: 0,
    unhandledErrors: 0,
    cellsFailed: 0,
    cellsMissing: 0,
    coverageBelowFloor: [],
  });
  if (!noPublicUrl.includes("main (and nightly)")) {
    throw new Error(
      "renderSummaryMarkdown should note main-only public HTML when no reportUrl"
    );
  }

  const badVitest = path.join(temp, "vitest-unhandled.json");
  await writeFile(
    badVitest,
    JSON.stringify({
      success: false,
      startTime: Date.parse(currentRun),
      unhandledErrors: [{ message: "write EPIPE" }],
      testResults: [
        {
          name: "packages/example/x.test.ts",
          status: "passed",
          startTime: Date.parse(currentRun),
          endTime: Date.parse(currentRun) + 5,
          assertionResults: [{ status: "passed" }],
        },
      ],
    })
  );
  const unhandledOut = path.join(temp, "unhandled.html");
  execFileSync(
    process.execPath,
    [
      "scripts/test-report/generate.mjs",
      "--output",
      unhandledOut,
      "--vitest",
      badVitest,
      "--lane-markers",
      markers,
      "--perf",
      perf,
      "--playwright",
      playwright,
    ],
    { stdio: "inherit" }
  );
  const unhandledHtml = await readFile(unhandledOut, "utf8");
  // The other half of the deleted hero: "unhandled errors" was a tile that
  // printed a zero every night. Since #862 the count only renders when there is
  // one to render, so it is pinned against the run that HAS one — banner, count
  // and message in a single match, plus the verdict the count is supposed to
  // drive. A page that banners the errors while still calling itself shippable
  // is the failure the old always-on tile could never catch.
  requireAll(unhandledHtml, [
    /<p class="lede urgent">Unhandled Vitest errors: 1 — [^<]*write EPIPE/u,
    '<div class="verdictbar verdict-red"',
    "1 unhandled error(s)",
  ]);
  console.log("test report smoke: ok");
} finally {
  await rm(temp, { recursive: true, force: true });
}

/**
 * Assert every required fragment is on a rendered page. A `RegExp` entry pins
 * markup whose shape carries the meaning (a count beside the word it is filed
 * under); a string entry pins literal copy.
 * @param {string} page The rendered HTML.
 * @param {(string | RegExp)[]} required Fragments that must be present.
 */
function requireAll(page, required) {
  for (const fragment of required) {
    const present =
      typeof fragment === "string"
        ? page.includes(fragment)
        : fragment.test(page);
    if (!present) throw new Error(`report missing ${fragment}`);
  }
}

function rootForFixture() {
  return path.resolve(import.meta.dirname, "../..");
}
