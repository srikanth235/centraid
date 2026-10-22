//! AN APP'S OWN QUERY, RUN IN THE CORE (#1046).
//!
//! `app_query.proto` states the shapes and why a query that joins and expands
//! cannot be a page read a shell writes. This module is the core's half: the
//! door an app crate reads through, the dispatch from a typed request to the
//! app's loader, and the one conversion from the loader's Rust rows to the
//! answer's messages.
//!
//! # THE DOOR IS THE PAGE DOOR
//!
//! An app crate reads through [`PageDoor`] and holds no SQL (`sql-confinement`
//! refuses a statement anywhere but `crates/{ontology,vault,search}` and
//! `crates/apps/kit`). [`VaultDoor`] is that trait over the open vault, and it
//! runs each page through [`Vault::keyset_page`] — the call [`crate::api::page`]
//! makes for `Request::Page` — so an app query reads exactly what a shell's own
//! page read could, under the same clamp, the same keyset and the same
//! `query_only` connection. It adds ONE check the page door does not make: the
//! kit's grammar ([`centraid_apps_kit::grammar::parse`]), because that is what
//! the app's parity tests read through ([`centraid_apps_kit::testdoor`]), and a
//! statement the tests would refuse must not run here.
//!
//! # A DENIAL IS A STATE, A FAILURE IS AN ERROR, AND THE DOOR KNOWS WHICH
//!
//! The kit has one door failure, [`KitError::Door`], and every loader turns it
//! into its payload's denial — which is right for a consent refusal and wrong
//! for a file that would not read: a screen would draw "you may not ask" over a
//! broken statement. So the door keeps what the vault actually said, and after
//! the loader returns, a failure the door saw is answered as THAT error, never
//! as the denial the loader made of it. What is left as a denial is one the
//! loader produced without the door failing, which on this phone is none: the
//! page door evaluates no grant, because the phone IS the owner (#1029 §1).
//!
//! # CIVIL TIME IN THE ZONE THE DEVICE STATES
//!
//! A shell's shared layer has no calendar (`agenda.proto`'s header), so every
//! local reading — an occurrence's wall clock and days, today, now — is
//! computed here, in the request's `tz`, by `crates/apps/agenda`'s `local`
//! module. [`zone_of`] is the rule: the stated IANA name, else the vault's own
//! ([`Vault::time_zone`]), else a refusal. It is never the host's clock and
//! never UTC by default — the same two tiers, and no third, that
//! [`FireZone::resolve`] states for cron and recurrence.
//!
//! # A CEILING IS A TYPED REFUSAL
//!
//! A loader that walks its joins or expands its series to a stated bound stops
//! with [`KitError::FanOutExceeded`], and that is [`CoreError::ReadBoundReached`]
//! here — `ERROR_CODE_READ_BOUND_REACHED` on the wire — never a panic and never
//! a short answer (D-1020-D3-12). Every other kit error from a compiled-in
//! statement is the app crate breaking its own contract, and is an invariant.

use std::cell::RefCell;

use centraid_api_proto::core_v1 as wire;
use centraid_apps_agenda::local;
use centraid_apps_agenda::queries as agenda;
use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::page::{Page, PageCursor, PageRequest};
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::{Cell, Row};
use centraid_apps_kit::statement::{PageBindValue, PageQuery};
use centraid_vault::Vault;
use centraid_vault::page::KeysetPage;
use centraid_vault::time::zone::{FireZone, ZoneUnset};
use centraid_vault::value::Value;

use crate::error::{CoreError, Result};

// The chat's arm (R-CHAT-1): the thread list, a thread, and a card's row.
mod chat;
// The named as search results (#1097, R-1097-19..24): notebooks, albums,
// projects, Docs folders and chat threads, for Home and the
// owning apps.
mod named;
// People's arm (#1046): its conversions and tests, beside this one.
// Docs' arm (#1046): its conversions and tests, beside this one.
mod docs;
// Health's arm (#1129): six answers, every figure the app crate's (R-1129-12).
mod health;
// Locker's arm (#1047): metadata only; a secret is the session's.
mod locker;
// Money's arm (#1099): ten answers, the import plan and Home's tile.
pub(crate) mod money;
mod notes;
mod people;
// Photos' own search (#1097, R-1097-25..27): the text and album legs, the live rule
// and the correction.
mod photos;
// Tasks' arm (#1046): its conversions and tests, beside this one.
mod tasks;
// Home's arm (R-CHROME-6): every app's search domain but Locker's.
mod vault;

