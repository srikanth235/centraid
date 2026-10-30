//! `native-shell-parity` — a field one shell reads, the other must read too
//! (#1152).
//!
//! The shells draw Rust's `ViewState` and perform its `Effect`s
//! (`crates/api-proto/proto/centraid/core/v1/*_screens.proto` and
//! `screens.proto`). Nothing compiles both of them on one machine, so a field
//! Rust added for a view could be drawn by SwiftUI and silently forgotten by
//! Compose (or the other way round) for as long as nobody looked. This rule
//! takes the census a reviewer would: every field of every message in those
//! files, and which shell's hand-written source reads it.
//!
//! A field is READ by a shell when a spelling of its name occurs in that
//! shell's source (comments cut, string contents kept: an interpolation is
//! code):
//!
//! - **Kotlin**, Wire's proto spelling: `.name` or a named argument/assignment
//!   `name =`, and the same with the `_` Wire appends to a name that clashes
//!   with a Kotlin word (`data_`, `open_`, `value_`). A `val name =` is a local,
//!   not a read.
//! - **Swift**, SwiftProtobuf's camelCase: `receiver.name`, a label `name:`, and
//!   the same with the `_p` the generator appends to a name that clashes with
//!   its own accessors (`hasValue_p`, `clearAfterMs_p`). `id` and `url` are
//!   initialisms (`photoID`, `openURL`). A oneof arm is also read as an
//!   implicit member (`case .clipboardSet(let set)?`); any other field needs a
//!   receiver, so `.hidden` in `.scrollContentBackground(.hidden)` is not
//!   `AgendaCalendarChoice.hidden`.
//!
//! WHAT THE CENSUS CANNOT SEE: the match is by FIELD NAME, not by message (no
//! type resolution here), so two messages sharing a name share a verdict, and a
//! Kotlin call that passes a field positionally never spells it. The register
//! says so beside each entry that is a collision rather than a real read.
//!
//! The rule's verdict is the register's ratchet: [`REGISTER`] names every item
//! that is not read by both shells, as one of four statuses:
//!
//! - [`Status::Platform`]: the other platform has no such thing (with the reason).
//! - [`Status::Gap`]: a lane owes the other shell a read, or the field is read by
//!   neither and waits for a decision to consume or delete it.
//! - [`Status::RustOnly`]: Rust writes it and Rust reads it back, or hands it from
//!   one screen or service to another; it round-trips through a shell untouched
//!   or never reaches a shell at all, and no shell is owed a read.
//! - [`Status::Runtime`]: the runtime itself originates or consumes it (a timer, a
//!   change notice, a service report); it is no shell's to send or draw.
//!
//! A [`Status::RustOnly`] or [`Status::Runtime`] row holds only while no shell
//! spells the field: the moment one does, the field is a shell's and the row is
//! stale (the rule says so). A closed gap must LEAVE the register, so the
//! register only shrinks once it is written.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::native_parity_register::REGISTER;
use crate::rules::{RuleReport, relative, source_files};

/// The shell a [`Status::Platform`] entry says is the only one with the thing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shell {
    Android,
    Ios,
}

/// Which shells do not read a [`Status::Gap`] item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Missing {
    /// Only SwiftUI reads it.
    Android,
    /// Only Compose reads it.
    Ios,
    /// Neither reads it.
    Both,
}

/// Why an item is not read by both shells.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Only this shell reads it, and the other platform has no such thing.
    Platform { only: Shell, why: &'static str },
    /// The item should be read by both and is not: `lane` owes it (A, B, C, D
    /// are the umbrella's lanes; F is "unowned, or read by neither: consume or
    /// delete").
    Gap {
        lane: &'static str,
        missing_on: Missing,
    },
    /// Rust writes it and Rust reads it back, or hands it from one screen or
    /// service to another (`Ctx::post`, a stored wire message): no shell is owed
    /// a read. `missing_on` is what the by-name census sees, which is
    /// [`Missing::Both`] unless a shell spells the NAME for an unrelated symbol
    /// (a collision, said in `why`); it must keep matching.
    RustOnly {
        why: &'static str,
        missing_on: Missing,
    },
    /// The runtime originates or consumes it (a timer, a change notice, a
    /// service report): it is no shell's to send or draw. `missing_on` as for
    /// [`Status::RustOnly`].
    Runtime {
        why: &'static str,
        missing_on: Missing,
    },
}

