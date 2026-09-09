// The registries: what the change set did to the documents the law protects
// (#1005).
//
// The generator reads; the rules judge. A rule cannot open a git object, so
// everything a comparison needs is computed once here and lands in the arrival
// record as plain data.
import { readFileSync } from "node:fs";
import path from "node:path";

import { ROOT, git, gitBytes, parseNameStatus } from "./git.mjs";
import { byteCompare } from "./digest.mjs";
import { readPacks } from "../eslint.config.mjs";

/**
 * In-message waivers, from every commit body in the range and from the pending
 * message.
 *
 * The token is `governance: allow-<directive> ...`, optionally inside an HTML
 * comment. `doc-integrity` needs a path and a reason; the others need a reason.
 * A bare token with no reason does not waive - that was true of the shell
 * directives and stays true here.
 *
 * @param {object[]} commits The commits in the range.
 * @param {object|null} pending The pending commit, if any.
 * @returns {{directive: string, path: string|null, reason: string, source: string}[]}
 *   Sorted by (source, directive, path).
 */
export function collectWaivers(commits, pending) {
  const token = /^\s*(?:<!--)?\s*governance:\s*allow-(?<directive>[a-z0-9-]+)\s+(?<rest>.+?)\s*(?:-->)?\s*$/u;
  const waivers = [];
  const scan = (text, source) => {
    for (const line of (text ?? "").split("\n")) {
      const match = token.exec(line);
      if (!match) continue;
      const { directive, rest } = match.groups;
      const fields = rest.split(/\s+/u).filter(Boolean);
      // `doc-integrity` is the one path-scoped waiver: `<path> <reason>`. It
      // needs both fields, so a one-field line is not a waiver at all.
      if (directive === "doc-integrity") {
        if (fields.length < 2) continue;
        waivers.push({ directive, path: fields[0], reason: fields.slice(1).join(" "), source });
      } else {
        waivers.push({ directive, path: null, reason: fields.join(" "), source });
      }
    }
  };
  for (const commit of commits) scan(`${commit.subject}\n${commit.body}`, `commit:${commit.sha}`);
  if (pending) scan(pending.message, "pending");
  return waivers.sort((a, b) =>
    byteCompare(
      `${a.source} ${a.directive} ${a.path ?? ""}`,
      `${b.source} ${b.directive} ${b.path ?? ""}`
    )
  );
}

/**
 * The document-integrity rules a pack declares, as `[mode, target, argument]`.
 *
 * `frozen-files receipts/*.md` is a cross-pack invariant in the shell directive
 * - always restored after the overlay is read - so it is restored here too,
 * whatever a pack says.
 *
 * @returns {{mode: string, target: string, argument: string|null}[]} The rules.
 */
export function documentIntegrityRules() {
  const declared = readPacks().flatMap(
    (pack) => pack.options?.["doc-integrity"]?.rules ?? []
  );
  const rules = [...declared];
  if (!rules.includes("frozen-files receipts/*.md")) rules.push("frozen-files receipts/*.md");
  return rules
    .map((line) => {
      const [mode, target, ...rest] = line.split(/\s+/u).filter(Boolean);
      return { mode, target, argument: rest.length > 0 ? rest.join(" ") : null };
    })
    .sort((a, b) =>
      byteCompare(
        `${a.mode} ${a.target} ${a.argument ?? ""}`,
        `${b.mode} ${b.target} ${b.argument ?? ""}`
      )
    );
}

/**
 * `<mode> <path>` glob matching, with `*` crossing `/`.
 *
 * That is bash's `[[ "$f" == $glob ]]` semantics, which the shell directive
 * used deliberately over git's pathspec wildcards, so `receipts/*.md` covers a
 * nested receipt too.
 *
 * @param {string} glob The pattern.
 * @returns {RegExp} The matcher.
 */
