// Waivers: every place the law lets somebody write down an exception (#1005).
//
// A waiver is the one construct that makes a rule not apply, so an exception
// nobody can enumerate is not an exception but a hole. Three places one can be
// written — a commit body, a comment on a line the change added, an
// `eslint-disable` directive in a governance document — are read here, by one
// collector, into one list with one shape, which `waiver-docket` then holds
// against the register of standing exceptions.
import { git } from "./git.mjs";
import { byteCompare, globToRegExp } from "./digest.mjs";
import { DOCUMENT_PATTERNS } from "../eslint.config.mjs";

/**
 * A `governance: allow-<directive>` token, wherever one is written.
 *
 * `rest` is only the tail of the FIRST line; a reason that runs on is
 * assembled by the caller, which is the whole point of parsing paragraphs
 * rather than lines.
 */
const WAIVER_TOKEN =
  /^\s*(?:<!--\s*)?governance:\s*allow-(?<directive>[a-z0-9-]+)\s*(?<rest>.*?)\s*(?:-->)?\s*$/u;

/**
 * The same token, written inside a source comment rather than in a message.
 *
 * The comment form is required, and a line carrying a backtick is refused: a
 * document that QUOTES the token — every constitution section does — must not
 * register a waiver nobody spent.
 */
const IN_FILE_TOKEN =
  /^\s*(?:\/\/|\/\*|\*|#|<!--)\s*governance:\s*allow-(?<directive>[a-z0-9-]+)\s*(?<rest>.*?)\s*(?:\*\/|-->)?\s*$/u;

/** A git trailer, which ends a commit body's last paragraph. */
const TRAILER = /^[A-Z][A-Za-z-]*(?:-[A-Za-z]+)*:\s/u;

/**
 * An `eslint-disable*` directive and its ESLint description.
 *
 * ESLint's own suppression syntax is the law's waiver primitive for the
 * document rules, so nothing here re-implements one: the rule list and the
 * `--` description are read exactly as ESLint reads them.
 */
const DISABLE =
  /^\s*(?:\/\/|\/\*|\*|#|<!--)\s*eslint-disable(?:-next-line|-line)?(?<rest>[^\n]*)$/u;

/**
 * The documents whose suppressions are waivers.
 *
 * A source file's `eslint-disable` answers to oxlint or to the product's own
 * config and is not an exception to THIS law; only the governance documents
 * the law lints are read here.
 */
const DOCUMENTS = DOCUMENT_PATTERNS.map(globToRegExp);

/**
 * Strip a comment's closing delimiter from a reason.
 *
 * @param {string} text The raw tail.
 * @returns {string} The reason.
 */
function closeComment(text) {
  return text.replace(/\s*(?:\*\/|-->)\s*$/u, "").trim();
}

/**
 * Read one `governance: allow-*` line and everything its reason runs onto.
 *
 * A reason is a PARAGRAPH, not a line. The first parser stopped at the newline
 * and the front page printed half a sentence ("the law's test roster lived in
 * the"), which is worse than no reason at all: it reads as a complete thought
 * and is not one.
 *
 * @param {string[]} lines The document's lines.
 * @param {number} index The line the token was found on.
 * @param {string} rest The tail of that line.
 * @returns {{reason: string, next: number}} The reason and where to resume.
 */
function readReason(lines, index, rest) {
  const parts = [closeComment(rest)];
  let cursor = index + 1;
  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.trim() === "") break;
    if (TRAILER.test(line)) break;
    if (WAIVER_TOKEN.test(line)) break;
    parts.push(closeComment(line.trim()));
  }
  return { reason: parts.filter(Boolean).join(" ").trim(), next: cursor };
}

/**
 * The waiver rows one text contributes.
 *
 * @param {string} text The message or document.
 * @param {string} source Where it came from, for the audit trail.
 * @param {object} [options] `inFile` selects the comment-form token.
 * @returns {object[]} The rows, unsorted.
 */
function waiversIn(text, source, options = {}) {
  const token = options.inFile ? IN_FILE_TOKEN : WAIVER_TOKEN;
  const lines = (text ?? "").split("\n");
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (options.inFile && lines[index].includes("`")) continue;
    const match = token.exec(lines[index]);
    if (!match) continue;
    const { directive } = match.groups;
    // A single-line comment cannot run on: the next line is somebody else's
    // code, not the rest of the sentence.
    const read = options.inFile
      ? { reason: closeComment(match.groups.rest), next: index }
      : readReason(lines, index, match.groups.rest);
    index = read.next - (options.inFile ? 0 : 1);
    // `doc-integrity` is the one path-scoped waiver: `<path> <reason>`. It
    // needs both fields, so a one-field line is not a waiver at all.
    if (directive === "doc-integrity" && !options.inFile) {
      const fields = read.reason.split(/\s+/u).filter(Boolean);
      if (fields.length < 2) continue;
      rows.push({
        directive,
        path: fields[0],
        reason: fields.slice(1).join(" "),
        source,
        docket: null,
      });
      continue;
    }
    rows.push({
      directive,
      path: options.path ?? null,
      reason: read.reason,
      source,
      docket: /\bdocket:(?<id>D-[0-9]+)\b/u.exec(read.reason)?.groups.id ?? null,
    });
  }
  return rows;
}

