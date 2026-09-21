//! THE KEEP-IN-TOUCH SUMMARY — and the birthday rail the daily brief reads
//! (D-1020-PE7).
//!
//! `queries/dashboard.ts`'s doctrine, in its own words: *"who is overdue to
//! reconnect with (last contact strictly past their cadence), which reminders
//! are coming up next (birthdays and dates with their reminder on), the most
//! recent touches you have logged, and the headline counts. A person never
//! contacted counts from when they were added, so a fresh contact reads as
//! on-track."*
//!
//! ## Three rules a port must not re-derive
//!
//! 1. **A cadence of 0 days is "no cadence", not "overdue every day"**: those
//!    people are excluded from Reconnect entirely rather than pinned to the top
//!    of it forever (`dashboard.ts:11`-`:13`). See [`crate::dates::is_overdue`].
//! 2. **Overdue only AFTER the cadence day**, strictly greater, never on it
//!    (`format.ts:3`-`:5`).
//! 3. **`linked` / `to_link` are one reading and stay null together**
//!    (`format.ts:109`-`:112`): a denied share plane leaves the pair absent
//!    while the four original counts stand.
//!
//! ## Finding PE-F3 — the counts are a fold over a clamped page
//!
//! `counts.all` is `profileRows.length` and `dashboard.ts:103` asks for
//! `window = 9_999` as ONE page. `MAX_PAGE_ROWS` clamps a page to 500, so **a
//! vault with more than 500 live people reports `all: 500`** and folds
//! `reconnect`, `upcoming` and `starred` over the same 500 — with no
//! `truncated` flag anywhere in the payload to say so, because the dashboard's
//! output schema has none. That is the D-1020-D3-12 failure in its worse form:
//! "a balance derived from a silently short ledger is a WRONG NUMBER, not a
//! slow screen", with a person count in place of the balance. The port walks
//! the stated window and ships [`DashboardData::truncated`].
//!
//! The window itself is the other half of the finding: the `dashboard` query's
//! input schema declares **no properties at all**, so 9,999 is a number with no
//! declaration behind it and no way for a caller to change it.
//!
//! ## The birthday rail is civil time, and the zone is the vault's
//!
//! `upcoming` sorts by [`crate::dates::days_until_month_day`], which v0
//! computes against the HOST's local midnight. This is the *birthday, daily
//! brief* notification journey's data, and the automations lane's rule is that
//! a civil-time question is answered in the vault's zone
//! (`docs/cron-timezone.md`) — so [`load_dashboard`] takes the vault's own
//! civil date and there is no clock in this crate to read the host's from.

use std::collections::BTreeMap;

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::reads::{PageDoor, read_window};
use centraid_apps_kit::row::{Cell, Row, text_of};

use crate::dates::{CivilDate, days_since_contact, days_until_month_day, is_overdue};
use crate::queries::{
    ACTIVITY_TARGET_TYPE, DASHBOARD_WINDOW, PARTY_PAIR_BOUND, PersonCard, RECENT_ACTIVITY_ROWS,
    ROSTER_FAN_OUT, UNKNOWN_NAME, activities_statement, activity_links_statement,
    annotations_statement, dashboard_profiles_statement, fold_party_tags,
    important_dates_statement, names_by_party, parties_statement, party_tags_statement,
    read_taxonomy, reminder_on, walked,
};
use crate::Denial;

/// One row of the Upcoming rail: a person's card plus the date itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpcomingRow {
    pub card: PersonCard,
    pub date_id: String,
    pub label: String,
    pub month_day: String,
    /// Days until the next occurrence, in the VAULT's zone. Not in v0's
    /// payload — v0 sorts by it and drops it — and shipped here because the
    /// daily brief needs "is this today" and must not recompute it against a
    /// second clock.
    pub in_days: i64,
}

/// One row of the Recent rail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentRow {
    pub card: PersonCard,
    pub interaction_id: String,
    /// The kind concept's **`pref_label`**, or `Touch`. Note the asymmetry with
    /// the person sheet, which shows the same concept's `notation`
    /// (`dashboard.ts:254`-`:256` against `person.ts:531`): the dashboard shows
    /// a label and the sheet shows a code, for the same row.
    pub kind: String,
    pub text: String,
    pub occurred_at: String,
}

