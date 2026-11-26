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
//! kit's grammar ([`centraid_domain::grammar::parse`]), because that is what
//! the app's parity tests read through ([`centraid_domain::testdoor`]), and a
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
//! computed here, in the request's `tz`, by `crates/apps/calendar`'s `local`
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
use std::collections::BTreeSet;

use centraid_api_proto::core_v1 as wire;
use centraid_domain::error::{KitError, KitResult};
use centraid_domain::page::{Page, PageCursor, PageRequest};
use centraid_domain::reads::PageDoor;
use centraid_domain::row::{Cell, Row};
use centraid_domain::statement::{PageBindValue, PageQuery};
use centraid_vault::Vault;
use centraid_vault::page::KeysetPage;
use centraid_vault::time::zone::{FireZone, ZoneUnset};
use centraid_vault::value::Value;

use crate::error::{CoreError, Result};

pub(crate) mod chat;

/// Answer one app query against the open vault.
///
/// `now` is the vault's own clock, never the host's: a loader reads it only to
/// default an empty range to "today".
pub fn answer(vault: &Vault, request: &wire::AppQueryRequest) -> Result<wire::AppQueryResponse> {
    answer_recording(vault, request, &mut BTreeSet::new())
}

/// [`answer`], and the tables the door read for it, handed back in `tables`
/// when the answer is whole: `load` says what an answer was drawn from so a
/// screen knows which change events redraw it.
pub(crate) fn answer_recording(
    vault: &Vault,
    request: &wire::AppQueryRequest,
    tables: &mut BTreeSet<String>,
) -> Result<wire::AppQueryResponse> {
    use wire::app_query_request::Query as Q;
    let Some(query) = &request.query else {
        return Err(CoreError::InvalidRequest {
            detail: "an app query names no query".to_owned(),
        });
    };
    let _now = vault.clock().now_text();
    let door = VaultDoor::new(vault);
    let answer = match query {
        Q::ChatThreads(asked) => chat::threads(vault, &door, asked)?,
        Q::ChatThread(asked) => chat::thread(vault, asked)?,
        Q::ChatCard(asked) => chat::card(vault, asked)?,
    };
    *tables = door.take_tables();
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

/// A loader's answer as the wire's: the data, the denial, or the error — with
/// what the DOOR saw taking precedence over what the loader made of it.
fn settle<T>(
    door: &VaultDoor<'_>,
    loaded: KitResult<(T, Option<centraid_domain::Denial>)>,
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

    /// **FORWARDED, because the trait's default is `correct`, which a door that
    /// wraps another cannot reach.**
    fn correct_thin(
        &self,
        principal: &centraid_search::Principal,
        entities: &[&str],
        query: &str,
    ) -> std::result::Result<Option<String>, centraid_search::SearchError> {
        self.inner
            .correct_thin(principal, entities, query)
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

/// A loader's answer through [`corrected_search`]: the data and the words it was
/// corrected to (empty when none), then the denial, if any.
type Corrected<T> = ((T, String), Option<centraid_domain::Denial>);

/// An exact answer with fewer rows than this is thin, and is filled from the
/// corrected words.
///
/// A member who types `budegt` and has one note called "Budget" is served by
/// that note and by the others the slip would have found; a member who has none
/// is served by the others alone. Three is the least that reads as a list rather
/// than as the one thing that happened to match.
const FILL_BELOW: usize = centraid_search::THIN_ANSWER;

/// THE CORRECTION PASS, once for every surface the full-text door answers.
///
/// `run` is the surface's whole search at one term; `rows` counts the rows its
/// answer holds; `fill` joins the exact answer and the corrected one. The exact
/// term runs first. **Only when that answer is thin (fewer than [`FILL_BELOW`]
/// rows) and carries no denial** does the door correct the term against the
/// vocabulary of `entities` (the domains the surface is about to search again):
/// for an empty answer a word the vault holds is kept; for one or two rows
/// the door's filled pass also corrects a typed word that is a whole word held by
/// fewer than three documents when a neighbour holds more
/// ([`centraid_search::Search::correct_thin`]).
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
    mut run: impl FnMut(&str) -> KitResult<(T, Option<centraid_domain::Denial>)>,
) -> KitResult<Corrected<T>> {
    let (exact, denial) = run(term)?;
    if denial.is_some() || rows(&exact) >= FILL_BELOW || term.trim().is_empty() {
        return Ok(((exact, String::new()), denial));
    }
    // An empty answer is corrected as ever: a word the vault holds is kept. A thin
    // one found its words, so only the door's filled pass may correct a rare one.
    let principal = centraid_search::Principal::Owner;
    let corrected = if rows(&exact) == 0 {
        search.correct(&principal, entities, term)
    } else {
        search.correct_thin(&principal, entities, term)
    };
    let Ok(Some(words)) = corrected else {
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

// ---------------------------------------------------------------------------
// The door.
// ---------------------------------------------------------------------------

/// [`PageDoor`] over the open vault, through [`Vault::keyset_page`].
pub struct VaultDoor<'v> {
    vault: &'v Vault,
    /// The FIRST failure the vault reported, kept so it is answered as itself
    /// and not as the denial a loader makes of [`KitError::Door`].
    failure: RefCell<Option<CoreError>>,
    /// The physical tables every statement this door ran named in its `FROM`.
    tables: RefCell<BTreeSet<String>>,
}

impl<'v> VaultDoor<'v> {
    #[must_use]
    pub const fn new(vault: &'v Vault) -> Self {
        Self {
            vault,
            failure: RefCell::new(None),
            tables: RefCell::new(BTreeSet::new()),
        }
    }

    /// The tables this door has read so far, taken.
    pub(crate) fn take_tables(&self) -> BTreeSet<String> {
        std::mem::take(&mut self.tables.borrow_mut())
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
        let shape = centraid_domain::grammar::parse(query)?;
        self.tables
            .borrow_mut()
            .extend(shape.tables.into_iter().map(|part| part.physical));
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
            held_thumbnail: query.held_thumbnail,
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
// The conversion: `crates/apps/calendar`'s rows as `agenda.proto` spells them.
// ONE place, so a field that moved is one edit.
// ---------------------------------------------------------------------------