function shellGlob(glob) {
  const body = glob.replace(/[.+^${}()|[\]\\?]/gu, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${body}$`, "u");
}

/**
 * The lines under `## <heading>` (any heading level) of a document.
 *
 * @param {string} text The document.
 * @param {string} heading The heading text.
 * @returns {string[]} The section's lines, in order.
 */
export function extractSection(text, heading) {
  const out = [];
  let inside = false;
  for (const line of text.split("\n")) {
    const match = /^#{1,6}\s+(?<title>.*?)\s*$/u.exec(line);
    if (match) {
      if (match.groups.title === heading) {
        inside = true;
        continue;
      }
      if (inside) inside = false;
      continue;
    }
    if (inside) out.push(line);
  }
  return out;
}

/**
 * The lines under `## <heading>` of a document, stopping only at the next
 * LEVEL-2 heading, matched case-insensitively.
 *
 * The shell pack had two different extractors and the difference is load-
 * bearing: `doc-integrity` stopped at a heading of any level (above), while
 * `receipt-per-issue` read a receipt section through its `###` subheadings.
 * A receipt whose `## Verification` is organised into sub-sections must still
 * have its evidence seen.
 *
 * @param {string} text The document.
 * @param {string} heading The heading text.
 * @returns {string[]} The section's lines, in order.
 */
export function extractReceiptSection(text, heading) {
  const out = [];
  let inside = false;
  for (const line of text.split("\n")) {
    const match = /^##\s+(?<title>.*?)\s*$/u.exec(line);
    if (match) {
      if (inside) break;
      if (match.groups.title.toLowerCase() === heading.toLowerCase()) inside = true;
      continue;
    }
    if (inside) out.push(line);
  }
  return out;
}

/**
 * The frozen-document registry: for every protected path that exists at the
 * baseline, what it was and what it is now.
 *
 * The generator does the reading; the rule does the judging. A rule cannot open
 * a git object, so everything the comparison needs - both blob oids, whether
 * the append-only prefix survived, which frozen-section lines went missing - is
 * computed once, here.
 *
 * @param {object} range The resolved range.
 * @param {boolean} pending Whether the staged tree is the "current" side.
 * @returns {object[]} One row per protected path, sorted by path then mode.
 */
export function collectFrozen(range, pending) {
  // No new work against the trunk means nothing to compare: the shell
  // directive returned green here and so does the record.
  if (!range.hasBase) return [];
  const current = pending ? "" : range.head;
  // Two tree reads, not two per protected path. The receipts corpus alone is
  // hundreds of files, and a `git rev-parse` per file per side cost seconds at
  // the pre-commit rung — the one place this must be cheap.
  const treeOids = (rev) => {
    const rows =
      rev === ""
        ? git(["ls-files", "-s", "-z"])
            .split("\0")
            .filter(Boolean)
            .map((line) => {
              const [meta, file] = line.split("\t");
              return [file, meta.split(" ")[1]];
            })
        : git(["ls-tree", "-r", "-z", rev])
            .split("\0")
            .filter(Boolean)
            .map((line) => {
              const [meta, file] = line.split("\t");
              return [file, meta.split(" ")[2]];
            });
    return new Map(rows);
  };
  const baseOids = treeOids(range.base);
  const currentOids = treeOids(current);
  const shaAt = (rev, file) =>
    (rev === range.base ? baseOids : currentOids).get(file) ?? null;
  const blobAt = (rev, file) => gitBytes(["cat-file", "blob", `${rev}:${file}`]);
  const baseFiles = [...baseOids.keys()];

  const rows = [];
  for (const rule of documentIntegrityRules()) {
    const targets =
      rule.mode === "frozen-files"
        ? baseFiles.filter((file) => shellGlob(rule.target).test(file))
        : [rule.target];
    for (const file of targets) {
      const baseSha = shaAt(range.base, file);
      if (baseSha === null) continue; // absent at the baseline -> not yet frozen
      const headSha = shaAt(current, file);
      const row = {
        path: file,
        mode: rule.mode,
        heading: rule.argument,
        baseSha,
        headSha,
        deleted: headSha === null,
      };
      if (rule.mode === "append-only") {
        let prefixIntact = false;
        if (headSha !== null) {
          const before = blobAt(range.base, file);
          const after = blobAt(current, file);
          prefixIntact =
            after.length >= before.length && before.equals(after.subarray(0, before.length));
        }
        row.appendOnly = { prefixIntact };
      }
      if (rule.mode === "frozen-section") {
        let missingLines = [];
        if (headSha !== null) {
          const present = new Set(
            extractSection(blobAt(current, file).toString("utf8"), rule.argument)
          );
          missingLines = extractSection(
            blobAt(range.base, file).toString("utf8"),
            rule.argument
          )
            .filter((line) => line.replace(/\s/gu, "") !== "")
            .filter((line) => !present.has(line));
        }
        row.section = { missingLines };
      }
      rows.push(row);
    }
  }
  return rows.sort((a, b) => byteCompare(`${a.path} ${a.mode}`, `${b.path} ${b.mode}`));
}

/**
 * The receipt registry: every tracked receipt, which ones this change added,
 * and the shape facts a rule needs to judge them.
 *
 * Uniqueness and filename shape are questions about the whole corpus, which is
 * why they are answered here and not by linting one document: a rule that only
 * ever saw the receipts a change touched could never see a collision with one
 * it did not.
 *
 * @param {object} range The resolved range.
 * @param {object|null} pending The pending commit, if any.
 * @returns {object} The registry.
 */
export function collectReceipts(range, pending) {
  const dir = "receipts";
  const tracked = git(["ls-files", "-z", "--", `${dir}/*.md`]).split("\0").filter(Boolean);
  const addedIn = (args) =>
    new Set(
      git(["diff", "--no-renames", "--diff-filter=A", "--name-only", "-z", ...args, "--", `${dir}/*.md`])
        .split("\0")
        .filter(Boolean)
    );
  const addedInPending = pending ? addedIn(["--cached"]) : new Set();
  const addedInRange = range.hasBase ? addedIn([`${range.base}..${range.head}`]) : new Set();

  const branch = (() => {
    try {
      return git(["rev-parse", "--abbrev-ref", "HEAD"]);
    } catch {
      return "";
    }
  })();
  const onDefaultBranch = branch === "main" || branch === "master";
  const staged = parseNameStatus(git(["diff", "--cached", "-z", "--name-status", "--diff-filter=ACMR"]));
  const hasStaged = staged.length > 0;
  // The shell directive's two completed-change shapes, unchanged: a staged
  // commit being made straight onto the trunk, or a branch whose index is clean
  // and which has work against the trunk (a PR, as CI sees it).
  const completedChange =
    (onDefaultBranch && hasStaged) || (!onDefaultBranch && !hasStaged && range.hasBase);

  const files = tracked.sort(byteCompare).map((file) => {
    let text = "";
    try {
      text = readFileSync(path.join(ROOT, file), "utf8");
    } catch {
      text = "";
    }
    const headings = text
      .split("\n")
      .map((line) => /^##\s+(?<title>.+?)\s*$/u.exec(line)?.groups.title)
      .filter(Boolean);
    const verification = extractReceiptSection(text, "Verification").join("\n");
    const audit = extractReceiptSection(text, "Audit").join("\n");
    return {
      path: file,
      name: file.slice(file.lastIndexOf("/") + 1),
      addedInRange: addedInRange.has(file),
      addedInPending: addedInPending.has(file),
      // A head-of-file waiver exempts one receipt from the whole rule.
      fileWaiver: /governance:\s*allow-receipt-per-issue\s+\S/u.test(
        text.split("\n").slice(0, 10).join("\n").replaceAll("<!--", "").replaceAll("-->", "")
      ),
      headings,
      // A session-only stub is legal on an intermediate commit and never on a
      // completed one.
      stub: headings.length > 0 && headings.every((heading) => heading === "Session" || heading === "Accounting"),
      verification: {
        hasFence: /^\s*```/mu.test(verification),
        hasOutcome:
          /(?:^|\s)(?:pass(?:ed)?|fail(?:ed)?|ok|error|exit\s*[0-9]+|green)(?:\s|$|[.:,])/iu.test(verification),
        hasUrl: /https?:\/\//u.test(verification),
      },
      audit: { hasVerdict: /\b(?:PASS|REFUTED)\b/u.test(audit) },
    };
  });

  return {
    files,
    change: {
      branch,
      onDefaultBranch,
      hasStaged,
      completedChange,
      touchesReceipt: [
        ...(pending ? staged.map((row) => row.path) : []),
        ...(range.hasBase ? arrivalFilesIn(range) : []),
      ].some((file) => /^receipts\/issue-.*\.md$/u.test(file)),
    },
  };
}

/**
 * The change set's paths, for the receipt registry's `touchesReceipt`.
 *
 * @param {object} range The resolved range.
 * @returns {string[]} Paths added, modified, copied or renamed in the range.
 */
function arrivalFilesIn(range) {
  return parseNameStatus(
    git(["diff", "-z", "--name-status", "--diff-filter=ACMR", `${range.base}..${range.head}`])
  ).map((row) => row.path);
}