/// The headline counts. **`linked` and `to_link` live inside the reading**, so
/// a denied share plane has no pair to draw as zeros.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Counts {
    pub all: usize,
    pub reconnect: usize,
    pub upcoming: usize,
    pub starred: usize,
}

/// What `dashboard` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DashboardData {
    pub reconnect: Vec<PersonCard>,
    pub upcoming: Vec<UpcomingRow>,
    pub recent: Vec<RecentRow>,
    pub counts: Counts,
    /// **More live people exist than the window read.** v0's payload cannot say
    /// this at all; see finding PE-F3.
    pub truncated: bool,
    /// The window the counts were folded over, so `all` is readable as
    /// "`all` of this many".
    pub window: usize,
}

/// `dashboard` — the summary.
///
/// `today` is the vault's own civil date and `now_ms` the instant the cadence
/// arithmetic is measured against. Both are the caller's, for the reason
/// [`crate::dates`] states: a handler that could read a clock would read the
/// host's.
pub fn load_dashboard(
    door: &dyn PageDoor,
    today: CivilDate,
    now_ms: i64,
) -> KitResult<(DashboardData, Option<Denial>)> {
    let empty = DashboardData {
        window: DASHBOARD_WINDOW,
        ..DashboardData::default()
    };

    // THE WINDOW IS WALKED, because `counts.all` is a fold over it.
    let window = match read_window(door, &dashboard_profiles_statement(), DASHBOARD_WINDOW) {
        Ok(window) => window,
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
    let taxonomy = match read_taxonomy(door) {
        Ok(taxonomy) => taxonomy,
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

    let profiles = window.rows;
    let party_ids: Vec<String> = profiles
        .iter()
        .filter_map(|row| text_of(row, "party_id"))
        .collect();
    if party_ids.is_empty() {
        return Ok((
            DashboardData {
                window: DASHBOARD_WINDOW,
                ..DashboardData::default()
            },
            None,
        ));
    }

    let parties = walked!(
        door,
        &parties_statement("people.dashboard.parties", &party_ids)?,
        ROSTER_FAN_OUT,
        empty.clone()
    );
    let tags = walked!(
        door,
        &party_tags_statement("people.dashboard.tags", &party_ids)?,
        PARTY_PAIR_BOUND,
        empty.clone()
    );
    let dates = walked!(
        door,
        &important_dates_statement("people.dashboard.importantDates", &party_ids)?,
        ROSTER_FAN_OUT,
        empty.clone()
    );
    let links_rows = walked!(
        door,
        &activity_links_statement(&party_ids)?,
        ROSTER_FAN_OUT,
        empty.clone()
    );
    let names = names_by_party(&parties);
    let cards: BTreeMap<String, PersonCard> = profiles
        .iter()
        .filter_map(|row| {
            let party_id = text_of(row, "party_id")?;
            Some((
                party_id.clone(),
                PersonCard {
                    name: names
                        .get(&party_id)
                        .cloned()
                        .unwrap_or_else(|| UNKNOWN_NAME.to_owned()),
                    avatar_color: text_of(row, "avatar_color"),
                    role: text_of(row, "role").unwrap_or_default(),
                    party_id,
                },
            ))
        })
        .collect();
    let card = |party_id: &str| -> PersonCard {
        cards.get(party_id).cloned().unwrap_or_else(|| PersonCard {
            party_id: party_id.to_owned(),
            name: UNKNOWN_NAME.to_owned(),
            avatar_color: None,
            role: String::new(),
        })
    };

    let (_, starred_parties) = fold_party_tags(&tags, &taxonomy);
    let starred = tags
        .iter()
        .filter(|row| {
            taxonomy.starred_concept_id().as_deref() == text_of(row, "concept_id").as_deref()
        })
        .count();
    drop(starred_parties);

    // RECONNECT: overdue, most overdue first.
    let mut overdue: Vec<(i64, String)> = profiles
        .iter()
        .filter_map(|row| {
            let party_id = text_of(row, "party_id")?;
            let cadence = row
                .get("cadence_days")
                .and_then(Cell::integer)
                .unwrap_or_default();
            let last = text_of(row, "last_contacted_at");
            let created = text_of(row, "created_at");
            if !is_overdue(cadence, last.as_deref(), created.as_deref(), now_ms) {
                return None;
            }
            let over = days_since_contact(last.as_deref(), created.as_deref(), now_ms) - cadence;
            Some((over, party_id))
        })
        .collect();
    // MOST OVERDUE FIRST, and ties by party id so the rail does not reshuffle
    // between two reads — v0's `toSorted` is stable over the profile page's own
    // order, which is `created_at DESC, party_id`; this is the explicit key.
    overdue.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    let reconnect: Vec<PersonCard> = overdue.iter().map(|(_, party_id)| card(party_id)).collect();

    // UPCOMING: active reminders, nearest first, in the VAULT's zone.
    let mut soon: Vec<(i64, &Row)> = dates
        .iter()
        .filter(|row| reminder_on(row))
        .map(|row| {
            (
                days_until_month_day(
                    today,
                    text_of(row, "month_day").unwrap_or_default().as_str(),
                ),
                row,
            )
        })
        .collect();
    soon.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| text_of(left.1, "date_id").cmp(&text_of(right.1, "date_id")))
    });
    let upcoming: Vec<UpcomingRow> = soon
        .iter()
        .filter_map(|(in_days, row)| {
            let party_id = text_of(row, "party_id")?;
            Some(UpcomingRow {
                card: card(&party_id),
                date_id: text_of(row, "date_id")?,
                label: text_of(row, "label").unwrap_or_default(),
                month_day: text_of(row, "month_day").unwrap_or_default(),
                in_days: *in_days,
            })
        })
        .collect();

    // RECENT: the activity rail's own window, bounded by the links above.
    let activity_ids: Vec<String> = links_rows
        .iter()
        .filter_map(|row| text_of(row, "from_id"))
        .collect();
    let party_by_activity: BTreeMap<String, String> = links_rows
        .iter()
        .filter_map(|row| Some((text_of(row, "from_id")?, text_of(row, "to_id")?)))
        .collect();
    let recent = if activity_ids.is_empty() {
        Vec::new()
    } else {
        let activities = match read_window(
            door,
            &activities_statement("people.dashboard.activities", &activity_ids)?,
            RECENT_ACTIVITY_ROWS,
        ) {
            Ok(window) => window.rows,
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
        let notes = walked!(
            door,
            &annotations_statement(
                "people.dashboard.activityNotes",
                ACTIVITY_TARGET_TYPE,
                &activity_ids,
                centraid_apps_kit::statement::PageOrder::asc("annotation_id", "annotation_id"),
            )?,
            ROSTER_FAN_OUT,
            empty.clone()
        );
        let text_by_activity: BTreeMap<String, String> = notes
            .iter()
            .filter_map(|row| Some((text_of(row, "target_id")?, text_of(row, "body_text")?)))
            .collect();
        activities
            .iter()
            .filter_map(|row| {
                let activity_id = text_of(row, "activity_id")?;
                // A touch whose link this window did not return is not this
                // rail's row — v0 drops it rather than drawing a card with no
                // person on it.
                let party_id = party_by_activity.get(&activity_id)?;
                Some(RecentRow {
                    card: card(party_id),
                    kind: text_of(row, "kind_concept_id")
                        .and_then(|concept_id| taxonomy.label_of(&concept_id))
                        .unwrap_or_else(|| DEFAULT_TOUCH_LABEL.to_owned()),
                    text: text_by_activity
                        .get(&activity_id)
                        .cloned()
                        .unwrap_or_default(),
                    occurred_at: text_of(row, "started_at").unwrap_or_default(),
                    interaction_id: activity_id,
                })
            })
            .collect()
    };

    let counts = Counts {
        all: profiles.len(),
        reconnect: reconnect.len(),
        upcoming: upcoming.len(),
        starred,
    };
    Ok((
        DashboardData {
            reconnect,
            upcoming,
            recent,
            counts,
            truncated: window.filled,
            window: DASHBOARD_WINDOW,
        },
        None,
    ))
}

/// The label a touch shows when its kind concept resolves to none.
pub const DEFAULT_TOUCH_LABEL: &str = "Touch";

