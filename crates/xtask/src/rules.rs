//! Structural rules — the invariants from #1020 that no compiler can hold.
//!
//! Four of them, one per invariant in the issue's *Execution plan → Invariants*:
//! SQL confinement, the five-symbol C ABI, no listening TCP socket, and no
//! platform import in `mobile/shared/commonMain`.
//!
//! **These are file walks and hand-rolled scanners, not parse trees.** The
//! issue rules that tree-sitter owns structural rules; it is not here yet,
//! because the four rules below are answerable from string literals, attribute
//! lines and import lines, and a parser would cost the `local` budget more than
//! the precision is worth today. When a rule needs to know what an expression
//! *means*, that is the commit that adds tree-sitter. Until then the scanners
//! are unit-tested against fixtures that must be caught (see the tests below) —
//! a rule with no demonstrated red is a claim, not a gate.
//!
//! Three of the four have a subject that does not exist yet (`crates/core-ffi`
//! in wave 2, `mobile/` in wave 3). They are live from day one and report
//! PENDING with the wave that lands their subject, rather than being written
//! later: a rule added after the code it constrains has to be argued for, and a
//! rule that was always there is just true.

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

/// Where SQL is allowed to appear. Everywhere else under `crates/` a SQL
/// keyword in a string literal is a finding (#1020 invariant).
const SQL_ALLOWED_ROOTS: [&str; 5] = [
    "crates/ontology",
    "crates/vault",
    "crates/seat",
    "crates/search",
    "crates/apps/kit",
];

/// `crates/xtask` is exempt from the two source-scanning rules because it
/// **holds their patterns**: the keyword table below and the listener patterns
/// in `listener_hits` are string literals in this very crate, so scanning the
/// gate runner with its own rules would report the rules themselves. The
/// exemption is one named directory, greppable, and the runner ships no product
/// surface — it is not shipped in any artifact and opens no socket.
const RULE_RUNNER: &str = "crates/xtask";

/// The keywords that make a string literal SQL. Uppercase and case-sensitive on
/// purpose: `"delete the draft"` in a copy string is English, `"DELETE FROM"` is
/// a statement, and matching case-insensitively would drown the rule in prose.
const SQL_KEYWORDS: [&str; 6] = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "CREATE TABLE",
    "PRAGMA",
];

/// The C ABI's exact symbol count (#1020: `open`, `call`, `next_event`, `free`,
/// `close`). Tighten-only in the sense that matters: it is an equality, so both
/// a sixth symbol and a lost fifth are findings.
const ABI_SYMBOLS: usize = 5;

/// Imports that make a `commonMain` file platform-specific.
const PLATFORM_IMPORT_PREFIXES: [&str; 8] = [
    "android.",
    "androidx.",
    "java.",
    "javax.",
    "kotlin.native.",
    "kotlinx.cinterop",
    "platform.",
    "co.touchlab.",
];

/// One rule's verdict.
pub struct RuleReport {
    pub name: &'static str,
    pub state: RuleState,
    pub findings: Vec<String>,
    /// Anything about the scan a reader needs to make sense of the file count —
    /// notably how many files a rule skipped BY DESIGN. Without it
    /// `sql-confinement` reports "0 files scanned" on a tree full of SQL,
    /// because every one of those files is in an allowed crate, and a reader
    /// cannot tell that from a rule that is silently not running.
    pub note: String,
}

pub enum RuleState {
    /// The rule's subject exists and was scanned. Carries the file count.
    Applied(usize),
    /// The rule's subject is not in the tree yet. Carries the wave that lands it.
    Pending(String),
}

impl RuleReport {
    fn applied(name: &'static str, scanned: usize, findings: Vec<String>) -> Self {
        Self {
            name,
            state: RuleState::Applied(scanned),
            findings,
            note: String::new(),
        }
    }

    fn with_note(mut self, note: String) -> Self {
        self.note = note;
        self
    }

