//! THE CORE'S NOTES ANSWERS, AS FINISHED ROWS. Pure; every word from
//! `strings::notes` or the kit's civil words.
//!
//! DATES ARE THE MEMBER'S DAYS. A library row's "Edited 3 March" is
//! `updated_local_day` (else `created_local_day`), which the core read in the
//! request's zone; no zone arithmetic happens here. A search hit's is the same
//! pair, read in the zone the search states. An answer with no zone resolved
//! says no day at all — never a UTC instant's.

use centraid_api_proto::core_v1 as wire;

use super::routes;
use crate::kit::civil;
use crate::strings::{Locale, fill, notes as words};

/// The characters a title derived from a body's first line may hold.
const TITLE_FROM_BODY: usize = 80;

/// The first non-blank line of `body`, trimmed, at most 80 characters.
#[must_use]
pub fn first_line(body: &str) -> String {
    body.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(TITLE_FROM_BODY).collect())
        .unwrap_or_default()
}

/// The title, else the preview's first line, else "Untitled note".
#[must_use]
pub fn title_of(locale: Locale, title: Option<&str>, preview: &str) -> String {
    title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
        .or_else(|| Some(first_line(preview)).filter(|line| !line.is_empty()))
        .unwrap_or_else(|| words::untitled(locale))
}

/// "2 of 5 done", or empty when the note has no checklist.
#[must_use]
pub fn check_label(locale: Locale, done: u32, total: u32) -> String {
    if total == 0 {
        return String::new();
    }
    fill(
        &words::checks_done(locale),
        &[("done", &done.to_string()), ("total", &total.to_string())],
    )
}

/// "12 notes" / "1 note"; "200+ notes" when `more` lie beyond the window.
#[must_use]
pub fn notes_count(locale: Locale, count: usize, more: bool) -> String {
    let n = count as u64;
    if more {
        words::notes_count_more(locale, n)
    } else {
        words::notes_count(locale, n)
    }
}

/// A notebook's name, else "Untitled notebook".
#[must_use]
pub fn notebook_name(locale: Locale, notebook: &wire::NotesNotebook) -> String {
    notebook
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map_or_else(|| words::untitled_notebook(locale), str::to_owned)
}

/// What a row shows of one note, whichever answer it came from.
struct Parts<'a> {
    note_id: &'a str,
    title: Option<&'a str>,
    preview: &'a str,
    pinned: bool,
    local_day: &'a str,
    notebook_names: &'a [String],
    notebook_ids: &'a [String],
    check_total: u32,
    check_done: u32,
    runs: Vec<wire::NotesTextRun>,
}

