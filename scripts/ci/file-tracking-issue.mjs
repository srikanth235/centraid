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
 *   node scripts/ci/file-tracking-issue.mjs \
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

/** Parse `--flag value` pairs. Unknown flags are an error, not a silent no-op. */
export function parseArgs(argv) {
  const known = new Set(["title", "search", "body-file", "label", "run-url"]);
  const booleans = new Set(["update"]);
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
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
  for (const required of ["title", "search", "body-file"]) {
    if (!out[required]) throw new Error(`--${required} is required`);
  }
  return out;
}

/**
 * `gh issue list --search` takes a raw search string. Restricting to `in:title`
 * and `--state open` is what keeps a closed issue from being resurrected and a
 * body mention from matching.
 */
export function buildSearchQuery(search) {
  return `in:title ${search}`;
}

/**
 * `gh ... --json number --jq '.[0].number'` prints an empty string for no match
 * and the literal `null` when the array is empty but well-formed. Both mean
 * "nothing found" — treating `"null"` as an issue number is how you end up
 * commenting on issue NaN.
 */
export function parseExistingNumber(stdout) {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed || trimmed === "null") return null;
  if (!/^\d+$/u.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * The open issue whose title is EXACTLY `title`, from a `--json number,title`
 * listing.
 *
 * `gh issue list --search 'in:title X'` is a full-text query: it matches word
 * stems, ignores punctuation, and happily returns `… — mobile-e2e-ios-smoke`
 * for a search naming `mobile-e2e-ios`. In comment mode a near-match costs one
 * misplaced comment; in `--update` mode it OVERWRITES another lane's issue
 * body, so the exact match is a correctness requirement rather than tidiness.
 *
 * @param {string} stdout Raw stdout of `gh issue list --json number,title`.
 * @param {string} title The title to match exactly.
 * @returns {number|null} The issue number, or null when nothing matches.
 */
export function findExactTitleNumber(stdout, title) {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    if (entry && typeof entry === "object" && entry.title === title) {
      const number = Number(entry.number);
      if (Number.isInteger(number) && number > 0) return number;
    }
  }
  return null;
}

/**
 * Rewrite the matching open issue's body in place, or open it if none is open.
 *
 * Never re-creates: an issue that exists is edited, so the lane has exactly one
 * rolling issue for as long as it is red and the URL in yesterday's report
 * still resolves to today's state.
 *
 * @param {object} options Title/search/body plus the injected `gh` runner.
 * @param {(args: string[]) => {status: number|null, stdout: string, stderr: string}} options.run Invokes `gh` with the given argv.
 * @returns {{ok: boolean, action: string, number?: number, labelled?: boolean, error?: string}} What happened.
 */
export function updateTrackingIssue({ run, title, search, body, label }) {
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

/**
 * Open a tracking issue, preferring the labelled form.
 *
 * Split out of `fileTrackingIssue` so `--update` shares the exact same
 * create-with-label-fallback path: a repo without the label must still get the
 * issue, because losing the alert is worse than losing the label.
 *
 * @param {object} options Title/body/label plus the injected `gh` runner.
 * @param {(args: string[]) => {status: number|null, stdout: string, stderr: string}} options.run Invokes `gh` with the given argv.
 * @returns {{ok: boolean, action: string, labelled?: boolean, error?: string}} What happened.
 */
export function createTrackingIssue({ run, title, body, label }) {
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

/**
 * Comment on the matching open issue, or open a new one.
 *
 * @param {object} options Title/search/body plus the injected `gh` runner.
 * @param {(args: string[]) => {status: number|null, stdout: string, stderr: string}} options.run
 *   Invokes `gh` with the given argv. Injected so the whole decision tree is
 *   testable without a network or a repo.
 */
export function fileTrackingIssue({ run, title, search, body, label, runUrl }) {
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

  // Label first; a repo without that label must still get the issue, so fall
  // back to an unlabelled create rather than losing the alert.
  const created = createTrackingIssue({ run, title, body, label });
  return created.ok ? created : { ...created, runUrl };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const body = readFileSync(args["body-file"], "utf8");
  const run = (argv) => {
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

if (process.argv[1] && process.argv[1].endsWith("file-tracking-issue.mjs")) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
