//! THE JOURNAL — the owner's own entries folded together with what they logged.
//!
//! `queries/journal.ts`'s doctrine, in its own words: *"The People journal
//! projects canonical rows (#450): owner entries are knowledge.note rows tagged
//! in the People-journal scheme; automatic ones are core.activity rows linked
//! `about` a party, with annotations."*
//!
//! ## A denied journal read THROWS rather than answering empty
//!
//! `readJournalNoteIds` is the one read in the tree whose denial is deliberately
//! *not* graceful (`journal-scheme.ts:34`-`:36`): "a denied read THROWS —
//! answering 'empty' would leak journal notes into excluded surfaces". The
//! marker set is what tells a journal note from an ordinary note, and an empty
//! marker set means *every* note is an ordinary one — so Notes' library, which
//! excludes People-journal entries, would start showing them. The port keeps the
//! failure a failure: a door refusal on the marker reads becomes the query's own
//! `vaultDenied`, never an empty entry list beside a `null` denial.
//!
//! ## Two shapes in one column, and the date column is two different things
//!
//! An owner entry carries `{mood, text}` and an automatic one
//! `{touch, text, party_id, name, avatar_color}`. Both carry `date`, and v0
//! fills it differently: an entry's is `created_at.slice(0, 10)` — a civil date
//! — and an automatic entry's is the whole `started_at` instant
//! (`journal.ts:215` against `:225`). The feed renders them in one column.
//! That is finding PE-F4, and the port keeps `sort_at` (the instant, which is
//! what the order is over) apart from `date` (what the row shows) so the two
//! are not one field doing two jobs.
//!
//! ## The scheme's marker is read three times, not once
//!
//! Scheme → concepts → tags, three statements (`journal-scheme.ts`), each
//! bounded by the last. The cost is three round trips for one `concept_id`; the
//! reason is that the vocabulary read is shared and a scheme-scoped read is
//! narrower than the whole concept table.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::reads::{PageDoor, read_pages};
use centraid_apps_kit::row::text_of;

use crate::Denial;
use crate::queries::{
    ACTIVITY_TARGET_TYPE, JOURNAL_ENTRY_NOTATION, JOURNAL_SCHEME_URI, PARTY_PAIR_BOUND,
    PERSON_JOIN_BOUND, ROSTER_FAN_OUT, UNKNOWN_NAME, activities_statement, annotations_statement,
    contents_statement, journal_activity_links_statement, journal_concepts_all_statement,
    journal_concepts_statement, journal_notes_statement, journal_profiles_statement,
    journal_scheme_statement, journal_tags_statement, names_by_party, parties_statement, walked,
};

/// The title prefix a journal note carries, stripped to leave the mood.
pub const JOURNAL_TITLE_PREFIX: &str = "People journal · ";

/// One journal row. Two shapes, one feed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JournalEntry {
    /// The owner's own entry: a mood and a line.
    Owner {
        id: String,
        /// The instant the order is over.
        sort_at: String,
        /// The CIVIL DATE the row shows — `sort_at`'s first ten characters.
        date: String,
        mood: String,
        text: String,
    },
    /// A logged interaction, folded in automatically.
    Auto {
        id: String,
        sort_at: String,
        /// **The whole instant**, not a date, which is v0's own asymmetry
        /// (finding PE-F4).
        date: String,
        touch: String,
        text: String,
        party_id: String,
        name: String,
        avatar_color: Option<String>,
    },
}

impl JournalEntry {
    /// The key the feed is ordered by, newest first.
    #[must_use]
    pub fn sort_at(&self) -> &str {
        match self {
            Self::Owner { sort_at, .. } | Self::Auto { sort_at, .. } => sort_at,
        }
    }

    /// The row's id, which is the note's or the activity's.
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            Self::Owner { id, .. } | Self::Auto { id, .. } => id,
        }
    }
}

/// What `journal` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct JournalData {
    pub entries: Vec<JournalEntry>,
}

/// The note ids carrying the People-journal marker.
///
/// **A denial here is an error**, not an empty set: see the module note.
/// A vault with no journal scheme, or a scheme with no marker concept, is an
/// honest empty set — nothing has been journalled yet.
pub fn read_journal_note_ids(door: &dyn PageDoor) -> KitResult<BTreeSet<String>> {
    let schemes = read_pages(door, &journal_scheme_statement(), PERSON_JOIN_BOUND)?;
    let Some(scheme_id) = schemes
        .iter()
        .find(|row| text_of(row, "uri").as_deref() == Some(JOURNAL_SCHEME_URI))
        .and_then(|row| text_of(row, "scheme_id"))
    else {
        return Ok(BTreeSet::new());
    };
    let concepts = read_pages(
        door,
        &journal_concepts_statement(&scheme_id),
        PERSON_JOIN_BOUND,
    )?;
    let Some(marker) = concepts
        .iter()
        .find(|row| text_of(row, "notation").as_deref() == Some(JOURNAL_ENTRY_NOTATION))
        .and_then(|row| text_of(row, "concept_id"))
    else {
        return Ok(BTreeSet::new());
    };
    let tags = read_pages(door, &journal_tags_statement(&marker), PARTY_PAIR_BOUND)?;
    Ok(tags
        .iter()
        .filter(|row| text_of(row, "concept_id").as_deref() == Some(marker.as_str()))
        .filter_map(|row| text_of(row, "target_id"))
        .collect())
}