/// One register row: `"Message.field"` (nested messages as `Outer.Inner`).
pub type Entry = (&'static str, Status);

/// `Status::Platform`, as a row's right-hand side.
pub const fn platform(only: Shell, why: &'static str) -> Status {
    Status::Platform { only, why }
}

/// `Status::Gap`, as a row's right-hand side.
pub const fn gap(lane: &'static str, missing_on: Missing) -> Status {
    Status::Gap { lane, missing_on }
}

/// `Status::RustOnly`, as a row's right-hand side: no shell spells the field.
pub const fn rust_only(why: &'static str) -> Status {
    Status::RustOnly {
        why,
        missing_on: Missing::Both,
    }
}

/// `Status::RustOnly` for a field whose NAME one shell spells for an unrelated
/// symbol, so the by-name census sees `missing_on` (the collision is in `why`).
pub const fn rust_only_named(why: &'static str, missing_on: Missing) -> Status {
    Status::RustOnly { why, missing_on }
}

/// `Status::Runtime`, as a row's right-hand side: no shell spells the field.
pub const fn runtime(why: &'static str) -> Status {
    Status::Runtime {
        why,
        missing_on: Missing::Both,
    }
}

/// `Status::Runtime` for a field whose NAME one shell spells for an unrelated
/// symbol, so the by-name census sees `missing_on` (the collision is in `why`).
pub const fn runtime_named(why: &'static str, missing_on: Missing) -> Status {
    Status::Runtime { why, missing_on }
}

/// How much the census must see before it may pass: a check over a handful of
/// files passes forever.
#[derive(Clone, Copy)]
pub struct Floors {
    pub items: usize,
    pub kotlin: usize,
    pub swift: usize,
}

const FLOORS: Floors = Floors {
    items: 1000,
    kotlin: 50,
    swift: 50,
};

const NAME: &str = "native-shell-parity";

/// The rule, over the tree at `root` and the checked-in [`REGISTER`].
pub fn native_shell_parity(root: &Path) -> RuleReport {
    check(root, REGISTER, FLOORS)
}

// ---------------------------------------------------------------------------
// The sources
// ---------------------------------------------------------------------------

fn protos(root: &Path) -> Vec<PathBuf> {
    let dir = root.join("crates/api-proto/proto/centraid/core/v1");
    let mut out: Vec<PathBuf> = source_files(&dir, "proto")
        .into_iter()
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == "screens.proto" || name.ends_with("_screens.proto"))
        })
        .collect();
    out.sort();
    out
}

/// The Compose shell and the JVM binding it draws through (tests excluded).
fn kotlin_sources(root: &Path) -> Vec<PathBuf> {
    let mut out = source_files(&root.join("mobile/androidApp/src/main"), "kt");
    for set in ["commonMain", "jnaMain", "jvmMain", "androidMain"] {
        out.extend(source_files(&root.join("mobile/core/src").join(set), "kt"));
    }
    out.sort();
    out
}

