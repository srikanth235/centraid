// The registries: what the change set did to the documents the law protects
// (#1005).
//
// The generator reads; the rules judge. A rule cannot open a git object, so
// everything a comparison needs is computed once here and lands in the arrival
// record as plain data.
import { git, gitBytes, parseNameStatus } from "./git.mjs";
import { byteCompare } from "./digest.mjs";
import { readPacks } from "../eslint.config.mjs";

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
 * Every citation in a document: issue numbers and `docs/decisions.md` anchors.
 *
 * @param {string} text The document.
 * @returns {string[]} Sorted, de-duplicated citations.
 */
export function collectCites(text) {
  const cites = new Set();
  for (const match of text.matchAll(/#(?<number>[0-9]{2,7})\b/gu)) {
    cites.add(`#${match.groups.number}`);
  }
  for (const match of text.matchAll(/decisions\.md(?<anchor>#[a-z0-9-]+)/gu)) {
    cites.add(`docs/decisions.md${match.groups.anchor}`);
  }
  return [...cites].sort(byteCompare);
}

/**
 * A ruling id as a receipt writes one: `**R13**`, `**W4-D1**`, `**R-1005-19**`.
 */
const RULING_ID = /\*\*(?<id>R-?[0-9]+(?:-[0-9]+)?|W[0-9]+-D[0-9]+)\*\*/gu;

/**
 * Every ruling a receipt records, with what its paragraph cites.
 *
 * A ruling with no citation is a rule nobody agreed to: the reader cannot find
 * the issue it was argued on or the decisions row it is in force under. The
 * generator only READS — which ids are written, on which line, and which
 * issues or `docs/decisions.md` anchors sit in the same paragraph. Whether
 * that is enough is `doctrine-citation`'s judgement.
 *
 * @param {string} text The receipt.
 * @returns {{id: string, line: number, cites: string[]}[]} The rulings.
 */
export function collectRulings(text) {
  const lines = text.split("\n");
  // A paragraph is the contiguous run of non-blank lines a ruling sits in; in
  // a markdown table one row is one line, which is exactly the granularity a
  // decisions table wants.
  const paragraphs = [];
  let start = 0;
  for (let index = 0; index <= lines.length; index += 1) {
    const blank = index === lines.length || lines[index].trim() === "";
    if (!blank) continue;
    if (index > start) paragraphs.push({ start, lines: lines.slice(start, index) });
    start = index + 1;
  }
  const rulings = [];
  for (const paragraph of paragraphs) {
    for (const [offset, line] of paragraph.lines.entries()) {
      // A table row is its own paragraph for citation purposes: two rulings in
      // one table must not lend each other a citation neither wrote.
      const scope = line.trimStart().startsWith("|") ? [line] : paragraph.lines;
      const cites = new Set();
      for (const scoped of scope) {
        for (const match of scoped.matchAll(/#(?<number>[0-9]{2,7})\b/gu)) {
          cites.add(`#${match.groups.number}`);
        }
        for (const match of scoped.matchAll(
          /decisions\.md(?<anchor>#[a-z0-9-]+)/gu
        )) {
          cites.add(`docs/decisions.md${match.groups.anchor}`);
        }
        for (const match of scoped.matchAll(/\((?<anchor>#[a-z][a-z0-9-]{4,})\)/gu)) {
          cites.add(`docs/decisions.md${match.groups.anchor}`);
        }
      }
      for (const match of line.matchAll(RULING_ID)) {
        rulings.push({
          id: match.groups.id,
          line: paragraph.start + offset + 1,
          cites: [...cites].sort(byteCompare),
        });
      }
    }
  }
  return rulings;
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
 * The corpus is read out of `source` — the range's head, or the index inside
 * the commit hook — never out of the working copy (R-1005-27). A registry that
 * reported whatever was checked out would make the same range say a different
 * thing on every machine, and did: the fixture pinned the branch it was
 * generated on.
 *
 * @param {object} range The resolved range.
 * @param {object|null} pending The pending commit, if any.
 * @param {object} source The tree reader for the side being judged.
 * @returns {object} The registry.
 */
export function collectReceipts(range, pending, source) {
  const dir = "receipts";
  const isReceipt = shellGlob(`${dir}/*.md`);
  const tracked = source.list([dir]).filter((file) => isReceipt.test(file));
  const addedIn = (args) =>
    new Set(
      git(["diff", "--no-renames", "--diff-filter=A", "--name-only", "-z", ...args, "--", `${dir}/*.md`])
        .split("\0")
        .filter(Boolean)
    );
  const addedInPending = pending ? addedIn(["--cached"]) : new Set();
  const addedInRange = range.hasBase ? addedIn([`${range.base}..${range.head}`]) : new Set();

  // The two completed-change shapes, said in terms of the record's own inputs:
  // a commit being written straight onto the trunk, or a branch with work
  // against the trunk and no commit in flight — a PR, as CI sees it. The old
  // reading asked git for the current branch name, which is a fact about the
  // checkout and not about the change (R-1005-27).
  const completed =
    pending === null ? range.hasBase : range.onDefaultBranch === true;

  const staged = pending
    ? parseNameStatus(git(["diff", "--cached", "-z", "--name-status", "--diff-filter=ACMR"]))
    : [];
  const touchedPaths = new Set([
    ...staged.map((row) => row.path),
    ...(range.hasBase ? arrivalFilesIn(range) : []),
  ]);
  const sorted = tracked.sort(byteCompare);
  const blobs = source.read(sorted);
  const files = sorted.map((file) => {
    const bytes = blobs.get(file);
    const text = bytes === null ? "" : bytes.toString("utf8");
    const headings = text
      .split("\n")
      .map((line) => /^##\s+(?<title>.+?)\s*$/u.exec(line)?.groups.title)
      .filter(Boolean);
    const verification = extractReceiptSection(text, "Verification").join("\n");
    const audit = extractReceiptSection(text, "Audit").join("\n");
    const decisions = extractReceiptSection(text, "Decisions").join("\n");
    const cost =
      [...extractReceiptSection(text, "Accounting"), ...extractReceiptSection(text, "Cost")]
        .map((line) => line.trim())
        .find((line) => line !== "") ?? null;
    const issueNumber = /issue-(?<number>[0-9]+)/u.exec(file)?.groups.number;
    return {
      path: file,
      name: file.slice(file.lastIndexOf("/") + 1),
      issue: issueNumber === undefined ? null : Number(issueNumber),
      addedInRange: addedInRange.has(file),
      addedInPending: addedInPending.has(file),
      touched: touchedPaths.has(file),
      // A ruling recorded in a receipt is a decision the adjudication layer
      // must also carry: either a `## Decisions` section with content, or a
      // bold ruling id anywhere in the document (`**R-1005-13**`, `**W2-D1**`).
      // Only for the receipts this change touched: the corpus is 380 files and
      // a rule never judges a receipt nobody opened, so parsing every one of
      // them would grow the record by megabytes to answer nothing.
      rulings: touchedPaths.has(file) ? collectRulings(text) : [],
      // Everything this receipt cites, anywhere in it: the issues it names and
      // the `docs/decisions.md` anchors it links. `doctrine-citation` asks
      // whether a change that touched a doctrine domain said WHY here.
      cites: touchedPaths.has(file) ? collectCites(text) : [],
      recordsRuling:
        decisions.trim() !== "" ||
        /\*\*(?:R-?[0-9]+-[0-9]+|R[0-9]+|W[0-9]+-D[0-9]+)\*\*/u.test(text) ||
        /\bR-[0-9]+-[0-9]+\b/u.test(text),
      // The token cost of the arrival, when the receipt states one. The number
      // is the author's; the law only reports whether it was recorded.
      cost,
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
      completed,
      touchesReceipt: [...touchedPaths].some((file) => /^receipts\/issue-.*\.md$/u.test(file)),
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


/**
 * The lines a change set ADDED to one file, across the range and the index.
 *
 * `-U0` because context lines are not this change's writing, and a rule that
 * accepted them would let a change satisfy the registry by touching a file
 * near somebody else's bullet.
 *
 * @param {object} range The resolved range.
 * @param {boolean} staged Whether an index diff should be included.
 * @param {string} file The repo-relative path.
 * @returns {string[]} The added lines, without their `+`.
 */
function addedLines(range, staged, file) {
  const collect = (args) => {
    let raw = "";
    try {
      raw = git(["diff", "-U0", "--no-color", ...args, "--", file]);
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
  };
  return [
    ...(range.hasBase ? collect([`${range.base}..${range.head}`]) : []),
    ...(staged ? collect(["--cached"]) : []),
  ];
}

/**
 * One adjudication document, and which issues this change cited in it.
 *
 * The registry rules ask "was the ruling written down where rulings live?", so
 * what matters is not that the file was opened but that a line naming the issue
 * was added to it.
 *
 * @param {object} range The resolved range.
 * @param {object|null} pending The pending commit, if any.
 * @param {string} file The repo-relative path.
 * @returns {{path: string, touched: boolean, issues: number[], lines: number}} The row.
 */
export function collectDocument(range, pending, file) {
  const added = addedLines(range, pending !== null, file);
  const issues = new Set();
  for (const line of added) {
    for (const match of line.matchAll(/#(?<number>[0-9]{1,7})\b/gu)) {
      issues.add(Number(match.groups.number));
    }
  }
  return {
    path: file,
    touched: added.length > 0,
    issues: [...issues].sort((a, b) => a - b),
    lines: added.length,
  };
}

/**
 * The docket: the register of standing exceptions to the law.
 *
 * #1005 reserves the path and the docket lane creates the file. Until it
 * exists the register is `exists: false`, which is what lets a rule say
 * "not yet established" instead of "no row found" — the difference between a
 * missing institution and a missing entry.
 *
 * `rowsOnBase` is the ids the docket already carried at the baseline. A row
 * filed and spent in the same arrival is a permission slip an agent wrote
 * itself, and the difference between that and a granted exception is exactly
 * which side of the merge-base the row was on.
 *
* @param {object|null} range The resolved range, for the baseline read.
 * @param {object} source The tree reader for the side being judged.
 * @returns {{path: string, exists: boolean, rows: object[], rowsOnBase: string[]}} The docket.
 */
export function collectDocket(range, source) {
  const file = ".governance/law/docket.json";
  const parse = (text) => {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : (parsed.rows ?? parsed.entries ?? []);
  };
  let rows = [];
  let exists = false;
  const bytes = source.read([file]).get(file);
  if (bytes !== null) {
    try {
      rows = parse(bytes.toString("utf8"));
      exists = true;
    } catch {
      exists = false;
    }
  }
  let rowsOnBase = [];
  if (range?.base) {
    try {
      rowsOnBase = parse(git(["show", `${range.base}:${file}`]))
        .map((row) => row?.id)
        .filter((id) => typeof id === "string")
        .sort(byteCompare);
    } catch {
      rowsOnBase = [];
    }
  }
  return { path: file, exists, rows, rowsOnBase };
}
