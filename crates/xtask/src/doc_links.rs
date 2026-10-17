//! `doc-links` — every relative link and in-repo anchor in the repository's
//! markdown resolves (Q-1005-1, the owner's ruling of 2026-10-15).
//!
//! The docs doctrine is "docs are load-bearing: stale docs are bugs, broken
//! internal links are bugs". Until this step it had no statute: the link half
//! lost its enforcing directive when the vendored `governance-kit/docs` pack
//! went, and the first sweep found forty-five links into code that was deleted
//! (`packages/server`, `crates/automations`, a Tally crate) from documents that
//! still describe it.
//!
//! **What it checks.** For each tracked markdown file, outside the two trees
//! below: every inline link, image and reference definition, and every `href`
//! or `src` in embedded HTML, that is not an external URL. The file part must
//! be a file or directory git knows about; the `#fragment` part, when the target
//! is markdown, must be a heading's GitHub slug or an explicit `id`/`name`.
//! Files are taken from `git ls-files` (tracked, plus untracked and not
//! ignored), not from the disk: a link to a file git ignores resolves on this
//! machine and 404s everywhere else, and a case difference resolves on macOS
//! and breaks on Linux.
//!
//! **What it does not check.** The network: `http:`, `https:`, `mailto:` and
//! every other scheme are skipped, so the step is fast and cannot flake. Line
//! anchors (`#L10`) and fragments into non-markdown files are skipped, since
//! GitHub resolves those in the browser. Reference-style *uses* (`[text][ref]`)
//! are not matched against their definitions; the definition's destination is
//! checked. There is deliberately **no narration tripwire** — the second half of
//! the docs doctrine, "history is cited, never narrated", is a judgement that
//! cannot be decided by a scanner, and a scanner that tries trains authors to
//! phrase around it. It stays a reviewer's principle.
//!
//! **What it skips, and why.** Only what the repository already declares
//! uneditable, so a finding there could never be fixed:
//!
//! - what `doc-integrity` freezes, **read from its pack row**
//!   (`.governance/law/packs/governance-kit-audit.json`) rather than copied
//!   here: `receipts/*.md` (append-only evidence — 196 of the links in them
//!   point at code that has since gone, which is what a record of past work
//!   looks like), and the frozen sections `QUALITY.md` "Resolved" and
//!   `CONSTITUTION.md` "Evolution Log", whose lines may not be rewritten. A
//!   second list would drift from the first, and the direction of that drift is
//!   a link check that skips a document the freeze has since released or
//!   fails one it has since frozen;
//! - `.governance/packs/`, the vendored governance kit, which
//!   `managed-tree-integrity` refuses any edit to.
//!
//! None of this is an allowlist of findings. Links *into* a frozen section are
//! still checked, and every skip is named in the step's own line so it is not
//! mistaken for a sweep that silently covers less than it says.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::{Context as _, Result, anyhow};

/// A path component that marks a build or dependency tree, never documentation.
const SKIPPED_COMPONENTS: [&str; 4] = ["node_modules", "target", ".git", "dist"];

/// The vendored governance kit: `managed-tree-integrity` refuses edits to it.
const VENDORED: &str = ".governance/packs/";

/// Where `doc-integrity`'s frozen set is declared.
const DOC_INTEGRITY_PACK: &str = ".governance/law/packs/governance-kit-audit.json";

/// What the check does not read, because the repository forbids editing it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exclusions {
    /// `frozen-files` globs: every matching file is skipped.
    pub frozen_files: Vec<String>,
    /// `frozen-section` rows: `(file, heading)`. The links under that heading
    /// are skipped; the rest of the file is checked.
    pub frozen_sections: Vec<(String, String)>,
}

impl Exclusions {
    /// The set `doc-integrity` declares today, for a tree where its pack row
    /// cannot be read.
    pub fn builtin() -> Self {
        Self {
            frozen_files: vec!["receipts/*.md".to_owned()],
            frozen_sections: vec![
                ("CONSTITUTION.md".to_owned(), "Evolution Log".to_owned()),
                ("QUALITY.md".to_owned(), "Resolved".to_owned()),
            ],
        }
    }

    /// `doc-integrity`'s rows from the pack, or [`Exclusions::builtin`] when the
    /// pack is missing or has no such rows.
    pub fn from_repo(root: &Path) -> Self {
        fs::read_to_string(root.join(DOC_INTEGRITY_PACK))
            .ok()
            .and_then(|text| Self::parse(&text))
            .unwrap_or_else(Self::builtin)
    }

    /// Parse the pack's `options["doc-integrity"].rules`:
    /// `frozen-files <glob>` and `frozen-section <file> <heading…>`.
    pub fn parse(pack: &str) -> Option<Self> {
        let document: serde_json::Value = serde_json::from_str(pack).ok()?;
        let rules = document["options"]["doc-integrity"]["rules"].as_array()?;
        let mut parsed = Self {
            frozen_files: Vec::new(),
            frozen_sections: Vec::new(),
        };
        for rule in rules.iter().filter_map(serde_json::Value::as_str) {
            let mut words = rule.split_whitespace();
            match words.next() {
                Some("frozen-files") => parsed.frozen_files.extend(words.map(str::to_owned)),
                Some("frozen-section") => {
                    if let Some(file) = words.next() {
                        let heading = words.collect::<Vec<_>>().join(" ");
                        if !heading.is_empty() {
                            parsed.frozen_sections.push((file.to_owned(), heading));
                        }
                    }
                }
                _ => {}
            }
        }
        (!parsed.frozen_files.is_empty() || !parsed.frozen_sections.is_empty()).then_some(parsed)
    }

