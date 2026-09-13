//! THE ROSTER, THE SEARCH AND THE TRASH SHELF — the three queries that answer
//! in the people-row shape.
//!
//! `queries/people.ts` is the one to read first (258 lines). Its doctrine, in
//! its own words: *"The people window as a bounded recent view: the CRM people
//! are the rows of people.profile (each a 1:1 enrichment of a canonical
//! core.party), newest first, caller-sized … Each row also carries the sharing
//! plane's answer to 'is this person linked to a vault of their own?'"*
//!
//! ## The window is walked, not clamped (finding PE-F3)
//!
//! v0 asks for the roster as ONE page of `limit` rows and takes `.rows`
//! (`people.ts:106`-`:122`). `MAX_PAGE_ROWS` clamps a page to 500, so **a
//! roster declaring a 10,000-row window returns at most 500 people**. It does
//! at least say so — `truncated` is the page's own cursor and the status line
//! names it — but `window: 9999` beside 500 rows is a sentence that is not
//! true. The port walks the stated window with
//! [`centraid_apps_kit::read_window`] and reports whether it filled, which is
//! the second half of D-1020-D3-12 applied to this app.
//!
//! ## The share plane is ONE read for the whole window, and it denies alone
//!
//! `readLiveBindings` catches and answers `null` — "facts absent" — rather than
//! letting a denial darken the roster (`_shared.ts:2`-`:3`). v0 then ships
//! `linked: null` **and `vault_count: 0` beside it**
//! (`people.ts:212`-`:213`), which is the "0 instead of unknown" failure the
//! type in [`crate::ReadState`] exists to make unrepresentable: here the counts
//! live inside [`VaultLinks`], so a denied read has no count to read at all.

use std::collections::BTreeMap;

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{PageDoor, read_window};
use centraid_apps_kit::row::{Cell, Row, text_of};

use crate::queries::{
    PARTY_PAIR_BOUND, ROSTER_FAN_OUT, ROSTER_MAX, ROSTER_MIN, Reminder, TRASH_ROWS, Taxonomy,
    UNKNOWN_NAME, Walked, fold_party_tags, fold_reminders, important_dates_statement,
    live_bindings_statement, names_by_party, parties_statement, party_tags_statement,
    read_taxonomy, roster_profiles_statement, trash_profiles_statement, walk, walked,
};
use crate::{Denial, ReadState};

/// What the roster was asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PeopleInput {
    /// Absent is the declared maximum, as v0's `Number(input?.limit) ||
    /// ROSTER_MAX` resolves it — including for a `0`, which is falsy there.
    pub limit: Option<usize>,
}

impl PeopleInput {
    /// The window this input asks for, clamped to the manifest's declared
    /// range.
    ///
    /// **The declared maximum is 10,000 and the port honours it** (D-1020-PE4);
    /// v0 clamps to 9,999 for a look-ahead row it no longer takes. Nothing in
    /// the manifest explains why the number is 10,000 rather than the 2,000
    /// every other app stops at, and this lane did not find an explanation.
    #[must_use]
    pub fn window(self) -> usize {
        self.limit
            .filter(|limit| *limit > 0)
            .unwrap_or(ROSTER_MAX)
            .clamp(ROSTER_MIN, ROSTER_MAX)
    }
}

/// The share plane's answer for a whole roster: live bindings by party.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct VaultLinks {
    counts: BTreeMap<String, usize>,
}

impl VaultLinks {
    /// Count the live bindings a `people.shared.liveBindings` walk returned.
    #[must_use]
    pub fn of_bindings(rows: &[Row]) -> Self {
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for row in rows {
            if let Some(party_id) = text_of(row, "party_id") {
                *counts.entry(party_id).or_insert(0) += 1;
            }
        }
        Self { counts }
    }

    /// Whether this person has a vault of their own.
    #[must_use]
    pub fn linked(&self, party_id: &str) -> bool {
        self.counts.contains_key(party_id)
    }

    /// How many vaults they are bound to. Only reachable through a `Ready`
    /// reading, which is what stops a denial being drawn as a zero.
    #[must_use]
    pub fn vault_count(&self, party_id: &str) -> usize {
        self.counts.get(party_id).copied().unwrap_or(0)
    }