fn note_row(locale: Locale, parts: Parts<'_>) -> wire::NotesNoteRow {
    let title = title_of(locale, parts.title, parts.preview);
    let edited = parts.local_day.get(..10).map_or_else(String::new, |day| {
        format!(
            "{} {}",
            words::edited(locale),
            civil::day_month(locale, day)
        )
    });
    let meta = std::iter::once(edited)
        .chain(
            parts
                .notebook_names
                .iter()
                .filter(|name| !name.trim().is_empty())
                .cloned(),
        )
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let check = check_label(locale, parts.check_done, parts.check_total);
    let spoken = [
        title.clone(),
        if parts.pinned {
            words::section_pinned(locale)
        } else {
            String::new()
        },
        meta.clone(),
        check.clone(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(", ");
    let snippet = if parts.runs.is_empty() {
        parts.preview.to_owned()
    } else {
        parts.runs.iter().map(|run| run.text.as_str()).collect()
    };
    wire::NotesNoteRow {
        note_id: parts.note_id.to_owned(),
        title,
        snippet,
        snippet_runs: parts.runs,
        meta,
        pinned: parts.pinned,
        check_label: check,
        accessibility_label: spoken,
        notebook_id: parts.notebook_ids.first().cloned().unwrap_or_default(),
        route: Some(routes::editor(parts.note_id)),
    }
}

/// A library (or trash) row.
#[must_use]
pub fn row(locale: Locale, row: &wire::NotesRow) -> wire::NotesNoteRow {
    let local_day = if row.updated_local_day.is_empty() {
        &row.created_local_day
    } else {
        &row.updated_local_day
    };
    note_row(
        locale,
        Parts {
            note_id: &row.note_id,
            title: row.title.as_deref(),
            preview: &row.preview,
            pinned: row.pinned,
            local_day,
            notebook_names: &row.notebook_names,
            notebook_ids: &row.notebook_ids,
            check_total: row.check_total,
            check_done: row.check_done,
            runs: Vec::new(),
        },
    )
}

/// A search hit: its snippet's matches are runs.
#[must_use]
pub fn hit(locale: Locale, hit: &wire::NotesSearchHit) -> wire::NotesNoteRow {
    let local_day = if hit.updated_local_day.is_empty() {
        &hit.created_local_day
    } else {
        &hit.updated_local_day
    };
    note_row(
        locale,
        Parts {
            note_id: &hit.note_id,
            title: hit.title.as_deref(),
            preview: &hit.preview,
            pinned: hit.pinned,
            local_day,
            notebook_names: &hit.notebook_names,
            notebook_ids: &hit.notebook_ids,
            check_total: hit.check_total,
            check_done: hit.check_done,
            runs: runs_of(&hit.snippet),
        },
    )
}

/// `⟦match⟧` spans as runs. No marker: no runs (the preview is drawn).
#[must_use]
pub fn runs_of(snippet: &str) -> Vec<wire::NotesTextRun> {
    const OPEN: char = '⟦';
    const CLOSE: char = '⟧';
    if !snippet.contains(OPEN) {
        return Vec::new();
    }
    let mut runs = Vec::new();
    let mut rest = snippet;
    while !rest.is_empty() {
        let Some(open) = rest.find(OPEN) else {
            runs.push(run(rest, false));
            break;
        };
        if open > 0 {
            runs.push(run(&rest[..open], false));
        }
        let after = &rest[open + OPEN.len_utf8()..];
        let Some(close) = after.find(CLOSE) else {
            runs.push(run(after, false));
            break;
        };
        runs.push(run(&after[..close], true));
        rest = &after[close + CLOSE.len_utf8()..];
    }
    runs.retain(|run| !run.text.is_empty());
    runs
}

fn run(text: &str, highlighted: bool) -> wire::NotesTextRun {
    wire::NotesTextRun {
        text: text.to_owned(),
        highlighted,
    }
}

/// The notebooks a note may be filed into, the current one marked; "No
/// notebook" leads.
#[must_use]
pub fn file_choices(
    locale: Locale,
    notebooks: &[wire::NotesNotebook],
    current: &str,
) -> Vec<wire::NotesChoice> {
    std::iter::once(wire::NotesChoice {
        id: String::new(),
        label: words::no_notebook(locale),
        selected: current.is_empty(),
        sort: 0,
    })
    .chain(notebooks.iter().map(|notebook| wire::NotesChoice {
        id: notebook.notebook_id.clone(),
        label: notebook_name(locale, notebook),
        selected: notebook.notebook_id == current,
        sort: 0,
    }))
    .collect()
}

/// The section head `Pinned (3)` / `Notes (9)` over `rows`.
fn section(title: String, rows: Vec<wire::NotesNoteRow>) -> wire::NotesLibrarySection {
    wire::NotesLibrarySection {
        head: Some(wire::NotesSectionHead {
            title,
            count: u32::try_from(rows.len()).unwrap_or(u32::MAX),
        }),
        rows,
    }
}

/// PINNED FIRST, as the core ordered them: a "Pinned" section, then the rest.
#[must_use]
pub fn sections(locale: Locale, rows: Vec<wire::NotesNoteRow>) -> Vec<wire::NotesLibrarySection> {
    if rows.is_empty() {
        return Vec::new();
    }
    let (pinned, rest): (Vec<_>, Vec<_>) = rows.into_iter().partition(|row| row.pinned);
    if pinned.is_empty() {
        return vec![section(words::section_notes(locale), rest)];
    }
    if rest.is_empty() {
        return vec![section(words::section_pinned(locale), pinned)];
    }
    vec![
        section(words::section_pinned(locale), pinned),
        section(words::section_notes(locale), rest),
    ]
}

/// The powerbox's seven columns, by the kind the index names.
fn domain_of(locale: Locale, entity: &str) -> String {
    match entity {
        "note" => words::domain_notes(locale),
        "person" => words::domain_people(locale),
        "event" => words::domain_events(locale),
        "task" => words::domain_tasks(locale),
        "document" => words::domain_docs(locale),
        "photo" => words::domain_photos(locale),
        "locker_item" => words::domain_locker(locale),
        _ => words::domain_other(locale),
    }
}

/// What one target IS, in a word; unknown kinds say nothing.
fn kind_of(locale: Locale, entity: &str) -> String {
    match entity {
        "note" => words::link_kind_note(locale),
        "person" => words::link_kind_person(locale),
        "event" => words::link_kind_event(locale),
        "task" => words::link_kind_task(locale),
        "document" => words::link_kind_document(locale),
        "photo" => words::link_kind_photograph(locale),
        "locker_item" => words::link_kind_locker_item(locale),
        _ => String::new(),
    }
}

/// The characters an excerpt subtitle may hold.
const EXCERPT: usize = 80;

/// THE SUBTITLE AS WORDS. The search index answers a raw column: an event's
/// `dtstart`, a task's `due_at`, an expense's `spent_on`, a note's decoded body,
/// else the app's name. A day is a civil day in words ("Wed 11 March");
/// anything else is a clean excerpt — its first line with the markdown marks
/// taken out, capped.
///
/// The day is the core's `subtitle_local_day`, read in the device's zone —
/// never the instant's own date part. A when the core could not place (an
/// instant, no zone) says what kind of thing the row is instead.
#[must_use]
pub fn subtitle_of(locale: Locale, target: &wire::NotesLinkTarget) -> String {
    let subtitle = target.subtitle.trim();
    // THE INDEX'S FALLBACK IS THE APP KEY ("photos", "docs") when a row has no
    // subtitle column of its own — an identifier, not copy.
    // The same goes for the entity's own kind name ("note", "person").
    if subtitle == target.app_id || subtitle == target.entity {
        return kind_of(locale, &target.entity);
    }
    if let Some(day) = target.subtitle_local_day.get(..10) {
        let words = civil::day_month(locale, day);
        if words != target.subtitle_local_day {
            return words;
        }
    }
    if looks_like_when(subtitle) {
        return kind_of(locale, &target.entity);
    }
    excerpt(&target.subtitle)
}

/// `2026-03-11`, `2026-03-11T09:00:00Z`, `2026-03-11 09:00`: a day or an instant.
fn looks_like_when(text: &str) -> bool {
    let bytes = text.as_bytes();
    let digits = |from: usize, count: usize| {
        bytes
            .get(from..from + count)
            .is_some_and(|part| part.iter().all(u8::is_ascii_digit))
    };
    let at = |index: usize, byte: u8| bytes.get(index) == Some(&byte);
    if !(digits(0, 4) && at(4, b'-') && digits(5, 2) && at(7, b'-') && digits(8, 2)) {
        return false;
    }
    if bytes.len() == 10 {
        return true;
    }
    (at(10, b'T') || at(10, b' ')) && digits(11, 2) && at(13, b':') && digits(14, 2)
}

/// The first non-blank line of `markdown`, unmarked and capped at 80 characters.
#[must_use]
pub fn excerpt(markdown: &str) -> String {
    let Some(line) = markdown.lines().map(unmark).find(|line| !line.is_empty()) else {
        return String::new();
    };
    if line.chars().count() <= EXCERPT {
        line
    } else {
        let mut cut: String = line.chars().take(EXCERPT).collect();
        cut = cut.trim_end().to_owned();
        cut.push('…');
        cut
    }
}

/// One line without its markdown: block marks at the start, image and link
/// syntax reduced to their text, `[[wiki]]` links to their title, emphasis marks.
fn unmark(line: &str) -> String {
    let mut text = line.trim().to_owned();
    text = strip_block_marks(&text);
    text = replace_bracketed(&text, "![", "](", ")");
    text = replace_bracketed(&text, "[[", "]]", "");
    text = replace_bracketed(&text, "[", "](", ")");
    for mark in ["**", "__", "~~", "`"] {
        text = text.replace(mark, "");
    }
    text = strip_single_emphasis(&text);
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Heading, quote, list and task marks at a line's start — repeated, as
/// `> - [ ] ` nests them.
fn strip_block_marks(line: &str) -> String {
    let mut rest = line;
    loop {
        let trimmed = rest.trim_start();
        let after = [
            "###### ", "##### ", "#### ", "### ", "## ", "# ", "> ", "- ", "* ", "+ ", "[ ] ",
            "[x] ", "[X] ",
        ]
        .iter()
        .find_map(|mark| trimmed.strip_prefix(mark))
        .or_else(|| numbered(trimmed));
        match after {
            Some(next) => rest = next,
            None => return trimmed.to_owned(),
        }
    }
}

/// `12. ` or `3) ` at a line's start.
fn numbered(text: &str) -> Option<&str> {
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let rest = &text[digits..];
    rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "))
}

/// `open text mid target close` reduced to `text` (or, with an empty `mid`, to
/// the text between `open` and `close`), for every occurrence.
fn replace_bracketed(text: &str, open: &str, mid: &str, close: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(open) {
        let inner = &rest[start + open.len()..];
        let Some(end) = inner.find(mid) else {
            break;
        };
        let label = &inner[..end];
        let after_mid = &inner[end + mid.len()..];
        let tail = if close.is_empty() {
            Some(after_mid)
        } else {
            after_mid
                .find(close)
                .map(|at| &after_mid[at + close.len()..])
        };
        let Some(tail) = tail else {
            break;
        };
        // A `[` link must not swallow a wiki-style double bracket.
        if label.contains('[') {
            break;
        }
        out.push_str(&rest[..start]);
        out.push_str(label);
        rest = tail;
    }
    out.push_str(rest);
    out
}

/// `*` and `_` emphasis marks that are not inside a word.
fn strip_single_emphasis(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let word = |c: Option<&char>| c.is_some_and(|c| c.is_alphanumeric() || *c == '_');
    let mut out = String::new();
    for (index, &c) in chars.iter().enumerate() {
        if c == '*' || c == '_' {
            let before = index.checked_sub(1).and_then(|i| chars.get(i));
            let after = chars.get(index + 1);
            if !(word(before) && word(after)) {
                continue;
            }
        }
        out.push(c);
    }
    out
}

/// The powerbox's rows, grouped by domain in the core's order.
#[must_use]
pub fn link_domains(
    locale: Locale,
    targets: &[wire::NotesLinkTarget],
) -> Vec<wire::NotesLinkDomain> {
    let mut domains: Vec<(String, Vec<wire::NotesLinkTargetRow>)> = Vec::new();
    for target in targets {
        let label = domain_of(locale, &target.entity);
        let subtitle = subtitle_of(locale, target);
        let title = if target.title.trim().is_empty() {
            words::untitled(locale)
        } else {
            target.title.clone()
        };
        let row = wire::NotesLinkTargetRow {
            entity: target.entity.clone(),
            id: target.id.clone(),
            accessibility_label: [target.title.as_str(), subtitle.as_str(), label.as_str()]
                .into_iter()
                .filter(|part| !part.trim().is_empty())
                .collect::<Vec<_>>()
                .join(", "),
            title,
            subtitle,
            app_id: target.app_id.clone(),
        };
        match domains.iter_mut().find(|(name, _)| *name == label) {
            Some((_, rows)) => rows.push(row),
            None => domains.push((label, vec![row])),
        }
    }
    domains
        .into_iter()
        .map(|(title, rows)| wire::NotesLinkDomain {
            head: Some(wire::NotesSectionHead {
                title,
                count: u32::try_from(rows.len()).unwrap_or(u32::MAX),
            }),
            rows,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_first_line_skips_blanks_and_caps_at_eighty() {
        assert_eq!(first_line("\n  \n  Milk and eggs  \nmore"), "Milk and eggs");
        assert_eq!(first_line(&"x".repeat(200)).chars().count(), 80);
        assert_eq!(first_line("   "), "");
    }

    #[test]
    fn snippet_matches_are_highlighted_runs() {
        let runs = runs_of("a ⟦match⟧ here");
        let shape: Vec<(&str, bool)> = runs
            .iter()
            .map(|run| (run.text.as_str(), run.highlighted))
            .collect();
        assert_eq!(shape, [("a ", false), ("match", true), (" here", false)]);
        assert!(runs_of("no marker").is_empty());
    }

    #[test]
    fn an_excerpt_drops_markdown_marks() {
        assert_eq!(
            excerpt("## **Bold** and [a link](http://x) and [[Wiki]]"),
            "Bold and a link and Wiki"
        );
        assert_eq!(excerpt("> - [ ] buy milk"), "buy milk");
        assert_eq!(excerpt(&"word ".repeat(40)).chars().count(), 80);
    }

    #[test]
    fn a_when_shape_is_a_day_or_an_instant() {
        assert!(looks_like_when("2026-03-11"));
        assert!(looks_like_when("2026-03-11T09:00:00Z"));
        assert!(looks_like_when("2026-03-11 09:00"));
        assert!(!looks_like_when("Meeting notes 2026-03-11"));
    }
}
