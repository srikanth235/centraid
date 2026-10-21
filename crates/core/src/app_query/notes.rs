//! NOTES' ARM OF THE APP QUERY (#1046): `crates/apps/notes`' folds, asked
//! through [`super::VaultDoor`] and spelled as `notes.proto` spells them.
//!
//! The fold, the journal asymmetry (D-1020-N3), the version-chain refusal
//! (D-1020-N2), the powerbox (D-1020-N1), the shelf's sort and filters and the
//! Journal's local days are the crate's; this module resolves the zone, opens
//! the FTS door over the read connection, runs the loader and converts.
//!
//! # A MALFORMED CHAIN IS A DENIAL HERE, NOT AN ERROR
//!
//! `load_history` folds a cycle or an over-long chain onto the payload's
//! denial, which is the shape a screen renders (the crate's README). The door
//! did not fail, so [`super::settle`] answers it as `denied` with the chain's
//! own sentence.

use centraid_api_proto::core_v1 as wire;
use centraid_apps_notes as notes;
use centraid_apps_notes::cards::{OwnerCards, RefCard};
use centraid_apps_notes::queries::{self, LibraryRow, SearchRow};
use centraid_search::Principal;
use centraid_vault::Vault;

use centraid_vault::time::zone::FireZone;

use super::{
    RecordingSearch, VaultDoor, corrected_search, named, non_empty, settle, zone_if_any, zone_of,
};
use crate::error::{CoreError, Result};

type Answer = wire::app_query_response::Answer;

/// A request's `window`: 0 is the manifest's default, anything else is the
/// loader's to clamp.
fn window_of(window: u32) -> Option<i64> {
    (window > 0).then_some(i64::from(window))
}

/// An instant's civil day in the request's zone (`notes.proto`, "CIVIL
/// DAYS"); empty when the instant is absent. The zone is [`zone_of`]'s — the
/// stated one, else the vault's, and neither is refused: the shell states it
/// on every request, so no zoneless answer is carried any more.
fn local_day(zone: &FireZone, instant: Option<&str>) -> String {
    instant
        .and_then(|instant| notes::local::civil_day(zone, instant))
        .unwrap_or_default()
}

/// [`local_day`] for a decoration's zone, which may be none: EMPTY then.
fn day_if(zone: Option<&FireZone>, instant: Option<&str>) -> String {
    zone.map(|zone| local_day(zone, instant))
        .unwrap_or_default()
}

/// A non-empty instant, or none: `NotesNote` spells an absent one as `""`.
fn known(instant: &str) -> Option<&str> {
    (!instant.is_empty()).then_some(instant)
}

/// An instant's wall clock, `YYYY-MM-DDTHH:MM`, in `zone`; EMPTY when either
/// is absent.
fn minute_if(zone: Option<&FireZone>, instant: Option<&str>) -> String {
    zone.zip(instant)
        .and_then(|(zone, instant)| centraid_apps_agenda::local::now_local(zone, instant))
        .unwrap_or_default()
}

fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

pub(super) fn library(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::NotesLibraryRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let cards = OwnerCards::new(door);
    let filter = notes::LibraryFilter {
        sort: match asked.sort() {
            wire::NotesSort::Created => notes::Sort::Created,
            wire::NotesSort::Title => notes::Sort::Title,
            wire::NotesSort::Updated | wire::NotesSort::Unspecified => notes::Sort::Updated,
        },
        pinned_only: asked.pinned_only,
        notebook_id: non_empty(&asked.notebook_id).map(str::to_owned),
        unfiled_only: asked.unfiled_only,
        tag_concept_ids: asked.tag_concept_ids.clone(),
    };
    settle(
        door,
        queries::load_library(door, &cards, window_of(asked.window)),
        |data| {
            let data = notes::shape_library(data, &filter);
            Answer::NotesLibrary(wire::NotesLibrary {
                notes: data
                    .notes
                    .into_iter()
                    .map(|row| row_to_wire(row, &zone))
                    .collect(),
                notebooks: data
                    .notebooks
                    .into_iter()
                    .map(|notebook| wire::NotesNotebook {
                        notebook_id: notebook.notebook_id,
                        name: notebook.name,
                        sort_order: notebook.sort_order,
                        ..wire::NotesNotebook::default()
                    })
                    .collect(),
                tags: data
                    .tags
                    .into_iter()
                    .map(|tag| wire::NotesTagFacet {
                        concept_id: tag.concept_id,
                        label: tag.label,
                    })
                    .collect(),
                truncated: data.truncated,
                window: count(data.window),
            })
        },
    )
}

pub(super) fn notebooks(door: &VaultDoor<'_>) -> Result<Answer> {
    settle(door, notes::load_notebooks(door), |data| {
        Answer::NotesNotebooks(wire::NotesNotebooks {
            unfiled_count: count(data.unfiled_count),
            unfiled_truncated: data.unfiled_truncated,
            notebooks: data
                .notebooks
                .into_iter()
                .map(|notebook| wire::NotesNotebook {
                    notebook_id: notebook.notebook_id,
                    name: notebook.name,
                    sort_order: notebook.sort_order,
                    parent_notebook_id: notebook.parent_notebook_id,
                    note_count: count(notebook.note_count),
                })
                .collect(),
        })
    })
}