/**
 * The `eslint-disable*` directives one added line carries.
 *
 * @param {string} line The added line.
 * @param {string} file The document it was added to.
 * @returns {object[]} One row per rule the directive names.
 */
function disablesIn(line, file) {
  // A line quoting the directive — every constitution section does — is prose,
  // not a suppression.
  if (line.includes("`")) return [];
  if (!DOCUMENTS.some((matcher) => matcher.test(file))) return [];
  const match = DISABLE.exec(line);
  if (!match) return [];
  const rest = match.groups.rest.replace(/\s*(?:\*\/|-->)\s*$/u, "");
  const [named, ...description] = rest.split(/\s--\s/u);
  const reason = description.join(" -- ").trim();
  const docket = /\bdocket:(?<id>D-[0-9]+)\b/u.exec(reason)?.groups.id ?? null;
  const rules = named
    .split(",")
    .map((entry) => entry.trim().replace(/^law\//u, ""))
    .filter(Boolean);
  return (rules.length > 0 ? rules : ["*"]).map((directive) => ({
    directive,
    path: file,
    reason,
    source: `disable:${file}`,
    docket,
  }));
}

/**
 * The lines a change set ADDED, per file, in ONE diff per side.
 *
 * One `git diff` for the range and one for the index, rather than one per
 * file: #1002's squash carries 1022 paths and a call apiece is the difference
 * between a generator that fits the pre-commit rung and one that does not.
 *
 * @param {object} range The resolved range.
 * @param {boolean} staged Whether the index is included.
 * @returns {Map<string, string[]>} path → added lines, without their `+`.
 */
export function addedLinesByFile(range, staged) {
  const out = new Map();
  const absorb = (raw) => {
    let file = null;
    for (const line of raw.split("\n")) {
      if (line.startsWith("+++ ")) {
        const target = line.slice(4).trim();
        file = target === "/dev/null" ? null : target.replace(/^b\//u, "");
        if (file !== null && !out.has(file)) out.set(file, []);
        continue;
      }
      if (file === null || !line.startsWith("+") || line.startsWith("+++")) continue;
      out.get(file).push(line.slice(1));
    }
  };
  const read = (args) => {
    try {
      return git(["diff", "-U0", "--no-color", "--no-renames", ...args]);
    } catch {
      return "";
    }
  };
  if (range.hasBase) absorb(read([`${range.base}..${range.head}`]));
  if (staged) absorb(read(["--cached"]));
  return out;
}

/**
 * The waivers written INTO files, from the lines a change added.
 *
 * Separate from the message half so a test can drive it with lines rather
 * than with a git range: what a comment means is not a question about git.
 *
 * @param {Iterable<[string, string[]]>} entries path → added lines.
 * @returns {object[]} The rows, sorted as `collectWaivers` sorts.
 */
export function collectWaiversFromLines(entries) {
  const rows = [];
  for (const [file, lines] of entries) {
    for (const line of lines) {
      rows.push(
        ...waiversIn(line, `file:${file}`, { inFile: true, path: file }),
        ...disablesIn(line, file)
      );
    }
  }
  return rows.sort(sortWaivers);
}

/**
 * The one order a waiver list is ever written in.
 *
 * @param {object} a A row.
 * @param {object} b Another.
 * @returns {number} The comparison.
 */
function sortWaivers(a, b) {
  return byteCompare(
    `${a.source} ${a.directive} ${a.path ?? ""} ${a.reason}`,
    `${b.source} ${b.directive} ${b.path ?? ""} ${b.reason}`
  );
}

/**
 * Every waiver this change spent: in a commit body, in the message being
 * written, on a line it added to a file, and in an `eslint-disable` directive
 * it added to a governance document.
 *
 * A waiver is an exception to the law, and an exception nobody can enumerate
 * is not an exception but a hole. The three places one can be written are
 * therefore read by one collector, into one list, with the same shape.
 *
 * @param {object[]} commits The commits in the range.
 * @param {object|null} pending The pending commit, if any.
 * @param {object} [range] The resolved range, for the in-file half.
 * @returns {{directive: string, path: string|null, reason: string, source: string, docket: string|null}[]}
 *   Sorted by (source, directive, path).
 */
export function collectWaivers(commits, pending, range = null) {
  const waivers = [];
  for (const commit of commits) {
    waivers.push(...waiversIn(`${commit.subject}\n${commit.body}`, `commit:${commit.sha}`));
  }
  if (pending) waivers.push(...waiversIn(pending.message, "pending"));
  if (range) {
    waivers.push(...collectWaiversFromLines(addedLinesByFile(range, pending !== null)));
  }
  return waivers.sort(sortWaivers);
}