/// Answer one app query against the open vault.
///
/// `now` is the vault's own clock, never the host's: a loader reads it only to
/// default an empty range to "today".
pub fn answer(vault: &Vault, request: &wire::AppQueryRequest) -> Result<wire::AppQueryResponse> {
    use wire::app_query_request::Query as Q;
    use wire::app_query_response::Answer as A;
    let Some(query) = &request.query else {
        return Err(CoreError::InvalidRequest {
            detail: "an app query names no query".to_owned(),
        });
    };
    let now = vault.clock().now_text();
    let door = VaultDoor::new(vault);
    let answer = match query {
        Q::AgendaUpcoming(asked) => {
            let zone = zone_of(vault, &asked.tz)?;
            settle(
                &door,
                agenda::load_upcoming(
                    &door,
                    non_empty(&asked.from),
                    non_empty(&asked.to),
                    &now,
                    &zone,
                ),
                |data| A::AgendaUpcoming(upcoming_to_wire(data, &zone, &now)),
            )?
        }
        Q::AgendaDayContext(asked) => {
            let zone = zone_of(vault, &asked.tz)?;
            settle(
                &door,
                agenda::load_day_context(
                    &door,
                    non_empty(&asked.from),
                    non_empty(&asked.to),
                    &now,
                    &zone,
                ),
                |data| A::AgendaDayContext(day_context_to_wire(data, &zone, &now)),
            )?
        }
        Q::AgendaParties(_) => settle(&door, agenda::load_parties(&door), |data| {
            A::AgendaParties(parties_to_wire(data))
        })?,
        Q::AgendaEvent(asked) => {
            let zone = zone_of(vault, &asked.tz)?;
            settle(
                &door,
                centraid_apps_agenda::load_event(
                    &door,
                    &asked.event_id,
                    non_empty(&asked.instance_key),
                    non_empty(&asked.original_start_local),
                ),
                |data| {
                    A::AgendaEvent(Box::new(wire::AgendaEventDetail {
                        today: local::today(&zone, &now).unwrap_or_default(),
                        now_local: local::now_local(&zone, &now).unwrap_or_default(),
                        event: data.event.map(|event| event_to_wire(event, &zone)),
                        calendar: data.calendar.map(calendar_to_wire),
                    }))
                },
            )?
        }
        Q::AgendaSearch(asked) => {
            if asked.limit == 0 {
                // REQUIRED AND VALIDATED, not defaulted: proto3 cannot say
                // "required", so the refusal is the contract.
                return Err(CoreError::InvalidRequest {
                    detail: "an agenda search carries no limit; a default is how an unbounded \
                             read gets written by accident"
                        .to_owned(),
                });
            }
            let zone = zone_of(vault, &asked.tz)?;
            // WHERE A REPEATING HIT OPENS (#1047): the occurrence it means,
            // asked of the same door after the hits are folded.
            let loaded = search_events(vault, &door, &asked.term, asked.limit)?.and_then(
                |((data, corrected), denial)| {
                    let next = if denial.is_none() {
                        data.events
                            .iter()
                            .map(|event| centraid_apps_agenda::next_occurrence(&door, event, &now))
                            .collect::<KitResult<Vec<_>>>()?
                    } else {
                        Vec::new()
                    };
                    Ok(((data, next, corrected), denial))
                },
            );
            settle(&door, loaded, |(data, next, corrected)| {
                A::AgendaSearch(search_to_wire(data, next, corrected, &zone))
            })?
        }
        Q::DocsDrive(asked) => docs::drive(vault, &door, &now, asked)?,
        Q::DocsSearch(asked) => docs::search(vault, &door, &now, asked)?,
        Q::DocsDocument(asked) => docs::document(vault, &door, &now, asked)?,
        Q::DocsActivity(asked) => docs::activity(vault, &door, asked)?,
        Q::PeopleRoster(asked) => people::roster(vault, &door, &now, asked)?,
        Q::PeopleTouch(asked) => people::touch(vault, &door, &now, asked)?,
        Q::PeoplePerson(asked) => people::person(vault, &door, &now, asked)?,
        Q::PeopleSearch(asked) => people::search(vault, &door, &now, asked)?,
        Q::PeopleTrash(asked) => people::trash(vault, &door, asked)?,
        Q::NotesLibrary(asked) => notes::library(vault, &door, asked)?,
        Q::NotesNotebooks(_) => notes::notebooks(&door)?,
        Q::NotesJournal(asked) => notes::journal(vault, &door, &now, asked)?,
        Q::NotesSearch(asked) => notes::search(vault, &door, asked)?,
        Q::NotesTrash(asked) => notes::trash(vault, &door, asked)?,
        Q::NotesHistory(asked) => notes::history(vault, &door, asked)?,
        Q::NotesLinkTargets(asked) => notes::link_targets(vault, &door, asked)?,
        Q::NotesNote(asked) => notes::note(vault, &door, asked)?,
        Q::TasksBoard(asked) => tasks::board(vault, &door, &now, asked)?,
        Q::TasksTask(asked) => tasks::task(vault, &door, &now, asked)?,
        Q::TasksProjects(asked) => tasks::projects(vault, &door, &now, asked)?,
        Q::TasksSearch(asked) => tasks::search(vault, &door, &now, asked)?,
        Q::TasksCatchUp(asked) => tasks::catch_up(vault, &door, &now, asked)?,
        Q::TasksTrash(asked) => tasks::trash(vault, &door, asked)?,
        Q::LockerItems(asked) => locker::items(vault, &door, &now, asked)?,
        Q::LockerItem(asked) => locker::item(vault, &door, &now, asked)?,
        Q::LockerSearch(asked) => locker::search(vault, &door, asked)?,
        Q::LockerReview(asked) => locker::review(vault, &door, &now, asked)?,
        Q::LockerAccess(asked) => locker::access(vault, &door, asked)?,
        Q::ChatThreads(asked) => chat::threads(vault, &door, asked)?,
        Q::ChatThread(asked) => chat::thread(vault, asked)?,
        Q::ChatCard(asked) => chat::card(vault, asked)?,
        Q::VaultSearch(asked) => vault::search(vault, &door, asked)?,
        Q::PhotosSearch(asked) => photos::search(vault, &door, asked)?,
        Q::PhotosDuplicates(_) => photos::duplicates(&door)?,
        Q::MoneySpending(asked) => money::spending(vault, &door, &now, asked)?,
        Q::MoneyActivity(asked) => money::activity(vault, &door, &now, asked)?,
        Q::MoneyTransaction(asked) => money::transaction(vault, &door, &now, asked)?,
        Q::MoneyCashflow(asked) => money::cashflow(vault, &door, &now, asked)?,
        Q::MoneyAccounts(asked) => money::accounts(vault, &door, &now, asked)?,
        Q::MoneyRules(_) => money::rules(&door)?,
        Q::MoneyCategories(_) => money::categories(&door)?,
        Q::MoneyTargetSheet(asked) => money::target_sheet(vault, &door, &now, asked)?,
        Q::MoneyRecurring(asked) => money::recurring(vault, &door, &now, asked)?,
        Q::MoneySearch(asked) => money::search(vault, &door, &now, asked)?,
        // Health (#1129): no zone and no clock; the request states its day.
        Q::HealthToday(asked) => health::today(vault, &door, &now, asked)?,
        Q::HealthSeries(asked) => health::series(vault, &door, &now, asked)?,
        Q::HealthTrends(asked) => health::trends(vault, &door, &now, asked)?,
        Q::HealthWorkouts(asked) => health::workouts(vault, &door, asked)?,
        Q::HealthWorkout(asked) => health::workout(vault, &door, asked)?,
        Q::HealthFollowView(asked) => health::follow_view(vault, &door, &now, asked)?,
    };
    Ok(wire::AppQueryResponse {
        answer: Some(answer),
    })
}

/// An empty string on the wire is the loader's `None`: proto3 has no absent
/// string, and every loader already reads `""` as "not stated".
fn non_empty(value: &str) -> Option<&str> {
    (!value.is_empty()).then_some(value)
}

/// THE ZONE A QUERY ANSWERS IN: the request's `tz`, else the vault's own, else
/// a refusal — the request's fault, `ERROR_CODE_INVALID_REQUEST`, because the
/// device knows its zone and did not say it. An unknown name is refused the
/// same way rather than demoted to the vault's: a device that named
/// `America/New_Yrok` meant something, and answering in another zone would be
/// answering a question nobody asked.
pub(crate) fn zone_of(vault: &Vault, stated: &str) -> Result<FireZone> {
    let stated = non_empty(stated.trim());
    let vault_zone = match stated {
        Some(_) => None,
        None => vault.time_zone()?,
    };
    FireZone::resolve(stated, vault_zone.as_deref()).map_err(|unset| CoreError::InvalidRequest {
        detail: match unset {
            ZoneUnset::Missing => "an agenda query states no `tz` and this vault's settings \
                                   name no zone; the device's own zone is the answer, and \
                                   00:00Z is somebody else's midnight"
                .to_owned(),
            ZoneUnset::Unknown { name } => {
                format!("`{name}` is not a time zone this build's bundled database knows")
            }
        },
    })
}

/// THE ZONE OF A DECORATION: [`zone_of`]'s rule, except that a request which
/// states none on a vault that names none gets `None` rather than a refusal.
/// For an answer whose civil readings are a decoration (an editor's "Edited",
/// a search hit's day, a file name) — failing the whole read over one would
/// take the thing away to report its label. The readings are then EMPTY,
/// never UTC; an unknown name is still refused, because a device that named
/// a zone meant one.
fn zone_if_any(vault: &Vault, stated: &str) -> Result<Option<FireZone>> {
    let stated = non_empty(stated.trim());
    if stated.is_none() && vault.time_zone()?.is_none() {
        return Ok(None);
    }
    zone_of(vault, stated.unwrap_or_default()).map(Some)
}

/// A loader's answer as the wire's: the data, the denial, or the error — with
/// what the DOOR saw taking precedence over what the loader made of it.
fn settle<T>(
    door: &VaultDoor<'_>,
    loaded: KitResult<(T, Option<centraid_apps_kit::Denial>)>,
    data: impl FnOnce(T) -> wire::app_query_response::Answer,
) -> Result<wire::app_query_response::Answer> {
    if let Some(failure) = door.failure.borrow_mut().take() {
        return Err(failure);
    }
    match loaded {
        Ok((_, Some(denial))) => Ok(wire::app_query_response::Answer::Denied(
            wire::AppQueryDenial {
                code: denial.code,
                message: denial.message,
                revoked_at: denial.revoked_at,
            },
        )),
        Ok((value, None)) => Ok(data(value)),
        Err(KitError::FanOutExceeded { query, cap }) => {
            Err(CoreError::ReadBoundReached { query, cap })
        }
        Err(other) => Err(CoreError::Invariant {
            context: format!("an app query broke its own read contract: {other}"),
        }),
    }
}