    fn skips_file(&self, path: &str) -> bool {
        path.starts_with(VENDORED)
            || self
                .frozen_files
                .iter()
                .any(|glob| glob_matches(glob, path))
    }

    /// The 1-based line ranges of `file`'s frozen sections: from the heading to
    /// the line before the next heading of the same or a higher level.
    fn frozen_lines(&self, file: &str, text: &str) -> Vec<(usize, usize)> {
        let wanted: Vec<&str> = self
            .frozen_sections
            .iter()
            .filter(|(name, _)| name == file)
            .map(|(_, heading)| heading.as_str())
            .collect();
        if wanted.is_empty() {
            return Vec::new();
        }
        let lines = prose_lines(text);
        let mut ranges = Vec::new();
        for (position, (number, line)) in lines.iter().enumerate() {
            let Some(title) = atx_heading(line) else {
                continue;
            };
            if !wanted.contains(&inline_text(title).trim()) {
                continue;
            }
            let level = line.trim_start().chars().take_while(|c| *c == '#').count();
            let end = lines[position + 1..]
                .iter()
                .find(|(_, next)| {
                    atx_heading(next).is_some()
                        && next.trim_start().chars().take_while(|c| *c == '#').count() <= level
                })
                .map_or(usize::MAX, |(next_number, _)| next_number - 1);
            ranges.push((*number, end));
        }
        ranges
    }

    /// What the step's line says it did not read.
    pub fn describe(&self) -> String {
        let mut parts: Vec<String> = self.frozen_files.clone();
        parts.push(VENDORED.to_owned());
        parts.extend(
            self.frozen_sections
                .iter()
                .map(|(file, heading)| format!("{file} § {heading}")),
        );
        parts.join(", ")
    }
}

/// `*` within a path segment, and a `**` segment for any depth.
fn glob_matches(pattern: &str, path: &str) -> bool {
    fn segments(pattern: &[&str], path: &[&str]) -> bool {
        match (pattern.first(), path.first()) {
            (None, None) => true,
            (Some(&"**"), _) => {
                segments(&pattern[1..], path) || (!path.is_empty() && segments(pattern, &path[1..]))
            }
            (Some(pat), Some(part)) => {
                wildcard(pat.as_bytes(), part.as_bytes()) && segments(&pattern[1..], &path[1..])
            }
            _ => false,
        }
    }
    fn wildcard(pattern: &[u8], text: &[u8]) -> bool {
        match pattern.split_first() {
            None => text.is_empty(),
            Some((b'*', rest)) => (0..=text.len()).any(|skip| wildcard(rest, &text[skip..])),
            Some((byte, rest)) => text
                .split_first()
                .is_some_and(|(first, tail)| first == byte && wildcard(rest, tail)),
        }
    }
    let pattern: Vec<&str> = pattern.split('/').collect();
    let path: Vec<&str> = path.split('/').collect();
    segments(&pattern, &path)
}

#[derive(Debug, PartialEq, Eq)]
pub struct Finding {
    pub file: String,
    pub line: usize,
    pub dest: String,
    pub why: String,
}

impl Finding {
    /// `file:line: (destination) why` — the shape an editor can jump to.
    pub fn render(&self) -> String {
        format!("{}:{}: ({}) {}", self.file, self.line, self.dest, self.why)
    }
}

#[derive(Debug, Default)]
pub struct Report {
    pub files: usize,
    pub links: usize,
    pub anchors: usize,
    pub findings: Vec<Finding>,
    /// What was not read, spelled out for the step's line.
    pub skipped: String,
}

impl Report {
    /// The block printed on failure and written to `findings.txt`.
    pub fn block(&self) -> String {
        let mut out = String::new();
        for finding in &self.findings {
            let _ = writeln!(out, "{}", finding.render());
        }
        out
    }

    pub fn summary(&self) -> String {
        format!(
            "{} markdown file(s), {} relative link(s), {} anchor(s); not read: {}",
            self.files, self.links, self.anchors, self.skipped
        )
    }
}

/// Check the repository at `root`.
pub fn check(root: &Path) -> Result<Report> {
    let files = repository_files(root)?;
    let exclusions = Exclusions::from_repo(root);
    let scan: Vec<String> = files
        .iter()
        .filter(|path| is_scanned(path, &exclusions))
        .filter(|path| {
            // A symlink (`CLAUDE.md` is one) is its target, which is scanned
            // under its own name.
            fs::symlink_metadata(root.join(path)).is_ok_and(|meta| !meta.file_type().is_symlink())
        })
        .cloned()
        .collect();
    let read = |path: &str| fs::read(root.join(path)).ok().map(lossy);
    Ok(check_files(&files, &scan, &read, &exclusions))
}

