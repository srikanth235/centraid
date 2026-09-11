#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Open-or-update a tracking issue for a red scheduled lane (#557).
 *
 * Three workflows filed tracking issues with near-identical inline shell —
 * e2e.yml (nightly), extension-e2e.yml (companion), interop-weekly.yml (backup
 * interop). "Near-identical" is the problem: the nightly copy had no
 * `--label` fallback, so on a repo without a `tech-debt` label it would have
 * behaved differently from the other two, and nobody would have known until a
 * nightly went red. Alerting code that only runs when something is already
 * broken has to be the least surprising code in the repo.
 *
 * Usage:
 *   node scripts/ci/file-tracking-issue.ts \
 *     --title '[nightly] lane red — mobile-e2e-ios' \
 *     --search '[nightly] lane red — mobile-e2e-ios' \
 *     --body-file /tmp/body.md \
 *     [--update] [--label tech-debt] [--run-url https://...]
 *
 * TWO MODES, AND THE DIFFERENCE IS THE WHOLE POINT (#915 Wave 0).
 *
 *   default   append a comment to the matching open issue. Right for an event
 *             that happened once — a red canary on ONE commit — where the
 *             history of occurrences is the value.
 *   --update  REPLACE the matching open issue's body. Right for a ROLLING
 *             issue: one issue per lane whose body always states the lane's
 *             current condition. The nightly used to comment on a single
 *             '[nightly] e2e lane red — tracking' issue every morning, which
 *             produced a thread nobody read and thirteen issues closed as
 *             noise. A rolling issue is never re-created and never grows: the
 *             title names the lane, the body is today's answer, and closing it
 *             means the lane is green.
 *
 * `--update` matches by EXACT TITLE, not by the fuzzy `in:title` search, because
 * a search for `lane red — mobile-e2e-ios` also matches
 * `lane red — mobile-e2e-ios-smoke`, and editing the wrong lane's body in place
 * destroys it. The search still narrows the server-side query; the exact match
 * is what picks the issue out of the result.
 *
 * Exits non-zero if the issue could not be filed. That is deliberate: a
 * swallowed `::warning::` here means a red lane with no trace anywhere, which
 * is the exact failure #556 was.
 */
import { readFileSync } from "node:fs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type GhRunner = (args: string[]) => GhResult;

export interface TrackingResult {
  ok: boolean;
  action: string;
  number?: number;
  labelled?: boolean;
  error?: string;
  runUrl?: string;
}

export interface TrackingArgs {
  title: string;
  search: string;
  "body-file": string;
  label?: string;
  "run-url"?: string;
  update?: boolean;
}

/** Parse `--flag value` pairs. Unknown flags are an error, not a silent no-op. */
export function parseArgs(argv: string[]): TrackingArgs {
  const known = new Set(["title", "search", "body-file", "label", "run-url"]);
  const booleans = new Set(["update"]);
  const out: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith("--"))
      throw new Error(`unexpected argument \`${token}\``);
    const key = token.slice(2);
    if (booleans.has(key)) {
      out[key] = true;
      continue;
    }
    if (!known.has(key)) throw new Error(`unknown flag \`--${key}\``);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`--${key} needs a value`);
    out[key] = value;
    index += 1;
  }
  const title = out.title;
  const search = out.search;
  const bodyFile = out["body-file"];
  if (typeof title !== "string" || title.length === 0)
    throw new Error("--title is required");
  if (typeof search !== "string" || search.length === 0)
    throw new Error("--search is required");
  if (typeof bodyFile !== "string" || bodyFile.length === 0)
    throw new Error("--body-file is required");
  const parsed: TrackingArgs = {
    title,
    search,
    "body-file": bodyFile,
  };
  if (typeof out.label === "string") parsed.label = out.label;
  if (typeof out["run-url"] === "string") parsed["run-url"] = out["run-url"];
  if (out.update === true) parsed.update = true;
  return parsed;
}

/**
 * `gh issue list --search` takes a raw search string. Restricting to `in:title`
 * and `--state open` is what keeps a closed issue from being resurrected and a
 * body mention from matching.
 */
export function buildSearchQuery(search: string): string {
  return `in:title ${search}`;
}

/**
 * `gh ... --json number --jq '.[0].number'` prints an empty string for no match
 * and the literal `null` when the array is empty but well-formed. Both mean
 * "nothing found" — treating `"null"` as an issue number is how you end up
 * commenting on issue NaN.
 */