    /// How many of a window's parties are linked. The dashboard's `linked`
    /// count, which is a `Set` size in v0 and a key count here.
    #[must_use]
    pub fn linked_in(&self, party_ids: &[String]) -> usize {
        party_ids
            .iter()
            .filter(|party_id| self.counts.contains_key(party_id.as_str()))
            .count()
    }
}

/// One roster row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterRow {
    pub party_id: String,
    pub name: String,
    pub role: String,
    pub avatar_color: Option<String>,
    pub cadence_days: i64,
    pub last_contacted_at: Option<String>,
    pub created_at: String,
    /// One lists-scheme tag, the same mechanism Docs' folders use.
    pub list_id: Option<String>,
    /// The canonical flags-scheme star on the PARTY (#274) — shared vault-wide,
    /// never a People-local column.
    pub starred: bool,
    /// The dates whose reminder is ON, so the sidebar can derive Upcoming
    /// client-side.
    pub reminders: Vec<Reminder>,
    /// The hit snippet, on a `search` row only.
    pub snippet: Option<String>,
}

/// What `people` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PeopleData {
    pub people: Vec<RosterRow>,
    pub lists: Vec<crate::queries::ListEntry>,
    /// Older people exist beyond the window. **The walk's own answer**, not a
    /// row count and not one page's cursor.
    pub truncated: bool,
    pub window: usize,
    /// **Denied is "we cannot see"; `Ready` with no entry for a party is
    /// "linked to no vault".** `links_available` on the wire.
    pub links: ReadState<VaultLinks>,
}

/// What `search` answers: the same rows, in **vault rank order**.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SearchData {
    pub people: Vec<RosterRow>,
}

/// One row of the trash shelf. **Secret-free by construction**: a name, a role
/// and a purge date, because a trash shelf is a list of things to restore and
/// not a second copy of the person (`trash.ts:1`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashRow {
    pub party_id: String,
    pub name: String,
    pub role: String,
    pub purge_at: Option<String>,
}

/// What `trash` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TrashData {
    pub people: Vec<TrashRow>,
    /// The shelf is longer than [`TRASH_ROWS`]. v0 cannot say this at all — it
    /// takes one page and reports nothing.
    pub truncated: bool,
}

/// One FTS hit, as the three indexes answer.
///
/// `ctx.vault.search` belongs to `crates/search` and is not a
/// [`centraid_apps_kit::PageQuery`], so the hits arrive here already ranked and
/// the fold keeps that order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub party_id: String,
    pub snippet: Option<String>,
}

/// Rank the three indexes' hits into one ordered party list with one snippet
/// each.
///
/// **Name matches first, then role, then notes** (`search.ts:8`), and a party
/// already ranked keeps its position — but takes a snippet from a later index
/// if the earlier one had none (`search.ts:93`-`:98`). Both halves matter: the
/// order is the answer's meaning and the snippet is what the row shows.
#[must_use]
pub fn rank_hits(
    by_name: &[SearchHit],
    by_role: &[SearchHit],
    by_note: &[SearchHit],
) -> Vec<SearchHit> {
    let mut order: Vec<String> = Vec::new();
    let mut snippets: BTreeMap<String, String> = BTreeMap::new();
    for hit in by_name.iter().chain(by_role).chain(by_note) {
        if hit.party_id.is_empty() {
            continue;
        }
        match snippets.get(&hit.party_id) {
            None => {
                snippets.insert(
                    hit.party_id.clone(),
                    hit.snippet.clone().unwrap_or_default(),
                );
                order.push(hit.party_id.clone());
            }
            Some(existing) if existing.is_empty() => {
                if let Some(snippet) = hit.snippet.as_ref().filter(|text| !text.is_empty()) {
                    snippets.insert(hit.party_id.clone(), snippet.clone());
                }
            }
            Some(_) => {}
        }
    }
    order
        .into_iter()
        .map(|party_id| SearchHit {
            snippet: snippets.get(&party_id).cloned(),
            party_id,
        })
        .collect()
}