    fn pending(name: &'static str, reason: &str) -> Self {
        Self {
            name,
            state: RuleState::Pending(reason.to_owned()),
            findings: Vec::new(),
            note: String::new(),
        }
    }

    /// The one line this rule prints, whatever its verdict.
    pub fn line(&self) -> String {
        match (&self.state, self.findings.len()) {
            (RuleState::Pending(reason), _) => {
                format!("PENDING {} — {reason}", self.name)
            }
            (RuleState::Applied(scanned), 0) => {
                format!(
                    "ok      {} — {scanned} file(s) scanned, clean{}",
                    self.name, self.note
                )
            }
            (RuleState::Applied(scanned), count) => {
                format!(
                    "FAIL    {} — {count} finding(s) in {scanned} file(s) scanned{}",
                    self.name, self.note
                )
            }
        }
    }
}

/// Every rule, in a stable order.
pub fn all(root: &Path) -> Vec<RuleReport> {
    vec![
        sql_confinement(root),
        abi_symbol_count(root),
        no_listening_socket(root),
        commonmain_no_platform_import(root),
    ]
}

/// `cargo xtask rules` — the rules on their own, for the edit-run loop.
pub fn print_report(root: &Path) -> bool {
    let reports = all(root);
    let mut ok = true;
    for report in &reports {
        println!("  {}", report.line());
        for finding in &report.findings {
            println!("        {finding}");
            ok = false;
        }
    }
    ok
}

