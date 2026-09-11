#!/usr/bin/env node
/**
 * The body of a rolling per-lane issue, when the report cannot supply one (#915).
 *
 * WHY A FALLBACK EXISTS AT ALL. The rolling issue's body is supposed to come
 * from `scripts/test-report/rolling-issue-body.mjs`, rendered from the same
 * attention-queue model as the report's §3, so the issue and the page can never
 * disagree. But the alerting path runs precisely when things are broken — the
 * report job is one of the lanes that can be red, and a red `test-health-report`
 * leaves no `summary.json` to render from. An alerting path that throws when
 * the report is missing is #556 restated: a lane red with no trace anywhere.
 *
 * So this writes the smaller, always-available truth: which lane, what verdict
 * GitHub recorded, whether it is parked and until when, and the run to read.
 * It never invents a case list. A body that says "the report did not render" is
 * information; a body that fabricates cell-level detail is not.
 *
 * Usage:
 *   node scripts/ci/rolling-issue-fallback-body.ts \
 *     --lane mobile-e2e-ios --rung 4 --result failure \
 *     --run-url https://github.com/o/r/actions/runs/1 [--out /tmp/body.md]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
/** Lane parks, merged into the quarantine ledger by #915 Wave 4. */
const QUARANTINE_PATHS = [path.join(root, "tests/quarantine.json")];

export interface LanePark {
  issue?: number;
  expires?: string;
  why?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPark(value: unknown): LanePark | null {
  if (!isRecord(value)) return null;
  const issue = value.issue;
  const expires = value.expires;
  const why = value.why;
  const park: LanePark = {};
  if (typeof issue === "number") park.issue = issue;
  if (typeof expires === "string") park.expires = expires;
  if (typeof why === "string") park.why = why;
  return park;
}

/**
 * The park entry covering a lane, or null.
 *
 * Still takes a LIST of ledgers, in priority order, so a future split needs no
 * second edit; today there is one. An entry whose `expires` has passed is
 * deliberately still returned: an expired park is the loudest thing this body
 * can say, and hiding it would turn a missed deadline into silence.
 */
export function parkFor(
  ledgers: readonly unknown[],
  lane: string
): LanePark | null {
  for (const ledger of ledgers) {
    const lanes =
      isRecord(ledger) && isRecord(ledger.lanes) ? ledger.lanes : {};
    const entry = asPark(lanes[lane]);
    if (entry) return entry;
  }
  return null;
}

export function renderFallbackBody({
  lane,
  rung,
  result,
  runUrl,
  today,
  park,
}: {
  lane: string;
  rung: string | number;
  result: string;
  runUrl: string;
  today: string;
  park: LanePark | null;
}): string {
  const expired = !!(park?.expires && park.expires < today);
  const state = park
    ? expired
      ? `parked until ${park.expires} — **that date has passed**, so this counts as red again`
      : `parked until ${park.expires}`
    : "not parked";
  const lines = [
    `## \`${lane}\` is red on rung ${rung}`,
    "",
    "This issue is **rolling**: its body is rewritten on every red run and never",
    "appended to, so what you read here is the lane's current condition rather",
    "than a thread. Close it when the lane is green.",
    "",
    "| Signal | Value |",
    "| --- | --- |",
    `| Lane | \`${lane}\` |`,
    `| Rung | ${rung} |`,
    `| Tonight's result | \`${result}\` |`,
    `| Park | ${state} |`,
    `| Actions run | ${runUrl} |`,
    `| Updated | ${today} |`,
  ];
  if (park?.issue) lines.push(`| Tracking | #${park.issue} |`);
  lines.push("");
  if (park?.why) {
    lines.push(`**Why it is parked.** ${park.why}`, "");
  }
  lines.push(
    "_The full attention-queue body could not be rendered — the nightly report's",
    "`summary.json` was not available on this run, which usually means the report",
    "lane itself is red. Read the Actions run above; the per-lane evidence files",
    "are in this run's `artifacts/evidence/` uploads._",
    "",
    "Two ways out of a red lane, both deliberate: fix it, or park it in",
    "`tests/quarantine.json#lanes` **with an expiry** and an issue number. A park",
    "is a deadline, never a mute."
  );
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv: string[]): {
  lane: string | null;
  rung: string;
  result: string;
  runUrl: string;
  out: string | null;
} {
  const out = {
    lane: null as string | null,
    rung: "?",
    result: "failure",
    runUrl: "",
    out: null as string | null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];
    if (next === undefined) continue;
    if (current === "--lane") {
      out.lane = next;
      i += 1;
    } else if (current === "--rung") {
      out.rung = next;
      i += 1;
    } else if (current === "--result") {
      out.result = next;
      i += 1;
    } else if (current === "--run-url") {
      out.runUrl = next;
      i += 1;
    } else if (current === "--out") {
      out.out = next;
      i += 1;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.lane) {
    console.error("rolling-issue-fallback-body: --lane <job-id> is required");
    process.exitCode = 2;
    return;
  }
  const ledgers = QUARANTINE_PATHS.filter((p) => existsSync(p)).map((p) => {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    return parsed;
  });
  const body = renderFallbackBody({
    lane: args.lane,
    rung: args.rung,
    result: args.result,
    runUrl: args.runUrl,
    today: new Date().toISOString().slice(0, 10),
    park: parkFor(ledgers, args.lane),
  });
  if (args.out) {
    mkdirSync(path.dirname(path.resolve(root, args.out)), { recursive: true });
    writeFileSync(path.resolve(root, args.out), body);
  } else {
    process.stdout.write(body);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