pub(super) fn journal(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::NotesJournalRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let today = notes::local::today(&zone, now).ok_or_else(|| CoreError::Invariant {
        context: format!("the vault clock's day did not read: {now}"),
    })?;
    settle(
        door,
        queries::load_journal(door, window_of(asked.window)),
        |data| {
            Answer::NotesJournal(wire::NotesJournal {
                days: notes::journal_days(data.entries, &zone)
                    .into_iter()
                    .map(|day| wire::NotesJournalDay {
                        day: day.day,
                        entries: day
                            .entries
                            .into_iter()
                            .map(|placed| wire::NotesJournalEntry {
                                note_id: placed.entry.note_id,
                                title: placed.entry.title,
                                format: placed.entry.format,
                                created_at: placed.entry.created_at.unwrap_or_default(),
                                updated_at: placed.entry.updated_at,
                                local_time: placed.local_time,
                                preview: placed.entry.preview,
                                check_total: count(placed.entry.check.total),
                                check_done: count(placed.entry.check.done),
                            })
                            .collect(),
                    })
                    .collect(),
                today,
                truncated: data.truncated,
                window: count(data.window),
                tz: zone.name().to_owned(),
            })
        },
    )
}

pub(super) fn search(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::NotesSearchRequest,
) -> Result<Answer> {
    let zone = zone_if_any(vault, &asked.tz)?;
    // THE NOTEBOOKS THE TERM NAMES RIDE BESIDE THE NOTES (#1097, R-1097-19..21),
    // and the correction treats the two as one answer: it runs only when both
    // are empty, over the notes' vocabulary and the notebooks'.
    let entities = named::entities_of(queries::NOTE_TARGET_TYPE, "notes");
    let loaded = with_search(vault, door, |search| {
        corrected_search(
            search,
            &entities,
            &asked.term,
            |(data, found): &(queries::SearchData, Vec<centraid_search::Target>)| {
                data.notes.is_empty() && found.is_empty()
            },
            |term| {
                let (data, denial) = queries::load_search(door, search, &Principal::Owner, term)?;
                if denial.is_some() {
                    return Ok(((data, Vec::new()), denial));
                }
                let (found, denial) = named::of_app(search, "notes", term, named::CONTAINER_ROWS);
                Ok(((data, found), denial))
            },
        )
    })?;
    settle(door, loaded, |((data, found), corrected)| {
        Answer::NotesSearch(wire::NotesSearch {
            corrected,
            hits: data
                .notes
                .into_iter()
                .map(|hit| hit_to_wire(hit, zone.as_ref()))
                .collect(),
            containers: found.into_iter().map(named::to_wire).collect(),
        })
    })
}

pub(super) fn link_targets(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::NotesLinkTargetsRequest,
) -> Result<Answer> {
    // THE POWERBOX IS ISOLATED PER DOMAIN: a probe that refuses drops its own
    // column (the crate's `load_link_targets`), so the plain FTS door is the
    // right one here — a refusal the recording door kept would fail the whole
    // sheet over one domain.
    let loaded = vault.read(|connection| {
        let index =
            centraid_search::SqliteDoor::open(connection).map_err(|error| CoreError::Invariant {
                context: format!("the search index will not open: {error}"),
            });
        Ok(index
            .map(|index| queries::load_link_targets(door, &index, &Principal::Owner, &asked.term)))
    })??;
    let zone = zone_if_any(vault, &asked.tz)?;
    settle(door, loaded, |data| {
        Answer::NotesLinkTargets(wire::NotesLinkTargets {
            targets: data
                .targets
                .into_iter()
                .map(|target| wire::NotesLinkTarget {
                    app_id: named::app_of(&target.entity).to_owned(),
                    subtitle_local_day: subtitle_day(zone.as_ref(), &target.subtitle),
                    entity: target.entity,
                    id: target.id,
                    title: target.title,
                    subtitle: target.subtitle,
                    snippet: target.snippet,
                })
                .collect(),
        })
    })
}

/// A powerbox subtitle's civil day (`NotesLinkTarget.subtitle_local_day`).
/// The index answers a raw column: a date (`spent_on`, an all-day
/// `dtstart`) or a floating wall clock is already civil, so its date part IS
/// the day; an instant — a `Z` or an offset after the date — is read in the
/// zone, and with no zone it has no day. Anything else is not a when: EMPTY.
pub(super) fn subtitle_day(zone: Option<&FireZone>, subtitle: &str) -> String {
    let text = subtitle.trim();
    let bytes = text.as_bytes();
    let dated = bytes.len() >= 10
        && bytes[..10].iter().enumerate().all(|(at, byte)| {
            if at == 4 || at == 7 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        });
    if !dated {
        return String::new();
    }
    if bytes.len() == 10 {
        return text.to_owned();
    }
    if bytes[10] != b'T' && bytes[10] != b' ' {
        return String::new();
    }
    // The clock, and the designator after it when there is one.
    let time = &text[11..];
    let (clock, zoned) = match time.find(['Z', '+', '-']) {
        Some(at) => (&time[..at], true),
        None => (time, false),
    };
    let clocked = clock.len() >= 5
        && clock.as_bytes()[2] == b':'
        && clock
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b':' || byte == b'.');
    if !clocked {
        return String::new();
    }
    if !zoned {
        return text[..10].to_owned();
    }
    day_if(zone, Some(&format!("{}T{time}", &text[..10])))
}

