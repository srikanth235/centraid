//! PEOPLE'S ARM OF THE APP QUERY (#1046): `crates/apps/people`'s folds, asked
//! through [`super::VaultDoor`] and spelled as `people.proto` spells them.
//!
//! The chips, the sort and every cadence and civil-date fact are the crate's
//! (`centraid_apps_people::phone`); this module only resolves the zone and the
//! vault clock, runs the loader, and converts. `today` is the vault clock's day
//! in the request's zone ([`super::zone_of`]'s rule) and `now_ms` is the vault
//! clock's instant — never the host's.
//!
//! # THE ROSTER IS THE PROFILES, NOT EVERY PARTY
//!
//! A party with no `people_profile` row — the owner, a face-review party made
//! by `core.add_party`, an organisation — is not in the roster, the dashboard
//! or the sheet. That is kept rather than widened: a profile-less party has no
//! cadence, no trash state and no row `people.edit_person` or
//! `people.trash_person` would accept, so a roster that drew it would draw a
//! row every action on the sheet refuses. A person made anywhere else becomes
//! a People row by being made with `people.add_person` (which takes the
//! `display_name` and mints the party with its profile).

use centraid_api_proto::core_v1 as wire;
use centraid_apps_agenda::local;
use centraid_apps_people as people;
use centraid_apps_people::dates::CivilDate;
use centraid_apps_people::phone::{self, RosterFilter, RosterSort};
use centraid_apps_people::roster::{PeopleInput, RosterRow, SearchHit};
use centraid_vault::Vault;
use centraid_vault::time::zone::FireZone;

use super::{VaultDoor, settle, zone_of};
use crate::error::{CoreError, Result};

type Answer = wire::app_query_response::Answer;

/// The vault clock, read once per query: its instant and, in `zone`, its day.
struct Clock {
    now_ms: i64,
    today: String,
    civil: CivilDate,
    zone: FireZone,
}

impl Clock {
    /// An instant's civil day in the request's zone; empty when it does not
    /// parse.
    fn local_day(&self, instant: &str) -> String {
        local::today(&self.zone, instant).unwrap_or_default()
    }
}

fn clock(zone: &FireZone, now: &str) -> Result<Clock> {
    let invariant = |what: &str| CoreError::Invariant {
        context: format!("the vault clock's {what} did not read: {now}"),
    };
    let now_ms = people::dates::parse_instant(now).ok_or_else(|| invariant("instant"))?;
    let today = local::today(zone, now).ok_or_else(|| invariant("day"))?;
    let civil = CivilDate::parse(&today).ok_or_else(|| invariant("day"))?;
    Ok(Clock {
        now_ms,
        today,
        civil,
        zone: zone.clone(),
    })
}

pub(super) fn roster(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::PeopleRosterRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let clock = clock(&zone, now)?;
    let input = PeopleInput {
        limit: usize::try_from(asked.limit).ok().filter(|limit| *limit > 0),
    };
    let filter = match asked.filter() {
        wire::PeopleRosterFilter::Starred => RosterFilter::Starred,
        wire::PeopleRosterFilter::Due => RosterFilter::Due,
        wire::PeopleRosterFilter::All | wire::PeopleRosterFilter::Unspecified => RosterFilter::All,
    };
    let sort = match asked.sort() {
        wire::PeopleRosterSort::Name => RosterSort::Name,
        wire::PeopleRosterSort::Recent | wire::PeopleRosterSort::Unspecified => RosterSort::Recent,
    };
    settle(door, people::roster::load_people(door, input), |data| {
        let (kept, counts) = phone::arrange(data.people, filter, sort, clock.now_ms);
        Answer::PeopleRoster(wire::PeopleRoster {
            people: kept
                .into_iter()
                .map(|row| row_to_wire(row, &clock))
                .collect(),
            lists: data
                .lists
                .into_iter()
                .map(|list| wire::PeopleList {
                    list_id: list.list_id,
                    name: list.name,
                })
                .collect(),
            truncated: data.truncated,
            window: count(data.window),
            today: clock.today.clone(),
            count_all: count(counts.all),
            count_starred: count(counts.starred),
            count_due: count(counts.due),
        })
    })
}

