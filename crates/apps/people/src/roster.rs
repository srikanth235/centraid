//! THE ROSTER, THE SEARCH AND THE TRASH SHELF — the three reads that answer in
//! the people-row shape.
//!
//! The roster is a bounded recent window of the circle, newest-added first,
//! caller-sized and **walked to its stated size** (the door clamps a page to
//! 500, so a 10,000-row window is twenty pages and the answer says whether it
//! filled). Each row carries the facts a list draws: the star, the list, the
//! reminders that are on, and **when the person was last touched, computed
//! here from the activities `with` them**. What a window of people hangs on is
//! read one table at a time ([`crate::queries`]).

use std::collections::BTreeMap;

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::PageDoor;

use crate::Denial;
use crate::queries::{
    ListEntry, PersonRow, ROSTER_MAX, ROSTER_MIN, Reminder, asked, dates, last_contacts, list_of,
    lists, people_among, read_circle, read_trashed, reminders, starred, touch_stubs,
};

/// What the roster was asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PeopleInput {
    /// Absent is the declared maximum, a `0` included.
    pub limit: Option<usize>,
}

impl PeopleInput {
    /// The window this input asks for, clamped to the manifest's declared range.
    #[must_use]
    pub fn window(self) -> usize {
        self.limit
            .filter(|limit| *limit > 0)
            .unwrap_or(ROSTER_MAX)
            .clamp(ROSTER_MIN, ROSTER_MAX)
    }
}

/// One roster row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterRow {
    pub party_id: String,
    pub name: String,
    pub role: String,
    /// 0 is no cadence.
    pub cadence_days: i64,
    /// The newest touch, or none.
    pub last_contacted_at: Option<String>,
    pub created_at: String,
    pub list_id: Option<String>,
    pub starred: bool,
    /// The dates whose reminder is on, so the sidebar can derive Upcoming.
    pub reminders: Vec<Reminder>,
    /// The hit snippet, on a `search` row only.
    pub snippet: Option<String>,
}

/// What `people` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PeopleData {
    pub people: Vec<RosterRow>,
    pub lists: Vec<ListEntry>,
    /// Older people exist beyond the window: the walk's own answer.
    pub truncated: bool,
    pub window: usize,
}

/// What `search` answers: the same rows, in **vault rank order**.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SearchData {
    pub people: Vec<RosterRow>,
}

/// One row of the trash shelf: a name, a role and a purge date, because a
/// trash shelf is a list of things to restore and not a second copy of the person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashRow {
    pub party_id: String,
    pub name: String,
    pub role: String,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
}

/// What `trash` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TrashData {
    pub people: Vec<TrashRow>,
    /// The shelf is longer than its window.
    pub truncated: bool,
}

/// One hit of the index, already ranked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub party_id: String,
    pub snippet: Option<String>,
}

/// Rank hits into one ordered list with one snippet each: the first hit of a
/// person keeps their place, and a later hit supplies a snippet the first had none of.
#[must_use]
pub fn rank_hits(hits: &[SearchHit]) -> Vec<SearchHit> {
    let mut ranked: Vec<SearchHit> = Vec::new();
    for hit in hits.iter().filter(|hit| !hit.party_id.is_empty()) {
        match ranked.iter_mut().find(|seen| seen.party_id == hit.party_id) {
            None => ranked.push(SearchHit {
                party_id: hit.party_id.clone(),
                snippet: Some(hit.snippet.clone().unwrap_or_default()),
            }),
            Some(seen) if seen.snippet.as_deref().is_none_or(str::is_empty) => {
                if let Some(snippet) = hit.snippet.as_ref().filter(|text| !text.is_empty()) {
                    seen.snippet = Some(snippet.clone());
                }
            }
            Some(_) => {}
        }
    }
    ranked
}