/// `journal` — the feed.
pub fn load_journal(door: &dyn PageDoor) -> KitResult<(JournalData, Option<Denial>)> {
    let empty = JournalData::default();
    // The marker reads. A DOOR REFUSAL HERE IS THE QUERY'S DENIAL, because an
    // empty marker set is a different and wrong answer.
    let note_ids: Vec<String> = match read_journal_note_ids(door) {
        Ok(ids) => ids.into_iter().collect(),
        Err(KitError::Door(message)) => {
            return Ok((
                empty,
                Some(Denial {
                    code: None,
                    message: Some(message),
                    revoked_at: None,
                }),
            ));
        }
        Err(other) => return Err(other),
    };

    let concepts = walked!(
        door,
        &journal_concepts_all_statement(),
        PARTY_PAIR_BOUND,
        empty.clone()
    );
    let links = walked!(
        door,
        &journal_activity_links_statement(),
        ROSTER_FAN_OUT,
        empty.clone()
    );

    let activity_ids: Vec<String> = links
        .iter()
        .filter_map(|row| text_of(row, "from_id"))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let party_ids: Vec<String> = links
        .iter()
        .filter_map(|row| text_of(row, "to_id"))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();

    let notes = if note_ids.is_empty() {
        Vec::new()
    } else {
        walked!(
            door,
            &journal_notes_statement(&note_ids)?,
            ROSTER_FAN_OUT,
            empty.clone()
        )
    };
    let (activities, annotations) = if activity_ids.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        let activities = walked!(
            door,
            &activities_statement("people.journal.activities", &activity_ids)?,
            ROSTER_FAN_OUT,
            empty.clone()
        );
        let annotations = walked!(
            door,
            &annotations_statement(
                "people.journal.annotations",
                ACTIVITY_TARGET_TYPE,
                &activity_ids,
                centraid_apps_kit::statement::PageOrder::asc("annotation_id", "annotation_id"),
            )?,
            ROSTER_FAN_OUT,
            empty.clone()
        );
        (activities, annotations)
    };
    let (parties, profiles) = if party_ids.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        let parties = walked!(
            door,
            &parties_statement("people.journal.parties", &party_ids)?,
            ROSTER_FAN_OUT,
            empty.clone()
        );
        let profiles = walked!(
            door,
            &journal_profiles_statement(&party_ids)?,
            ROSTER_FAN_OUT,
            empty.clone()
        );
        (parties, profiles)
    };

    let content_ids: Vec<String> = notes
        .iter()
        .filter_map(|row| text_of(row, "body_content_id"))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let contents = if content_ids.is_empty() {
        Vec::new()
    } else {
        walked!(
            door,
            &contents_statement(&content_ids)?,
            ROSTER_FAN_OUT,
            empty.clone()
        )
    };

    let content_by_id: BTreeMap<String, String> = contents
        .iter()
        .filter_map(|row| Some((text_of(row, "content_id")?, text_of(row, "content_uri")?)))
        .collect();
    let notation_by_concept: BTreeMap<String, String> = concepts
        .iter()
        .filter_map(|row| Some((text_of(row, "concept_id")?, text_of(row, "notation")?)))
        .collect();
    let names = names_by_party(&parties);
    let colour_by_party: BTreeMap<String, String> = profiles
        .iter()
        .filter_map(|row| Some((text_of(row, "party_id")?, text_of(row, "avatar_color")?)))
        .collect();
    let party_by_activity: BTreeMap<String, String> = links
        .iter()
        .filter_map(|row| Some((text_of(row, "from_id")?, text_of(row, "to_id")?)))
        .collect();
    let text_by_activity: BTreeMap<String, String> = annotations
        .iter()
        .filter_map(|row| Some((text_of(row, "target_id")?, text_of(row, "body_text")?)))
        .collect();

    let mut entries: Vec<JournalEntry> = Vec::new();
    for row in &notes {
        let Some(id) = text_of(row, "note_id") else {
            continue;
        };
        let created_at = text_of(row, "created_at").unwrap_or_default();
        entries.push(JournalEntry::Owner {
            id,
            date: created_at.chars().take(10).collect(),
            mood: text_of(row, "title")
                .unwrap_or_default()
                .strip_prefix(JOURNAL_TITLE_PREFIX)
                .map_or_else(|| text_of(row, "title").unwrap_or_default(), str::to_owned),
            text: text_of(row, "body_content_id")
                .and_then(|content_id| content_by_id.get(&content_id).cloned())
                .map(|uri| decode_data_uri(&uri))
                .unwrap_or_default(),
            sort_at: created_at,
        });
    }
    for row in &activities {
        let Some(id) = text_of(row, "activity_id") else {
            continue;
        };
        let started_at = text_of(row, "started_at").unwrap_or_default();
        let party_id = party_by_activity.get(&id).cloned().unwrap_or_default();
        entries.push(JournalEntry::Auto {
            touch: text_of(row, "kind_concept_id")
                .and_then(|concept_id| notation_by_concept.get(&concept_id).cloned())
                .unwrap_or_else(|| "interaction".to_owned()),
            text: text_by_activity.get(&id).cloned().unwrap_or_default(),
            name: names
                .get(&party_id)
                .cloned()
                .unwrap_or_else(|| UNKNOWN_NAME.to_owned()),
            avatar_color: colour_by_party.get(&party_id).cloned(),
            party_id,
            // The whole instant, as v0 ships it (finding PE-F4).
            date: started_at.clone(),
            sort_at: started_at,
            id,
        });
    }
    // NEWEST FIRST, over the INSTANT rather than over the rendered `date`.
    // v0 compares with `localeCompare` over the same strings; for ISO instants
    // the two orders agree, and the tiebreak on id is stated here because v0
    // relies on `toSorted`'s stability over a concatenation order (owner
    // entries, then automatic ones) that nothing writes down.
    entries.sort_by(|left, right| {
        right
            .sort_at()
            .cmp(left.sort_at())
            .then_with(|| left.id().cmp(right.id()))
    });

    Ok((JournalData { entries }, None))
}