pub(super) fn touch(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::PeopleTouchRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let clock = clock(&zone, now)?;
    settle(
        door,
        people::dashboard::load_dashboard(door, clock.civil, clock.now_ms),
        |data| {
            let card = |card: people::queries::PersonCard| wire::PeopleCard {
                days_over: data.days_over.get(&card.party_id).copied(),
                party_id: card.party_id,
                name: card.name,
                role: card.role,
                avatar_color: card.avatar_color,
            };
            Answer::PeopleTouch(wire::PeopleTouch {
                reconnect: data.reconnect.iter().cloned().map(card).collect(),
                upcoming: data
                    .upcoming
                    .iter()
                    .cloned()
                    .map(|row| wire::PeopleUpcoming {
                        date: Some(date_to_wire(
                            row.date_id,
                            row.label,
                            row.month_day,
                            true,
                            &clock,
                        )),
                        // Days over is a Reconnect fact, not an Upcoming one.
                        person: Some(wire::PeopleCard {
                            days_over: None,
                            ..card(row.card)
                        }),
                    })
                    .collect(),
                recent: data
                    .recent
                    .iter()
                    .cloned()
                    .map(|row| wire::PeopleTouchEntry {
                        interaction_id: row.interaction_id,
                        party_id: row.card.party_id,
                        kind: row.kind,
                        text: row.text,
                        occurred_local_day: clock.local_day(&row.occurred_at),
                        occurred_at: row.occurred_at,
                        name: row.card.name,
                        avatar_color: row.card.avatar_color,
                    })
                    .collect(),
                count_all: count(data.counts.all),
                count_reconnect: count(data.counts.reconnect),
                count_upcoming: count(data.counts.upcoming),
                count_starred: count(data.counts.starred),
                truncated: data.truncated,
                window: count(data.window),
                today: clock.today.clone(),
            })
        },
    )
}

pub(super) fn person(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::PeoplePersonRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let clock = clock(&zone, now)?;
    settle(
        door,
        people::person::load_person(door, asked.party_id.trim()),
        |data| {
            Answer::PeoplePerson(wire::PeoplePerson {
                sheet: data.person.map(|person| sheet_to_wire(person, &clock)),
                today: clock.today.clone(),
            })
        },
    )
}

pub(super) fn trash(door: &VaultDoor<'_>) -> Result<Answer> {
    settle(door, people::roster::load_trash(door), |data| {
        Answer::PeopleTrash(wire::PeopleTrash {
            people: data
                .people
                .into_iter()
                .map(|row| wire::PeopleTrashRow {
                    party_id: row.party_id,
                    name: row.name,
                    role: row.role,
                    purge_at: row.purge_at,
                })
                .collect(),
            truncated: data.truncated,
        })
    })
}

/// `people.search`: the `core.party` name index, ranked, folded to the live
/// People profiles among the hits.
///
/// v0 also asked a `people.profile` index (role) and a
/// `knowledge.annotation` index (notes); `crates/search` registers neither
/// domain, so the name index is the whole search here and
/// [`people::roster::rank_hits`] ranks one list.
pub(super) fn search(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::PeopleSearchRequest,
) -> Result<Answer> {
    if asked.limit == 0 {
        return Err(CoreError::InvalidRequest {
            detail: "a people search carries no limit; a default is how an unbounded read \
                     gets written by accident"
                .to_owned(),
        });
    }
    let term = asked.term.trim();
    if term.is_empty() {
        return Ok(Answer::PeopleSearch(wire::PeopleSearch::default()));
    }
    let now_ms = people::dates::parse_instant(now).ok_or_else(|| CoreError::Invariant {
        context: format!("the vault clock's instant did not read: {now}"),
    })?;
    let limit = usize::try_from(asked.limit)
        .unwrap_or(usize::MAX)
        .min(people::queries::SEARCH_LIMIT);
    let hits = vault.read(|connection| {
        let index = match centraid_search::SqliteDoor::open(connection) {
            Ok(index) => index,
            Err(error) => {
                return Ok(Err(CoreError::Invariant {
                    context: format!("the search index will not open: {error}"),
                }));
            }
        };
        let request =
            centraid_search::SearchRequest::new(people::queries::PARTY_TARGET_TYPE, term, limit);
        Ok(Ok(centraid_search::Search::query(
            &index,
            &centraid_search::Principal::Owner,
            &request,
        )))
    })??;
    let hits = match hits {
        Ok(centraid_search::Answer::Data { page, .. }) => page
            .rows
            .into_iter()
            .map(|target| SearchHit {
                party_id: target.id,
                snippet: Some(target.snippet),
            })
            .collect::<Vec<_>>(),
        Ok(centraid_search::Answer::Denied(denial)) => {
            return Ok(Answer::Denied(wire::AppQueryDenial {
                code: denial.code,
                message: denial.message,
                revoked_at: denial.revoked_at,
            }));
        }
        Err(centraid_search::SearchError::NoSearchableWords { .. }) => Vec::new(),
        Err(error) => {
            return Err(CoreError::Invariant {
                context: format!("the search index refused: {error}"),
            });
        }
    };
    let ranked = people::roster::rank_hits(&hits, &[], &[]);
    settle(door, people::roster::load_search(door, &ranked), |data| {
        Answer::PeopleSearch(wire::PeopleSearch {
            people: data
                .people
                .into_iter()
                .map(|row| {
                    let cadence = phone::cadence(
                        row.cadence_days,
                        row.last_contacted_at.as_deref(),
                        &row.created_at,
                        now_ms,
                    );
                    row_to_wire_with(row, cadence, &[])
                })
                .collect(),
        })
    })
}

