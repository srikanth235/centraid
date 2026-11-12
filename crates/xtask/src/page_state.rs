//! `page-state` — every screen that reads says so on the kit's one page (#1185).
//!
//! A screen that reads draws one of five things: loading, a failure with Retry, the vault's gate,
//! an empty page, or its data (under a note when a refresh failed). Rust says which in
//! `PageState page`, the shells draw it through the one shared view, and no screen keeps an arm of
//! its own. Nothing compiles both shells here, so the rule holds the two halves it can see:
//!
//! 1. **No screen proto keeps a read arm of its own.** No message but `PageState` has a `Loading`
//!    field (the old `oneof content { loading, failure, denied }`) or both a `Failure` and a
//!    `Denied`. A lone `Failure` is a write's or a sheet's refusal, not a read.
//! 2. **A screen that reads carries the page.** For every state in `ViewState`'s `kind` oneof, the
//!    Rust that builds it (the file with its `view_state::Kind::<State>(`, and the module's other
//!    files when that file is a `mod.rs`) is scanned for a read (`read::read(`, `ctx.load(`,
//!    `reading::load(`, a `Reading::` arm). If it reads and the state can draw what it read (a
//!    field that is repeated or a message of its own, beyond the status line), the state, or a
//!    message reachable from it, must have a `PageState page` field. A screen that reads nothing,
//!    or whose state is only scalars and a status line, needs none: the verdict is made from the
//!    protos and the sources, so there is no list of exempt screens.
//! 3. **No screen keeps a read state of its own in Rust.** No `enum` in the screens crate has both
//!    a `Loading` and a `Failed` variant (a private `Phase`): `kit::read::Page` is the one.
//!
//! The sweep test (`crates/screens/tests/page_sweep.rs`) is the behaviour half: every screen with a
//! failing read is Failed, never Empty or Ready.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::rules::{RuleReport, relative, source_files};

const NAME: &str = "page-state";

/// The kit's message that holds the read states, the only message allowed the arms.
const PAGE_MESSAGE: &str = "PageState";

/// The file that defines `kit::read::Page`, the one enum with a `Loading` and a `Failed`.
const PAGE_HOME: &str = "crates/screens/src/kit/read.rs";

/// The types that were a screen's own read arms.
const READ_ARMS: [&str; 3] = ["Loading", "Failure", "Denied"];

/// What reading looks like in a screen's source.
const READS: [&str; 5] = [
    "read::read(",
    "ctx.load(",
    "reading::load(",
    "Reading::Data(",
    "Reading::Failed",
];

/// The rule, over the tree at `root`.
pub fn page_state(root: &Path) -> RuleReport {
    let proto_dir = root.join("crates/api-proto/proto/centraid/core/v1");
    let screens = proto_dir.join("screens.proto");
    let Ok(view_state) = fs::read_to_string(&screens) else {
        return RuleReport::pending(NAME, "no screens.proto");
    };
    let mut messages: BTreeMap<String, Vec<Field>> = BTreeMap::new();
    let mut enums: BTreeSet<String> = BTreeSet::new();
    let mut files = 0usize;
    let mut protos: Vec<PathBuf> = source_files(&proto_dir, "proto")
        .into_iter()
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == "screens.proto" || name.ends_with("_screens.proto"))
        })
        .collect();
    protos.sort();
    let mut findings = Vec::new();
    for path in &protos {
        files += 1;
        let source = fs::read_to_string(path).unwrap_or_default();
        enums.extend(enum_names(&source));
        for (message, fields) in parse_messages(&source) {
            if message != PAGE_MESSAGE {
                let has = |kind: &str| fields.iter().any(|field| field.kind == kind);
                let own_arms = has("Loading") || (has("Failure") && has("Denied"));
                for field in &fields {
                    if own_arms && READ_ARMS.contains(&field.kind.as_str()) {
                        findings.push(format!(
                            "{}: `{message}.{}` is its own `{}` arm; the read is `PageState page`",
                            relative(root, path),
                            field.name,
                            field.kind
                        ));
                    }
                }
            }
            messages.entry(message).or_default().extend(fields);
        }
    }

    let sources = rust_sources(root);
    for (state, variant) in view_states(&view_state) {
        let builders: Vec<&PathBuf> = sources
            .iter()
            .filter(|(_, text)| text.contains(&format!("view_state::Kind::{variant}(")))
            .map(|(path, _)| path)
            .collect();
        let Some(reads) = reads_of(&builders, &sources) else {
            continue;
        };
        if !draws_data(&state, &messages, &enums) {
            continue;
        }
        if !reaches_page(&state, &messages, &mut BTreeSet::new()) {
            findings.push(format!(
                "{state}: its Rust reads ({reads}) but the state has no `PageState page`"
            ));
        }
    }
    for (path, text) in &sources {
        // `kit::read::Page` is the one read state; it is where the enum is allowed to live.
        if relative(root, path) == PAGE_HOME {
            continue;
        }
        for name in own_read_enums(text) {
            findings.push(format!(
                "{}: `enum {name}` keeps a read state of its own (Loading and Failed); use `kit::read::Page`",
                relative(root, path)
            ));
        }
    }
    RuleReport::applied(NAME, files + sources.len(), findings)
}

