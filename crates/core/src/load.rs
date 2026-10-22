//! `load(app, query, params)`: THE ONE READ (#1135).
//!
//! A shell, the chat and the training harness name an app's query and state its
//! arguments by name. This module is the core's half of `action.proto`'s
//! `LoadRequest`:
//!
//! 1. the app's manifest must DECLARE the query — the catalogue is the manifest,
//!    so a name it does not list is refused whatever the core could run;
//! 2. [`decode`] reads `params` into the query's typed request, in Rust, and
//!    refuses a parameter the query does not take and one of the wrong type;
//! 3. [`crate::app_query`] runs the app's own query and answers its own typed
//!    answer, with the tables the door read.
//!
//! The decode is a table of one arm per query. A query the manifest declares
//! and this table lacks is refused with that sentence, so a manifest that grows
//! a query before the core can read it fails loudly instead of answering
//! nothing.

use std::collections::BTreeSet;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::Vault;
use wire::app_query_request::Query as Q;

use crate::catalog;
use crate::error::{CoreError, Result};

/// A cursor's two halves, joined: the sort key and the primary key. U+001F, the
/// unit separator, cannot occur in either (both are ids or ISO text).
const CURSOR_SEPARATOR: char = '\u{1f}';

/// Run one query against the open vault.
///
/// # Errors
/// [`CoreError::InvalidRequest`] for an app or query the catalogue lacks, a
/// parameter the query does not take, or one of the wrong type; whatever the
/// query itself refuses with.
pub fn load(vault: &Vault, request: &wire::LoadRequest) -> Result<wire::LoadResponse> {
    let app = catalog::app(&request.app).ok_or_else(|| CoreError::InvalidRequest {
        detail: format!("`{}` is not an app this core carries", request.app),
    })?;
    if app.manifest().query(&request.query).is_none() {
        return Err(CoreError::InvalidRequest {
            detail: format!(
                "app `{}` declares no query `{}`",
                request.app, request.query
            ),
        });
    }
    let mut params = Params::new(request);
    let Some(query) = decode(&request.app, &request.query, &mut params)? else {
        return Err(CoreError::InvalidRequest {
            detail: format!(
                "app `{}` declares the query `{}` and this core has no reader for it yet",
                request.app, request.query
            ),
        });
    };
    params.finish()?;
    let mut tables = BTreeSet::new();
    let answer = crate::app_query::answer_recording(
        vault,
        &wire::AppQueryRequest { query: Some(query) },
        &mut tables,
    )?;
    Ok(wire::LoadResponse {
        answer: Some(answer),
        tables: tables.into_iter().collect(),
    })
}

/// The reader of a query's arguments. Every read marks the name consumed;
/// [`Params::finish`] refuses any name nothing read.
pub(crate) struct Params<'a> {
    request: &'a wire::LoadRequest,
    read: BTreeSet<&'a str>,
    /// `limit` and `after` ride the request itself, so they are marked here
    /// only when a query takes them.
    limit_taken: bool,
    after_taken: bool,
}

impl<'a> Params<'a> {
    pub(crate) fn new(request: &'a wire::LoadRequest) -> Self {
        Self {
            request,
            read: BTreeSet::new(),
            limit_taken: false,
            after_taken: false,
        }
    }

    fn bad(&self, name: &str, wanted: &str) -> CoreError {
        CoreError::InvalidRequest {
            detail: format!(
                "`{}.{}` takes `{name}` as {wanted}",
                self.request.app, self.request.query
            ),
        }
    }