/// `people` — the roster.
pub fn load_people(
    door: &dyn PageDoor,
    input: PeopleInput,
) -> KitResult<(PeopleData, Option<Denial>)> {
    let window = input.window();
    let empty = PeopleData {
        window,
        links: ReadState::Denied(Denial::default()),
        ..PeopleData::default()
    };

    // THE WINDOW IS WALKED. v0 takes one page and calls it the window.
    let walked_window = match read_window(door, &roster_profiles_statement(), window) {
        Ok(walked) => walked,
        Err(centraid_apps_kit::KitError::Door(message)) => {
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
    let taxonomy = match walk(
        door,
        &crate::queries::taxonomy_concepts_statement(),
        PARTY_PAIR_BOUND,
    )? {
        Walked::Denied(denial) => return Ok((empty, Some(denial))),
        Walked::Rows(concepts) => {
            match walk(
                door,
                &crate::queries::taxonomy_schemes_statement(),
                ROSTER_FAN_OUT,
            )? {
                Walked::Denied(denial) => return Ok((empty, Some(denial))),
                Walked::Rows(schemes) => Taxonomy { concepts, schemes },
            }
        }
    };
    let lists = taxonomy.lists();

    let profiles = walked_window.rows;
    let party_ids: Vec<String> = profiles
        .iter()
        .filter_map(|row| text_of(row, "party_id"))
        .collect();
    if party_ids.is_empty() {
        // AN EMPTY ROSTER IS NOT A DENIED ONE. v0 returns `links_available:
        // true` here without having read the plane, and the port keeps the
        // claim honest by saying what it knows: nobody is linked, because
        // nobody is here.
        return Ok((
            PeopleData {
                people: Vec::new(),
                lists,
                truncated: false,
                window,
                links: ReadState::Ready(VaultLinks::default()),
            },
            None,
        ));
    }

    let empty = PeopleData {
        lists: lists.clone(),
        window,
        links: ReadState::Denied(Denial::default()),
        ..PeopleData::default()
    };
    let parties = walked!(
        door,
        &parties_statement("people.roster.parties", &party_ids)?,
        ROSTER_FAN_OUT,
        empty.clone()
    );
    let tags = walked!(
        door,
        &party_tags_statement("people.roster.tags", &party_ids)?,
        PARTY_PAIR_BOUND,
        empty.clone()
    );
    let dates = walked!(
        door,
        &important_dates_statement("people.roster.importantDates", &party_ids)?,
        ROSTER_FAN_OUT,
        empty.clone()
    );
    // THE ONE READ THAT DENIES ALONE.
    let links = match walk(door, &live_bindings_statement(&party_ids)?, ROSTER_FAN_OUT)? {
        Walked::Rows(rows) => ReadState::Ready(VaultLinks::of_bindings(&rows)),
        Walked::Denied(denial) => ReadState::Denied(denial),
    };

    let names = names_by_party(&parties);
    let (list_by_party, starred) = fold_party_tags(&tags, &taxonomy);
    let reminders = fold_reminders(&dates);

    let people = profiles
        .iter()
        .filter_map(|row| {
            let party_id = text_of(row, "party_id")?;
            Some(RosterRow {
                name: names
                    .get(&party_id)
                    .cloned()
                    .unwrap_or_else(|| UNKNOWN_NAME.to_owned()),
                role: text_of(row, "role").unwrap_or_default(),
                avatar_color: text_of(row, "avatar_color"),
                cadence_days: row
                    .get("cadence_days")
                    .and_then(Cell::integer)
                    .unwrap_or_default(),
                last_contacted_at: text_of(row, "last_contacted_at"),
                created_at: text_of(row, "created_at").unwrap_or_default(),
                list_id: list_by_party.get(&party_id).cloned(),
                starred: starred.contains(&party_id),
                reminders: reminders.get(&party_id).cloned().unwrap_or_default(),
                snippet: None,
                party_id,
            })
        })
        .collect();

    Ok((
        PeopleData {
            people,
            lists,
            truncated: walked_window.filled,
            window,
            links,
        },
        None,
    ))
}

/// `search` — the roster's row shape, in the order the indexes ranked it.
///
/// **The hits are filtered to the CRM people**: a party with no live
/// `people_profile` is a party this app does not show, however well it matched
/// (`search.ts:185`). A trashed person is excluded by the same filter, because
/// the profile read carries `deleted_at IS NULL`.
///
/// `reminders` is `[]` on every search row in v0 (`search.ts:198`) — the
/// important-date read is the roster's and search does not make it. The port
/// reproduces the empty list rather than making a read v0 does not, and names
/// it: a search result cannot show the reminder chip the same person shows on
/// the roster.
pub fn load_search(
    door: &dyn PageDoor,
    hits: &[SearchHit],
) -> KitResult<(SearchData, Option<Denial>)> {
    if hits.is_empty() {
        return Ok((SearchData::default(), None));
    }
    let party_ids: Vec<String> = hits.iter().map(|hit| hit.party_id.clone()).collect();
    let empty = SearchData::default();

    let profiles = walked!(
        door,
        &search_profiles_statement(&party_ids)?,
        ROSTER_FAN_OUT,
        empty.clone()
    );
    let parties = walked!(
        door,
        &parties_statement("people.search.parties", &party_ids)?,
        ROSTER_FAN_OUT,
        empty.clone()
    );
    let tags = walked!(
        door,
        &party_tags_statement("people.search.tags", &party_ids)?,
        PARTY_PAIR_BOUND,
        empty.clone()
    );
    let taxonomy = match read_taxonomy(door) {
        Ok(taxonomy) => taxonomy,
        Err(centraid_apps_kit::KitError::Door(message)) => {
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

    let names = names_by_party(&parties);
    let (list_by_party, starred) = fold_party_tags(&tags, &taxonomy);
    let by_party: BTreeMap<String, &Row> = profiles
        .iter()
        .filter_map(|row| Some((text_of(row, "party_id")?, row)))
        .collect();

    let people = hits
        .iter()
        .filter_map(|hit| {
            let row = by_party.get(&hit.party_id)?;
            Some(RosterRow {
                party_id: hit.party_id.clone(),
                name: names
                    .get(&hit.party_id)
                    .cloned()
                    .unwrap_or_else(|| UNKNOWN_NAME.to_owned()),
                role: text_of(row, "role").unwrap_or_default(),
                avatar_color: text_of(row, "avatar_color"),
                cadence_days: row
                    .get("cadence_days")
                    .and_then(Cell::integer)
                    .unwrap_or_default(),
                last_contacted_at: text_of(row, "last_contacted_at"),
                created_at: text_of(row, "created_at").unwrap_or_default(),
                list_id: list_by_party.get(&hit.party_id).cloned(),
                starred: starred.contains(&hit.party_id),
                reminders: Vec::new(),
                snippet: Some(hit.snippet.clone().unwrap_or_default()),
            })
        })
        .collect();

    Ok((SearchData { people }, None))
}

/// `people.search.profiles` — the live CRM profiles among the ranked hits.
fn search_profiles_statement(
    party_ids: &[String],
) -> KitResult<centraid_apps_kit::statement::PageQuery> {
    let fragment = centraid_apps_kit::reads::in_list("party_id", party_ids)?;
    Ok(centraid_apps_kit::statement::PageQuery::new(
        "people.search.profiles",
        "party_id, created_at, cadence_days, role, avatar_color, last_contacted_at, deleted_at",
        "people_profile",
        centraid_apps_kit::statement::PageOrder::asc("party_id", "party_id"),
    )
    .filter(
        &format!("{} AND deleted_at IS NULL", fragment.sql),
        fragment.bind,
    ))
}

/// `trash` — the reversible shelf.
///
/// **The canonical parties remain intact** (`trash.ts:16`): trashing a person
/// dates the `people_profile` shut and leaves `core_party` alone, which is why
/// the shelf has to read the names from the party table rather than from a copy
/// it kept.
pub fn load_trash(door: &dyn PageDoor) -> KitResult<(TrashData, Option<Denial>)> {
    let empty = TrashData::default();
    let shelf = match read_window(door, &trash_profiles_statement(), TRASH_ROWS) {
        Ok(shelf) => shelf,
        Err(centraid_apps_kit::KitError::Door(message)) => {
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
    let party_ids: Vec<String> = shelf
        .rows
        .iter()
        .filter_map(|row| text_of(row, "party_id"))
        .collect();
    if party_ids.is_empty() {
        return Ok((TrashData::default(), None));
    }
    let parties = walked!(
        door,
        &parties_statement("people.trash.parties", &party_ids)?,
        ROSTER_FAN_OUT,
        empty.clone()
    );
    let names = names_by_party(&parties);
    let people = shelf
        .rows
        .iter()
        .filter_map(|row| {
            let party_id = text_of(row, "party_id")?;
            Some(TrashRow {
                name: names
                    .get(&party_id)
                    .cloned()
                    .unwrap_or_else(|| UNKNOWN_NAME.to_owned()),
                role: text_of(row, "role").unwrap_or_default(),
                purge_at: text_of(row, "purge_at"),
                party_id,
            })
        })
        .collect();
    Ok((
        TrashData {
            people,
            truncated: shelf.filled,
        },
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queries::V0_ROSTER_MAX;

    #[test]
    fn the_window_clamps_to_the_manifests_range_and_an_absent_limit_is_the_maximum() {
        assert_eq!(PeopleInput { limit: None }.window(), ROSTER_MAX);
        // A ZERO IS FALSY IN v0 and resolves to the default, not to the floor.
        assert_eq!(PeopleInput { limit: Some(0) }.window(), ROSTER_MAX);
        assert_eq!(PeopleInput { limit: Some(1) }.window(), ROSTER_MIN);
        assert_eq!(PeopleInput { limit: Some(200) }.window(), 200);
        assert_eq!(
            PeopleInput {
                limit: Some(50_000)
            }
            .window(),
            ROSTER_MAX
        );
        // THE DIVERGENCE, stated: v0 hands back one row fewer at the ceiling.
        assert_eq!(
            PeopleInput {
                limit: Some(10_000)
            }
            .window(),
            ROSTER_MAX
        );
        assert_ne!(ROSTER_MAX, V0_ROSTER_MAX);
    }

    #[test]
    fn a_denied_share_plane_has_no_count_to_draw_a_chip_on() {
        let denied: ReadState<VaultLinks> = ReadState::Denied(Denial::default());
        assert!(denied.ready().is_none());
        // There is no `linked` and no `vault_count` reachable here at all: the
        // fields live inside the reading, which is the whole point.
        let ready = ReadState::Ready(VaultLinks::of_bindings(&[]));
        assert!(ready.known());
        assert_eq!(
            ready.ready().map(|links| links.vault_count("p1")),
            Some(0),
            "a KNOWN zero is a different claim from a denied read"
        );
    }

    #[test]
    fn live_bindings_count_per_party_and_a_party_with_none_is_unlinked() {
        let binding = |id: &str, party: &str| {
            let mut row = Row::new();
            row.insert("binding_id".to_owned(), Cell::Text(id.to_owned()));
            row.insert("party_id".to_owned(), Cell::Text(party.to_owned()));
            row
        };
        let links = VaultLinks::of_bindings(&[
            binding("b1", "p1"),
            binding("b2", "p1"),
            binding("b3", "p2"),
        ]);
        assert!(links.linked("p1"));
        assert_eq!(links.vault_count("p1"), 2);
        assert!(!links.linked("p3"));
        assert_eq!(links.vault_count("p3"), 0);
        // The dashboard's `linked` count is DISTINCT parties, not bindings.
        assert_eq!(
            links.linked_in(&["p1".to_owned(), "p2".to_owned(), "p3".to_owned()]),
            2
        );
    }

    #[test]
    fn ranking_keeps_the_first_index_that_matched_and_the_first_snippet_that_is_real() {
        let hit = |party: &str, snippet: &str| SearchHit {
            party_id: party.to_owned(),
            snippet: Some(snippet.to_owned()),
        };
        let ranked = rank_hits(
            &[hit("p-name", "Maya"), hit("p-both", "")],
            &[hit("p-both", "Design lead"), hit("p-role", "Grandfather")],
            &[hit("p-name", "a note"), hit("p-note", "cabin")],
        );
        assert_eq!(
            ranked
                .iter()
                .map(|hit| hit.party_id.as_str())
                .collect::<Vec<_>>(),
            ["p-name", "p-both", "p-role", "p-note"],
            "name matches rank first, then role, then notes"
        );
        // The empty snippet from the name index is filled by the role index…
        assert_eq!(ranked[1].snippet.as_deref(), Some("Design lead"));
        // …and a snippet that was already real is never overwritten.
        assert_eq!(ranked[0].snippet.as_deref(), Some("Maya"));
    }
}