/// The rows of these people, in their order, with the facts a list draws.
pub(crate) fn rows_of(
    door: &dyn PageDoor,
    members: &[PersonRow],
    lists: &[ListEntry],
    with_reminders: bool,
) -> KitResult<Vec<RosterRow>> {
    let ids: Vec<String> = members.iter().map(|person| person.id.clone()).collect();
    let stars = starred(door, &ids)?;
    let filed = list_of(door, &ids, lists)?;
    let last = last_contacts(&touch_stubs(door, &ids)?);
    let mut due: BTreeMap<String, Vec<Reminder>> = if with_reminders {
        let found = dates(door, &members.iter().collect::<Vec<_>>())?;
        reminders(&found)
    } else {
        BTreeMap::new()
    };
    Ok(members
        .iter()
        .map(|person| RosterRow {
            party_id: person.id.clone(),
            name: person.name.clone(),
            role: person.role.clone(),
            cadence_days: person.cadence_days,
            last_contacted_at: last.get(&person.id).cloned(),
            created_at: person.created_at.clone(),
            list_id: filed.get(&person.id).cloned(),
            starred: stars.contains(&person.id),
            reminders: due.remove(&person.id).unwrap_or_default(),
            snippet: None,
        })
        .collect())
}

/// `people` — the roster.
pub fn load_people(
    door: &dyn PageDoor,
    input: PeopleInput,
) -> KitResult<(PeopleData, Option<Denial>)> {
    let window = input.window();
    let empty = PeopleData {
        window,
        ..PeopleData::default()
    };
    let circle = asked!(read_circle(door, window), empty.clone());
    let lists = asked!(lists(door), empty.clone());
    let people = asked!(rows_of(door, &circle.members, &lists, true), empty);
    Ok((
        PeopleData {
            people,
            lists,
            truncated: circle.filled,
            window,
        },
        None,
    ))
}

/// `search` — the roster's row shape, in the order the index ranked it.
///
/// The hits are filtered to the live circle: a trashed person, the owner and a
/// pet are hits of the index and no one this app shows. A search row carries no
/// reminders; the dates are the roster's read.
pub fn load_search(
    door: &dyn PageDoor,
    hits: &[SearchHit],
) -> KitResult<(SearchData, Option<Denial>)> {
    let ids: Vec<String> = hits.iter().map(|hit| hit.party_id.clone()).collect();
    let live = asked!(people_among(door, &ids, true), SearchData::default());
    let members: Vec<PersonRow> = hits
        .iter()
        .filter_map(|hit| live.get(&hit.party_id).cloned())
        .collect();
    let lists = asked!(lists(door), SearchData::default());
    let mut people = asked!(
        rows_of(door, &members, &lists, false),
        SearchData::default()
    );
    for (row, hit) in people
        .iter_mut()
        .zip(hits.iter().filter(|hit| live.contains_key(&hit.party_id)))
    {
        row.snippet = hit.snippet.clone();
    }
    Ok((SearchData { people }, None))
}

/// `trash` — the reversible shelf.
pub fn load_trash(door: &dyn PageDoor) -> KitResult<(TrashData, Option<Denial>)> {
    let shelf = asked!(read_trashed(door), TrashData::default());
    Ok((
        TrashData {
            people: shelf
                .members
                .into_iter()
                .map(|person| TrashRow {
                    party_id: person.id,
                    name: person.name,
                    role: person.role,
                    deleted_at: person.deleted_at,
                    purge_at: person.purge_at,
                })
                .collect(),
            truncated: shelf.filled,
        },
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_clamps_to_the_manifests_range_and_an_absent_limit_is_the_maximum() {
        let window = |limit| PeopleInput { limit }.window();
        assert_eq!(window(None), ROSTER_MAX);
        assert_eq!(window(Some(0)), ROSTER_MAX);
        assert_eq!(window(Some(5)), ROSTER_MIN);
        assert_eq!(window(Some(50_000)), ROSTER_MAX);
        assert_eq!(window(Some(300)), 300);
    }

    #[test]
    fn ranking_keeps_the_first_hit_of_a_person_and_the_first_snippet_that_is_real() {
        let hit = |id: &str, snippet: Option<&str>| SearchHit {
            party_id: id.to_owned(),
            snippet: snippet.map(str::to_owned),
        };
        let ranked = rank_hits(&[
            hit("b", None),
            hit("a", Some("first")),
            hit("b", Some("later")),
            hit("a", Some("second")),
            hit("", Some("no one")),
        ]);
        assert_eq!(
            ranked,
            [hit("b", Some("later")), hit("a", Some("first"))],
            "order is the first hit's; a blank snippet is filled by a later real one"
        );
    }
}