fn lossy(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Does this path's markdown get checked?
pub fn is_scanned(path: &str, exclusions: &Exclusions) -> bool {
    if !path.to_ascii_lowercase().ends_with(".md") || exclusions.skips_file(path) {
        return false;
    }
    !path
        .split('/')
        .any(|component| SKIPPED_COMPONENTS.contains(&component))
}

/// Every path git would show on a pull request: tracked, plus untracked and not
/// ignored. Anything not on disk (a deleted-but-unstaged file) is dropped.
fn repository_files(root: &Path) -> Result<BTreeSet<String>> {
    let output = Command::new("git")
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .current_dir(root)
        .output()
        .context("spawn `git ls-files`")?;
    if !output.status.success() {
        return Err(anyhow!(
            "`git ls-files` exited {}: links are resolved against the files git knows about, \
             so a tree with no git cannot be checked",
            output.status.code().unwrap_or(-1)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .filter(|path| !path.is_empty())
        .filter(|path| fs::symlink_metadata(root.join(path)).is_ok())
        .map(str::to_owned)
        .collect())
}

/// The check, over plain data. `files` is every file in the repository, `scan`
/// the markdown among them to check, and `read` returns a file's text.
pub fn check_files(
    files: &BTreeSet<String>,
    scan: &[String],
    read: &dyn Fn(&str) -> Option<String>,
    exclusions: &Exclusions,
) -> Report {
    let mut directories: BTreeSet<&str> = BTreeSet::new();
    for file in files {
        let mut rest = file.as_str();
        while let Some((parent, _)) = rest.rsplit_once('/') {
            directories.insert(parent);
            rest = parent;
        }
    }
    let mut anchors: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut report = Report {
        skipped: exclusions.describe(),
        ..Report::default()
    };
    for file in scan {
        let Some(text) = read(file) else { continue };
        report.files += 1;
        let frozen = exclusions.frozen_lines(file, &text);
        for link in extract(&text) {
            if frozen
                .iter()
                .any(|(from, to)| (*from..=*to).contains(&link.line))
            {
                continue;
            }
            let dest = link.dest.trim();
            if dest.is_empty() || is_external(dest) {
                continue;
            }
            report.links += 1;
            let (raw_path, fragment) = match dest.split_once('#') {
                Some((path, fragment)) => (path, fragment),
                None => (dest, ""),
            };
            let raw_path = raw_path.split('?').next().unwrap_or("");
            let path = percent_decode(raw_path);
            let Some(target) = resolve(file, &path) else {
                report.findings.push(Finding {
                    file: file.clone(),
                    line: link.line,
                    dest: dest.to_owned(),
                    why: "climbs out of the repository".to_owned(),
                });
                continue;
            };
            let is_file = files.contains(&target);
            let is_dir = target.is_empty() || directories.contains(target.as_str());
            if !is_file && !is_dir {
                report.findings.push(Finding {
                    file: file.clone(),
                    line: link.line,
                    dest: dest.to_owned(),
                    why: format!("{target} does not exist in the repository"),
                });
                continue;
            }
            let fragment = percent_decode(fragment);
            if fragment.is_empty()
                || !is_file
                || !target.to_ascii_lowercase().ends_with(".md")
                || is_line_anchor(&fragment)
            {
                continue;
            }
            report.anchors += 1;
            let known = anchors.entry(target.clone()).or_insert_with(|| {
                read(&target)
                    .map(|text| anchors_of(&text))
                    .unwrap_or_default()
            });
            if !known.contains(&fragment.to_lowercase()) {
                report.findings.push(Finding {
                    file: file.clone(),
                    line: link.line,
                    dest: dest.to_owned(),
                    why: format!("{target} has no heading or anchor `#{fragment}`"),
                });
            }
        }
    }
    report
}

/// A scheme (`https:`, `mailto:`) or a protocol-relative `//`.
fn is_external(dest: &str) -> bool {
    if dest.starts_with("//") {
        return true;
    }
    let mut chars = dest.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) {
            return false;
        }
    }
    false
}

/// `#L10` and `#L10-L20`: GitHub resolves them in the browser, against lines.
fn is_line_anchor(fragment: &str) -> bool {
    let Some(rest) = fragment.strip_prefix('L') else {
        return fragment.starts_with(":~:");
    };
    let digits = |text: &str| !text.is_empty() && text.chars().all(|c| c.is_ascii_digit());
    match rest.split_once("-L") {
        Some((from, to)) => digits(from) && digits(to),
        None => digits(rest),
    }
}

/// The repository-relative path a link from `file` names; `None` if it climbs
/// out of the repository. The empty string is the repository root.
fn resolve(file: &str, path: &str) -> Option<String> {
    if path.is_empty() {
        return Some(file.to_owned());
    }
    let mut parts: Vec<&str> = if path.starts_with('/') {
        Vec::new()
    } else {
        let mut parts: Vec<&str> = file.split('/').collect();
        parts.pop();
        parts
    };
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            normal => parts.push(normal),
        }
    }
    Some(parts.join("/"))
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
        {
            out.push(high * 16 + low);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Extracting links
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub struct Link {
    pub line: usize,
    pub dest: String,
}

/// An opening or closing code fence: three or more backticks or tildes.
/// Returns the character and the run length.
fn fence(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim_start();
    let first = trimmed.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let run = trimmed.chars().take_while(|c| *c == first).count();
    (run >= 3).then_some((first, run))
}

/// Walks a document's lines outside fenced code, yielding `(number, line)`.
///
/// A closing fence needs the same character, at least the opening length, and
/// nothing after it. Fences inside list items are indented, so any indentation
/// counts as a fence: the alternative reads a fenced example's `[x](y)` as a
/// link.
fn prose_lines(text: &str) -> Vec<(usize, &str)> {
    let mut open: Option<(char, usize)> = None;
    let mut out = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if let Some((character, run)) = fence(line) {
            match open {
                None => {
                    open = Some((character, run));
                    continue;
                }
                Some((open_character, open_run))
                    if character == open_character
                        && run >= open_run
                        && line.trim().chars().all(|c| c == character) =>
                {
                    open = None;
                    continue;
                }
                Some(_) => {}
            }
        }
        if open.is_none() {
            out.push((index + 1, line));
        }
    }
    out
}