    fn value(&mut self, name: &'a str) -> Option<&'a wire::Value> {
        self.read.insert(name);
        self.request
            .params
            .get(name)
            .filter(|value| !matches!(value.kind, Some(wire::value::Kind::Null(_)) | None))
    }

    /// The zone the answer's civil readings are drawn in.
    pub(crate) fn zone(&self) -> String {
        self.request.zone.clone()
    }

    /// The request's `limit`, or `default` when it states none.
    pub(crate) fn limit(&mut self, default: u32) -> u32 {
        self.limit_taken = true;
        if self.request.limit == 0 {
            default
        } else {
            self.request.limit
        }
    }

    /// The request's `after`, split into its two keys.
    pub(crate) fn after(&mut self) -> Result<Option<(String, String)>> {
        self.after_taken = true;
        if self.request.after.is_empty() {
            return Ok(None);
        }
        self.request
            .after
            .split_once(CURSOR_SEPARATOR)
            .map(|(sort_key, pk)| Some((sort_key.to_owned(), pk.to_owned())))
            .ok_or_else(|| CoreError::InvalidRequest {
                detail: format!(
                    "`{}.{}` takes `after` as the sort key and the primary key joined by U+001F",
                    self.request.app, self.request.query
                ),
            })
    }

    /// A string; absent is empty, as proto3 reads it.
    pub(crate) fn text(&mut self, name: &'a str) -> Result<String> {
        Ok(self.opt_text(name)?.unwrap_or_default())
    }

    pub(crate) fn opt_text(&mut self, name: &'a str) -> Result<Option<String>> {
        match self.value(name).map(|value| &value.kind) {
            None => Ok(None),
            Some(Some(wire::value::Kind::Text(text))) => Ok(Some(text.clone())),
            Some(_) => Err(self.bad(name, "text")),
        }
    }

    fn integer(&mut self, name: &'a str) -> Result<Option<i64>> {
        match self.value(name).map(|value| &value.kind) {
            None => Ok(None),
            Some(Some(wire::value::Kind::Integer(number))) => Ok(Some(*number)),
            Some(_) => Err(self.bad(name, "an integer")),
        }
    }

    pub(crate) fn opt_int(&mut self, name: &'a str) -> Result<Option<i64>> {
        self.integer(name)
    }

    /// A boolean, as 0 or 1; absent is false.
    pub(crate) fn flag(&mut self, name: &'a str) -> Result<bool> {
        match self.integer(name)? {
            None | Some(0) => Ok(false),
            Some(1) => Ok(true),
            Some(_) => Err(self.bad(name, "0 or 1")),
        }
    }

    /// A list of strings, as text holding a JSON array; absent is empty.
    pub(crate) fn list(&mut self, name: &'a str) -> Result<Vec<String>> {
        match self.opt_text(name)? {
            None => Ok(Vec::new()),
            Some(text) => serde_json::from_str::<Vec<String>>(&text)
                .map_err(|_| self.bad(name, "a JSON array of text")),
        }
    }

    /// An enum by its proto name (`TASKS_VIEW_TODAY`), by the name after
    /// `prefix` in any case (`today`), or by its number; absent is 0.
    pub(crate) fn enumeration(
        &mut self,
        name: &'a str,
        prefix: &str,
        by_name: fn(&str) -> Option<i32>,
        by_number: fn(i32) -> bool,
    ) -> Result<i32> {
        match self.value(name).map(|value| &value.kind) {
            None => Ok(0),
            Some(Some(wire::value::Kind::Integer(number))) => i32::try_from(*number)
                .ok()
                .filter(|number| by_number(*number))
                .ok_or_else(|| self.bad(name, "a number this enum has")),
            Some(Some(wire::value::Kind::Text(text))) => {
                let upper = text.to_ascii_uppercase().replace('-', "_");
                by_name(&upper)
                    .or_else(|| by_name(&format!("{prefix}{upper}")))
                    .ok_or_else(|| self.bad(name, "a name this enum has"))
            }
            Some(_) => Err(self.bad(name, "an enum name or number")),
        }
    }

    /// Refuse any argument no reader asked for.
    pub(crate) fn finish(&self) -> Result<()> {
        if let Some(unknown) = self
            .request
            .params
            .keys()
            .find(|name| !self.read.contains(name.as_str()))
        {
            return Err(CoreError::InvalidRequest {
                detail: format!(
                    "`{}.{}` takes no `{unknown}`",
                    self.request.app, self.request.query
                ),
            });
        }
        if self.request.limit != 0 && !self.limit_taken {
            return Err(CoreError::InvalidRequest {
                detail: format!(
                    "`{}.{}` takes no `limit`",
                    self.request.app, self.request.query
                ),
            });
        }
        if !self.request.after.is_empty() && !self.after_taken {
            return Err(CoreError::InvalidRequest {
                detail: format!(
                    "`{}.{}` takes no `after`",
                    self.request.app, self.request.query
                ),
            });
        }
        Ok(())
    }
}

/// One enum, spelled for [`Params::enumeration`].
macro_rules! en {
    ($params:ident, $name:literal, $prefix:literal, $enum:ty) => {
        $params.enumeration(
            $name,
            $prefix,
            |text| <$enum>::from_str_name(text).map(|found| found as i32),
            |number| <$enum>::try_from(number).is_ok(),
        )?
    };
}

/// A search's default window.
const SEARCH_ROWS: u32 = 20;

/// The query's typed request, or `None` when this core has no reader for it.
///
/// Names are the manifest's, kebab-case. The arm a name reads is the app
/// query it has always been: this table adds no behaviour, only the reading of
/// arguments by name.
#[allow(clippy::too_many_lines)]
fn decode(app: &str, query: &str, p: &mut Params<'_>) -> Result<Option<Q>> {
    let tz = p.zone();
    let found = match (app, query) {
        ("agenda", "upcoming") => Q::AgendaUpcoming(wire::AgendaUpcomingRequest {
            from: p.text("from")?,
            to: p.text("to")?,
            tz,
        }),
        ("agenda", "day-context") => Q::AgendaDayContext(wire::AgendaDayContextRequest {
            from: p.text("from")?,
            to: p.text("to")?,
            tz,
        }),
        ("agenda", "parties") => Q::AgendaParties(wire::AgendaPartiesRequest {}),
        ("agenda", "search") => Q::AgendaSearch(wire::AgendaSearchRequest {
            term: p.text("term")?,
            limit: p.limit(SEARCH_ROWS),
            tz,
        }),
        ("agenda", "event") => Q::AgendaEvent(wire::AgendaEventRequest {
            event_id: p.text("event_id")?,
            instance_key: p.text("instance_key")?,
            original_start_local: p.text("original_start_local")?,
            tz,
        }),

        ("tasks", "board") => Q::TasksBoard(wire::TasksBoardRequest {
            tz,
            limit: p.limit(0),
            view: en!(p, "view", "TASKS_VIEW_", wire::TasksView),
            project_id: p.text("project_id")?,
        }),
        ("tasks", "task") => Q::TasksTask(wire::TasksTaskRequest {
            task_id: p.text("task_id")?,
            tz,
        }),
        ("tasks", "projects") => Q::TasksProjects(wire::TasksProjectsRequest { tz }),
        ("tasks", "search") => Q::TasksSearch(wire::TasksSearchRequest {
            term: p.text("term")?,
            limit: p.limit(SEARCH_ROWS),
            tz,
        }),
        ("tasks", "catch-up") => Q::TasksCatchUp(wire::TasksCatchUpRequest { tz }),
        ("tasks", "trash") => Q::TasksTrash(wire::TasksTrashRequest { tz }),

        ("docs", "drive") => Q::DocsDrive(wire::DocsDriveRequest {
            shelf: en!(p, "shelf", "DOCS_SHELF_", wire::DocsShelf),
            folder_id: p.text("folder_id")?,
            r#type: en!(p, "type", "DOCS_TYPE_FILTER_", wire::DocsTypeFilter),
            modified: en!(
                p,
                "modified",
                "DOCS_MODIFIED_FILTER_",
                wire::DocsModifiedFilter
            ),
            label: p.text("label")?,
            sort: en!(p, "sort", "DOCS_SORT_", wire::DocsSort),
            ascending: p.flag("ascending")?,
            limit: p.limit(0),
            tz,
        }),
        ("docs", "search") => Q::DocsSearch(wire::DocsSearchRequest {
            term: p.text("term")?,
            limit: p.limit(SEARCH_ROWS),
            tz,
        }),
        ("docs", "document") => Q::DocsDocument(wire::DocsDocumentRequest {
            document_id: p.text("document_id")?,
            tz,
        }),
        ("docs", "activity") => Q::DocsActivity(wire::DocsActivityRequest {
            document_id: p.text("document_id")?,
            tz,
        }),

        ("notes", "library") => Q::NotesLibrary(wire::NotesLibraryRequest {
            window: p.limit(0),
            sort: en!(p, "sort", "NOTES_SORT_", wire::NotesSort),
            pinned_only: p.flag("pinned_only")?,
            notebook_id: p.text("notebook_id")?,
            unfiled_only: p.flag("unfiled_only")?,
            tag_concept_ids: p.list("tag_concept_ids")?,
            tz,
        }),
        ("notes", "notebooks") => Q::NotesNotebooks(wire::NotesNotebooksRequest {}),
        ("notes", "journal") => Q::NotesJournal(wire::NotesJournalRequest {
            window: p.limit(0),
            tz,
        }),
        ("notes", "search") => Q::NotesSearch(wire::NotesSearchRequest {
            term: p.text("term")?,
            tz,
        }),
        ("notes", "trash") => Q::NotesTrash(wire::NotesTrashRequest { tz }),
        ("notes", "history") => Q::NotesHistory(wire::NotesHistoryRequest {
            note_id: p.text("note_id")?,
            tz,
        }),
        ("notes", "link-targets") => Q::NotesLinkTargets(wire::NotesLinkTargetsRequest {
            term: p.text("term")?,
            tz,
        }),
        ("notes", "note") => Q::NotesNote(wire::NotesNoteRequest {
            note_id: p.text("note_id")?,
            tz,
        }),

        ("people", "roster") => Q::PeopleRoster(wire::PeopleRosterRequest {
            limit: p.limit(0),
            filter: en!(
                p,
                "filter",
                "PEOPLE_ROSTER_FILTER_",
                wire::PeopleRosterFilter
            ),
            sort: en!(p, "sort", "PEOPLE_ROSTER_SORT_", wire::PeopleRosterSort),
            tz,
        }),
        ("people", "touch") => Q::PeopleTouch(wire::PeopleTouchRequest { tz }),
        ("people", "person") => Q::PeoplePerson(wire::PeoplePersonRequest {
            party_id: p.text("party_id")?,
            tz,
        }),
        ("people", "search") => Q::PeopleSearch(wire::PeopleSearchRequest {
            term: p.text("term")?,
            limit: p.limit(SEARCH_ROWS),
            tz,
        }),
        ("people", "trash") => Q::PeopleTrash(wire::PeopleTrashRequest { tz }),

        ("locker", "items") => Q::LockerItems(wire::LockerItemsRequest {
            archived: p.flag("archived")?,
            limit: p.limit(0),
            tz,
        }),
        ("locker", "item") => Q::LockerItem(wire::LockerItemRequest {
            item_id: p.text("item_id")?,
            tz,
        }),
        ("locker", "search") => Q::LockerSearch(wire::LockerSearchRequest {
            term: p.text("term")?,
            limit: p.limit(SEARCH_ROWS),
            tz,
        }),
        ("locker", "review") => Q::LockerReview(wire::LockerReviewRequest { tz }),
        ("locker", "access") => Q::LockerAccess(wire::LockerAccessRequest {
            item_id: p.text("item_id")?,
            limit: p.limit(0),
            tz,
        }),

        ("photos", "search") => Q::PhotosSearch(wire::PhotosSearchRequest {
            term: p.text("term")?,
            limit: p.limit(SEARCH_ROWS),
            correct: p.flag("correct")?,
        }),
        ("photos", "duplicates") => Q::PhotosDuplicates(wire::PhotosDuplicatesRequest {}),

        ("money", "spending") => Q::MoneySpending(wire::MoneySpendingRequest {
            tz,
            month: p.text("month")?,
        }),
        ("money", "activity") => Q::MoneyActivity(wire::MoneyActivityRequest {
            tz,
            month: p.text("month")?,
            account_id: p.opt_text("account_id")?,
            category_filter: en!(
                p,
                "category_filter",
                "MONEY_CATEGORY_FILTER_",
                wire::MoneyCategoryFilter
            ),
            category_id: p.text("category_id")?,
            limit: p.limit(0),
            after: p
                .after()?
                .map(|(sort_key, pk)| wire::MoneyCursor { sort_key, pk }),
        }),
        ("money", "transaction") => Q::MoneyTransaction(wire::MoneyTransactionRequest {
            tz,
            txn_id: p.text("txn_id")?,
        }),
        ("money", "cashflow") => Q::MoneyCashflow(wire::MoneyCashflowRequest {
            tz,
            through: p.text("through")?,
        }),
        ("money", "accounts") => Q::MoneyAccounts(wire::MoneyAccountsRequest { tz }),
        ("money", "rules") => Q::MoneyRules(wire::MoneyRulesRequest {}),
        ("money", "categories") => Q::MoneyCategories(wire::MoneyCategoriesRequest {}),
        ("money", "target-sheet") => Q::MoneyTargetSheet(wire::MoneyTargetSheetRequest {
            tz,
            month: p.text("month")?,
            category_id: p.text("category_id")?,
            currency: p.text("currency")?,
            typing_amount_minor: p.opt_int("typing_amount_minor")?,
            typing_carry: p.flag("typing_carry")?,
        }),
        ("money", "recurring") => Q::MoneyRecurring(wire::MoneyRecurringRequest { tz }),
        ("money", "search") => Q::MoneySearch(wire::MoneySearchRequest {
            tz,
            month: p.text("month")?,
            term: p.text("term")?,
            limit: p.limit(SEARCH_ROWS),
        }),

        ("health", "today") => Q::HealthToday(wire::HealthTodayRequest { tz }),
        ("health", "series") => Q::HealthSeries(wire::HealthSeriesRequest {
            metric: en!(p, "metric", "HEALTH_METRIC_", wire::HealthMetric),
            range: en!(p, "range", "HEALTH_RANGE_", wire::HealthRange),
            tz,
        }),
        ("health", "trends") => Q::HealthTrends(wire::HealthTrendsRequest {
            range: en!(p, "range", "HEALTH_TREND_RANGE_", wire::HealthTrendRange),
            tz,
        }),
        ("health", "workouts") => Q::HealthWorkouts(wire::HealthWorkoutsRequest {
            kind_concept_id: p.opt_text("kind_concept_id")?,
            limit: p.limit(0),
            after: p
                .after()?
                .map(|(started_at, activity_id)| wire::HealthWorkoutsCursor {
                    started_at,
                    activity_id,
                }),
            tz,
        }),
        ("health", "workout") => Q::HealthWorkout(wire::HealthWorkoutRequest {
            activity_id: p.text("activity_id")?,
            tz,
        }),
        ("health", "follow-view") => Q::HealthFollowView(wire::HealthFollowViewRequest { tz }),
        _ => return Ok(None),
    };
    Ok(Some(found))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every `(app, query)` [`decode`] has an arm for.
    const KNOWN: &[(&str, &str)] = &[
        ("agenda", "upcoming"),
        ("agenda", "day-context"),
        ("agenda", "parties"),
        ("agenda", "search"),
        ("agenda", "event"),
        ("tasks", "board"),
        ("tasks", "task"),
        ("tasks", "projects"),
        ("tasks", "search"),
        ("tasks", "catch-up"),
        ("tasks", "trash"),
        ("docs", "drive"),
        ("docs", "search"),
        ("docs", "document"),
        ("docs", "activity"),
        ("notes", "library"),
        ("notes", "notebooks"),
        ("notes", "journal"),
        ("notes", "search"),
        ("notes", "trash"),
        ("notes", "history"),
        ("notes", "link-targets"),
        ("notes", "note"),
        ("people", "roster"),
        ("people", "touch"),
        ("people", "person"),
        ("people", "search"),
        ("people", "trash"),
        ("locker", "items"),
        ("locker", "item"),
        ("locker", "search"),
        ("locker", "review"),
        ("locker", "access"),
        ("photos", "search"),
        ("photos", "duplicates"),
        ("money", "spending"),
        ("money", "activity"),
        ("money", "transaction"),
        ("money", "cashflow"),
        ("money", "accounts"),
        ("money", "rules"),
        ("money", "categories"),
        ("money", "target-sheet"),
        ("money", "recurring"),
        ("money", "search"),
        ("health", "today"),
        ("health", "series"),
        ("health", "trends"),
        ("health", "workouts"),
        ("health", "workout"),
        ("health", "follow-view"),
    ];

    fn ask(app: &str, query: &str) -> wire::LoadRequest {
        wire::LoadRequest {
            app: app.to_owned(),
            query: query.to_owned(),
            zone: "America/New_York".to_owned(),
            ..wire::LoadRequest::default()
        }
    }

    #[test]
    fn every_known_arm_decodes_and_nothing_else_does() {
        for (app, query) in KNOWN.iter() {
            let request = ask(app, query);
            let mut params = Params::new(&request);
            assert!(
                decode(app, query, &mut params)
                    .unwrap_or_else(|error| panic!("{app}.{query}: {error}"))
                    .is_some(),
                "{app}.{query} has no arm"
            );
        }
        let request = ask("agenda", "nothing");
        assert!(
            decode("agenda", "nothing", &mut Params::new(&request))
                .expect("no error")
                .is_none()
        );
    }

    #[test]
    fn arguments_are_read_by_name_and_a_stranger_is_refused() {
        let mut request = ask("tasks", "board");
        request.limit = 50;
        request.params.insert(
            "view".to_owned(),
            wire::Value {
                kind: Some(wire::value::Kind::Text("today".to_owned())),
            },
        );
        let mut params = Params::new(&request);
        let Some(Q::TasksBoard(board)) = decode("tasks", "board", &mut params).expect("decodes")
        else {
            panic!("a board");
        };
        assert_eq!(board.view, wire::TasksView::Today as i32);
        assert_eq!(board.limit, 50);
        assert_eq!(board.tz, "America/New_York");
        params.finish().expect("everything was read");

        request.params.insert(
            "typo".to_owned(),
            wire::Value {
                kind: Some(wire::value::Kind::Integer(1)),
            },
        );
        let mut params = Params::new(&request);
        decode("tasks", "board", &mut params).expect("decodes");
        assert!(matches!(
            params.finish(),
            Err(CoreError::InvalidRequest { detail }) if detail.contains("takes no `typo`")
        ));

        // A limit on a query that takes none, and a wrong type.
        let mut request = ask("agenda", "parties");
        request.limit = 5;
        let mut params = Params::new(&request);
        decode("agenda", "parties", &mut params).expect("decodes");
        assert!(params.finish().is_err());
        let mut request = ask("tasks", "task");
        request.params.insert(
            "task_id".to_owned(),
            wire::Value {
                kind: Some(wire::value::Kind::Integer(1)),
            },
        );
        assert!(decode("tasks", "task", &mut Params::new(&request)).is_err());
    }
}