/// The names of the enums a proto declares.
fn enum_names(source: &str) -> Vec<String> {
    source
        .lines()
        .filter_map(|line| {
            let line = line.split("//").next().unwrap_or("").trim();
            line.strip_prefix("enum ")
                .map(|rest| rest.trim_end_matches('{').trim().to_owned())
        })
        .collect()
}

const SCALARS: [&str; 15] = [
    "string", "bool", "bytes", "double", "float", "int32", "int64", "uint32", "uint64", "sint32",
    "sint64", "fixed32", "fixed64", "sfixed32", "sfixed64",
];

/// Whether a state can draw what it read: a repeated field, or a message of its own (not the
/// status line, a confirm or a route, which carry no read).
fn draws_data(
    state: &str,
    messages: &BTreeMap<String, Vec<Field>>,
    enums: &BTreeSet<String>,
) -> bool {
    messages.get(state).is_some_and(|fields| {
        fields.iter().any(|field| {
            field.repeated
                || !(SCALARS.contains(&field.kind.as_str())
                    || enums.contains(&field.kind)
                    || matches!(field.kind.as_str(), "StatusLine" | "Confirm" | "Route"))
        })
    })
}

/// Whether `message`, or one reachable through its fields, has a `PageState page`.
fn reaches_page(
    message: &str,
    messages: &BTreeMap<String, Vec<Field>>,
    seen: &mut BTreeSet<String>,
) -> bool {
    if !seen.insert(message.to_owned()) {
        return false;
    }
    let Some(fields) = messages.get(message) else {
        return false;
    };
    fields.iter().any(|field| {
        (field.kind == PAGE_MESSAGE && field.name == "page")
            || reaches_page(&field.kind, messages, seen)
    })
}

/// The enums of a Rust source that have both a `Loading` and a `Failed` variant.
fn own_read_enums(source: &str) -> Vec<String> {
    let code = source.split("#[cfg(test)]").next().unwrap_or(source);
    let mut out = Vec::new();
    let mut lines = code.lines().peekable();
    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        let Some(rest) = trimmed
            .strip_prefix("enum ")
            .or_else(|| trimmed.strip_prefix("pub enum "))
            .or_else(|| trimmed.strip_prefix("pub(crate) enum "))
            .or_else(|| trimmed.strip_prefix("pub(super) enum "))
        else {
            continue;
        };
        let name: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        let mut variants: Vec<String> = Vec::new();
        // An enum written on one line: `enum Phase { Loading, Failed }`.
        if let (Some(open), Some(close)) = (trimmed.find('{'), trimmed.rfind('}')) {
            variants.extend(
                trimmed[open + 1..close]
                    .split(',')
                    .map(|variant| variant.trim().to_owned()),
            );
        }
        let mut depth = i32::from(trimmed.contains('{') && !trimmed.contains('}'));
        while depth > 0 {
            let Some(body) = lines.next() else { break };
            depth += i32::try_from(body.matches('{').count()).unwrap_or(0);
            depth -= i32::try_from(body.matches('}').count()).unwrap_or(0);
            if depth <= 0 {
                break;
            }
            let head: String = body
                .trim()
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !head.is_empty() && depth == 1 {
                variants.push(head);
            }
        }
        if variants.iter().any(|v| v == "Loading") && variants.iter().any(|v| v == "Failed") {
            out.push(name);
        }
    }
    out
}

/// A message field: its type and its name.
#[derive(Clone, Debug)]
struct Field {
    kind: String,
    name: String,
    repeated: bool,
}