/// Every link destination in `text`: inline links and images, reference
/// definitions, and `href`/`src` attributes of embedded HTML. Fenced code,
/// inline code and HTML comments are not searched.
pub fn extract(text: &str) -> Vec<Link> {
    let mut links = Vec::new();
    let mut in_comment = false;
    for (number, line) in prose_lines(text) {
        let visible = strip_comments(line, &mut in_comment);
        let masked = mask_code_spans(&visible);
        if let Some(dest) = definition(&masked) {
            links.push(Link { line: number, dest });
            continue;
        }
        for dest in inline_destinations(&masked) {
            links.push(Link { line: number, dest });
        }
        for dest in attribute_values(&masked, &["href", "src"]) {
            links.push(Link { line: number, dest });
        }
    }
    links
}

/// The line with `<!-- … -->` removed, across lines.
fn strip_comments(line: &str, in_comment: &mut bool) -> String {
    let mut out = String::new();
    let mut rest = line;
    loop {
        if *in_comment {
            match rest.find("-->") {
                Some(at) => {
                    *in_comment = false;
                    rest = &rest[at + 3..];
                }
                None => return out,
            }
        } else {
            match rest.find("<!--") {
                Some(at) => {
                    out.push_str(&rest[..at]);
                    *in_comment = true;
                    rest = &rest[at + 4..];
                }
                None => {
                    out.push_str(rest);
                    return out;
                }
            }
        }
    }
}

/// The line with every inline code span replaced by spaces, so a `[x](y)`
/// shown as code is not read as a link. An unclosed run of backticks is text.
fn mask_code_spans(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '`' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let run = chars[i..].iter().take_while(|c| **c == '`').count();
        let after = i + run;
        let mut j = after;
        let mut close = None;
        while j < chars.len() {
            if chars[j] == '`' {
                let length = chars[j..].iter().take_while(|c| **c == '`').count();
                if length == run {
                    close = Some(j + length);
                    break;
                }
                j += length;
            } else {
                j += 1;
            }
        }
        match close {
            Some(end) => {
                out.extend(std::iter::repeat_n(' ', end - i));
                i = end;
            }
            None => {
                out.extend(std::iter::repeat_n('`', run));
                i = after;
            }
        }
    }
    out
}

/// `[label]: destination "title"` at the start of a line.
fn definition(line: &str) -> Option<String> {
    let indent = line.len() - line.trim_start().len();
    if indent > 3 {
        return None;
    }
    let rest = line.trim_start().strip_prefix('[')?;
    let close = rest.find("]:")?;
    if close == 0 || rest[..close].contains(['[', ']']) {
        return None;
    }
    let after = rest[close + 2..].trim_start();
    if after.is_empty() {
        return None;
    }
    if let Some(inner) = after.strip_prefix('<') {
        return inner.find('>').map(|end| inner[..end].to_owned());
    }
    Some(after.split_whitespace().next()?.to_owned())
}

/// The destination of every `](…)` on the line.
fn inline_destinations(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b']' && bytes[i + 1] == b'(' && (i == 0 || bytes[i - 1] != b'\\') {
            let (dest, next) = destination(line, i + 2);
            if let Some(dest) = dest {
                out.push(dest);
            }
            i = next.max(i + 2);
        } else {
            i += 1;
        }
    }
    out
}

/// A link destination starting at byte `start` (just after the `(`): either
/// `<…>`, or a run with balanced parentheses ending at whitespace or the `)`.
/// Returns it and the index to resume from.
fn destination(line: &str, start: usize) -> (Option<String>, usize) {
    let rest = &line[start..];
    let trimmed = rest.trim_start();
    let offset = start + (rest.len() - trimmed.len());
    if let Some(inner) = trimmed.strip_prefix('<') {
        return match inner.find('>') {
            Some(end) => (Some(inner[..end].to_owned()), offset + 1 + end + 1),
            None => (None, offset + 1),
        };
    }
    let mut depth = 0usize;
    let mut end = trimmed.len();
    for (at, c) in trimmed.char_indices() {
        match c {
            '(' => depth += 1,
            ')' if depth == 0 => {
                end = at;
                break;
            }
            ')' => depth -= 1,
            c if c.is_whitespace() => {
                end = at;
                break;
            }
            _ => {}
        }
    }
    let dest = &trimmed[..end];
    if dest.is_empty() {
        (None, offset + end)
    } else {
        (Some(dest.to_owned()), offset + end)
    }
}