/// The text of a `data:` URI, percent-decoded.
///
/// v0's `decodeText` (`journal.ts:48`-`:57`): anything that is not a `data:`
/// URI, and anything whose percent-encoding does not decode, is the empty
/// string. **Not an error** — a journal entry whose body row is a `blob:` URI
/// is an entry whose text is elsewhere, and the feed still shows its mood and
/// its date.
#[must_use]
pub fn decode_data_uri(uri: &str) -> String {
    if !uri.starts_with("data:") {
        return String::new();
    }
    let Some(comma) = uri.find(',') else {
        return String::new();
    };
    let encoded = &uri[comma + 1..];
    let bytes = encoded.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut at = 0usize;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let Some(hex) = encoded.get(at + 1..at + 3) else {
                return String::new();
            };
            let Ok(byte) = u8::from_str_radix(hex, 16) else {
                return String::new();
            };
            out.push(byte);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_data_uri_decodes_and_anything_else_is_empty() {
        assert_eq!(
            decode_data_uri("data:text/plain;charset=utf-8,Sunday%20lunch"),
            "Sunday lunch"
        );
        assert_eq!(decode_data_uri("data:text/plain,caf%C3%A9"), "café");
        // Not a data URI: the text lives elsewhere.
        assert_eq!(decode_data_uri("blob:abc"), "");
        // A data URI with no comma is not one.
        assert_eq!(decode_data_uri("data:text/plain"), "");
        // Broken encoding is the empty string, never a panic and never a
        // half-decoded line.
        assert_eq!(decode_data_uri("data:text/plain,%zz"), "");
        assert_eq!(decode_data_uri("data:text/plain,%C3"), "");
    }

    #[test]
    fn the_feed_is_newest_first_over_the_instant() {
        let owner = |id: &str, at: &str| JournalEntry::Owner {
            id: id.to_owned(),
            sort_at: at.to_owned(),
            date: at.chars().take(10).collect(),
            mood: "Good".to_owned(),
            text: String::new(),
        };
        let auto = |id: &str, at: &str| JournalEntry::Auto {
            id: id.to_owned(),
            sort_at: at.to_owned(),
            date: at.to_owned(),
            touch: "call".to_owned(),
            text: String::new(),
            party_id: "p1".to_owned(),
            name: "Maya".to_owned(),
            avatar_color: None,
        };
        let mut entries = [
            owner("n1", "2099-01-01T09:00:00.000Z"),
            auto("a1", "2099-03-01T09:00:00.000Z"),
            owner("n2", "2099-02-01T09:00:00.000Z"),
        ];
        entries.sort_by(|left, right| {
            right
                .sort_at()
                .cmp(left.sort_at())
                .then_with(|| left.id().cmp(right.id()))
        });
        assert_eq!(
            entries.iter().map(JournalEntry::id).collect::<Vec<_>>(),
            ["a1", "n2", "n1"]
        );
        // THE TWO SHAPES CARRY `date` DIFFERENTLY, and the test states it so
        // finding PE-F4 cannot be closed by accident.
        match (&entries[0], &entries[1]) {
            (JournalEntry::Auto { date, .. }, JournalEntry::Owner { date: shown, .. }) => {
                assert_eq!(date.len(), 24, "an automatic entry's date is an instant");
                assert_eq!(shown.len(), 10, "an owner entry's date is a civil date");
            }
            _ => panic!("the order moved"),
        }
    }

    #[test]
    fn the_mood_is_the_title_with_its_prefix_stripped() {
        let title = format!("{JOURNAL_TITLE_PREFIX}Quiet");
        assert_eq!(title.strip_prefix(JOURNAL_TITLE_PREFIX), Some("Quiet"));
        // A title with no prefix is taken whole rather than emptied.
        assert_eq!("Quiet".strip_prefix(JOURNAL_TITLE_PREFIX), None);
    }
}