export function parseExistingNumber(
  stdout: string | null | undefined
): number | null {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed || trimmed === "null") return null;
  if (!/^\d+$/u.test(trimmed)) return null;
  return Number(trimmed);
}

/** The open issue whose title is EXACTLY `title`, from a `--json number,title` listing. */
export function findExactTitleNumber(
  stdout: string | null | undefined,
  title: string
): number | null {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    if (isRecord(entry) && entry.title === title) {
      const number = Number(entry.number);
      if (Number.isInteger(number) && number > 0) return number;
    }
  }
  return null;
}

/** Rewrite the matching open issue's body in place, or open it if none is open. */
export function updateTrackingIssue({
  run,
  title,
  search,
  body,
  label,
}: {
  run: GhRunner;
  title: string;
  search: string;
  body: string;
  label?: string;
}): TrackingResult {
  const found = run([
    "issue",
    "list",
    "--search",
    buildSearchQuery(search),
    "--state",
    "open",
    "--limit",
    "50",
    "--json",
    "number,title",
  ]);
  const existing =
    found.status === 0 ? findExactTitleNumber(found.stdout, title) : null;

  if (existing !== null) {
    const edited = run(["issue", "edit", String(existing), "--body", body]);
    if (edited.status !== 0) {
      return {
        ok: false,
        action: "edit",
        number: existing,
        error: edited.stderr,
      };
    }
    return { ok: true, action: "edit", number: existing };
  }
  return createTrackingIssue({ run, title, body, label });
}

/** Open a tracking issue, preferring the labelled form. */
export function createTrackingIssue({
  run,
  title,
  body,
  label,
}: {
  run: GhRunner;
  title: string;
  body: string;
  label?: string;
}): TrackingResult {
  if (label) {
    const labelled = run([
      "issue",
      "create",
      "--title",
      title,
      "--body",
      body,
      "--label",
      label,
    ]);
    if (labelled.status === 0)
      return { ok: true, action: "create", labelled: true };
  }
  const plain = run(["issue", "create", "--title", title, "--body", body]);
  if (plain.status !== 0) {
    return { ok: false, action: "create", error: plain.stderr };
  }
  return { ok: true, action: "create", labelled: false };
}

/** Comment on the matching open issue, or open a new one. */
export function fileTrackingIssue({
  run,
  title,
  search,
  body,
  label,
  runUrl,
}: {
  run: GhRunner;
  title: string;
  search: string;
  body: string;
  label?: string;
  runUrl?: string;
}): TrackingResult {
  const found = run([
    "issue",
    "list",
    "--search",
    buildSearchQuery(search),
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[0].number",
  ]);
  const existing =
    found.status === 0 ? parseExistingNumber(found.stdout) : null;

  if (existing !== null) {
    const commented = run([
      "issue",
      "comment",
      String(existing),
      "--body",
      body,
    ]);
    if (commented.status !== 0) {
      return {
        ok: false,
        action: "comment",
        number: existing,
        error: commented.stderr,
      };
    }
    return { ok: true, action: "comment", number: existing };
  }

  const created = createTrackingIssue({ run, title, body, label });
  return created.ok ? created : { ...created, runUrl };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const body = readFileSync(args["body-file"], "utf8");
  const run: GhRunner = (argv) => {
    const result = spawnSync("gh", argv, { encoding: "utf8" });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };

  const result = args.update
    ? updateTrackingIssue({
        run,
        title: args.title,
        search: args.search,
        body,
        label: args.label,
      })
    : fileTrackingIssue({
        run,
        title: args.title,
        search: args.search,
        body,
        label: args.label,
        runUrl: args["run-url"],
      });

  if (!result.ok) {
    const where = result.number ? ` #${result.number}` : "";
    console.error(
      `::error::Failed to ${result.action} tracking issue${where} — run ${args["run-url"] ?? "(unknown)"}`
    );
    if (result.error) console.error(result.error);
    process.exitCode = 1;
    return;
  }
  if (result.action === "comment" || result.action === "edit")
    console.log(
      `${result.action === "edit" ? "Rewrote" : "Commented on"} issue #${result.number}`
    );
  else
    console.log(
      `Opened tracking issue${result.labelled ? " (labelled)" : " (unlabelled fallback)"}`
    );
}

if (process.argv[1] && process.argv[1].endsWith("file-tracking-issue.ts")) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message}`);
    process.exitCode = 1;
  }
}