/// The quoted value of every `name="…"` / `name='…'` for the given attributes.
fn attribute_values(line: &str, names: &[&str]) -> Vec<String> {
    let lower = line.to_ascii_lowercase();
    let mut out = Vec::new();
    for name in names {
        let mut from = 0;
        while let Some(found) = lower[from..].find(name) {
            let at = from + found;
            from = at + name.len();
            let before_ok = at == 0
                || !lower.as_bytes()[at - 1].is_ascii_alphanumeric()
                    && lower.as_bytes()[at - 1] != b'-';
            let rest = &line[at + name.len()..];
            let Some(rest) = rest.trim_start().strip_prefix('=') else {
                continue;
            };
            let rest = rest.trim_start();
            let Some(quote) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') else {
                continue;
            };
            if !before_ok {
                continue;
            }
            if let Some(end) = rest[1..].find(quote) {
                out.push(rest[1..1 + end].to_owned());
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

/// Every anchor a markdown document offers: each heading's GitHub slug (with
/// `-1`, `-2` on duplicates) and every `id`/`name` attribute of embedded HTML.
/// Lower-cased: GitHub matches a fragment without regard to case.
pub fn anchors_of(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    let lines = prose_lines(text);
    for (position, (_, line)) in lines.iter().enumerate() {
        let heading = atx_heading(line).or_else(|| {
            let next = lines.get(position + 1).map(|(_, next)| *next)?;
            setext_heading(line, next)
        });
        if let Some(heading) = heading {
            let slug = slug(&inline_text(heading));
            let count = seen.entry(slug.clone()).or_insert(0);
            let unique = if *count == 0 {
                slug
            } else {
                format!("{slug}-{count}")
            };
            *count += 1;
            out.insert(unique.to_lowercase());
        }
        for value in attribute_values(line, &["id", "name"]) {
            out.insert(value.to_lowercase());
        }
    }
    out
}

/// `## Heading text ##` → `Heading text`.
fn atx_heading(line: &str) -> Option<&str> {
    let indent = line.len() - line.trim_start().len();
    if indent > 3 {
        return None;
    }
    let trimmed = line.trim_start();
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &trimmed[hashes..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    let rest = rest.trim();
    // An optional closing run of `#`, separated from the text by a space.
    let without = rest.trim_end_matches('#');
    if without.len() < rest.len() && (without.is_empty() || without.ends_with([' ', '\t'])) {
        return Some(without.trim_end());
    }
    Some(rest)
}

/// A paragraph line followed by `===` or `---`.
fn setext_heading<'a>(line: &'a str, next: &str) -> Option<&'a str> {
    let text = line.trim();
    if text.is_empty()
        || text.starts_with(['#', '>', '-', '*', '+', '|', '<', '=', '['])
        || text.chars().next().is_some_and(|c| c.is_ascii_digit())
    {
        return None;
    }
    let underline = next.trim();
    let indent = next.len() - next.trim_start().len();
    let bar = underline.chars().next()?;
    if indent > 3 || !(bar == '=' || bar == '-') || !underline.chars().all(|c| c == bar) {
        return None;
    }
    Some(text)
}

/// The text of a heading as rendered, which is what GitHub slugs.
pub fn inline_text(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '`' => {
                let run = chars[i..].iter().take_while(|c| **c == '`').count();
                let mut j = i + run;
                let mut close = None;
                while j < chars.len() {
                    if chars[j] == '`' {
                        let length = chars[j..].iter().take_while(|c| **c == '`').count();
                        if length == run {
                            close = Some(j);
                            break;
                        }
                        j += length;
                    } else {
                        j += 1;
                    }
                }
                match close {
                    Some(end) => {
                        let content: String = chars[i + run..end].iter().collect();
                        let trimmed = if content.starts_with(' ')
                            && content.ends_with(' ')
                            && content.trim().len() < content.len() - 1
                        {
                            &content[1..content.len() - 1]
                        } else {
                            content.as_str()
                        };
                        out.push_str(trimmed);
                        i = end + run;
                    }
                    None => {
                        out.extend(std::iter::repeat_n('`', run));
                        i += run;
                    }
                }
            }
            '\\' if chars.get(i + 1).is_some_and(char::is_ascii_punctuation) => {
                out.push(chars[i + 1]);
                i += 2;
            }
            '!' if chars.get(i + 1) == Some(&'[') => i += 1,
            '[' => match matching(&chars, i, '[', ']') {
                Some(close) => {
                    let inner: String = chars[i + 1..close].iter().collect();
                    out.push_str(&inline_text(&inner));
                    i = close + 1;
                    // A destination or a reference label after the text.
                    match chars.get(i) {
                        Some('(') => {
                            if let Some(end) = matching(&chars, i, '(', ')') {
                                i = end + 1;
                            }
                        }
                        Some('[') => {
                            if let Some(end) = matching(&chars, i, '[', ']') {
                                i = end + 1;
                            }
                        }
                        _ => {}
                    }
                }
                None => {
                    out.push('[');
                    i += 1;
                }
            },
            '<' if chars
                .get(i + 1)
                .is_some_and(|c| c.is_ascii_alphabetic() || *c == '/' || *c == '!') =>
            {
                match chars[i..].iter().position(|c| *c == '>') {
                    Some(end) => i += end + 1,
                    None => {
                        out.push('<');
                        i += 1;
                    }
                }
            }
            '*' => i += 1,
            '_' => {
                let before = i.checked_sub(1).and_then(|at| chars.get(at));
                let after = chars.get(i + 1);
                let word = |c: Option<&char>| c.is_some_and(|c| c.is_alphanumeric());
                // An underscore between two word characters is part of the word.
                if word(before) && word(after) {
                    out.push('_');
                }
                i += 1;
            }
            '&' => {
                let rest: String = chars[i..].iter().take(8).collect();
                let entities = [
                    ("&amp;", '&'),
                    ("&lt;", '<'),
                    ("&gt;", '>'),
                    ("&quot;", '"'),
                    ("&#39;", '\''),
                    ("&nbsp;", ' '),
                ];
                match entities.iter().find(|(name, _)| rest.starts_with(name)) {
                    Some((name, replacement)) => {
                        out.push(*replacement);
                        i += name.len();
                    }
                    None => {
                        out.push('&');
                        i += 1;
                    }
                }
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    out
}

/// The index of the bracket that closes the one at `open`.
fn matching(chars: &[char], open: usize, opener: char, closer: char) -> Option<usize> {
    let mut depth = 0usize;
    for (at, c) in chars.iter().enumerate().skip(open) {
        if *c == '\\' {
            continue;
        }
        if *c == opener {
            depth += 1;
        } else if *c == closer {
            depth -= 1;
            if depth == 0 {
                return Some(at);
            }
        }
    }
    None
}

/// GitHub's heading slug: lower-case, keep letters, numbers, `_` and `-`, turn
/// each space into `-`, drop everything else.
pub fn slug(text: &str) -> String {
    text.trim()
        .to_lowercase()
        .chars()
        .filter_map(|c| match c {
            ' ' => Some('-'),
            '-' | '_' => Some(c),
            c if c.is_alphanumeric() || ('\u{0300}'..='\u{036f}').contains(&c) => Some(c),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(files: &[(&str, &str)]) -> (BTreeSet<String>, BTreeMap<String, String>) {
        let names = files.iter().map(|(path, _)| (*path).to_owned()).collect();
        let texts = files
            .iter()
            .map(|(path, text)| ((*path).to_owned(), (*text).to_owned()))
            .collect();
        (names, texts)
    }

    /// Findings as `file:line why-fragment` pairs for readable assertions.
    fn run(files: &[(&str, &str)]) -> Report {
        let (names, texts) = repo(files);
        let exclusions = Exclusions::builtin();
        let scan: Vec<String> = names
            .iter()
            .filter(|p| is_scanned(p, &exclusions))
            .cloned()
            .collect();
        check_files(&names, &scan, &|path| texts.get(path).cloned(), &exclusions)
    }

    fn broken(report: &Report) -> Vec<(String, usize, String)> {
        report
            .findings
            .iter()
            .map(|f| (f.file.clone(), f.line, f.dest.clone()))
            .collect()
    }

    #[test]
    fn a_link_to_a_file_that_does_not_exist_is_a_finding_at_its_line() {
        let report = run(&[
            (
                "docs/a.md",
                "# A\n\nSee [the trap](traps/missing.md) and [real](b.md).\n",
            ),
            ("docs/b.md", "# B\n"),
        ]);
        assert_eq!(
            broken(&report),
            [("docs/a.md".to_owned(), 3, "traps/missing.md".to_owned())]
        );
        assert!(
            report.findings[0].why.contains("docs/traps/missing.md"),
            "{}",
            report.findings[0].why
        );
        assert_eq!(report.links, 2);
    }

    #[test]
    fn relative_paths_resolve_from_the_linking_file_and_absolute_ones_from_the_root() {
        let report = run(&[
            (
                "docs/photos/a.md",
                "[up](../../crates/x/src/lib.rs) [root](/docs/b.md) [here](./c.md) [dir](../../crates/x)\n",
            ),
            ("docs/b.md", ""),
            ("docs/photos/c.md", ""),
            ("crates/x/src/lib.rs", ""),
        ]);
        assert!(report.findings.is_empty(), "{:?}", report.findings);
    }

    #[test]
    fn a_link_that_climbs_out_of_the_repository_is_a_finding() {
        let report = run(&[("a.md", "[out](../../etc/passwd)\n")]);
        assert_eq!(report.findings.len(), 1);
        assert!(report.findings[0].why.contains("climbs out"));
    }

    #[test]
    fn a_heading_anchor_resolves_and_a_missing_one_does_not() {
        let report = run(&[
            (
                "a.md",
                "[ok](b.md#the-local-gate-loop) [bad](b.md#no-such-heading) [self](#intro) [selfbad](#nope)\n\n# Intro\n",
            ),
            ("b.md", "# B\n\n## The `local` gate loop\n"),
        ]);
        assert_eq!(
            broken(&report),
            [
                ("a.md".to_owned(), 1, "b.md#no-such-heading".to_owned()),
                ("a.md".to_owned(), 1, "#nope".to_owned())
            ]
        );
        assert_eq!(report.anchors, 4);
    }

    #[test]
    fn slugs_follow_githubs_rules() {
        for (heading, want) in [
            ("The local gate loop", "the-local-gate-loop"),
            (
                "`cargo xtask artifact-key` (#1020, D-1020-G2)",
                "cargo-xtask-artifact-key-1020-d-1020-g2",
            ),
            ("Decisions — lane B2 (#1020)", "decisions--lane-b2-1020"),
            ("Q&A: what's _new_?", "qa-whats-new"),
            ("snake_case_name stays", "snake_case_name-stays"),
            (
                "**Bold** and *italic* and [a link](x.md)",
                "bold-and-italic-and-a-link",
            ),
            ("Image ![alt text](a.png) here", "image-alt-text-here"),
            ("Rust & C++ <sup>2</sup>", "rust--c-2"),
            ("Ünïcode Straße", "ünïcode-straße"),
            ("trailing hashes ##", "trailing-hashes"),
            ("keep `_underscored_` code", "keep-_underscored_-code"),
        ] {
            let heading_line = format!("## {heading}\n");
            let found = anchors_of(&heading_line);
            assert!(
                found.contains(want),
                "{heading:?}: wanted {want:?}, got {found:?}"
            );
        }
    }

    #[test]
    fn duplicate_headings_get_numeric_suffixes() {
        let found = anchors_of("# Notes\n\n## Notes\n\n### Notes\n");
        assert_eq!(
            found.into_iter().collect::<Vec<_>>(),
            ["notes", "notes-1", "notes-2"]
        );
    }

    #[test]
    fn setext_headings_and_explicit_html_anchors_count() {
        let found = anchors_of(
            "Title\n=====\n\nSub head\n--------\n\n<a id=\"v1-gate\"></a>\n\n<a name='Old'></a>\n",
        );
        assert!(found.contains("title"));
        assert!(found.contains("sub-head"));
        assert!(found.contains("v1-gate"));
        assert!(found.contains("old"));
    }

    #[test]
    fn anchor_matching_ignores_case_and_percent_encoding() {
        let report = run(&[
            ("a.md", "[x](b.md#THE-heading) [y](b.md#the%2Dheading)\n"),
            ("b.md", "# The Heading\n"),
        ]);
        assert!(report.findings.is_empty(), "{:?}", report.findings);
    }

    #[test]
    fn fragments_into_non_markdown_and_line_anchors_are_not_checked() {
        let report = run(&[
            (
                "a.md",
                "[src](x.rs#L10-L20) [md](b.md#L7) [dir](docs#anything) [t](b.md#:~:text=hi)\n",
            ),
            ("x.rs", ""),
            ("b.md", ""),
            ("docs/c.md", ""),
        ]);
        assert!(report.findings.is_empty(), "{:?}", report.findings);
    }

    #[test]
    fn external_links_are_skipped_without_a_network() {
        let report = run(&[(
            "a.md",
            "[a](https://example.org/x) [b](mailto:x@y.z) [c](//cdn.example/x.js) [d](tel:123) <https://auto.link>\n",
        )]);
        assert!(report.findings.is_empty());
        assert_eq!(report.links, 0);
    }

    #[test]
    fn code_in_every_form_is_not_a_link() {
        let report = run(&[(
            "a.md",
            "```md\n[fenced](nowhere.md)\n```\n\nInline `[code](nowhere.md)` and ``double `[x](y.md)` ticks``.\n\n~~~\n[tilde](nowhere.md)\n~~~\n\n    ```\n  [indented fence](nowhere.md)\n    ```\n\n<!-- [comment](nowhere.md)\nstill [comment](nowhere.md) -->\n\n[after](missing.md)\n",
        )]);
        assert_eq!(
            broken(&report),
            [("a.md".to_owned(), 18, "missing.md".to_owned())]
        );
    }

    #[test]
    fn a_longer_fence_is_not_closed_by_a_shorter_one() {
        let report = run(&[(
            "a.md",
            "````\n```\n[still code](nowhere.md)\n```\n````\n[live](missing.md)\n",
        )]);
        assert_eq!(
            broken(&report),
            [("a.md".to_owned(), 6, "missing.md".to_owned())]
        );
    }

    #[test]
    fn reference_definitions_angle_brackets_titles_and_query_strings_are_read() {
        let report = run(&[
            (
                "a.md",
                "[ref]: b.md\n[angle]: <my file.md> \"Title\"\n[bad]: gone.md\n\n[inline](<my file.md> \"t\") [enc](my%20file.md) [q](b.md?plain=1) [paren](c(1).md)\n",
            ),
            ("b.md", ""),
            ("my file.md", ""),
            ("c(1).md", ""),
        ]);
        assert_eq!(
            broken(&report),
            [("a.md".to_owned(), 3, "gone.md".to_owned())]
        );
    }

    #[test]
    fn html_href_and_src_are_links_too() {
        let report = run(&[
            (
                "a.md",
                "<a href=\"b.md\">ok</a> <img src='gone.png' alt=x> <a data-href=\"also-not.md\">x</a>\n",
            ),
            ("b.md", ""),
        ]);
        assert_eq!(
            broken(&report),
            [("a.md".to_owned(), 1, "gone.png".to_owned())]
        );
    }

    #[test]
    fn a_link_nested_in_an_image_link_yields_both_destinations() {
        let found = extract("[![badge](img/b.svg)](https://ci.example/run)\n");
        assert_eq!(
            found.iter().map(|l| l.dest.as_str()).collect::<Vec<_>>(),
            ["img/b.svg", "https://ci.example/run"]
        );
    }

    #[test]
    fn a_directory_is_a_valid_target_and_a_different_case_is_not() {
        let report = run(&[
            (
                "a.md",
                "[dir](crates/x/) [dir2](crates/x) [case](Crates/x)\n",
            ),
            ("crates/x/lib.rs", ""),
        ]);
        assert_eq!(
            broken(&report),
            [("a.md".to_owned(), 1, "Crates/x".to_owned())]
        );
    }

    #[test]
    fn the_unscanned_trees_are_exactly_the_declared_ones() {
        let skip = Exclusions::builtin();
        assert!(is_scanned("docs/decisions.md", &skip));
        assert!(is_scanned("README.md", &skip));
        assert!(is_scanned("crates/xtask/README.md", &skip));
        assert!(!is_scanned("receipts/issue-1-x.md", &skip));
        assert!(!is_scanned(".governance/packs/a/b.md", &skip));
        assert!(is_scanned(".governance/law/README.md", &skip));
        assert!(!is_scanned("docs/notes.txt", &skip));
        assert!(!is_scanned("web/node_modules/x/README.md", &skip));
        assert!(!is_scanned("target/doc/x.md", &skip));
    }

    #[test]
    fn the_frozen_set_is_read_from_the_doc_integrity_pack_row() {
        let pack = r#"{"options": {"doc-integrity": {"rules": [
            "frozen-files receipts/*.md",
            "frozen-files notes/**/*.md",
            "frozen-section QUALITY.md Resolved",
            "frozen-section CONSTITUTION.md Evolution Log",
            "something-else x"
        ]}}}"#;
        let parsed = Exclusions::parse(pack).expect("the pack row parses");
        assert_eq!(parsed.frozen_files, ["receipts/*.md", "notes/**/*.md"]);
        assert_eq!(
            parsed.frozen_sections,
            [
                ("QUALITY.md".to_owned(), "Resolved".to_owned()),
                ("CONSTITUTION.md".to_owned(), "Evolution Log".to_owned())
            ]
        );
        assert!(is_scanned("docs/a.md", &parsed));
        assert!(!is_scanned("receipts/x.md", &parsed));
        assert!(!is_scanned("notes/2026/09/x.md", &parsed));
        assert_eq!(Exclusions::parse("{}"), None);
        assert_eq!(Exclusions::parse("not json"), None);
    }

    /// The row the repository actually has, so a change to `doc-integrity`'s
    /// frozen set moves this check with it instead of drifting from it.
    #[test]
    fn the_real_pack_row_and_the_builtin_fallback_agree() {
        let root = crate::repo_root();
        assert_eq!(Exclusions::from_repo(&root), Exclusions::builtin());
    }

    #[test]
    fn links_in_a_frozen_section_are_skipped_and_links_into_it_are_not() {
        let report = run(&[
            (
                "QUALITY.md",
                "# Quality\n\n[open broken](gone-open.md)\n\n## Resolved\n\n[old](gone-resolved.md)\n\n### Detail\n\n[older](gone-detail.md)\n\n## Notes\n\n[after](gone-after.md)\n",
            ),
            (
                "docs/a.md",
                "[into](../QUALITY.md#resolved) [bad](../QUALITY.md#nope)\n",
            ),
        ]);
        assert_eq!(
            broken(&report),
            [
                ("QUALITY.md".to_owned(), 3, "gone-open.md".to_owned()),
                ("QUALITY.md".to_owned(), 15, "gone-after.md".to_owned()),
                ("docs/a.md".to_owned(), 1, "../QUALITY.md#nope".to_owned()),
            ]
        );
        assert!(report.skipped.contains("QUALITY.md § Resolved"));
    }

    #[test]
    fn a_glob_star_stays_inside_one_segment_and_a_double_star_does_not() {
        assert!(glob_matches("receipts/*.md", "receipts/issue-1.md"));
        assert!(!glob_matches("receipts/*.md", "receipts/sub/issue-1.md"));
        assert!(!glob_matches("receipts/*.md", "docs/receipts/issue-1.md"));
        assert!(glob_matches("a/**/c.md", "a/b/x/c.md"));
        assert!(glob_matches("a/**/c.md", "a/c.md"));
        assert!(!glob_matches("a/*.md", "a/b.txt"));
    }

    #[test]
    fn destinations_with_a_balanced_parenthesis_and_no_destination_do_not_derail_a_line() {
        let found = extract("[a](x(1).md) then [b]() then [c](y.md \"title\") and f(x)[0](z.md)\n");
        assert_eq!(
            found.iter().map(|l| l.dest.as_str()).collect::<Vec<_>>(),
            ["x(1).md", "y.md", "z.md"]
        );
    }
}