/// The SwiftUI shell's hand-written sources and its C bridge, without protoc's
/// `Generated/`.
fn swift_sources(root: &Path) -> Vec<PathBuf> {
    let mut out = source_files(&root.join("mobile/iosApp/Sources"), "swift");
    out.extend(source_files(
        &root.join("mobile/iosApp/CoreBridge"),
        "swift",
    ));
    out.retain(|path| !relative(root, path).contains("/Generated/"));
    out.sort();
    out
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/// The text with every `//` line comment and every `/* */` block comment
/// (nested, as Kotlin and Swift nest them; KDoc included) cut. Newlines inside
/// a block comment stay, so a line number survives. String and character
/// literals are kept whole, contents and all: a `"*/*"` media type must not
/// close a comment and an interpolation `"\(state.label)"` is code.
fn without_comments(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0usize;
    let mut depth = 0usize;
    while at < bytes.len() {
        let rest = &bytes[at..];
        if depth > 0 {
            if rest.starts_with(b"/*") {
                depth += 1;
                at += 2;
            } else if rest.starts_with(b"*/") {
                depth -= 1;
                at += 2;
            } else {
                if bytes[at] == b'\n' {
                    out.push(b'\n');
                }
                at += 1;
            }
        } else if rest.starts_with(b"//") {
            while at < bytes.len() && bytes[at] != b'\n' {
                at += 1;
            }
        } else if rest.starts_with(b"/*") {
            depth = 1;
            at += 2;
        } else if rest.starts_with(b"\"\"\"") {
            let end = find(&bytes[at + 3..], b"\"\"\"").map_or(bytes.len(), |end| at + 3 + end + 3);
            out.extend_from_slice(&bytes[at..end]);
            at = end;
        } else if bytes[at] == b'"' {
            let mut end = at + 1;
            while end < bytes.len() && bytes[end] != b'"' && bytes[end] != b'\n' {
                end += if bytes[end] == b'\\' { 2 } else { 1 };
            }
            let end = (end + 1).min(bytes.len());
            out.extend_from_slice(&bytes[at..end]);
            at = end;
        } else if let Some(end) = char_literal_end(bytes, at) {
            out.extend_from_slice(&bytes[at..end]);
            at = end;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Where a `'x'` / `'\n'` character literal starting at `at` ends, so that
/// `'"'` does not open a string.
fn char_literal_end(bytes: &[u8], at: usize) -> Option<usize> {
    if bytes[at] != b'\'' {
        return None;
    }
    let next = *bytes.get(at + 1)?;
    if next == b'\\' {
        let close = bytes
            .get(at + 2..(at + 14).min(bytes.len()))?
            .iter()
            .position(|b| *b == b'\'')?;
        return Some(at + 2 + close + 1);
    }
    if next == b'\'' || next == b'\n' {
        return None;
    }
    let width = match next {
        0..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    };
    (bytes.get(at + 1 + width) == Some(&b'\'')).then_some(at + 1 + width + 1)
}

// ---------------------------------------------------------------------------
// The proto census
// ---------------------------------------------------------------------------

/// One field of one message, enum values excluded.
#[derive(Debug, PartialEq, Eq)]
struct Item {
    /// `Message.field`, nested messages qualified as `Outer.Inner.field`.
    key: String,
    field: String,
    /// A oneof arm: a shell reads it as an enum case, with no receiver.
    arm: bool,
}

enum Scope {
    Message(String),
    Oneof,
    /// An enum, a service, an option's body: nothing in it is a field.
    Opaque,
}

fn tokens(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < bytes.len() {
        let byte = bytes[at];
        if byte.is_ascii_whitespace() {
            at += 1;
        } else if byte == b'"' {
            let end = bytes[at + 1..]
                .iter()
                .position(|b| *b == b'"')
                .map_or(bytes.len(), |close| at + 1 + close + 1);
            out.push(text[at..end].to_owned());
            at = end;
        } else if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.' {
            let end = at
                + bytes[at..]
                    .iter()
                    .take_while(|b| b.is_ascii_alphanumeric() || **b == b'_' || **b == b'.')
                    .count();
            out.push(text[at..end].to_owned());
            at = end;
        } else {
            out.push((byte as char).to_string());
            at += 1;
        }
    }
    out
}

/// Every field of every message in `source`, in file order.
fn proto_items(source: &str) -> Vec<Item> {
    let mut items = Vec::new();
    let mut scopes: Vec<Scope> = Vec::new();
    let mut statement: Vec<String> = Vec::new();
    for token in tokens(&without_comments(source)) {
        match token.as_str() {
            "{" => {
                scopes.push(match statement.first().map(String::as_str) {
                    Some("message") => {
                        Scope::Message(statement.get(1).cloned().unwrap_or_default())
                    }
                    Some("oneof") => Scope::Oneof,
                    _ => Scope::Opaque,
                });
                statement.clear();
            }
            "}" => {
                scopes.pop();
                statement.clear();
            }
            ";" => {
                let declares = !matches!(
                    statement.first().map(String::as_str),
                    Some("reserved" | "option" | "syntax" | "package" | "import" | "extensions")
                );
                let top = scopes.last();
                if declares
                    && matches!(top, Some(Scope::Message(_) | Scope::Oneof))
                    && let Some(equals) = statement.iter().position(|word| word == "=")
                    && equals > 0
                {
                    let field = statement[equals - 1].clone();
                    let mut key: Vec<&str> = scopes
                        .iter()
                        .filter_map(|scope| match scope {
                            Scope::Message(name) => Some(name.as_str()),
                            _ => None,
                        })
                        .collect();
                    key.push(&field);
                    items.push(Item {
                        key: key.join("."),
                        arm: matches!(top, Some(Scope::Oneof)),
                        field,
                    });
                }
                statement.clear();
            }
            _ => statement.push(token),
        }
    }
    items
}

// ---------------------------------------------------------------------------
// What each shell reads
// ---------------------------------------------------------------------------

/// Every `[A-Za-z_][A-Za-z0-9_]*` in `text` with its byte range.
fn identifiers(text: &str) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < bytes.len() {
        if bytes[at].is_ascii_alphabetic() || bytes[at] == b'_' {
            let end = at
                + bytes[at..]
                    .iter()
                    .take_while(|b| b.is_ascii_alphanumeric() || **b == b'_')
                    .count();
            out.push((at, end));
            at = end;
        } else if bytes[at].is_ascii_digit() {
            // A number's suffix (`10L`, `0x1f`) is not a name.
            at += bytes[at..]
                .iter()
                .take_while(|b| b.is_ascii_alphanumeric() || **b == b'_')
                .count();
        } else {
            at += 1;
        }
    }
    out
}

/// The identifier ending just before `at`, past spaces and tabs.
fn word_before(text: &str, at: usize) -> &str {
    let bytes = text.as_bytes();
    let mut end = at;
    while end > 0 && (bytes[end - 1] == b' ' || bytes[end - 1] == b'\t') {
        end -= 1;
    }
    let mut start = end;
    while start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'_') {
        start -= 1;
    }
    &text[start..end]
}

/// The first byte at or after `at` that is not a space or a tab.
fn byte_after(text: &str, at: usize) -> Option<(usize, u8)> {
    let bytes = text.as_bytes();
    (at..bytes.len())
        .find(|index| bytes[*index] != b' ' && bytes[*index] != b'\t')
        .map(|index| (index, bytes[index]))
}

/// The names the Compose shell reads: `.name` and `name =`, not `val name =`.
fn kotlin_reads(code: &str, into: &mut BTreeSet<String>) {
    let bytes = code.as_bytes();
    for (start, end) in identifiers(code) {
        let name = &code[start..end];
        let dotted = start > 0 && bytes[start - 1] == b'.';
        let assigned = byte_after(code, end).is_some_and(|(index, byte)| {
            byte == b'='
                && bytes.get(index + 1) != Some(&b'=')
                && bytes.get(index + 1) != Some(&b'>')
        }) && !matches!(word_before(code, start), "val" | "var");
        if dotted || assigned {
            into.insert(name.to_owned());
        }
    }
}

/// The names the SwiftUI shell reads, by how they are spelled.
#[derive(Default)]
struct SwiftReads {
    /// `receiver.name`.
    receiver: BTreeSet<String>,
    /// `.name` with nothing before it: an enum case.
    implicit: BTreeSet<String>,
    /// `name:`, but not a declaration (`let name:`).
    label: BTreeSet<String>,
}

fn swift_reads(code: &str, into: &mut SwiftReads) {
    let bytes = code.as_bytes();
    for (start, end) in identifiers(code) {
        let name = &code[start..end];
        if start > 0 && bytes[start - 1] == b'.' {
            let receiver = start > 1
                && (bytes[start - 2].is_ascii_alphanumeric()
                    || matches!(bytes[start - 2], b'_' | b')' | b']' | b'?' | b'!'));
            if receiver {
                into.receiver.insert(name.to_owned());
            } else {
                into.implicit.insert(name.to_owned());
            }
        } else if bytes.get(end) == Some(&b':')
            && bytes.get(end + 1) != Some(&b':')
            && !matches!(word_before(code, start), "let" | "var")
        {
            into.label.insert(name.to_owned());
        }
    }
}

/// The two spellings SwiftProtobuf can give `field`: every word capitalised
/// (`photoId`), and with the initialisms it upper-cases (`photoID`, `openURL`).
fn swift_spellings(field: &str) -> BTreeSet<String> {
    let words: Vec<&str> = field.split('_').collect();
    let join = |initialisms: bool| -> String {
        let mut out = words[0].to_owned();
        for word in &words[1..] {
            if initialisms && matches!(*word, "id" | "url") {
                out.push_str(&word.to_ascii_uppercase());
            } else {
                let mut chars = word.chars();
                if let Some(first) = chars.next() {
                    out.extend(first.to_uppercase());
                    out.push_str(chars.as_str());
                }
            }
        }
        out
    };
    [join(false), join(true)].into_iter().collect()
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Observed {
    kotlin: bool,
    swift: bool,
}

impl Observed {
    fn missing(self) -> Option<Missing> {
        match (self.kotlin, self.swift) {
            (true, true) => None,
            (true, false) => Some(Missing::Ios),
            (false, true) => Some(Missing::Android),
            (false, false) => Some(Missing::Both),
        }
    }
}

fn observe(item: &Item, kotlin: &BTreeSet<String>, swift: &SwiftReads) -> Observed {
    let wire = [item.field.clone(), format!("{}_", item.field)];
    let spelled = swift_spellings(&item.field);
    let protobuf: Vec<String> = spelled
        .iter()
        .flat_map(|name| [name.clone(), format!("{name}_p")])
        .collect();
    Observed {
        kotlin: wire.iter().any(|name| kotlin.contains(name)),
        swift: protobuf.iter().any(|name| {
            swift.receiver.contains(name)
                || swift.label.contains(name)
                || (item.arm && swift.implicit.contains(name))
        }),
    }
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

fn describe(missing: Missing) -> &'static str {
    match missing {
        Missing::Android => "only SwiftUI reads it",
        Missing::Ios => "only Compose reads it",
        Missing::Both => "neither shell reads it",
    }
}

/// The rule over `root` with `register` and `floors`; the fixtures' door.
pub(crate) fn check(root: &Path, register: &[Entry], floors: Floors) -> RuleReport {
    let proto_files = protos(root);
    let kotlin_files = kotlin_sources(root);
    let swift_files = swift_sources(root);
    if proto_files.is_empty() {
        return RuleReport::pending(NAME, "no *_screens.proto under crates/api-proto");
    }
    if kotlin_files.is_empty() && swift_files.is_empty() {
        return RuleReport::pending(NAME, "no native shell sources");
    }
    let mut findings = Vec::new();

    let mut items = Vec::new();
    for file in &proto_files {
        items.extend(proto_items(&read(file)));
    }
    let mut kotlin = BTreeSet::new();
    for file in &kotlin_files {
        kotlin_reads(&without_comments(&read(file)), &mut kotlin);
    }
    let mut swift = SwiftReads::default();
    for file in &swift_files {
        swift_reads(&without_comments(&read(file)), &mut swift);
    }

    // AN EMPTY CENSUS IS A RULE THAT ALWAYS PASSES.
    if items.len() < floors.items
        || kotlin_files.len() < floors.kotlin
        || swift_files.len() < floors.swift
    {
        findings.push(format!(
            "the census sees {} proto item(s), {} Kotlin and {} Swift file(s); a rule over too little passes forever",
            items.len(),
            kotlin_files.len(),
            swift_files.len()
        ));
    }

    let mut rows: BTreeMap<&str, &Status> = BTreeMap::new();
    for (key, status) in register {
        if rows.insert(key, status).is_some() {
            findings.push(format!("{key}: in the register twice"));
        }
    }
    let keys: BTreeSet<&str> = items.iter().map(|item| item.key.as_str()).collect();
    for (key, _) in register {
        if !keys.contains(key) {
            findings.push(format!(
                "{key}: in the register, but no such field is in the screens protos; delete the entry"
            ));
        }
    }

    for item in &items {
        let observed = observe(item, &kotlin, &swift);
        let entry = rows.get(item.key.as_str()).copied();
        let Some(missing) = observed.missing() else {
            if entry.is_some() {
                findings.push(format!(
                    "{}: both shells read it now; delete its register entry (a closed gap leaves the register)",
                    item.key
                ));
            }
            continue;
        };
        let spelling = format!(
            "Kotlin `{}`, Swift `{}`",
            item.field,
            swift_spellings(&item.field)
                .into_iter()
                .collect::<Vec<_>>()
                .join("` or `")
        );
        match entry {
            None => findings.push(format!(
                "{}: {} ({spelling}); read it in the other shell, or register it in native_parity_register.rs",
                item.key,
                describe(missing)
            )),
            Some(Status::Platform { only, .. }) => {
                let holds = match only {
                    Shell::Android => missing == Missing::Ios,
                    Shell::Ios => missing == Missing::Android,
                };
                if !holds {
                    findings.push(format!(
                        "{}: registered as only {only:?} has it, but {} ({spelling})",
                        item.key,
                        describe(missing)
                    ));
                }
            }
            Some(Status::Gap { lane, missing_on }) => {
                if *missing_on != missing {
                    findings.push(format!(
                        "{}: registered as a lane {lane} gap missing on {missing_on:?}, but {} ({spelling}); update the entry",
                        item.key,
                        describe(missing)
                    ));
                }
            }
            Some(
                status @ (Status::RustOnly { missing_on, .. } | Status::Runtime { missing_on, .. }),
            ) => {
                if *missing_on != missing {
                    let kind = if matches!(status, Status::RustOnly { .. }) {
                        "Rust-only"
                    } else {
                        "runtime-originated"
                    };
                    let advice = if missing == Missing::Both {
                        "the name collision it was registered with is gone; register it without one"
                    } else {
                        "a shell reads it, so it is a shell's field now: read it in the other shell, or make the row a gap"
                    };
                    findings.push(format!(
                        "{}: registered as {kind} ({}), but {} ({spelling}); {advice}",
                        item.key,
                        describe(*missing_on),
                        describe(missing)
                    ));
                }
            }
        }
    }

    RuleReport::applied(
        NAME,
        proto_files.len() + kotlin_files.len() + swift_files.len(),
        findings,
    )
    .with_note(format!(
        " ({} item(s) in {} proto file(s), {} in the register)",
        items.len(),
        proto_files.len(),
        register.len()
    ))
}

#[cfg(test)]
#[path = "native_parity_tests.rs"]
mod tests;