/// Render every finding across every rule as one block, for the gate artifact.
pub fn findings_block(reports: &[RuleReport]) -> String {
    let mut out = String::new();
    for report in reports {
        let _ = writeln!(out, "{}", report.line());
        for finding in &report.findings {
            let _ = writeln!(out, "    {finding}");
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Rule 1 — SQL only under crates/{ontology,vault,seat,search} and crates/apps/kit
// ---------------------------------------------------------------------------

pub fn sql_confinement(root: &Path) -> RuleReport {
    const NAME: &str = "sql-confinement";
    let crates = root.join("crates");
    if !crates.is_dir() {
        return RuleReport::pending(NAME, "no crates/ directory yet");
    }
    let files = source_files(&crates, "rs");
    let mut scanned = 0usize;
    let mut allowed = 0usize;
    let mut exempt = 0usize;
    let mut findings = Vec::new();
    for file in &files {
        let rel = relative(root, file);
        if rel.starts_with(RULE_RUNNER) {
            exempt += 1;
            continue;
        }
        if SQL_ALLOWED_ROOTS
            .iter()
            .any(|allowed_root| rel.starts_with(allowed_root))
        {
            allowed += 1;
            continue;
        }
        scanned += 1;
        let Ok(source) = fs::read_to_string(file) else {
            continue;
        };
        let mut hit = BTreeSet::new();
        for literal in string_literals(&source) {
            for keyword in SQL_KEYWORDS {
                if word_at(&literal, keyword) {
                    hit.insert(keyword);
                }
            }
        }
        if !hit.is_empty() {
            let words: Vec<&str> = hit.into_iter().collect();
            findings.push(format!(
                "{rel}: string literal contains SQL ({}). SQL lives only under {} — a query outside them means a crate reached past its layer (#1020)",
                words.join(", "),
                SQL_ALLOWED_ROOTS.join(", ")
            ));
        }
    }
    RuleReport::applied(NAME, scanned, findings).with_note(format!(
        " ({allowed} in the allowed crates, {exempt} in the rule runner)"
    ))
}

// ---------------------------------------------------------------------------
// Rule 2 — the C ABI exports exactly five symbols
// ---------------------------------------------------------------------------

pub fn abi_symbol_count(root: &Path) -> RuleReport {
    const NAME: &str = "abi-five-symbols";
    let ffi = root.join("crates/core-ffi");
    if !ffi.is_dir() {
        return RuleReport::pending(
            NAME,
            "crates/core-ffi lands in wave 2 lane D; the rule is live and will count then",
        );
    }
    let files = source_files(&ffi, "rs");
    let mut symbols: Vec<String> = Vec::new();
    for file in &files {
        if let Ok(source) = fs::read_to_string(file) {
            symbols.extend(exported_c_symbols(&source));
        }
    }
    symbols.sort();
    let mut findings = Vec::new();
    if symbols.len() != ABI_SYMBOLS {
        findings.push(format!(
            "crates/core-ffi exports {} `extern \"C\"` symbol(s), not {ABI_SYMBOLS}: [{}]. The ABI is open/call/next_event/free/close and nothing else (#1020)",
            symbols.len(),
            symbols.join(", ")
        ));
    }
    RuleReport::applied(NAME, files.len(), findings)
}

/// Every `#[no_mangle] pub extern "C" fn` name in one Rust source file.
///
/// Attribute and signature are on different lines in every real formatting of
/// this, so the scanner looks ahead from the attribute past comments and
/// further attributes to the first signature line.
pub fn exported_c_symbols(source: &str) -> Vec<String> {
    let lines: Vec<&str> = source.lines().collect();
    let mut names = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if !line.contains("no_mangle") {
            continue;
        }
        for ahead in lines.iter().skip(index + 1).take(6) {
            let trimmed = ahead.trim();
            if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') {
                continue;
            }
            if trimmed.contains("extern \"C\"")
                && let Some(name) = function_name(trimmed)
            {
                names.push(name);
            }
            break;
        }
    }
    names
}

fn function_name(signature: &str) -> Option<String> {
    let after = signature.split("fn ").nth(1)?;
    let name: String = after
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() { None } else { Some(name) }
}

// ---------------------------------------------------------------------------
// Rule 3 — no crate opens a listening TCP socket
// ---------------------------------------------------------------------------

pub fn no_listening_socket(root: &Path) -> RuleReport {
    const NAME: &str = "no-listening-socket";
    let crates = root.join("crates");
    if !crates.is_dir() {
        return RuleReport::pending(NAME, "no crates/ directory yet");
    }
    let files = source_files(&crates, "rs");
    let mut scanned = 0usize;
    let mut exempt = 0usize;
    let mut findings = Vec::new();
    for file in &files {
        let rel = relative(root, file);
        if rel.starts_with(RULE_RUNNER) {
            exempt += 1;
            continue;
        }
        scanned += 1;
        let Ok(source) = fs::read_to_string(file) else {
            continue;
        };
        for (line, pattern) in listener_hits(&source) {
            findings.push(format!(
                "{rel}:{line}: `{pattern}` outside a `#[cfg(feature = \"blob-door\")]` block. iroh QUIC is the transport and the blob door is the only listener the product may ever have, off by default until wave 3 rules on it (#1020)"
            ));
        }
    }
    RuleReport::applied(NAME, scanned, findings)
        .with_note(format!(" ({exempt} in the rule runner)"))
}

/// Listener constructions that are NOT inside a `blob-door`-gated item.
///
/// The guard is tracked by brace depth: the attribute arms the next `{`, and
/// every hit until that brace closes is allowed.
pub fn listener_hits(source: &str) -> Vec<(usize, &'static str)> {
    const PATTERNS: [&str; 2] = ["TcpListener::bind", "tokio::net::TcpListener"];
    const GUARD: &str = "#[cfg(feature = \"blob-door\")]";
    let mut hits = Vec::new();
    let mut depth: i32 = 0;
    let mut guards: Vec<i32> = Vec::new();
    let mut armed = false;
    for (index, line) in source.lines().enumerate() {
        let code = line.split("//").next().unwrap_or(line);
        if line.contains(GUARD) {
            armed = true;
        } else {
            let guarded = armed || !guards.is_empty();
            if !guarded {
                // One hit per line: `tokio::net::TcpListener::bind(…)` matches
                // both patterns, and one line of code is one finding.
                if let Some(pattern) = PATTERNS.iter().find(|pattern| code.contains(**pattern)) {
                    hits.push((index + 1, *pattern));
                }
            }
        }
        for byte in code.bytes() {
            match byte {
                b'{' => {
                    depth += 1;
                    if armed {
                        guards.push(depth - 1);
                        armed = false;
                    }
                }
                b'}' => {
                    depth -= 1;
                    while guards.last().is_some_and(|guard| depth <= *guard) {
                        guards.pop();
                    }
                }
                _ => {}
            }
        }
    }
    hits
}

// ---------------------------------------------------------------------------
// Rule 4 — mobile/shared/commonMain has no platform import
// ---------------------------------------------------------------------------

pub fn commonmain_no_platform_import(root: &Path) -> RuleReport {
    const NAME: &str = "commonmain-no-platform-import";
    // BOTH KMP MODULES. `mobile/core`'s `commonMain` is the ABI binding's
    // shared half and is exactly as platform-free as `mobile/shared`'s: a JNA
    // `Pointer` or a `kotlinx.cinterop` import leaking into it would be the
    // same defect with a shorter blast radius (#1020 wave 3 lane E).
    let roots = [
        root.join("mobile/shared/src/commonMain"),
        root.join("mobile/core/src/commonMain"),
    ];
    if !roots.iter().any(|dir| dir.is_dir()) {
        return RuleReport::pending(
            NAME,
            "mobile/ lands in wave 3 lane E; Konsist replaces this rule there, and this cheap one stays",
        );
    }
    let files: Vec<_> = roots
        .iter()
        .filter(|dir| dir.is_dir())
        .flat_map(|dir| source_files(dir, "kt"))
        .collect();
    let mut findings = Vec::new();
    for file in &files {
        let rel = relative(root, file);
        let Ok(source) = fs::read_to_string(file) else {
            continue;
        };
        for (line, import) in platform_imports(&source) {
            findings.push(format!(
                "{rel}:{line}: `import {import}` is platform code in commonMain. Kotlin owns screen state and nothing platform-specific; expect/actual is the seam (#1020)"
            ));
        }
    }
    RuleReport::applied(NAME, files.len(), findings)
}

pub fn platform_imports(source: &str) -> Vec<(usize, String)> {
    let mut hits = Vec::new();
    for (index, line) in source.lines().enumerate() {
        let trimmed = line.trim();
        let Some(target) = trimmed.strip_prefix("import ") else {
            continue;
        };
        let target = target.trim();
        if PLATFORM_IMPORT_PREFIXES
            .iter()
            .any(|prefix| target.starts_with(prefix))
        {
            hits.push((index + 1, target.to_owned()));
        }
    }
    hits
}

// ---------------------------------------------------------------------------
// Shared scanners
// ---------------------------------------------------------------------------

/// Every file with the given extension under `dir`, sorted, skipping build and
/// dependency output so the walk is deterministic and cheap.
pub fn source_files(dir: &Path, extension: &str) -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk(dir, extension, &mut found);
    found.sort();
    found
}