pub(super) fn trash(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::NotesTrashRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let cards = OwnerCards::new(door);
    settle(door, notes::load_trash(door, &cards), |rows| {
        Answer::NotesTrash(wire::NotesTrash {
            notes: rows
                .into_iter()
                .map(|row| row_to_wire(row, &zone))
                .collect(),
        })
    })
}

pub(super) fn history(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::NotesHistoryRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    settle(
        door,
        queries::load_history(door, asked.note_id.trim()),
        |data| {
            Answer::NotesHistory(wire::NotesHistory {
                versions: data
                    .versions
                    .into_iter()
                    .map(|version| wire::NotesVersion {
                        asserted_local_day: local_day(&zone, Some(version.asserted_at.as_str())),
                        asserted_local: minute_if(Some(&zone), Some(version.asserted_at.as_str())),
                        content_id: version.content_id,
                        body: version.body,
                        media_type: version.media_type,
                        current: version.current,
                        asserted_at: version.asserted_at,
                    })
                    .collect(),
            })
        },
    )
}

pub(super) fn note(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::NotesNoteRequest,
) -> Result<Answer> {
    let zone = zone_if_any(vault, &asked.tz)?;
    settle(
        door,
        notes::load_editor_note(door, &asked.note_id),
        |note| {
            let zone = zone.as_ref();
            Answer::NotesNote(wire::NotesNote {
                created_local_day: day_if(zone, known(&note.created_at)),
                updated_local_day: day_if(zone, known(&note.updated_at)),
                updated_local: minute_if(zone, known(&note.updated_at)),
                found: note.found,
                note_id: note.note_id,
                title: note.title,
                format: note.format,
                pinned: note.pinned,
                body: note.body,
                body_content_id: note.body_content_id,
                current_revision_id: note.current_revision_id,
                row_version: note.row_version,
                created_at: note.created_at,
                updated_at: note.updated_at,
                deleted_at: note.deleted_at,
                purge_at: note.purge_at,
                notebook_id: note.notebook_id,
            })
        },
    )
}

/// The FTS door over the read connection the page door uses, with its
/// failures kept as [`VaultDoor`] keeps the page door's.
fn with_search<T>(
    vault: &Vault,
    door: &VaultDoor<'_>,
    run: impl FnOnce(&dyn centraid_search::Search) -> T,
) -> Result<T> {
    vault.read(|connection| {
        let index = match centraid_search::SqliteDoor::open(connection) {
            Ok(index) => index,
            Err(error) => {
                return Ok(Err(CoreError::Invariant {
                    context: format!("the search index will not open: {error}"),
                }));
            }
        };
        let search = RecordingSearch {
            inner: &index,
            door,
        };
        Ok(Ok(run(&search)))
    })?
}

// ---------------------------------------------------------------------------
// The conversion. ONE place, so a field that moved is one edit.
// ---------------------------------------------------------------------------

fn card_to_wire(card: RefCard) -> wire::NotesCard {
    wire::NotesCard {
        status: card.status.as_str().to_owned(),
        entity: card.entity,
        id: card.id,
        title: card.title,
        subtitle: card.subtitle,
        thumbnail_content_id: card.thumbnail_content_id,
    }
}

fn attachment_to_wire(attachment: queries::Attachment) -> wire::NotesAttachment {
    wire::NotesAttachment {
        attachment_id: attachment.attachment_id,
        content_id: attachment.content_id,
        role: attachment.role,
        is_primary: attachment.is_primary == 1,
        media_type: attachment.media_type,
        content_uri: attachment.content_uri,
        byte_size: attachment.byte_size,
    }
}

fn row_to_wire(row: LibraryRow, zone: &FireZone) -> wire::NotesRow {
    wire::NotesRow {
        created_local_day: local_day(zone, row.created_at.as_deref()),
        updated_local_day: local_day(zone, row.updated_at.as_deref()),
        deleted_local_day: local_day(zone, row.deleted_at.as_deref()),
        purge_local_day: local_day(zone, row.purge_at.as_deref()),
        note_id: row.note_id,
        title: row.title,
        format: row.format,
        pinned: row.pinned == 1,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: row.deleted_at,
        purge_at: row.purge_at,
        preview: row.preview,
        check_total: count(row.check.total),
        check_done: count(row.check.done),
        notebook_ids: row.notebook_ids,
        notebook_names: row.notebook_names,
        attachments: row
            .attachments
            .into_iter()
            .map(attachment_to_wire)
            .collect(),
        references: row
            .references
            .into_iter()
            .map(|reference| wire::NotesReference {
                link_id: reference.link_id,
                selector_json: reference.selector.map(|selector| selector.to_string()),
                card: Some(card_to_wire(reference.card)),
            })
            .collect(),
        backlinks: row
            .backlinks
            .into_iter()
            .map(|backlink| wire::NotesBacklink {
                link_id: backlink.link_id,
                card: Some(card_to_wire(backlink.card)),
            })
            .collect(),
        tags: row
            .tags
            .into_iter()
            .map(|tag| wire::NotesTag {
                tag_id: tag.tag_id,
                concept_id: tag.concept_id,
                label: tag.label,
            })
            .collect(),
    }
}