// ---------------------------------------------------------------------------
// The conversion.
// ---------------------------------------------------------------------------

/// A count on the wire. A window is at most 10,000, so the saturation is
/// never reached; it is here so an impossible count is not a panic.
fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn date_to_wire(
    date_id: String,
    label: String,
    month_day: String,
    reminder_on: bool,
    clock: &Clock,
) -> wire::PeopleDate {
    wire::PeopleDate {
        in_days: phone::in_days(clock.civil, &month_day),
        date_id,
        label,
        month_day,
        reminder_on,
    }
}

fn row_to_wire(row: RosterRow, clock: &Clock) -> wire::PeopleRosterRow {
    let cadence = phone::cadence(
        row.cadence_days,
        row.last_contacted_at.as_deref(),
        &row.created_at,
        clock.now_ms,
    );
    let reminders: Vec<wire::PeopleDate> = row
        .reminders
        .iter()
        .cloned()
        .map(|reminder| {
            date_to_wire(
                reminder.date_id,
                reminder.label,
                reminder.month_day,
                true,
                clock,
            )
        })
        .collect();
    row_to_wire_with(row, cadence, &reminders)
}

fn row_to_wire_with(
    row: RosterRow,
    cadence: phone::Cadence,
    reminders: &[wire::PeopleDate],
) -> wire::PeopleRosterRow {
    wire::PeopleRosterRow {
        party_id: row.party_id,
        name: row.name,
        role: row.role,
        avatar_color: row.avatar_color,
        cadence_days: row.cadence_days,
        last_contacted_at: row.last_contacted_at,
        created_at: row.created_at,
        list_id: row.list_id,
        starred: row.starred,
        due: cadence.due,
        days_since_contact: cadence.days_since_contact,
        reminders: reminders.to_vec(),
        snippet: row.snippet,
    }
}