fn walk(dir: &Path, extension: &str, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if matches!(name.as_ref(), "target" | "node_modules" | ".git" | "build") {
                continue;
            }
            walk(&path, extension, out);
        } else if path.extension().is_some_and(|found| found == extension) {
            out.push(path);
        }
    }
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Every string literal in a Rust source file, with comments excluded.
///
/// Handles `"…"` (with escapes) and raw strings (`r"…"`, `r#"…"#`), and skips
/// line and nested block comments — which is the whole reason the rule reads
/// literals rather than grepping the file: a keyword in a doc comment about SQL
/// is not SQL.
pub fn string_literals(source: &str) -> Vec<String> {
    let bytes = source.as_bytes();
    let mut out = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index += 2;
                let mut depth = 1usize;
                while index < bytes.len() && depth > 0 {
                    if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
                        depth += 1;
                        index += 2;
                    } else if bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/') {
                        depth -= 1;
                        index += 2;
                    } else {
                        index += 1;
                    }
                }
            }
            b'r' if !is_ident_byte(index.checked_sub(1).map(|prev| bytes[prev])) => {
                if let Some((literal, next)) = raw_string_at(source, index) {
                    out.push(literal);
                    index = next;
                } else {
                    index += 1;
                }
            }
            b'"' => {
                index += 1;
                let start = index;
                while index < bytes.len() {
                    if bytes[index] == b'\\' {
                        index += 2;
                        continue;
                    }
                    if bytes[index] == b'"' {
                        break;
                    }
                    index += 1;
                }
                let end = index.min(bytes.len());
                out.push(source[start..end].to_owned());
                index += 1;
            }
            _ => index += 1,
        }
    }
    out
}