fn hit_to_wire(hit: SearchRow, zone: Option<&FireZone>) -> wire::NotesSearchHit {
    wire::NotesSearchHit {
        created_local_day: day_if(zone, hit.created_at.as_deref()),
        updated_local_day: day_if(zone, hit.updated_at.as_deref()),
        note_id: hit.note_id,
        title: hit.title,
        format: hit.format,
        pinned: hit.pinned == 1,
        created_at: hit.created_at,
        updated_at: hit.updated_at,
        preview: hit.preview,
        check_total: count(hit.check.total),
        check_done: count(hit.check.done),
        notebook_ids: hit.notebook_ids,
        notebook_names: hit.notebook_names,
        attachments: hit
            .attachments
            .into_iter()
            .map(attachment_to_wire)
            .collect(),
        snippet: hit.snippet,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::CoreConfig;
    use crate::handle::{Core, Handle};
    use wire::app_query_request::Query as Q;

    /// The vault clock, stopped: 02:00Z on 2 June is still 1 June in New York.
    const NOW: &str = "2099-06-02T02:00:00.000Z";
    const TZ: &str = "America/New_York";

    struct Scratch {
        dir: std::path::PathBuf,
        handle: Handle,
        writes: std::cell::Cell<u32>,
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    impl Scratch {
        fn founded() -> Self {
            let dir = centraid_ontology::scratch::scratch_dir();
            std::fs::create_dir_all(&dir).expect("the directory is made");
            let now = centraid_vault::time::recurrence::parse_instant_ms(NOW).expect("an instant");
            let handle = Core::open(CoreConfig::new(dir.join("vault.db")).with_clock(
                std::sync::Arc::new(centraid_vault::clock::FixedClock::at(now)),
                std::sync::Arc::new(centraid_vault::clock::ClockIds::new(Box::new(
                    centraid_vault::clock::FixedClock::at(now),
                ))),
            ))
            .expect("it opens");
            handle
                .with_vault(|vault| Ok(vault.found("Notes", "Owner")?))
                .expect("it founds");
            Self {
                dir,
                handle,
                writes: std::cell::Cell::new(0),
            }
        }

        fn ask(&self, query: Q) -> Result<Answer> {
            match self.handle.call(&wire::Request {
                kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                    query: Some(query),
                })),
            })? {
                wire::Response {
                    kind: Some(wire::response::Kind::AppQuery(answer)),
                    ..
                } => Ok(answer.answer.expect("an app query is answered")),
                other => panic!("an app query answered as {other:?}"),
            }
        }

        fn run(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
            self.writes.set(self.writes.get() + 1);
            let response = self
                .handle
                .call(&wire::Request {
                    kind: Some(wire::request::Kind::Command(wire::Command {
                        name: name.to_owned(),
                        input: serde_json::to_vec(&input).expect("json"),
                        invoke_key: format!("notes-query-test-{}", self.writes.get()),
                        ..wire::Command::default()
                    })),
                })
                .unwrap_or_else(|error| panic!("{name} refused: {error}"));
            let Some(wire::response::Kind::Command(outcome)) = response.kind else {
                panic!("a command answered with something else");
            };
            assert_eq!(
                outcome.status,
                wire::CommandStatus::Executed as i32,
                "{name}: {}",
                outcome.reason
            );
            serde_json::from_slice(&outcome.output).expect("the output is JSON")
        }

        fn create(&self, title: &str, body: &str) -> String {
            self.run(
                "knowledge.create_note",
                serde_json::json!({ "title": title, "body_text": body }),
            )["note_id"]
                .as_str()
                .expect("a note id")
                .to_owned()
        }

        fn library(&self) -> wire::NotesLibrary {
            match self
                .ask(Q::NotesLibrary(wire::NotesLibraryRequest {
                    tz: TZ.to_owned(),
                    ..wire::NotesLibraryRequest::default()
                }))
                .expect("library answers")
            {
                Answer::NotesLibrary(library) => library,
                other => panic!("library answered as {other:?}"),
            }
        }

        fn note(&self, note_id: &str) -> wire::NotesNote {
            match self
                .ask(Q::NotesNote(wire::NotesNoteRequest {
                    note_id: note_id.to_owned(),
                    tz: TZ.to_owned(),
                }))
                .expect("note answers")
            {
                Answer::NotesNote(note) => note,
                other => panic!("note answered as {other:?}"),
            }
        }
    }

    /// A FOUNDED VAULT WITH NO NOTES answers every shelf empty — a fact, not a
    /// refusal — and a note id nothing answers to as `found = false`.
    #[test]
    fn an_empty_vault_answers_every_notes_query_empty() {
        let scratch = Scratch::founded();
        let library = scratch.library();
        assert!(library.notes.is_empty() && !library.truncated);
        assert_eq!(library.window, 200);
        assert!(matches!(
            scratch.ask(Q::NotesTrash(wire::NotesTrashRequest { tz: TZ.to_owned() })),
            Ok(Answer::NotesTrash(trash)) if trash.notes.is_empty()
        ));
        assert!(matches!(
            scratch.ask(Q::NotesNotebooks(wire::NotesNotebooksRequest {})),
            Ok(Answer::NotesNotebooks(_))
        ));
        let Ok(Answer::NotesJournal(journal)) =
            scratch.ask(Q::NotesJournal(wire::NotesJournalRequest {
                window: 0,
                tz: TZ.to_owned(),
            }))
        else {
            panic!("journal answers");
        };
        assert!(journal.days.is_empty());
        assert_eq!(journal.today, "2099-06-01", "the device's day, not UTC's");
        assert_eq!(
            journal.tz, TZ,
            "the zone the day was read in rides back, so a new entry is filed in it"
        );
        assert!(matches!(
            scratch.ask(Q::NotesSearch(wire::NotesSearchRequest {
                term: "anything".to_owned(),
                tz: String::new(),
            })),
            Ok(Answer::NotesSearch(found)) if found.hits.is_empty()
        ));
        assert!(!scratch.note("no-such-note").found);
        // A LOOSE NOTE IS COUNTED ON THE "UNFILED" ROW (#1047), with no
        // notebook anywhere in the vault.
        scratch.run(
            "knowledge.create_note",
            serde_json::json!({ "title": "Loose", "body_text": "scratch" }),
        );
        let Ok(Answer::NotesNotebooks(spine)) =
            scratch.ask(Q::NotesNotebooks(wire::NotesNotebooksRequest {}))
        else {
            panic!("notebooks answers");
        };
        assert_eq!(spine.unfiled_count, 1);
        // THE ZONE RULE IS AGENDA'S: founding names no zone, so an empty one
        // is refused rather than read as UTC.
        let refused = scratch
            .ask(Q::NotesJournal(wire::NotesJournalRequest {
                window: 0,
                tz: String::new(),
            }))
            .expect_err("no zone is refused");
        assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);
    }

    /// **"NEW ENTRY FOR TODAY" IS A NOTE DATED TODAY, AND NEEDS NO COMMAND OF
    /// ITS OWN** (Q-1047-8, owner ruling 2026-10-15). The journal sheet's Save is
    /// `people.add_journal_entry` with the journal's own `today` as `entry_date`:
    /// that command writes a `knowledge.note` and marks it, so the entry is a
    /// note — dated the day the member put it on, drawn under that day in the
    /// device's zone, and kept off the library the way every journal entry is.
    #[test]
    fn a_new_entry_for_today_is_a_note_dated_today_with_no_command_of_its_own() {
        let scratch = Scratch::founded();
        let journal = || {
            let Ok(Answer::NotesJournal(journal)) =
                scratch.ask(Q::NotesJournal(wire::NotesJournalRequest {
                    window: 0,
                    tz: TZ.to_owned(),
                }))
            else {
                panic!("journal answers");
            };
            journal
        };
        let today = journal().today;
        assert_eq!(today, "2099-06-01", "the device's day, not UTC's");

        let entry = scratch.run(
            "people.add_journal_entry",
            serde_json::json!({ "mood": "Good", "text": "Lunch with Ana", "entry_date": today }),
        )["entry_id"]
            .as_str()
            .expect("an entry id")
            .to_owned();

        let after = journal();
        assert_eq!(after.days.len(), 1);
        assert_eq!(
            after.days[0].day, today,
            "under today, in the device's zone"
        );
        assert_eq!(after.days[0].entries.len(), 1);
        assert_eq!(after.days[0].entries[0].note_id, entry);
        assert_eq!(
            after.days[0].entries[0].preview, "Lunch with Ana",
            "the entry is a note with a body"
        );
        // A NOTE, KEPT APART: it is not on the shelf, and not an unfiled note.
        assert!(scratch.library().notes.is_empty());
        let Ok(Answer::NotesNotebooks(spine)) =
            scratch.ask(Q::NotesNotebooks(wire::NotesNotebooksRequest {}))
        else {
            panic!("notebooks answers");
        };
        assert_eq!(spine.unfiled_count, 0);
        // AND REACHABLE BY ID, which is how the People screen opens one.
        assert!(scratch.note(&entry).found);
    }

    /// A JOURNAL ENTRY MADE TODAY IS FILED UNDER TODAY, east of UTC+11:59 too
    /// (the Q-1047-8 follow-up). The vault clock reads 2 June 02:00Z, which is
    /// 2 June, 14:00 in Auckland. An entry dated that day and filed with no zone
    /// is stamped noon UTC, which Auckland (UTC+12) already calls 3 June; one
    /// filed with the zone the journal answered in lands on 2 June.
    #[test]
    fn a_journal_entry_made_today_is_filed_under_today_east_of_utc_plus_eleven() {
        const AUCKLAND: &str = "Pacific/Auckland";
        let scratch = Scratch::founded();
        let journal = |tz: &str| match scratch
            .ask(Q::NotesJournal(wire::NotesJournalRequest {
                window: 0,
                tz: tz.to_owned(),
            }))
            .expect("the journal answers")
        {
            Answer::NotesJournal(journal) => journal,
            other => panic!("journal answered as {other:?}"),
        };
        let asked = journal(AUCKLAND);
        assert_eq!(asked.today, "2099-06-02");
        assert_eq!(
            asked.tz, AUCKLAND,
            "the zone the day was read in rides back"
        );

        // THE SHELL STATES BACK what the answer said: `today`, in `tz`.
        scratch.run(
            "people.add_journal_entry",
            serde_json::json!({
                "mood": "Good", "text": "In zone", "entry_date": asked.today, "tz": asked.tz,
            }),
        );
        let after = journal(AUCKLAND);
        assert_eq!(
            after
                .days
                .iter()
                .map(|day| day.day.as_str())
                .collect::<Vec<_>>(),
            ["2099-06-02"],
            "today's entry is under today"
        );

        // AND WITHOUT IT, the old behaviour is what it was: tomorrow's.
        scratch.run(
            "people.add_journal_entry",
            serde_json::json!({ "mood": "Good", "text": "No zone", "entry_date": asked.today }),
        );
        let both = journal(AUCKLAND);
        assert_eq!(
            both.days
                .iter()
                .map(|day| day.day.as_str())
                .collect::<Vec<_>>(),
            ["2099-06-03", "2099-06-02"],
            "a zoneless entry is noon UTC, which Auckland calls the next day"
        );
    }

    /// A TYPO FINDS THE NOTE AND SAYS WHAT WAS SEARCHED (#1097, R4, R8).
    #[test]
    fn a_typo_finds_the_note_and_says_what_it_searched() {
        let scratch = Scratch::founded();
        let kept = scratch.run(
            "knowledge.create_note",
            serde_json::json!({ "title": "Tomato stakes", "body_text": "Buy cedar stakes" }),
        )["note_id"]
            .as_str()
            .expect("a note id")
            .to_owned();
        let search = |term: &str| {
            let Ok(Answer::NotesSearch(found)) =
                scratch.ask(Q::NotesSearch(wire::NotesSearchRequest {
                    term: term.to_owned(),
                    tz: TZ.to_owned(),
                }))
            else {
                panic!("search answers");
            };
            found
        };
        let slipped = search("cedra");
        let hits: Vec<&str> = slipped
            .hits
            .iter()
            .map(|hit| hit.note_id.as_str())
            .collect();
        assert_eq!(hits, [kept.as_str()]);
        assert_eq!(slipped.corrected, "cedar");
        let exact = search("cedar");
        assert_eq!(exact.hits.len(), 1);
        assert!(exact.corrected.is_empty());
        let nothing = search("zeppelin");
        assert!(nothing.hits.is_empty() && nothing.corrected.is_empty());
    }

    /// TRASH IS ITS OWN SHELF: a deleted note leaves the library and the search
    /// and lands on `trash` with its purge date; the notebook spine counts only
    /// the live one.
    #[test]
    fn a_trashed_note_leaves_the_library_and_the_search_for_the_trash() {
        let scratch = Scratch::founded();
        let notebook = scratch.run(
            "knowledge.create_notebook",
            serde_json::json!({ "name": "Garden" }),
        )["notebook_id"]
            .as_str()
            .expect("a notebook id")
            .to_owned();
        let kept = scratch.run(
            "knowledge.create_note",
            serde_json::json!({
                "title": "Tomato stakes", "body_text": "Buy cedar stakes", "notebook_id": notebook,
            }),
        )["note_id"]
            .as_str()
            .expect("a note id")
            .to_owned();
        let gone = scratch.run(
            "knowledge.create_note",
            serde_json::json!({
                "title": "Old plan", "body_text": "cedar was too dear", "notebook_id": notebook,
            }),
        )["note_id"]
            .as_str()
            .expect("a note id")
            .to_owned();
        scratch.run(
            "knowledge.delete_note",
            serde_json::json!({ "note_id": gone }),
        );

        let library = scratch.library();
        let ids: Vec<&str> = library
            .notes
            .iter()
            .map(|row| row.note_id.as_str())
            .collect();
        assert_eq!(ids, [kept.as_str()]);
        assert_eq!(
            library.notes[0].notebook_ids,
            std::slice::from_ref(&notebook)
        );

        let Ok(Answer::NotesTrash(trash)) =
            scratch.ask(Q::NotesTrash(wire::NotesTrashRequest { tz: TZ.to_owned() }))
        else {
            panic!("trash answers");
        };
        assert_eq!(trash.notes.len(), 1);
        assert_eq!(trash.notes[0].note_id, gone);
        assert!(trash.notes[0].deleted_at.is_some() && trash.notes[0].purge_at.is_some());

        let Ok(Answer::NotesSearch(found)) =
            scratch.ask(Q::NotesSearch(wire::NotesSearchRequest {
                term: "cedar".to_owned(),
                tz: TZ.to_owned(),
            }))
        else {
            panic!("search answers");
        };
        let hits: Vec<&str> = found.hits.iter().map(|hit| hit.note_id.as_str()).collect();
        assert_eq!(hits, [kept.as_str()], "the trashed note is not searchable");
        assert!(
            found.hits[0].snippet.contains('⟦'),
            "{}",
            found.hits[0].snippet
        );
        // A HIT'S DAYS ARE THE DEVICE'S (#1047): the stopped clock's instant
        // read in New York.
        assert_eq!(found.hits[0].updated_local_day, "2099-06-01");
        assert_eq!(found.hits[0].created_local_day, "2099-06-01");
        // AND THE EDITOR'S NOTE CARRIES ITS "EDITED" READINGS.
        let note = scratch.note(&kept);
        assert_eq!(note.updated_local_day, "2099-06-01");
        assert!(
            note.updated_local.starts_with("2099-06-01T"),
            "{}",
            note.updated_local
        );
        assert_eq!(note.created_local_day, "2099-06-01");

        let Ok(Answer::NotesNotebooks(spine)) =
            scratch.ask(Q::NotesNotebooks(wire::NotesNotebooksRequest {}))
        else {
            panic!("notebooks answers");
        };
        let garden = spine
            .notebooks
            .iter()
            .find(|row| row.notebook_id == notebook)
            .expect("the notebook is on the spine");
        assert_eq!(garden.note_count, 1, "the trashed note does not count");
        assert_eq!(spine.unfiled_count, 0, "the one live note is filed");
        assert!(!spine.unfiled_truncated);

        let filtered = match scratch
            .ask(Q::NotesLibrary(wire::NotesLibraryRequest {
                unfiled_only: true,
                tz: TZ.to_owned(),
                ..wire::NotesLibraryRequest::default()
            }))
            .expect("library answers")
        {
            Answer::NotesLibrary(library) => library,
            other => panic!("{other:?}"),
        };
        assert!(filtered.notes.is_empty(), "the one live note is filed");

        let Ok(Answer::NotesLinkTargets(targets)) =
            scratch.ask(Q::NotesLinkTargets(wire::NotesLinkTargetsRequest {
                term: "tomato".to_owned(),
                tz: TZ.to_owned(),
            }))
        else {
            panic!("link targets answers");
        };
        assert!(
            targets
                .targets
                .iter()
                .any(|target| target.entity == "knowledge.note" && target.id == kept)
        );
    }

    /// HISTORY IS NEWEST FIRST, AND THE BASE MOVES ONLY WITH THE BODY. Two body
    /// edits are three versions with the head marked current; a title edit
    /// bumps `row_version` and leaves `current_revision_id` where it was — the
    /// fact an autosaving editor's conflict check rests on.
    #[test]
    fn history_is_newest_first_and_the_base_revision_moves_only_with_the_body() {
        let scratch = Scratch::founded();
        let note = scratch.create("Draft", "one");
        let first = scratch.note(&note);
        assert!(first.found);
        assert_eq!(first.body, "one");
        let base = first
            .current_revision_id
            .clone()
            .expect("a created note has a head");

        scratch.run(
            "knowledge.edit_note",
            serde_json::json!({ "note_id": note, "body_text": "two" }),
        );
        scratch.run(
            "knowledge.edit_note",
            serde_json::json!({ "note_id": note, "body_text": "three" }),
        );
        let edited = scratch.note(&note);
        assert_ne!(edited.current_revision_id.as_deref(), Some(base.as_str()));
        assert!(edited.row_version > first.row_version);

        scratch.run(
            "knowledge.edit_note",
            serde_json::json!({ "note_id": note, "title": "Renamed" }),
        );
        let renamed = scratch.note(&note);
        assert_eq!(renamed.title, "Renamed");
        assert_eq!(
            renamed.current_revision_id, edited.current_revision_id,
            "a title edit records no body occurrence"
        );
        assert!(renamed.row_version > edited.row_version);

        let Ok(Answer::NotesHistory(history)) =
            scratch.ask(Q::NotesHistory(wire::NotesHistoryRequest {
                note_id: note.clone(),
                tz: TZ.to_owned(),
            }))
        else {
            panic!("history answers");
        };
        let bodies: Vec<&str> = history
            .versions
            .iter()
            .map(|version| version.body.as_str())
            .collect();
        assert_eq!(bodies, ["three", "two", "one"]);
        assert!(history.versions[0].current);
        assert!(history.versions[1..].iter().all(|version| !version.current));
    }

    /// A POWERBOX SUBTITLE'S DAY IS CIVIL, NEVER A UTC SLICE: 02:00Z on 2 June
    /// is 1 June in New York; a date and a floating wall clock are their own
    /// date part in any zone; an instant with no zone, and prose that merely
    /// starts with a date, have no day.
    #[test]
    fn link_target_subtitles_answer_their_local_day() {
        let zone = FireZone::resolve(Some(TZ), None).expect("the zone resolves");
        let zone = Some(&zone);
        assert_eq!(subtitle_day(zone, "2099-06-02T02:00:00Z"), "2099-06-01");
        assert_eq!(
            subtitle_day(zone, "2099-06-02T02:00:00+00:00"),
            "2099-06-01"
        );
        assert_eq!(
            subtitle_day(zone, "2099-06-02T09:00:00-04:00"),
            "2099-06-02"
        );
        assert_eq!(subtitle_day(zone, "2099-06-02"), "2099-06-02");
        assert_eq!(subtitle_day(zone, "2099-06-02T02:00"), "2099-06-02");
        assert_eq!(subtitle_day(zone, "2099-06-02 02:00"), "2099-06-02");
        assert_eq!(subtitle_day(None, "2099-06-02T02:00:00Z"), "");
        assert_eq!(subtitle_day(None, "2099-06-02"), "2099-06-02");
        assert_eq!(subtitle_day(zone, "2099-06-02 was the day we met"), "");
        assert_eq!(subtitle_day(zone, "Groceries"), "");
        assert_eq!(subtitle_day(zone, ""), "");
    }

    /// CIVIL DAYS RIDE BESIDE THE INSTANTS: 02:00Z on 2 June is 1 June in New
    /// York, on the shelf, in the trash (with the purge day thirty days on)
    /// and in the history; a request with no zone in a zoneless vault is
    /// REFUSED, as Agenda's is — never answered in UTC, and never answered
    /// with its days quietly empty.
    #[test]
    fn library_trash_and_history_answer_local_days_in_the_requests_zone() {
        let scratch = Scratch::founded();
        let kept = scratch.create("Kept", "one");
        let gone = scratch.create("Gone", "two");
        scratch.run(
            "knowledge.delete_note",
            serde_json::json!({ "note_id": gone }),
        );
        let Ok(Answer::NotesLibrary(library)) =
            scratch.ask(Q::NotesLibrary(wire::NotesLibraryRequest {
                tz: TZ.to_owned(),
                ..wire::NotesLibraryRequest::default()
            }))
        else {
            panic!("library answers");
        };
        assert_eq!(library.notes[0].note_id, kept);
        assert_eq!(library.notes[0].created_local_day, "2099-06-01");
        assert_eq!(library.notes[0].updated_local_day, "2099-06-01");
        assert_eq!(library.notes[0].deleted_local_day, "");
        let Ok(Answer::NotesTrash(trash)) =
            scratch.ask(Q::NotesTrash(wire::NotesTrashRequest { tz: TZ.to_owned() }))
        else {
            panic!("trash answers");
        };
        assert_eq!(trash.notes[0].deleted_local_day, "2099-06-01");
        assert_eq!(trash.notes[0].purge_local_day, "2099-07-01");
        let Ok(Answer::NotesHistory(history)) =
            scratch.ask(Q::NotesHistory(wire::NotesHistoryRequest {
                note_id: kept.clone(),
                tz: TZ.to_owned(),
            }))
        else {
            panic!("history answers");
        };
        assert_eq!(history.versions[0].asserted_local_day, "2099-06-01");
        // No zone anywhere: refused, on every shelf that answers days.
        for asked in [
            Q::NotesLibrary(wire::NotesLibraryRequest::default()),
            Q::NotesTrash(wire::NotesTrashRequest::default()),
            Q::NotesHistory(wire::NotesHistoryRequest {
                note_id: kept.clone(),
                tz: String::new(),
            }),
        ] {
            let refused = scratch.ask(asked).expect_err("no zone is refused");
            assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);
        }
        // An unknown name is refused.
        let refused = scratch
            .ask(Q::NotesTrash(wire::NotesTrashRequest {
                tz: "America/New_Yrok".to_owned(),
            }))
            .expect_err("an unknown zone is refused");
        assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);
    }

    /// A NOTES DENIAL IS THE ANSWER'S `denied` ARM, carried field for field
    /// through the shared `settle` — the phone's door grants everything, so
    /// the loader's refusal is asserted here rather than provoked.
    #[test]
    fn a_notes_denial_is_the_denied_arm() {
        let scratch = Scratch::founded();
        scratch
            .handle
            .with_vault(|vault| {
                let door = VaultDoor::new(vault);
                let denied: centraid_apps_kit::KitResult<((), Option<notes::Denial>)> = Ok((
                    (),
                    Some(notes::Denial {
                        code: Some("revoked".to_owned()),
                        message: Some("the grant was revoked".to_owned()),
                        revoked_at: None,
                    }),
                ));
                let answer = settle(&door, denied, |()| unreachable!("no data"))
                    .expect("a denial is an answer");
                assert!(matches!(
                    answer,
                    Answer::Denied(wire::AppQueryDenial { code: Some(code), .. }) if code == "revoked"
                ));
                Ok(())
            })
            .expect("the vault is open");
    }

    /// A NOTEBOOK IS A SEARCH RESULT OF ITS OWN (#1097, R-1097-19..21): its name
    /// finds it beside the notes, an album of the same name is Photos' and not
    /// Notes', a deleted notebook is gone, and a slip in a word only a notebook
    /// holds is corrected to it.
    #[test]
    fn a_notebook_is_found_by_name_and_an_album_is_not_notes() {
        let scratch = Scratch::founded();
        let search = |term: &str| {
            let Ok(Answer::NotesSearch(found)) =
                scratch.ask(Q::NotesSearch(wire::NotesSearchRequest {
                    term: term.to_owned(),
                    tz: TZ.to_owned(),
                }))
            else {
                panic!("search answers");
            };
            found
        };
        let notebook = scratch.run(
            "knowledge.create_notebook",
            serde_json::json!({ "name": "Quokka recipes" }),
        )["notebook_id"]
            .as_str()
            .expect("a notebook id")
            .to_owned();
        scratch.run(
            "media.create_album",
            serde_json::json!({ "title": "Quokka holiday" }),
        );
        let note = scratch.create("Quokka sighting", "saw one");
        let found = search("quokka");
        let containers: Vec<(&str, &str, &str)> = found
            .containers
            .iter()
            .map(|hit| (hit.entity.as_str(), hit.id.as_str(), hit.app_id.as_str()))
            .collect();
        assert_eq!(
            containers,
            [("core.collection", notebook.as_str(), "notes")],
            "the notebook, and not the album, which opens in Photos"
        );
        assert_eq!(found.containers[0].title, "Quokka recipes");
        assert!(found.containers[0].snippet.contains('⟦'));
        let ids: Vec<&str> = found.hits.iter().map(|hit| hit.note_id.as_str()).collect();
        assert_eq!(ids, [note.as_str()]);

        // A TYPO IN A WORD ONLY THE NOTEBOOK HOLDS is corrected to it.
        scratch.run(
            "knowledge.create_notebook",
            serde_json::json!({ "name": "Wombat shelf" }),
        );
        let slipped = search("womabt");
        assert_eq!(slipped.corrected, "wombat");
        assert_eq!(slipped.containers.len(), 1);
        assert!(slipped.hits.is_empty());
        // An exact container hit is not corrected, and its rows' emptiness is
        // not read as an empty answer.
        let exact = search("wombat");
        assert!(exact.corrected.is_empty() && exact.containers.len() == 1);

        // A DELETED NOTEBOOK IS NOT FOUND.
        scratch.run(
            "knowledge.delete_notebook",
            serde_json::json!({ "notebook_id": notebook }),
        );
        assert!(search("recipes").containers.is_empty());
        assert!(search("quokka").containers.is_empty());
    }
}