fn sheet_to_wire(person: people::person::Person, clock: &Clock) -> wire::PeopleSheet {
    let profile = person.profile;
    let dates: Vec<wire::PeopleDate> = profile
        .dates
        .into_iter()
        .map(|date| {
            date_to_wire(
                date.date_id,
                date.label,
                date.month_day,
                date.reminder_on,
                clock,
            )
        })
        .collect();
    let reminders: Vec<wire::PeopleDate> = dates
        .iter()
        .filter(|date| date.reminder_on)
        .cloned()
        .collect();
    let cadence = phone::cadence(
        profile.cadence_days,
        profile.last_contacted_at.as_deref(),
        &profile.created_at,
        clock.now_ms,
    );
    let party_id = profile.party_id.clone();
    let (touches_known, touches) = match person.links {
        people::ReadState::Ready(links) => (
            true,
            links
                .interactions
                .into_iter()
                .map(|touch| wire::PeopleTouchEntry {
                    interaction_id: touch.interaction_id,
                    party_id: party_id.clone(),
                    kind: touch.kind,
                    text: touch.text,
                    occurred_local_day: clock.local_day(&touch.occurred_at),
                    occurred_at: touch.occurred_at,
                    name: String::new(),
                    avatar_color: None,
                })
                .collect(),
        ),
        people::ReadState::Loading | people::ReadState::Denied(_) => (false, Vec::new()),
    };
    wire::PeopleSheet {
        person: Some(row_to_wire_with(
            RosterRow {
                party_id: profile.party_id,
                name: profile.name,
                role: profile.role,
                avatar_color: profile.avatar_color,
                cadence_days: profile.cadence_days,
                last_contacted_at: profile.last_contacted_at,
                created_at: profile.created_at,
                list_id: profile.list_id,
                starred: profile.starred,
                reminders: Vec::new(),
                snippet: None,
            },
            cadence,
            &reminders,
        )),
        nickname: profile.nickname,
        met: profile.met,
        channels: profile
            .contact
            .into_iter()
            .map(|channel| wire::PeopleChannel {
                channel_id: channel.channel_id,
                kind: channel.kind,
                label: channel.label,
                value: channel.value,
                preferred: channel.preferred,
                duplicate_names: channel.duplicate_names,
            })
            .collect(),
        dates,
        notes: profile
            .notes
            .into_iter()
            .map(|note| wire::PeopleNote {
                annotation_id: note.annotation_id,
                text: note.text,
                created_local_day: clock.local_day(&note.created_at),
                created_at: note.created_at,
            })
            .collect(),
        touches_known,
        touches,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::CoreConfig;
    use crate::handle::{Core, Handle};
    use wire::app_query_request::Query as Q;

    /// Where every test's people are added: the vault clock at founding.
    const ADDED: &str = "2099-10-01T12:00:00.000Z";
    const TZ: &str = "America/New_York";

    /// A founded vault whose clock can be moved by reopening the file.
    struct Scratch {
        dir: std::path::PathBuf,
        handle: Option<Handle>,
        writes: std::cell::Cell<u32>,
    }

    fn open_at(path: &std::path::Path, now: &str) -> Handle {
        let now = centraid_vault::time::recurrence::parse_instant_ms(now).expect("an instant");
        Core::open(CoreConfig::new(path.to_path_buf()).with_clock(
            std::sync::Arc::new(centraid_vault::clock::FixedClock::at(now)),
            std::sync::Arc::new(centraid_vault::clock::ClockIds::new(Box::new(
                centraid_vault::clock::FixedClock::at(now),
            ))),
        ))
        .expect("it opens")
    }

    impl Scratch {
        fn founded() -> Self {
            let dir = centraid_ontology::golden::scratch_dir();
            std::fs::create_dir_all(&dir).expect("the directory is made");
            let handle = open_at(&dir.join("vault.db"), ADDED);
            handle
                .with_vault(|vault| Ok(vault.found("People", "Owner")?))
                .expect("it founds");
            Self {
                dir,
                handle: Some(handle),
                writes: std::cell::Cell::new(0),
            }
        }

        /// Close the vault and open it again with the clock at `now`.
        fn at(&mut self, now: &str) {
            drop(self.handle.take());
            self.handle = Some(open_at(&self.dir.join("vault.db"), now));
        }

        fn handle(&self) -> &Handle {
            self.handle.as_ref().expect("the vault is open")
        }

        fn ask(&self, query: Q) -> Result<Answer> {
            match self
                .handle()
                .call(&wire::Request {
                    kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                        query: Some(query),
                    })),
                })?
                .kind
            {
                Some(wire::response::Kind::AppQuery(answer)) => {
                    Ok(answer.answer.expect("an app query is answered"))
                }
                other => panic!("an app query answered as {other:?}"),
            }
        }

        fn run(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
            self.writes.set(self.writes.get() + 1);
            let response = self
                .handle()
                .call(&wire::Request {
                    kind: Some(wire::request::Kind::Command(wire::Command {
                        name: name.to_owned(),
                        input: serde_json::to_vec(&input).expect("json"),
                        invoke_key: format!("people-query-test-{}", self.writes.get()),
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

        fn add(&self, name: &str, cadence_days: i64) -> String {
            self.run(
                "people.add_person",
                serde_json::json!({ "display_name": name, "cadence_days": cadence_days }),
            )["party_id"]
                .as_str()
                .expect("a party id")
                .to_owned()
        }

        fn roster(&self, filter: wire::PeopleRosterFilter) -> wire::PeopleRoster {
            match self
                .ask(Q::PeopleRoster(wire::PeopleRosterRequest {
                    limit: 0,
                    filter: filter as i32,
                    sort: wire::PeopleRosterSort::Name as i32,
                    tz: TZ.to_owned(),
                }))
                .expect("the roster answers")
            {
                Answer::PeopleRoster(roster) => roster,
                other => panic!("the roster answered as {other:?}"),
            }
        }

        fn touch(&self, tz: &str) -> wire::PeopleTouch {
            match self
                .ask(Q::PeopleTouch(wire::PeopleTouchRequest {
                    tz: tz.to_owned(),
                }))
                .expect("touch answers")
            {
                Answer::PeopleTouch(touch) => touch,
                other => panic!("touch answered as {other:?}"),
            }
        }

        fn person(&self, party_id: &str) -> wire::PeoplePerson {
            match self
                .ask(Q::PeoplePerson(wire::PeoplePersonRequest {
                    party_id: party_id.to_owned(),
                    tz: TZ.to_owned(),
                }))
                .expect("the sheet answers")
            {
                Answer::PeoplePerson(person) => person,
                other => panic!("the sheet answered as {other:?}"),
            }
        }

        fn trash(&self) -> wire::PeopleTrash {
            match self
                .ask(Q::PeopleTrash(wire::PeopleTrashRequest {}))
                .expect("the shelf answers")
            {
                Answer::PeopleTrash(trash) => trash,
                other => panic!("the shelf answered as {other:?}"),
            }
        }

        fn search(&self, term: &str) -> wire::PeopleSearch {
            match self
                .ask(Q::PeopleSearch(wire::PeopleSearchRequest {
                    term: term.to_owned(),
                    limit: 10,
                }))
                .expect("search answers")
            {
                Answer::PeopleSearch(found) => found,
                other => panic!("search answered as {other:?}"),
            }
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            drop(self.handle.take());
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// AN EMPTY VAULT IS AN EMPTY ANSWER, NOT A REFUSAL — and the owner and a
    /// profile-less party (what Photos' face review makes with
    /// `core.add_party`) are not People rows.
    #[test]
    fn an_empty_vault_answers_empty_everywhere() {
        let scratch = Scratch::founded();
        let face = scratch.run(
            "core.add_party",
            serde_json::json!({ "display_name": "Ada from the photos", "kind": "person" }),
        )["party_id"]
            .as_str()
            .expect("a party id")
            .to_owned();

        let roster = scratch.roster(wire::PeopleRosterFilter::All);
        assert!(roster.people.is_empty(), "{:?}", roster.people);
        assert_eq!(
            (roster.count_all, roster.count_starred, roster.count_due),
            (0, 0, 0)
        );
        assert!(!roster.truncated);
        assert_eq!(roster.window, 10_000);
        assert_eq!(roster.today, "2099-10-01");

        let touch = scratch.touch(TZ);
        assert!(touch.reconnect.is_empty() && touch.upcoming.is_empty() && touch.recent.is_empty());
        assert_eq!(touch.count_all, 0);

        assert!(scratch.trash().people.is_empty());
        assert!(
            scratch.person(&face).sheet.is_none(),
            "no profile, no sheet"
        );
        assert!(scratch.person("no-such-party").sheet.is_none());
        assert!(scratch.search("Ada").people.is_empty());
    }

    /// TRASH IS EXCLUDED from the roster, the dashboard, the sheet and search,
    /// and is what the shelf answers.
    #[test]
    fn a_trashed_person_is_on_the_shelf_and_nowhere_else() {
        let scratch = Scratch::founded();
        let kept = scratch.add("Maya Lin", 30);
        let gone = scratch.add("Maya Gone", 30);
        scratch.run(
            "people.trash_person",
            serde_json::json!({ "party_id": gone }),
        );

        let roster = scratch.roster(wire::PeopleRosterFilter::All);
        assert_eq!(
            roster
                .people
                .iter()
                .map(|row| row.party_id.as_str())
                .collect::<Vec<_>>(),
            [kept.as_str()]
        );
        assert_eq!(roster.count_all, 1);
        assert_eq!(scratch.touch(TZ).count_all, 1);
        assert!(scratch.person(&gone).sheet.is_none());
        assert_eq!(
            scratch
                .search("Maya")
                .people
                .iter()
                .map(|row| row.party_id.as_str())
                .collect::<Vec<_>>(),
            [kept.as_str()]
        );
        let shelf = scratch.trash();
        assert_eq!(shelf.people.len(), 1);
        assert_eq!(shelf.people[0].party_id, gone);
        assert_eq!(shelf.people[0].name, "Maya Gone");
        assert!(shelf.people[0].purge_at.is_some());
    }

    /// RECONNECT IS MOST OVERDUE FIRST: sixty days after everyone was added, a
    /// weekly cadence is 53 days over and a monthly one 30; a cadence of 0 is
    /// never due and a 90-day one is not due yet. The roster's Due chip is the
    /// same fact.
    #[test]
    fn reconnect_is_ordered_most_overdue_first() {
        let mut scratch = Scratch::founded();
        let monthly = scratch.add("Monthly", 30);
        let weekly = scratch.add("Weekly", 7);
        scratch.add("Never", 0);
        scratch.add("Quarterly", 90);
        let starred = scratch.add("Starred", 0);
        scratch.run(
            "people.star_person",
            serde_json::json!({ "party_id": starred }),
        );
        scratch.at("2099-11-30T12:00:00.000Z");

        let touch = scratch.touch(TZ);
        let order: Vec<(&str, Option<i64>)> = touch
            .reconnect
            .iter()
            .map(|card| (card.party_id.as_str(), card.days_over))
            .collect();
        assert_eq!(
            order,
            [(weekly.as_str(), Some(53)), (monthly.as_str(), Some(30))]
        );
        assert_eq!(touch.count_reconnect, 2);
        assert_eq!(touch.count_all, 5);
        assert_eq!(touch.count_starred, 1);

        let due = scratch.roster(wire::PeopleRosterFilter::Due);
        assert_eq!(
            due.people
                .iter()
                .map(|row| row.name.as_str())
                .collect::<Vec<_>>(),
            ["Monthly", "Weekly"],
            "the chip, sorted by name"
        );
        assert!(due.people.iter().all(|row| row.due));
        assert_eq!(due.people[1].days_since_contact, 60);
        assert_eq!((due.count_all, due.count_due, due.count_starred), (5, 2, 1));
        let stars = scratch.roster(wire::PeopleRosterFilter::Starred);
        assert_eq!(stars.people.len(), 1);
        assert!(stars.people[0].starred);

        // A touch resets the clock and lands on the sheet's log and Recent.
        scratch.run(
            "people.log_interaction",
            serde_json::json!({ "party_id": weekly, "kind": "call", "text": "Caught up" }),
        );
        let touch = scratch.touch(TZ);
        assert_eq!(touch.reconnect.len(), 1);
        assert_eq!(touch.recent.len(), 1);
        assert_eq!(touch.recent[0].party_id, weekly);
        assert_eq!(touch.recent[0].name, "Weekly");
        let sheet = scratch.person(&weekly).sheet.expect("a live person");
        assert!(sheet.touches_known);
        assert_eq!(sheet.touches.len(), 1);
        assert_eq!(sheet.touches[0].text, "Caught up");
        assert!(!sheet.person.expect("a header").due);
    }

    /// A TOUCH AND A NOTE CARRY THEIR CIVIL DAY IN THE REQUEST'S ZONE:
    /// 02:00Z on 2 October is still 1 October in New York, on the dashboard's
    /// Recent rail and on the sheet.
    #[test]
    fn touches_and_notes_carry_their_local_day_in_the_request_zone() {
        let mut scratch = Scratch::founded();
        let ada = scratch.add("Ada", 7);
        scratch.at("2099-10-02T02:00:00.000Z");
        scratch.run(
            "people.log_interaction",
            serde_json::json!({ "party_id": ada, "kind": "Call", "text": "Late call" }),
        );
        scratch.run(
            "people.add_note",
            serde_json::json!({ "party_id": ada, "text": "Night owl" }),
        );
        let touch = scratch.touch(TZ);
        assert_eq!(touch.recent[0].occurred_local_day, "2099-10-01");
        assert_eq!(
            scratch.touch("Pacific/Auckland").recent[0].occurred_local_day,
            "2099-10-02"
        );
        let sheet = scratch.person(&ada).sheet.expect("a live person");
        assert_eq!(sheet.touches[0].occurred_local_day, "2099-10-01");
        assert_eq!(sheet.notes[0].created_local_day, "2099-10-01");
    }

    /// DATES ACROSS THE YEAR BOUNDARY, IN THE DEVICE'S ZONE. On New Year's Eve
    /// in New York a 2 January birthday is 2 days away and a 31 December one
    /// is today; the same instant is already 1 January in Auckland, where the
    /// first is a day away and the second is 364 days off.
    #[test]
    fn dates_count_across_the_year_boundary_in_the_request_zone() {
        let mut scratch = Scratch::founded();
        let ada = scratch.add("Ada", 0);
        for (label, month_day) in [("Birthday", "01-02"), ("Anniversary", "12-31")] {
            scratch.run(
                "people.add_important_date",
                serde_json::json!({
                    "party_id": ada, "label": label, "month_day": month_day, "reminder_on": true
                }),
            );
        }
        scratch.at("2099-12-31T20:00:00.000Z");

        let touch = scratch.touch(TZ);
        assert_eq!(touch.today, "2099-12-31");
        let rail: Vec<(&str, Option<i64>)> = touch
            .upcoming
            .iter()
            .map(|row| {
                let date = row.date.as_ref().expect("a date");
                (date.month_day.as_str(), date.in_days)
            })
            .collect();
        assert_eq!(rail, [("12-31", Some(0)), ("01-02", Some(2))]);

        let auckland = scratch.touch("Pacific/Auckland");
        assert_eq!(auckland.today, "2100-01-01");
        let rail: Vec<(&str, Option<i64>)> = auckland
            .upcoming
            .iter()
            .map(|row| {
                let date = row.date.as_ref().expect("a date");
                (date.month_day.as_str(), date.in_days)
            })
            .collect();
        assert_eq!(rail, [("01-02", Some(1)), ("12-31", Some(364))]);

        let sheet = scratch.person(&ada).sheet.expect("a live person");
        assert_eq!(sheet.dates.len(), 2);
        let roster = scratch.roster(wire::PeopleRosterFilter::All);
        assert_eq!(roster.people[0].reminders.len(), 2);
        assert!(
            roster.people[0]
                .reminders
                .iter()
                .any(|date| date.month_day == "01-02" && date.in_days == Some(2))
        );
    }

    /// A DENIAL IS A STATE: a People loader's refusal reaches the wire as the
    /// `denied` arm, not as an error and not as an empty roster.
    #[test]
    fn a_people_denial_is_the_denied_arm() {
        let scratch = Scratch::founded();
        scratch
            .handle()
            .with_vault(|vault| {
                let door = VaultDoor::new(vault);
                let loaded: centraid_apps_kit::KitResult<((), Option<people::Denial>)> = Ok((
                    (),
                    Some(people::Denial {
                        code: Some("consent_revoked".to_owned()),
                        message: Some("People may not read".to_owned()),
                        revoked_at: None,
                    }),
                ));
                let answer = settle(&door, loaded, |()| unreachable!("no data"))
                    .expect("a denial is not an error");
                let Answer::Denied(denial) = answer else {
                    panic!("answered as {answer:?}");
                };
                assert_eq!(denial.code.as_deref(), Some("consent_revoked"));
                Ok(())
            })
            .expect("the vault is open");
    }

    /// A zero search limit and an unknown zone are the request's fault.
    #[test]
    fn a_zero_limit_and_an_unknown_zone_are_invalid_requests() {
        let scratch = Scratch::founded();
        let refused = scratch
            .ask(Q::PeopleSearch(wire::PeopleSearchRequest {
                term: "Ada".to_owned(),
                limit: 0,
            }))
            .expect_err("a zero limit is refused");
        assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);
        let refused = scratch
            .ask(Q::PeopleTouch(wire::PeopleTouchRequest {
                tz: "America/New_Yrok".to_owned(),
            }))
            .expect_err("an unknown zone is refused");
        assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);
    }
}