fn is_ident_byte(byte: Option<u8>) -> bool {
    byte.is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// A raw string starting at `index` (`r`, then `#`s, then `"`), and the byte
/// index just past its terminator.
fn raw_string_at(source: &str, index: usize) -> Option<(String, usize)> {
    let bytes = source.as_bytes();
    let mut cursor = index + 1;
    let mut hashes = 0usize;
    while bytes.get(cursor) == Some(&b'#') {
        hashes += 1;
        cursor += 1;
    }
    if bytes.get(cursor) != Some(&b'"') {
        return None;
    }
    cursor += 1;
    let start = cursor;
    while cursor < bytes.len() {
        if bytes[cursor] == b'"' {
            let mut seen = 0usize;
            let mut after = cursor + 1;
            while seen < hashes && bytes.get(after) == Some(&b'#') {
                seen += 1;
                after += 1;
            }
            if seen == hashes {
                return Some((source[start..cursor].to_owned(), after));
            }
        }
        cursor += 1;
    }
    None
}

/// `needle` appears in `haystack` on word boundaries.
pub fn word_at(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let mut from = 0usize;
    while let Some(offset) = haystack.get(from..).and_then(|rest| rest.find(needle)) {
        let start = from + offset;
        let end = start + needle.len();
        let before_ok = start == 0 || !is_ident_byte(Some(bytes[start - 1]));
        let after_ok = end >= bytes.len() || !is_ident_byte(Some(bytes[end]));
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::fixture_dir;

    #[test]
    fn string_literals_skip_comments_and_read_raw_strings() {
        let source = r##"
// SELECT in a line comment is not SQL
/* SELECT in a block comment is not either /* nested */ still not */
fn query() -> &'static str { "SELECT 1" }
fn raw() -> &'static str { r#"INSERT INTO t VALUES (1)"# }
fn escaped() -> &'static str { "a \" quote" }
"##;
        let literals = string_literals(source);
        assert!(literals.iter().any(|literal| literal == "SELECT 1"));
        assert!(
            literals
                .iter()
                .any(|literal| literal == "INSERT INTO t VALUES (1)")
        );
        assert!(literals.iter().any(|literal| literal.contains("quote")));
        assert!(!literals.iter().any(|literal| literal.contains("comment")));
    }

    #[test]
    fn word_boundaries_are_respected() {
        assert!(word_at("SELECT 1", "SELECT"));
        assert!(word_at("x = CREATE TABLE t", "CREATE TABLE"));
        assert!(!word_at("DESELECTED", "SELECT"));
        assert!(!word_at("UPDATED_AT", "UPDATE"));
    }

    // ---- demonstrated reds, one per rule ----

    #[test]
    fn sql_outside_the_allowed_crates_is_caught() {
        let root = fixture_dir("sql-red");
        write(
            &root,
            "crates/net/src/lib.rs",
            "fn q() { let _ = \"SELECT 1 FROM rows\"; }",
        );
        write(
            &root,
            "crates/vault/src/lib.rs",
            "fn q() { let _ = \"SELECT 1 FROM rows\"; }",
        );
        let report = sql_confinement(&root);
        assert_eq!(report.findings.len(), 1, "{:?}", report.findings);
        assert!(report.findings[0].contains("crates/net/src/lib.rs"));
        assert!(report.findings[0].contains("SELECT"));
    }

    #[test]
    fn sql_inside_the_allowed_crates_is_clean() {
        let root = fixture_dir("sql-green");
        write(
            &root,
            "crates/apps/kit/src/lib.rs",
            "fn q() { let _ = \"SELECT 1\"; }",
        );
        write(
            &root,
            "crates/net/src/lib.rs",
            "/// SELECT is discussed here only\nfn q() {}",
        );
        assert!(sql_confinement(&root).findings.is_empty());
    }

    #[test]
    fn a_sixth_abi_symbol_is_caught() {
        let root = fixture_dir("abi-red");
        let mut source = String::new();
        for name in ["open", "call", "next_event", "free", "close", "extra"] {
            source.push_str(&format!(
                "#[no_mangle]\npub extern \"C\" fn centraid_{name}() {{}}\n"
            ));
        }
        write(&root, "crates/core-ffi/src/lib.rs", &source);
        let report = abi_symbol_count(&root);
        assert_eq!(report.findings.len(), 1);
        assert!(report.findings[0].contains("6 `extern \"C\"` symbol(s)"));
    }

    #[test]
    fn exactly_five_abi_symbols_is_clean() {
        let root = fixture_dir("abi-green");
        let mut source = String::new();
        for name in ["open", "call", "next_event", "free", "close"] {
            source.push_str(&format!(
                "#[no_mangle]\npub extern \"C\" fn centraid_{name}() {{}}\n"
            ));
        }
        write(&root, "crates/core-ffi/src/lib.rs", &source);
        assert!(abi_symbol_count(&root).findings.is_empty());
    }

    #[test]
    fn the_abi_rule_is_pending_until_the_crate_lands() {
        let root = fixture_dir("abi-pending");
        write(&root, "crates/net/src/lib.rs", "fn nothing() {}");
        let report = abi_symbol_count(&root);
        assert!(matches!(report.state, RuleState::Pending(_)));
        assert!(report.findings.is_empty());
    }

    #[test]
    fn an_unguarded_listener_is_caught_and_a_guarded_one_is_not() {
        let source = "\
fn open() {
    let _ = TcpListener::bind(\"0.0.0.0:0\");
}
#[cfg(feature = \"blob-door\")]
fn door() {
    let _ = TcpListener::bind(\"0.0.0.0:8443\");
}
";
        let hits = listener_hits(source);
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].0, 2);
    }

    #[test]
    fn the_listener_rule_reports_the_file_and_line() {
        let root = fixture_dir("listener-red");
        write(
            &root,
            "crates/net/src/lib.rs",
            "fn serve() {\n    let _ = tokio::net::TcpListener::bind(\"0.0.0.0:1\");\n}\n",
        );
        let report = no_listening_socket(&root);
        assert_eq!(report.findings.len(), 1);
        assert!(report.findings[0].contains("crates/net/src/lib.rs:2"));
    }

    #[test]
    fn a_platform_import_in_commonmain_is_caught() {
        let root = fixture_dir("commonmain-red");
        write(
            &root,
            "mobile/shared/src/commonMain/kotlin/Tally.kt",
            "package tally\n\nimport android.os.Bundle\nimport kotlin.time.Duration\n",
        );
        let report = commonmain_no_platform_import(&root);
        assert_eq!(report.findings.len(), 1, "{:?}", report.findings);
        assert!(report.findings[0].contains("android.os.Bundle"));
    }

    #[test]
    fn commonmain_without_platform_imports_is_clean() {
        let root = fixture_dir("commonmain-green");
        write(
            &root,
            "mobile/shared/src/commonMain/kotlin/Tally.kt",
            "package tally\n\nimport kotlinx.coroutines.flow.StateFlow\n",
        );
        assert!(commonmain_no_platform_import(&root).findings.is_empty());
    }

    fn write(root: &Path, relative: &str, contents: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("a parent")).expect("create fixture dirs");
        fs::write(path, contents).expect("write fixture");
    }
}