/// Every message and its fields (a oneof's arms included), nested messages as their own.
fn parse_messages(source: &str) -> Vec<(String, Vec<Field>)> {
    let mut out: Vec<(String, Vec<Field>)> = Vec::new();
    let mut stack: Vec<Option<usize>> = Vec::new();
    for raw in source.lines() {
        let line = raw.split("//").next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("message ") {
            let name = rest.trim_end_matches('{').trim().to_owned();
            out.push((name, Vec::new()));
            stack.push(Some(out.len() - 1));
            if line.ends_with('}') {
                stack.pop();
            }
            continue;
        }
        if line.starts_with("enum ") || line.starts_with("oneof ") {
            stack.push(None);
            continue;
        }
        if line.starts_with('}') {
            stack.pop();
            continue;
        }
        // The message a field belongs to: the nearest message on the stack (a oneof or enum
        // inside it adds no message of its own, but a oneof's arms are its fields).
        let owner = stack.iter().rev().find_map(|entry| *entry);
        let inside_enum = false;
        if let (Some(owner), false) = (owner, inside_enum)
            && let Some(field) = parse_field(line)
        {
            out[owner].1.push(field);
        }
    }
    out
}

/// `[optional|repeated] Type name = N;`, or none for a statement that is not a field.
fn parse_field(line: &str) -> Option<Field> {
    let line = line.trim_end_matches(';').trim();
    if line.starts_with("reserved ")
        || line.starts_with("option ")
        || line.starts_with("syntax")
        || line.starts_with("package")
        || line.starts_with("import")
    {
        return None;
    }
    let (declaration, number) = line.split_once('=')?;
    if !number
        .trim()
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_digit())
    {
        return None;
    }
    let mut words: Vec<&str> = declaration.split_whitespace().collect();
    let repeated = words.first() == Some(&"repeated");
    if matches!(words.first(), Some(&"optional" | &"repeated")) {
        words.remove(0);
    }
    if words.len() != 2 {
        return None;
    }
    Some(Field {
        kind: words[0].to_owned(),
        name: words[1].to_owned(),
        repeated,
    })
}

/// `ViewState`'s `kind` oneof: each state's message and the Rust variant (`agenda_home` →
/// `AgendaHome`).
fn view_states(source: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut inside = false;
    for raw in source.lines() {
        let line = raw.split("//").next().unwrap_or("").trim();
        if line.starts_with("message ViewState") {
            inside = true;
            continue;
        }
        if !inside {
            continue;
        }
        if line == "}" {
            // The oneof's close comes first; the message's close ends the scan.
            if out.is_empty() {
                continue;
            }
        }
        if let Some(field) = parse_field(line)
            && field.kind != "uint64"
        {
            out.push((field.kind, camel(&field.name)));
        }
        if line.starts_with("message ") {
            break;
        }
    }
    out
}

fn camel(name: &str) -> String {
    name.split('_')
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
                .unwrap_or_default()
        })
        .collect()
}

/// Every Rust source of the screens crate that is not a test, with its text.
fn rust_sources(root: &Path) -> Vec<(PathBuf, String)> {
    let mut out: Vec<(PathBuf, String)> = source_files(&root.join("crates/screens/src"), "rs")
        .into_iter()
        .map(|path| {
            let text = fs::read_to_string(&path).unwrap_or_default();
            (path, text)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// What the screen built by `builders` reads, or `None` when it reads nothing. A builder named
/// `mod.rs` is a module directory: its sibling files are the screen's too.
fn reads_of(builders: &[&PathBuf], sources: &[(PathBuf, String)]) -> Option<String> {
    for builder in builders {
        let mut scanned: Vec<&PathBuf> = vec![builder];
        if builder.file_name().is_some_and(|name| name == "mod.rs")
            && let Some(dir) = builder.parent()
        {
            scanned.extend(
                sources
                    .iter()
                    .map(|(path, _)| path)
                    .filter(|path| path.parent() == Some(dir) && path != builder),
            );
        }
        for path in scanned {
            let Some((_, text)) = sources.iter().find(|(candidate, _)| candidate == path) else {
                continue;
            };
            // The unit tests at the foot of a file are not the screen.
            let code = text.split("#[cfg(test)]").next().unwrap_or(text);
            if let Some(read) = READS.iter().find(|read| code.contains(*read)) {
                return Some(format!(
                    "`{}` in {}",
                    read.trim_end_matches('('),
                    path.file_name().and_then(|n| n.to_str()).unwrap_or("?")
                ));
            }
        }
    }
    None
}

#[cfg(test)]
#[path = "page_state_tests.rs"]
mod tests;