/// `agenda.search`: the FTS door's hits over the same read connection the page
/// door uses, folded by the app.
///
/// `crates/search` owns every `MATCH` in the workspace and asks for a
/// connection, so the search runs inside [`Vault::read`] — `query_only`, like
/// every page — and the page door's own reads nest inside it.
fn search_events(
    vault: &Vault,
    door: &VaultDoor<'_>,
    term: &str,
    limit: u32,
) -> Result<KitResult<Corrected<agenda::SearchData>>> {
    vault.read(|connection| {
        let index = match centraid_search::SqliteDoor::open(connection, vault.words()) {
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
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        Ok(Ok(corrected_search(
            &search,
            &[agenda::EVENT_KIND],
            term,
            |data: &agenda::SearchData| data.events.len(),
            |exact, again| agenda::SearchData {
                events: filled(exact.events, again.events, limit, |row| {
                    row.event_id.clone()
                }),
            },
            |term| {
                agenda::load_search_term(
                    door,
                    &search,
                    &centraid_search::Principal::Owner,
                    term,
                    limit,
                )
            },
        )))
    })?
}

/// The FTS door, with its failures kept the way [`VaultDoor`] keeps the page
/// door's: a term with no searchable word is an answer, and anything else the
/// index says is an error the core reports rather than a denial it draws.
struct RecordingSearch<'a, 'v> {
    inner: &'a dyn centraid_search::Search,
    door: &'a VaultDoor<'v>,
}

impl centraid_search::Search for RecordingSearch<'_, '_> {
    fn query(
        &self,
        principal: &centraid_search::Principal,
        request: &centraid_search::SearchRequest,
    ) -> std::result::Result<centraid_search::Answer, centraid_search::SearchError> {
        self.inner
            .query(principal, request)
            .inspect_err(|error| self.keep(error))
    }

    /// **FORWARDED, because the trait's default asks `query` once per kind.**
    fn query_each(
        &self,
        principal: &centraid_search::Principal,
        request: &centraid_search::EachRequest,
    ) -> std::result::Result<Vec<centraid_search::Target>, centraid_search::SearchError> {
        self.inner
            .query_each(principal, request)
            .inspect_err(|error| self.keep(error))
    }

    /// **FORWARDED, because the trait's default is `Ok(None)`.** A recorder that
    /// only wrapped `query` would silently correct nothing for every caller in
    /// this crate; the failure is kept the way `query`'s is.
    fn correct(
        &self,
        principal: &centraid_search::Principal,
        entities: &[&str],
        query: &str,
    ) -> std::result::Result<Option<String>, centraid_search::SearchError> {
        self.inner
            .correct(principal, entities, query)
            .inspect_err(|error| self.keep(error))
    }
}

impl RecordingSearch<'_, '_> {
    fn keep(&self, error: &centraid_search::SearchError) {
        if !matches!(
            error,
            centraid_search::SearchError::NoSearchableWords { .. }
        ) {
            self.door.keep(CoreError::Invariant {
                context: format!("the search index refused: {error}"),
            });
        }
    }
}

/// The FTS door over the read connection the page door uses, with its
/// failures kept as [`VaultDoor`] keeps the page door's.
pub(super) fn with_search<T>(
    vault: &Vault,
    door: &VaultDoor<'_>,
    run: impl FnOnce(&dyn centraid_search::Search) -> T,
) -> Result<T> {
    vault.read(|connection| {
        let index = match centraid_search::SqliteDoor::open(connection, vault.words()) {
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

/// A loader's answer through [`corrected_search`]: the data and the words it was
/// corrected to (empty when none), then the denial, if any.
type Corrected<T> = ((T, String), Option<centraid_apps_kit::Denial>);

/// An exact answer with fewer rows than this is thin, and is filled from the
/// corrected words.
///
/// A member who types `budegt` and has one note called "Budget" is served by
/// that note and by the others the slip would have found; a member who has none
/// is served by the others alone. Three is the least that reads as a list rather
/// than as the one thing that happened to match.
const FILL_BELOW: usize = 3;

/// THE CORRECTION PASS, once for every surface the full-text door answers.
///
/// `run` is the surface's whole search at one term; `rows` counts the rows its
/// answer holds; `fill` joins the exact answer and the corrected one. The exact
/// term runs first. **Only when that answer is thin (fewer than [`FILL_BELOW`]
/// rows) and carries no denial** does the door correct the term against the
/// vocabulary of `entities` (the domains the surface is about to search again).
/// With a correction the surface runs again, and `fill(exact, corrected)` answers
/// the exact rows FIRST and then the corrected rows that are not among them, up
/// to the surface's window. The corrected words are reported **only if they added
/// a row**: a correction that found nothing new is not reported, and an exact
/// answer that was empty is replaced by the corrected rows, as it always was. A
/// denial is never corrected around. The second element of the answer is the
/// words, empty when none answered — the wire's `corrected`.
///
/// A filled answer carries no continuation: no search answer pages past its
/// window, and a window of exact rows followed by another term's rows is not a
/// sequence a cursor could resume.
///
/// A failure of the door's `correct` is the recorder's to keep (it is kept the
/// way `query`'s is); here it only means there is no correction.
fn corrected_search<T>(
    search: &dyn centraid_search::Search,
    entities: &[&str],
    term: &str,
    rows: impl Fn(&T) -> usize,
    fill: impl Fn(T, T) -> T,
    mut run: impl FnMut(&str) -> KitResult<(T, Option<centraid_apps_kit::Denial>)>,
) -> KitResult<Corrected<T>> {
    let (exact, denial) = run(term)?;
    if denial.is_some() || rows(&exact) >= FILL_BELOW || term.trim().is_empty() {
        return Ok(((exact, String::new()), denial));
    }
    let Ok(Some(words)) = search.correct(&centraid_search::Principal::Owner, entities, term) else {
        return Ok(((exact, String::new()), None));
    };
    let (again, denial) = run(&words)?;
    if denial.is_some() || rows(&again) == 0 {
        return Ok(((exact, String::new()), None));
    }
    let had = rows(&exact);
    let filled = fill(exact, again);
    if rows(&filled) > had {
        Ok(((filled, words), None))
    } else {
        Ok(((filled, String::new()), None))
    }
}

/// The rows of `exact`, then those of `extra` whose key is not among them, up to
/// `window` in all. The exact rows are never dropped or reordered.
fn filled<R, K: Ord>(
    mut exact: Vec<R>,
    extra: Vec<R>,
    window: usize,
    key: impl Fn(&R) -> K,
) -> Vec<R> {
    let mut seen: std::collections::BTreeSet<K> = exact.iter().map(&key).collect();
    for row in extra {
        if exact.len() >= window {
            break;
        }
        if seen.insert(key(&row)) {
            exact.push(row);
        }
    }
    exact
}

/// [`filled`] over the door's own hits, which are keyed by kind and id.
fn filled_targets(
    exact: Vec<centraid_search::Target>,
    extra: Vec<centraid_search::Target>,
    window: usize,
) -> Vec<centraid_search::Target> {
    filled(exact, extra, window, |target| {
        (target.entity.clone(), target.id.clone())
    })
}

// ---------------------------------------------------------------------------
// The door.
// ---------------------------------------------------------------------------

/// [`PageDoor`] over the open vault, through [`Vault::keyset_page`].
pub struct VaultDoor<'v> {
    vault: &'v Vault,
    /// The FIRST failure the vault reported, kept so it is answered as itself
    /// and not as the denial a loader makes of [`KitError::Door`].
    failure: RefCell<Option<CoreError>>,
}

impl<'v> VaultDoor<'v> {
    #[must_use]
    pub const fn new(vault: &'v Vault) -> Self {
        Self {
            vault,
            failure: RefCell::new(None),
        }
    }

    /// The first failure the vault reported to this door, taken. For a caller
    /// that reads through an app crate's loader directly (the chat's photo
    /// reads) and so does not pass through [`settle`], which is where an
    /// app-query arm answers it.
    pub(crate) fn take_failure(&self) -> Option<CoreError> {
        self.failure.borrow_mut().take()
    }

    /// Keep a failure, unless an earlier one is already kept: the first is the
    /// cause, and what follows it is usually its echo.
    fn keep(&self, failure: CoreError) {
        let mut kept = self.failure.borrow_mut();
        if kept.is_none() {
            *kept = Some(failure);
        }
    }
}

impl PageDoor for VaultDoor<'_> {
    fn page(&self, query: &PageQuery, request: &PageRequest) -> KitResult<Page<Row>> {
        centraid_apps_kit::grammar::parse(query)?;
        let select: Vec<String> = query
            .select
            .split(',')
            .map(str::trim)
            .filter(|column| !column.is_empty())
            .map(str::to_owned)
            .collect();
        let answer = self.vault.keyset_page(&KeysetPage {
            name: query.name.clone(),
            select,
            from: query.from.clone(),
            predicate: query.r#where.clone(),
            binds: query.bind.iter().map(bind_of).collect(),
            sort_column: query.order.sort_column.clone(),
            pk_column: query.order.pk_column.clone(),
            descending: query.order.descending,
            limit: i64::try_from(request.limit).unwrap_or(i64::MAX),
            after: request
                .after
                .as_ref()
                .map(|cursor| (cursor.sort_key.clone(), cursor.pk.clone())),
            held_thumbnail: false,
            document_size: false,
        });
        match answer {
            Ok(answer) => Ok(Page {
                rows: answer
                    .rows
                    .into_iter()
                    .map(|image| {
                        image
                            .into_iter()
                            .map(|(column, value)| (column, cell_of(value)))
                            .collect()
                    })
                    .collect(),
                next: answer
                    .next
                    .map(|(sort_key, pk)| PageCursor { sort_key, pk }),
            }),
            Err(error) => {
                let sentence = error.to_string();
                self.keep(CoreError::Vault(error));
                Err(KitError::Door(sentence))
            }
        }
    }
}

fn bind_of(value: &PageBindValue) -> Value {
    match value {
        PageBindValue::Text(text) => Value::Text(text.clone()),
        PageBindValue::Integer(number) => Value::Integer(*number),
        PageBindValue::Real(number) => Value::Real(*number),
        PageBindValue::Null => Value::Null,
    }
}

fn cell_of(value: Value) -> Cell {
    match value {
        Value::Null => Cell::Null,
        Value::Integer(number) => Cell::Integer(number),
        Value::Real(number) => Cell::Real(number),
        Value::Text(text) => Cell::Text(text),
        Value::Blob(bytes) => Cell::Blob(bytes),
    }
}

// ---------------------------------------------------------------------------
// The conversion: `crates/apps/agenda`'s rows as `agenda.proto` spells them.
// ONE place, so a field that moved is one edit.
// ---------------------------------------------------------------------------

fn upcoming_to_wire(
    data: agenda::UpcomingData,
    zone: &FireZone,
    now: &str,
) -> wire::AgendaUpcoming {
    wire::AgendaUpcoming {
        events: data
            .events
            .into_iter()
            .map(|event| event_to_wire(event, zone))
            .collect(),
        calendars: data.calendars.into_iter().map(calendar_to_wire).collect(),
        today: local::today(zone, now).unwrap_or_default(),
        now_local: local::now_local(zone, now).unwrap_or_default(),
    }
}

fn search_to_wire(
    data: agenda::SearchData,
    next: Vec<Option<agenda::EventRow>>,
    corrected: String,
    zone: &FireZone,
) -> wire::AgendaSearch {
    let mut next = next.into_iter();
    wire::AgendaSearch {
        corrected,
        events: data
            .events
            .into_iter()
            .map(|event| {
                let mut hit = event_to_wire(event, zone);
                if let Some(occurrence) = next.next().flatten() {
                    hit.next_local_start = local::place(&occurrence, zone)
                        .map(|placed| placed.local_start)
                        .unwrap_or_default();
                    hit.next_original_start_local =
                        occurrence.original_start_local.unwrap_or_default();
                    hit.next_instance_key = occurrence.instance_key;
                }
                hit
            })
            .collect(),
    }
}

fn event_to_wire(event: agenda::EventRow, zone: &FireZone) -> wire::AgendaEvent {
    // WHERE IT FALLS, before the row is taken apart: the one placement, in the
    // request's zone. A start that does not parse is placed nowhere.
    let all_day = event.semantics() == centraid_vault::time::recurrence::Semantics::AllDay;
    let placed = local::place(&event, zone).unwrap_or_default();
    wire::AgendaEvent {
        local_start: placed.local_start,
        local_end: placed.local_end,
        local_days: placed.local_days,
        all_day,
        reminders: event
            .reminders
            .iter()
            .map(|minutes_before| wire::AgendaReminder {
                minutes_before: *minutes_before,
            })
            .collect(),
        event_id: event.event_id,
        summary: event.summary,
        description: event.description,
        dtstart: event.dtstart,
        dtend: event.dtend,
        start_tz: event.start_tz,
        end_tz: event.end_tz,
        recurrence_semantics: event.recurrence_semantics,
        rrule: event.rrule,
        rrule_support: event.rrule_support,
        status: event.status,
        location_place_id: event.location_place_id,
        location_name: event.location_name,
        created_at: event.created_at,
        updated_at: event.updated_at,
        calendar_id: event.calendar_id,
        conferencing_uri: event.conferencing_uri,
        attachments: event
            .attachments
            .into_iter()
            .map(|attachment| wire::AgendaAttachment {
                attachment_id: attachment.attachment_id,
                content_id: attachment.content_id,
                media_type: attachment.media_type,
                content_uri: attachment.content_uri,
                byte_size: attachment.byte_size,
            })
            .collect(),
        attendees: event
            .attendees
            .into_iter()
            .map(|attendee| wire::AgendaAttendee {
                party_id: attendee.party_id,
                name: attendee.name,
                partstat: attendee.partstat,
                is_you: attendee.is_you,
            })
            .collect(),
        recurrence_summary: event.recurrence_summary,
        is_recurrence_instance: event.is_recurrence_instance,
        instance_key: event.instance_key,
        original_start_local: event.original_start_local,
        recurrence_overlap: event.recurrence_overlap,
        snippet: event.snippet,
        // `search` only, and filled there (`search_to_wire`).
        next_instance_key: String::new(),
        next_original_start_local: String::new(),
        next_local_start: String::new(),
    }
}

fn calendar_to_wire(calendar: agenda::CalendarRow) -> wire::AgendaCalendar {
    wire::AgendaCalendar {
        calendar_id: calendar.calendar_id,
        name: calendar.name,
        color: calendar.color,
    }
}

fn day_context_to_wire(
    data: agenda::DayContextData,
    zone: &FireZone,
    now: &str,
) -> wire::AgendaDayContext {
    wire::AgendaDayContext {
        today: local::today(zone, now).unwrap_or_default(),
        now_local: local::now_local(zone, now).unwrap_or_default(),
        birthdays: data
            .birthdays
            .into_iter()
            .map(|birthday| wire::AgendaBirthday {
                party_id: birthday.party_id,
                name: birthday.name,
                // `month_day_of` admits 1-12 and 1-31 and nothing else.
                month: i32::try_from(birthday.month).unwrap_or_default(),
                day: i32::try_from(birthday.day).unwrap_or_default(),
                tier: match birthday.tier {
                    "inner" => wire::AgendaBirthdayTier::Inner,
                    "outer" => wire::AgendaBirthdayTier::Outer,
                    _ => wire::AgendaBirthdayTier::Unspecified,
                } as i32,
            })
            .collect(),
        holidays: data.holidays,
    }
}

fn parties_to_wire(data: agenda::PartiesData) -> wire::AgendaParties {
    wire::AgendaParties {
        parties: data
            .parties
            .into_iter()
            .map(|party| wire::AgendaParty {
                party_id: party.party_id,
                name: party.name,
                is_you: party.is_you,
            })
            .collect(),
        me: data.me,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::CoreConfig;
    use crate::handle::{Core, Handle};

    const FROM: &str = "2099-06-01T00:00:00.000Z";
    const TO: &str = "2099-06-22T00:00:00.000Z";
    /// The vault clock, stopped: 02:00Z on 2 June is still 1 June, 22:00, in
    /// New York — so a test that reads "today" in UTC gets a different answer.
    const NOW: &str = "2099-06-02T02:00:00.000Z";
    /// The device's zone every query here states, unless it is the point.
    const TZ: &str = "America/New_York";

    struct Scratch {
        dir: std::path::PathBuf,
        handle: Handle,
        writes: std::cell::Cell<u32>,
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
                .with_vault(|vault| Ok(vault.found("Agenda", "Owner")?))
                .expect("it founds");
            Self {
                dir,
                handle,
                writes: std::cell::Cell::new(0),
            }
        }

        /// One request through `Handle::call`, the door a shell uses.
        fn call(&self, kind: wire::request::Kind) -> Result<wire::response::Kind> {
            self.handle
                .call(&wire::Request { kind: Some(kind) })
                .map(|response| response.kind.expect("an answer has a kind"))
        }

        fn ask(
            &self,
            query: wire::app_query_request::Query,
        ) -> Result<wire::app_query_response::Answer> {
            match self.call(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                query: Some(query),
            }))? {
                wire::response::Kind::AppQuery(answer) => {
                    Ok(answer.answer.expect("an app query is answered"))
                }
                other => panic!("an app query answered as {other:?}"),
            }
        }

        fn upcoming(&self, from: &str, to: &str) -> Result<wire::AgendaUpcoming> {
            self.upcoming_in(from, to, TZ)
        }

        fn upcoming_in(&self, from: &str, to: &str, tz: &str) -> Result<wire::AgendaUpcoming> {
            match self.ask(wire::app_query_request::Query::AgendaUpcoming(
                wire::AgendaUpcomingRequest {
                    from: from.to_owned(),
                    to: to.to_owned(),
                    tz: tz.to_owned(),
                },
            ))? {
                wire::app_query_response::Answer::AgendaUpcoming(upcoming) => Ok(upcoming),
                other => panic!("upcoming answered as {other:?}"),
            }
        }

        fn run(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
            self.writes.set(self.writes.get() + 1);
            let wire::response::Kind::Command(outcome) = self
                .call(wire::request::Kind::Command(wire::Command {
                    name: name.to_owned(),
                    input: serde_json::to_vec(&input).expect("json"),
                    invoke_key: format!("app-query-test-{}", self.writes.get()),
                    ..wire::Command::default()
                }))
                .unwrap_or_else(|error| panic!("{name} refused: {error}"))
            else {
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

        fn propose(&self, summary: &str, start: &str, end: &str, rrule: Option<&str>) -> String {
            let mut input = serde_json::json!({
                "title": summary,
                "starts": start,
                "ends": end,
                "zone": "Etc/UTC",
                "reminders": [10],
            });
            if let Some(rule) = rrule {
                input["rule"] = serde_json::json!(rule);
            }
            self.propose_with(input)
        }

        /// A proposal with every field the caller's.
        fn propose_with(&self, input: serde_json::Value) -> String {
            self.run("event.propose", input)["id"]
                .as_str()
                .expect("an event id")
                .to_owned()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// THE WAVE'S EXIT, BELOW THE ABI: a weekly series comes back EXPANDED by
    /// the core — three occurrences in three weeks, each with its own key and
    /// the series' id — beside a one-off, with the reminders decoded, the
    /// trashed event absent, and the owner's calendar listed.
    #[test]
    fn upcoming_answers_a_weekly_series_expanded_and_the_trash_left_out() {
        let scratch = Scratch::founded();
        let one_off = scratch.propose(
            "Dentist",
            "2099-06-03T09:00:00.000Z",
            "2099-06-03T10:00:00.000Z",
            None,
        );
        let series = scratch.propose(
            "Morning run",
            "2099-05-04T07:00:00.000Z",
            "2099-05-04T08:00:00.000Z",
            Some("FREQ=WEEKLY"),
        );
        let trashed = scratch.propose(
            "Book the cabin",
            "2099-06-04T09:00:00.000Z",
            "2099-06-04T10:00:00.000Z",
            None,
        );
        scratch.run("entity.trash", serde_json::json!({ "id": trashed }));

        let upcoming = scratch.upcoming(FROM, TO).expect("upcoming answers");
        assert_eq!(upcoming.calendars.len(), 1, "the calendar founding made");
        assert!(
            upcoming
                .events
                .iter()
                .all(|event| event.event_id != trashed),
            "a trashed event is not on the agenda"
        );
        let runs: Vec<&wire::AgendaEvent> = upcoming
            .events
            .iter()
            .filter(|event| event.event_id == series && event.dtstart.as_str() >= FROM)
            .collect();
        assert_eq!(runs.len(), 3, "three weeks, three occurrences");
        let keys: std::collections::BTreeSet<&str> = runs
            .iter()
            .map(|event| event.instance_key.as_str())
            .collect();
        assert_eq!(keys.len(), 3, "each occurrence has its own key");
        for run in &runs {
            assert!(run.instance_key.starts_with(&format!("{series}:")));
            assert!(run.original_start_local.is_some());
            assert_eq!(run.recurrence_summary.as_deref(), Some("Weekly"));
            assert_eq!(
                run.reminders,
                vec![wire::AgendaReminder { minutes_before: 10 }]
            );
        }
        let dentist = upcoming
            .events
            .iter()
            .find(|event| event.event_id == one_off)
            .expect("the one-off is on the agenda");
        assert_eq!(dentist.instance_key, one_off);
        assert!(!dentist.is_recurrence_instance);
        assert_eq!(dentist.recurrence_summary, None);
    }

    /// WHERE EACH OCCURRENCE FALLS, IN THE DEVICE'S ZONE. A zoned call that
    /// starts at 23:30 New York time and ends at 01:00 is on two local days; a
    /// three-day all-day run is dates, end inclusive, and on all three; the
    /// answer's today and now are New York's reading of the vault clock; and
    /// nothing answered ended before `from`.
    /// A WINDOW TOO FULL TO EXPAND IS A BOUND THE SHELL IS TOLD, NOT A SHORT AGENDA.
    ///
    /// Forty daily series over six months are about 7,000 occurrences against
    /// `MAX_TOTAL_INSTANCES` (1,500): the read errors at the size it reaches, the
    /// core answers `ReadBoundReached` naming it, and a day of the same vault
    /// answers whole.
    #[test]
    fn a_window_too_full_to_expand_is_a_bound_reached_and_a_day_of_it_is_whole() {
        let scratch = Scratch::founded();
        for k in 0..40 {
            // Twenty minutes apart, so no two of them are the same busy time.
            let (hour, minute) = (k / 3, (k % 3) * 20);
            scratch.propose(
                &format!("Daily {k}"),
                &format!("2099-05-01T{hour:02}:{minute:02}:00.000Z"),
                &format!("2099-05-01T{hour:02}:{:02}:00.000Z", minute + 15),
                Some("FREQ=DAILY"),
            );
        }
        match scratch.upcoming("2099-06-01T00:00:00.000Z", "2099-12-01T00:00:00.000Z") {
            Err(CoreError::ReadBoundReached { query, cap }) => {
                assert_eq!(query, "agenda.upcoming.expansion");
                assert_eq!(cap, centraid_apps_agenda::MAX_TOTAL_INSTANCES);
            }
            other => panic!("a window past the bound answers a bound, not {other:?}"),
        }
        let day = scratch
            .upcoming("2099-06-03T04:00:00.000Z", "2099-06-04T04:00:00.000Z")
            .expect("a day reads");
        assert_eq!(day.events.len(), 40);
    }

    #[test]
    fn upcoming_answers_each_occurrence_in_the_request_zone() {
        let scratch = Scratch::founded();
        let late = scratch.propose_with(serde_json::json!({
            "title": "Late call",
            "starts": "2099-06-04T03:30:00.000Z",
            "ends": "2099-06-04T05:00:00.000Z",
            "zone": "Europe/London",
        }));
        let away = scratch.propose_with(serde_json::json!({
            "title": "Away",
            "starts": "2099-06-10",
            "ends": "2099-06-12",
            "timing": "all-day",
        }));
        // A weekly series anchored a year back: its reach-back month is not
        // answered.
        scratch.propose(
            "Morning run",
            "2098-06-05T11:00:00.000Z",
            "2098-06-05T12:00:00.000Z",
            Some("FREQ=WEEKLY"),
        );

        let upcoming = scratch.upcoming(FROM, TO).expect("upcoming answers");
        assert_eq!(upcoming.today, "2099-06-01");
        assert_eq!(upcoming.now_local, "2099-06-01T22:00");

        let call = upcoming
            .events
            .iter()
            .find(|event| event.event_id == late)
            .expect("the call is on the agenda");
        assert_eq!(call.local_start, "2099-06-03T23:30");
        assert_eq!(call.local_end, "2099-06-04T01:00");
        assert_eq!(call.local_days, ["2099-06-03", "2099-06-04"]);
        assert!(!call.all_day);

        let trip = upcoming
            .events
            .iter()
            .find(|event| event.event_id == away)
            .expect("the all-day run is on the agenda");
        assert!(trip.all_day, "a day and never a time");
        assert_eq!(trip.local_start, "2099-06-10");
        assert_eq!(trip.local_end, "2099-06-12", "the LAST day, inclusive");
        assert_eq!(trip.local_days, ["2099-06-10", "2099-06-11", "2099-06-12"]);

        let from = centraid_vault::time::recurrence::parse_instant_ms(FROM).expect("an instant");
        for event in &upcoming.events {
            let start = centraid_vault::time::recurrence::parse_instant_ms(&event.dtstart)
                .expect("a zoned start");
            let end = event
                .dtend
                .as_deref()
                .and_then(centraid_vault::time::recurrence::parse_instant_ms)
                .unwrap_or(start);
            assert!(
                end > from || start >= from,
                "{:?} at {} had ended before `from`",
                event.summary,
                event.dtstart
            );
        }
        assert_eq!(
            upcoming
                .events
                .iter()
                .filter(|event| event.summary.as_deref() == Some("Morning run"))
                .count(),
            3,
            "three weeks in range and none of the month before"
        );

        // THE SAME CALL, READ IN LONDON, is one local day.
        let london = scratch
            .upcoming_in(FROM, TO, "Europe/London")
            .expect("upcoming answers");
        let call = london
            .events
            .iter()
            .find(|event| event.event_id == late)
            .expect("the call is on the agenda");
        assert_eq!(call.local_start, "2099-06-04T04:30");
        assert_eq!(call.local_days, ["2099-06-04"]);
        assert_eq!(london.today, "2099-06-02");
    }

    /// THE ZONE RULE: an unknown name is refused, never demoted; an empty one
    /// is the vault's, and a vault that names none refuses too — never UTC.
    #[test]
    fn a_zone_is_stated_or_the_vaults_and_never_guessed() {
        let scratch = Scratch::founded();
        let unknown = scratch
            .upcoming_in(FROM, TO, "America/New_Yrok")
            .expect_err("an unknown zone is refused");
        assert_eq!(unknown.code(), wire::ErrorCode::InvalidRequest);
        assert!(
            unknown.to_string().contains("America/New_Yrok"),
            "{unknown}"
        );

        let unset = scratch
            .upcoming_in(FROM, TO, "")
            .expect_err("founding names no zone, so an empty one is refused");
        assert_eq!(unset.code(), wire::ErrorCode::InvalidRequest);

        // Parties has no local reading and states no zone.
        assert!(
            scratch
                .ask(wire::app_query_request::Query::AgendaParties(
                    wire::AgendaPartiesRequest {},
                ))
                .is_ok()
        );
    }

    /// `parties` names the owner and flags them; `day-context` — with nobody
    /// starred and nobody's birthday in range — answers no birthdays, which is
    /// a fact and not a refusal. It answers no due work: a dated task is a row
    /// in its day, read from `tasks.board` (R-1128-F1, #1128).
    #[test]
    fn parties_and_day_context_answer_typed() {
        let scratch = Scratch::founded();

        let wire::app_query_response::Answer::AgendaParties(parties) = scratch
            .ask(wire::app_query_request::Query::AgendaParties(
                wire::AgendaPartiesRequest {},
            ))
            .expect("parties answers")
        else {
            panic!("parties answered as something else");
        };
        let owner = parties.parties.first().expect("the owner is a person");
        assert!(owner.is_you, "the owner sorts first and is flagged");
        assert_eq!(parties.me.as_deref(), Some(owner.party_id.as_str()));

        let wire::app_query_response::Answer::AgendaDayContext(context) = scratch
            .ask(wire::app_query_request::Query::AgendaDayContext(
                wire::AgendaDayContextRequest {
                    from: "2099-06-01".to_owned(),
                    to: "2099-06-21".to_owned(),
                    tz: TZ.to_owned(),
                },
            ))
            .expect("day-context answers")
        else {
            panic!("day-context answered as something else");
        };
        assert!(context.birthdays.is_empty());
        assert!(context.holidays.is_empty(), "no holiday source exists");
        // TODAY IS THE DEVICE'S: the stopped clock's 02:00Z on the 2nd is the
        // 1st in New York.
        assert_eq!(context.today, "2099-06-01");
        assert_eq!(context.now_local, "2099-06-01T22:00");
    }

    /// `search` from a term, through the FTS door and the page door both.
    #[test]
    fn search_answers_in_rank_order_with_a_snippet() {
        let scratch = Scratch::founded();
        // The title alone is a hit without an excerpt; the words about it are the snippet.
        let cabin = scratch.propose_with(serde_json::json!({
            "title": "Cabin weekend", "starts": "2099-06-05T16:00:00.000Z",
            "ends": "2099-06-05T18:00:00.000Z", "zone": "Etc/UTC",
            "description": "the cabin sleeps six",
        }));
        scratch.propose(
            "Dentist",
            "2099-06-03T09:00:00.000Z",
            "2099-06-03T10:00:00.000Z",
            None,
        );
        let wire::app_query_response::Answer::AgendaSearch(found) = scratch
            .ask(wire::app_query_request::Query::AgendaSearch(
                wire::AgendaSearchRequest {
                    term: "cabin".to_owned(),
                    limit: 10,
                    tz: TZ.to_owned(),
                },
            ))
            .expect("search answers")
        else {
            panic!("search answered as something else");
        };
        assert_eq!(found.events.len(), 1);
        assert_eq!(found.events[0].event_id, cabin);
        assert!(
            found.events[0]
                .snippet
                .as_deref()
                .is_some_and(|snippet| snippet.contains('⟦'))
        );

        // A ZERO LIMIT IS REFUSED, NOT DEFAULTED.
        let refused = scratch
            .ask(wire::app_query_request::Query::AgendaSearch(
                wire::AgendaSearchRequest {
                    term: "cabin".to_owned(),
                    limit: 0,
                    tz: TZ.to_owned(),
                },
            ))
            .expect_err("a zero limit is refused");
        assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);
    }

    /// A TYPO FINDS THE EVENT AND SAYS WHAT WAS SEARCHED (#1097, R4, R8).
    #[test]
    fn a_typo_finds_the_event_and_says_what_it_searched() {
        let scratch = Scratch::founded();
        let cabin = scratch.propose(
            "Cabin weekend",
            "2099-06-05T16:00:00.000Z",
            "2099-06-05T18:00:00.000Z",
            None,
        );
        scratch.propose(
            "Dentist",
            "2099-06-03T09:00:00.000Z",
            "2099-06-03T10:00:00.000Z",
            None,
        );
        let search = |term: &str| {
            let wire::app_query_response::Answer::AgendaSearch(found) = scratch
                .ask(wire::app_query_request::Query::AgendaSearch(
                    wire::AgendaSearchRequest {
                        term: term.to_owned(),
                        limit: 10,
                        tz: TZ.to_owned(),
                    },
                ))
                .expect("search answers")
            else {
                panic!("search answered as something else");
            };
            found
        };
        let slipped = search("cabni");
        assert_eq!(slipped.events.len(), 1);
        assert_eq!(slipped.events[0].event_id, cabin);
        assert_eq!(slipped.corrected, "cabin");
        let exact = search("cabin");
        assert_eq!(exact.events.len(), 1);
        assert!(exact.corrected.is_empty());
        let nothing = search("zeppelin");
        assert!(nothing.events.is_empty() && nothing.corrected.is_empty());
    }

    /// THE RECORDER FORWARDS THE CORRECTION. `Search::correct` defaults to
    /// `Ok(None)`, so a recorder that wraps only `query` is a recorder that
    /// quietly corrects nothing for every caller in this crate; this fails the
    /// moment the forward is removed.
    #[test]
    fn the_recording_door_forwards_correct_and_keeps_its_failure() {
        use centraid_search::{Answer, Principal, Search, SearchError, SearchRequest};

        struct Inner(std::result::Result<Option<String>, SearchError>);
        impl Search for Inner {
            fn query(
                &self,
                _: &Principal,
                request: &SearchRequest,
            ) -> std::result::Result<Answer, SearchError> {
                Err(SearchError::NoSearchableWords {
                    query: request.query.clone(),
                })
            }
            fn correct(
                &self,
                _: &Principal,
                _: &[&str],
                _: &str,
            ) -> std::result::Result<Option<String>, SearchError> {
                self.0.clone()
            }
        }

        let scratch = Scratch::founded();
        scratch
            .handle
            .with_vault(|vault| {
                let door = VaultDoor::new(vault);
                let said = Inner(Ok(Some("cabin".to_owned())));
                let recording = RecordingSearch {
                    inner: &said,
                    door: &door,
                };
                assert_eq!(
                    recording.correct(&Principal::Owner, &["core.event"], "cabni"),
                    Ok(Some("cabin".to_owned())),
                    "the inner door's correction is the recorder's"
                );
                // A failure of the vocabulary is kept the way `query`'s is, so
                // `settle` reports it rather than the member seeing "no match".
                let broken = Inner(Err(SearchError::NotSearchable {
                    kind: "locker.item".to_owned(),
                    count: 13,
                }));
                let recording = RecordingSearch {
                    inner: &broken,
                    door: &door,
                };
                assert!(
                    recording
                        .correct(&Principal::Owner, &["locker.item"], "cabni")
                        .is_err()
                );
                assert!(
                    door.take_failure().is_some(),
                    "a refusal of `correct` is kept"
                );
                // ...but a term with no searchable word is an answer, not a failure.
                let none = Inner(Err(SearchError::NoSearchableWords {
                    query: "---".to_owned(),
                }));
                let recording = RecordingSearch {
                    inner: &none,
                    door: &door,
                };
                assert!(
                    recording
                        .correct(&Principal::Owner, &["core.event"], "---")
                        .is_err()
                );
                assert!(door.take_failure().is_none());
                Ok(())
            })
            .expect("the vault is open");
    }

    /// A CEILING IS A TYPED REFUSAL. Eight daily series over most of a year is
    /// 1,600 occurrences against the expansion's 1,500: the loader stops with
    /// `FanOutExceeded`, and the shell reads `READ_BOUND_REACHED` — not a
    /// panic, not an `Internal` that would restart the core, and not a short
    /// agenda that reads as a whole one.
    #[test]
    fn a_read_that_reaches_its_ceiling_is_refused_by_name() {
        let scratch = Scratch::founded();
        for hour in 1..=8 {
            scratch.propose(
                &format!("Daily {hour}"),
                &format!("2099-01-01T{hour:02}:00:00.000Z"),
                &format!("2099-01-01T{hour:02}:30:00.000Z"),
                Some("FREQ=DAILY"),
            );
        }
        let refused = scratch
            .upcoming("2099-01-01T00:00:00.000Z", "2099-12-31T00:00:00.000Z")
            .expect_err("the expansion reaches its cap");
        assert_eq!(refused.code(), wire::ErrorCode::ReadBoundReached);
        assert!(
            matches!(&refused, CoreError::ReadBoundReached { cap: 1_500, .. }),
            "{refused}"
        );
        assert!(!refused.sentence().is_empty());
        // THE HANDLE IS NOT POISONED: a narrower range answers.
        let narrow = scratch
            .upcoming("2099-03-01T00:00:00.000Z", "2099-03-08T00:00:00.000Z")
            .expect("a week answers");
        assert!(!narrow.events.is_empty());
    }

    /// A request that names no query is the request's fault, not the state's.
    #[test]
    fn an_app_query_naming_nothing_is_an_invalid_request() {
        let scratch = Scratch::founded();
        let refused = scratch
            .call(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                query: None,
            }))
            .expect_err("no query is refused");
        assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);
    }

    /// A FAILURE THE DOOR SAW IS ANSWERED AS ITSELF, never as the denial a
    /// loader makes of `KitError::Door`: a statement the vault will not run is
    /// an error, and a screen must not draw "you may not ask" over it.
    #[test]
    fn a_vault_failure_is_an_error_and_never_a_denial() {
        let scratch = Scratch::founded();
        scratch
            .handle
            .with_vault(|vault| {
                let door = VaultDoor::new(vault);
                // An order column the projection does not carry: the vault
                // refuses the shape, as it would for a shell's own page.
                let broken = PageQuery::new(
                    "test.broken",
                    "id",
                    "entity",
                    centraid_apps_kit::statement::PageOrder::asc("created_at", "id"),
                );
                let loaded = door
                    .page(&broken, &PageRequest::first(1))
                    .map(|_| (0_u8, None));
                let settled = settle(&door, loaded, |_| unreachable!("no data"));
                let error = settled.expect_err("the failure is an error");
                assert_eq!(error.code(), wire::ErrorCode::InvalidRequest);
                Ok(())
            })
            .expect("the vault is open");
    }

    /// `agenda_event` (#1029): one occurrence by its key, placed in `tz`, with
    /// the `today`/`now_local` a detail draws beside it; an unknown id answers
    /// an absent event, never an error.
    #[test]
    fn agenda_event_answers_one_occurrence_by_its_key_and_absent_for_nothing() {
        let scratch = Scratch::founded();
        // A wall clock in the device's zone, as the phone writes it.
        let series = scratch.propose_with(serde_json::json!({
            "title": "Morning run",
            "starts": "2099-05-04T07:00:00",
            "ends": "2099-05-04T08:00:00",
            "zone": TZ,
            "rule": "FREQ=WEEKLY",
        }));
        let ask = |event_id: &str, instance_key: &str| match scratch
            .ask(wire::app_query_request::Query::AgendaEvent(
                wire::AgendaEventRequest {
                    event_id: event_id.to_owned(),
                    instance_key: instance_key.to_owned(),
                    original_start_local: String::new(),
                    tz: TZ.to_owned(),
                },
            ))
            .expect("agenda_event answers")
        {
            wire::app_query_response::Answer::AgendaEvent(detail) => detail,
            other => panic!("agenda_event answered as {other:?}"),
        };
        let detail = ask(&series, &format!("{series}:2099-06-08T07:00:00"));
        let event = detail.event.expect("the occurrence is there");
        assert_eq!(event.dtstart, "2099-06-08T11:00:00.000Z");
        assert_eq!(event.local_start, "2099-06-08T07:00");
        assert!(!detail.today.is_empty() && !detail.now_local.is_empty());
        assert!(ask("no-such-event", "").event.is_none());
    }

    /// A door that would correct anything, counting how often it is asked: the
    /// test of "a correction never goes around a denial" needs a door that says
    /// yes, so that the only thing that can stop it is the helper.
    struct EagerDoor {
        asked: std::cell::Cell<u32>,
    }

    impl centraid_search::Search for EagerDoor {
        fn query(
            &self,
            _: &centraid_search::Principal,
            _: &centraid_search::SearchRequest,
        ) -> std::result::Result<centraid_search::Answer, centraid_search::SearchError> {
            unreachable!("corrected_search asks the surface's own run, never the door's query")
        }

        fn correct(
            &self,
            _: &centraid_search::Principal,
            _: &[&str],
            _: &str,
        ) -> std::result::Result<Option<String>, centraid_search::SearchError> {
            self.asked.set(self.asked.get() + 1);
            Ok(Some("cabin".to_owned()))
        }
    }

    /// A CORRECTION NEVER GOES AROUND A DENIAL (#1097, R4). An empty answer that
    /// carries a denial is a refusal, not a miss: the door is not asked to
    /// correct, the surface does not run again at other words, and the denial is
    /// the answer. The control is the same empty answer without a denial, which
    /// is corrected, so the door in this test would have corrected the first.
    #[test]
    fn a_correction_never_goes_around_a_denial() {
        let denial = centraid_apps_kit::Denial {
            code: Some("consent_revoked".to_owned()),
            message: Some("the app may not read".to_owned()),
            revoked_at: None,
        };
        let door = EagerDoor {
            asked: std::cell::Cell::new(0),
        };
        let runs = std::cell::RefCell::new(Vec::<String>::new());
        let denied = corrected_search(
            &door,
            &["core.content_item"],
            "cabn",
            |found: &Vec<&str>| found.len(),
            |exact, again| filled(exact, again, 8, |row| (*row).to_owned()),
            |words| {
                runs.borrow_mut().push(words.to_owned());
                Ok((Vec::new(), Some(denial.clone())))
            },
        )
        .expect("a denial is an answer");
        assert_eq!(
            door.asked.get(),
            0,
            "a denied search asked for a correction"
        );
        assert_eq!(*runs.borrow(), ["cabn"], "a denied search ran again");
        assert_eq!(denied, ((Vec::new(), String::new()), Some(denial)));

        // The control: no denial, an empty answer, and the second run finds a row.
        let runs = std::cell::RefCell::new(Vec::<String>::new());
        let ((found, corrected), refused) = corrected_search(
            &door,
            &["core.content_item"],
            "cabn",
            |found: &Vec<&str>| found.len(),
            |exact, again| filled(exact, again, 8, |row| (*row).to_owned()),
            |words| {
                runs.borrow_mut().push(words.to_owned());
                Ok((
                    if words == "cabin" {
                        vec!["row"]
                    } else {
                        Vec::new()
                    },
                    None,
                ))
            },
        )
        .expect("it answers");
        assert_eq!(door.asked.get(), 1);
        assert_eq!(*runs.borrow(), ["cabn", "cabin"]);
        assert_eq!(
            (found, corrected, refused),
            (vec!["row"], "cabin".to_owned(), None)
        );
    }

    /// THE FILL RULE: a thin exact answer (fewer than three rows) is followed by
    /// the corrected words' rows, the exact rows first and none twice; a full
    /// answer is not corrected; and the words are reported only when they added
    /// a row.
    #[test]
    fn a_thin_answer_is_filled_from_the_corrected_words_and_a_full_one_is_not() {
        let door = EagerDoor {
            asked: std::cell::Cell::new(0),
        };
        let fill = |exact: Vec<&'static str>, again: Vec<&'static str>| {
            filled(exact, again, 4, |row| (*row).to_owned())
        };
        let run = |answers: &'static [(&'static str, &'static [&'static str])]| {
            move |words: &str| -> KitResult<(Vec<&'static str>, Option<centraid_apps_kit::Denial>)> {
                let rows = answers
                    .iter()
                    .find(|(term, _)| *term == words)
                    .map_or(Vec::new(), |(_, rows)| rows.to_vec());
                Ok((rows, None))
            }
        };
        let ask = |answers: &'static [(&'static str, &'static [&'static str])]| {
            corrected_search(
                &door,
                &["note"],
                "cabn",
                |found: &Vec<&str>| found.len(),
                fill,
                run(answers),
            )
            .expect("it answers")
        };

        // One exact row and three more at the corrected words: the exact row
        // first, then the new ones up to the window of four; the words are said.
        let ((rows, corrected), _) = ask(&[("cabn", &["own"]), ("cabin", &["own", "a", "b", "c"])]);
        assert_eq!(
            (rows, corrected.as_str()),
            (vec!["own", "a", "b", "c"], "cabin")
        );
        assert_eq!(door.asked.get(), 1);

        // Two exact rows is thin too; empty is the old case, and the corrected
        // rows alone are the answer.
        let ((rows, corrected), _) = ask(&[("cabn", &["x", "y"]), ("cabin", &["z"])]);
        assert_eq!((rows, corrected.as_str()), (vec!["x", "y", "z"], "cabin"));
        let ((rows, corrected), _) = ask(&[("cabin", &["z"])]);
        assert_eq!((rows, corrected.as_str()), (vec!["z"], "cabin"));

        // The corrected words that add nothing are not reported.
        let ((rows, corrected), _) = ask(&[("cabn", &["x"]), ("cabin", &["x"])]);
        assert_eq!((rows, corrected.as_str()), (vec!["x"], ""));
        let ((rows, corrected), _) = ask(&[("cabn", &["x"])]);
        assert_eq!((rows, corrected.as_str()), (vec!["x"], ""));

        // Three exact rows is a list: the door is not even asked.
        let before = door.asked.get();
        let ((rows, corrected), _) = ask(&[("cabn", &["x", "y", "z"]), ("cabin", &["w"])]);
        assert_eq!((rows, corrected.as_str()), (vec!["x", "y", "z"], ""));
        assert_eq!(door.asked.get(), before);
    }

    #[test]
    fn the_exact_rows_are_never_dropped_to_make_room() {
        assert_eq!(filled(vec![1, 2], vec![2, 3, 4, 5], 3, |n| *n), [1, 2, 3]);
        assert_eq!(filled(vec![1, 2, 3], vec![4], 2, |n| *n), [1, 2, 3]);
    }
}
