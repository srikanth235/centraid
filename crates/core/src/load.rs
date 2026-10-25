//! `load(app, query, params)`: THE ONE READ (#1135).
//!
//! A shell, the chat and the training harness name an app's query and state its
//! arguments by name. This module is the core's half of `action.proto`'s
//! `LoadRequest`:
//!
//! 1. the app's manifest must DECLARE the query — the catalogue is the manifest,
//!    so a name it does not list is refused whatever the core could run;
//! 2. [`read`] decodes `params` into the query's typed request, in Rust, and
//!    refuses a parameter the query does not take and one of the wrong type;
//! 3. it then calls the app's own reader (`app_query::<app>::<reader>`) directly
//!    and answers that reader's typed answer, with the tables the door read.
//!
//! THE MANIFEST NAME IS THE ONLY NAME. The readers are keyed by the names the
//! manifests declare (`people.people`, not the arm it runs); the
//! `AppQueryRequest` oneof a screen still sends is not on this path. The test
//! `every_manifest_query_has_a_reader_and_no_reader_lacks_a_manifest_query`
//! holds the two lists to each other, so a manifest that grows a query before the
//! core can read it fails there and, at run time, is refused with that sentence
//! instead of answering nothing.

use std::collections::BTreeSet;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::Vault;

use crate::app_query::{self, VaultDoor};
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
    let manifest = catalog::manifest_of(&request.app).ok_or_else(|| CoreError::InvalidRequest {
        detail: format!("`{}` is not an app this core carries", request.app),
    })?;
    if manifest.query(&request.query).is_none() {
        return Err(CoreError::InvalidRequest {
            detail: format!(
                "app `{}` declares no query `{}`",
                request.app, request.query
            ),
        });
    }
    let mut params = Params::new(request);
    let now = vault.clock().now_text();
    let door = VaultDoor::new(vault);
    let Some(answer) = read(
        vault,
        &door,
        &now,
        &request.app,
        &request.query,
        &mut params,
    )?
    else {
        return Err(CoreError::InvalidRequest {
            detail: format!(
                "app `{}` declares the query `{}` and this core has no reader for it yet",
                request.app, request.query
            ),
        });
    };
    params.finish()?;
    let tables: BTreeSet<String> = door.take_tables();
    Ok(wire::LoadResponse {
        answer: Some(wire::AppQueryResponse {
            answer: Some(answer),
        }),
        tables: tables.into_iter().collect(),
    })
}

/// The reader of a query's arguments. Every read marks the name consumed;
/// [`Params::finish`] refuses any name nothing read.
pub(crate) struct Params<'a> {
    request: &'a wire::LoadRequest,
    pub(crate) read: BTreeSet<&'a str>,
    /// `limit` and `after` ride the request itself, so they are marked here
    /// only when a query takes them.
    pub(crate) limit_taken: bool,
    pub(crate) after_taken: bool,
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

    /// Bytes, as a BLOB; absent is empty.
    pub(crate) fn blob(&mut self, name: &'a str) -> Result<Vec<u8>> {
        match self.value(name).map(|value| &value.kind) {
            None => Ok(Vec::new()),
            Some(Some(wire::value::Kind::Blob(bytes))) => Ok(bytes.clone()),
            Some(_) => Err(self.bad(name, "bytes")),
        }
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

/// Decode one query's arguments and run its reader; `None` when this core has no
/// reader for the name.
///
/// Names are the manifest's, kebab-case, and the only ones: the reader a name
/// runs is the app's own function (`app_query::docs::document` answers
/// `docs.history`), called directly with the typed request the arguments decode
/// to.
#[allow(clippy::too_many_lines)]
fn read(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    app: &str,
    query: &str,
    p: &mut Params<'_>,
) -> Result<Option<wire::app_query_response::Answer>> {
    let tz = p.zone();
    let answer = match (app, query) {
        // The shell's own catalogue (`shell/manifest.json`), no app's.
        ("shell", "search") => app_query::vault::search(
            vault,
            door,
            &wire::VaultSearchRequest {
                term: p.text("term")?,
                tz,
            },
        )?,
        ("agenda", "upcoming") => app_query::agenda_upcoming(
            vault,
            door,
            now,
            &wire::AgendaUpcomingRequest {
                from: p.text("from")?,
                to: p.text("to")?,
                tz,
            },
        )?,
        ("agenda", "day-context") => app_query::agenda_day_context(
            vault,
            door,
            now,
            &wire::AgendaDayContextRequest {
                from: p.text("from")?,
                to: p.text("to")?,
                tz,
            },
        )?,
        ("agenda", "parties") => app_query::agenda_parties(door)?,
        ("agenda", "search") => app_query::agenda_search(
            vault,
            door,
            now,
            &wire::AgendaSearchRequest {
                term: p.text("term")?,
                limit: p.limit(SEARCH_ROWS),
                tz,
            },
        )?,

        ("agenda", "event") => app_query::agenda_event(
            vault,
            door,
            now,
            &wire::AgendaEventRequest {
                event_id: p.text("event_id")?,
                instance_key: p.text("instance_key")?,
                original_start_local: p.text("original_start_local")?,
                tz,
            },
        )?,
        ("agenda", "board") => app_query::agenda_task::board(
            vault,
            door,
            now,
            &wire::TasksBoardRequest {
                tz,
                limit: p.limit(0),
                view: en!(p, "view", "TASKS_VIEW_", wire::TasksView),
                project_id: p.text("project_id")?,
            },
        )?,
        ("agenda", "task") => app_query::agenda_task::task(
            vault,
            door,
            now,
            &wire::TasksTaskRequest {
                task_id: p.text("task_id")?,
                tz,
            },
        )?,
        ("agenda", "projects") => {
            app_query::agenda_task::projects(vault, door, now, &wire::TasksProjectsRequest { tz })?
        }
        ("agenda", "catch-up") => {
            app_query::agenda_task::catch_up(vault, door, now, &wire::TasksCatchUpRequest { tz })?
        }
        ("agenda", "trash") => {
            app_query::agenda_task::trash(vault, door, &wire::TasksTrashRequest { tz })?
        }

        ("docs", "drive") => app_query::docs::drive(
            vault,
            door,
            now,
            &wire::DocsDriveRequest {
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
            },
        )?,
        ("docs", "search") => app_query::docs::search(
            vault,
            door,
            now,
            &wire::DocsSearchRequest {
                term: p.text("term")?,
                limit: p.limit(SEARCH_ROWS),
                tz,
            },
        )?,
        // The document's version chain, with the document, its path and its text.
        ("docs", "history") => app_query::docs::document(
            vault,
            door,
            now,
            &wire::DocsDocumentRequest {
                document_id: p.text("document_id")?,
                tz,
            },
        )?,
        ("docs", "activity") => app_query::docs::activity(
            vault,
            door,
            &wire::DocsActivityRequest {
                document_id: p.text("document_id")?,
                tz,
            },
        )?,

        ("notes", "library") => app_query::notes::library(
            vault,
            door,
            &wire::NotesLibraryRequest {
                window: p.limit(0),
                sort: en!(p, "sort", "NOTES_SORT_", wire::NotesSort),
                pinned_only: p.flag("pinned_only")?,
                notebook_id: p.text("notebook_id")?,
                unfiled_only: p.flag("unfiled_only")?,
                tag_concept_ids: p.list("tag_concept_ids")?,
                tz,
            },
        )?,
        ("notes", "notebooks") => app_query::notes::notebooks(door)?,
        ("notes", "trash") => {
            app_query::notes::trash(vault, door, &wire::NotesTrashRequest { tz })?
        }
        ("notes", "journal") => app_query::notes::journal(
            vault,
            door,
            now,
            &wire::NotesJournalRequest {
                window: p.limit(0),
                tz,
            },
        )?,
        ("notes", "search") => app_query::notes::search(
            vault,
            door,
            &wire::NotesSearchRequest {
                term: p.text("term")?,
                tz,
            },
        )?,
        ("notes", "history") => app_query::notes::history(
            vault,
            door,
            &wire::NotesHistoryRequest {
                note_id: p.text("note_id")?,
                tz,
            },
        )?,
        ("notes", "link-targets") => app_query::notes::link_targets(
            vault,
            door,
            &wire::NotesLinkTargetsRequest {
                term: p.text("term")?,
                tz,
            },
        )?,
        ("notes", "about") => app_query::notes::about(
            vault,
            door,
            &wire::NotesAboutRequest {
                about_id: p.text("about_id")?,
                window: p.limit(0),
                tz,
            },
        )?,
        ("notes", "note") => app_query::notes::note(
            vault,
            door,
            &wire::NotesNoteRequest {
                note_id: p.text("note_id")?,
                tz,
            },
        )?,

        // The roster: the people window.
        ("people", "people") => app_query::people::roster(
            vault,
            door,
            now,
            &wire::PeopleRosterRequest {
                limit: p.limit(0),
                filter: en!(
                    p,
                    "filter",
                    "PEOPLE_ROSTER_FILTER_",
                    wire::PeopleRosterFilter
                ),
                sort: en!(p, "sort", "PEOPLE_ROSTER_SORT_", wire::PeopleRosterSort),
                tz,
            },
        )?,
        // The keep-in-touch summary.
        ("people", "dashboard") => {
            app_query::people::touch(vault, door, now, &wire::PeopleTouchRequest { tz })?
        }
        ("people", "person") => app_query::people::person(
            vault,
            door,
            now,
            &wire::PeoplePersonRequest {
                party_id: p.text("party_id")?,
                tz,
            },
        )?,
        ("people", "search") => app_query::people::search(
            vault,
            door,
            now,
            &wire::PeopleSearchRequest {
                term: p.text("term")?,
                limit: p.limit(SEARCH_ROWS),
                tz,
            },
        )?,
        ("people", "trash") => {
            app_query::people::trash(vault, door, &wire::PeopleTrashRequest { tz })?
        }

        ("locker", "items") => app_query::locker::items(
            vault,
            door,
            now,
            &wire::LockerItemsRequest {
                archived: p.flag("archived")?,
                limit: p.limit(0),
                tz,
            },
        )?,
        ("locker", "item") => app_query::locker::item(
            vault,
            door,
            now,
            &wire::LockerItemRequest {
                item_id: p.text("item_id")?,
                tz,
            },
        )?,
        ("locker", "search") => app_query::locker::search(
            vault,
            door,
            &wire::LockerSearchRequest {
                term: p.text("term")?,
                limit: p.limit(SEARCH_ROWS),
                tz,
            },
        )?,
        // The trash: what is waiting to be purged.
        ("locker", "trash") => {
            app_query::locker::trash(vault, door, &wire::LockerReviewRequest { tz })?
        }
        ("locker", "review") => {
            app_query::locker::review(vault, door, now, &wire::LockerReviewRequest { tz })?
        }
        ("locker", "access") => app_query::locker::access(
            vault,
            door,
            &wire::LockerAccessRequest {
                item_id: p.text("item_id")?,
                limit: p.limit(0),
                tz,
            },
        )?,

        ("photos", "search") => app_query::photos::search(
            vault,
            door,
            now,
            &wire::PhotosSearchRequest {
                term: p.text("term")?,
                limit: p.limit(SEARCH_ROWS),
                correct: p.flag("correct")?,
            },
        )?,
        ("photos", "duplicates") => app_query::photos::duplicates(door, now)?,
        // The screens' reads: one shelf, one photograph, the collections, the places.
        ("photos", "shelf") => app_query::photos::shelf(
            door,
            now,
            &wire::PhotosShelfRequest {
                view: en!(p, "view", "PHOTOS_SHELF_VIEW_", wire::PhotosShelfView),
                id: p.text("id")?,
                limit: p.limit(0),
                after: p
                    .after()?
                    .map(|(sort_key, id)| wire::PhotosCursor { sort_key, id }),
            },
        )?,
        ("photos", "photo") => {
            app_query::photos::photo(door, now, &wire::PhotosPhotoRequest { id: p.text("id")? })?
        }
        ("photos", "albums") => app_query::photos::albums(door, now)?,
        ("photos", "places") => app_query::photos::places(door, now)?,

        ("money", "spending") => app_query::money::spending(
            vault,
            door,
            now,
            &wire::MoneySpendingRequest {
                tz,
                month: p.text("month")?,
            },
        )?,
        ("money", "activity") => app_query::money::activity(
            vault,
            door,
            now,
            &wire::MoneyActivityRequest {
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
            },
        )?,
        ("money", "transaction") => app_query::money::transaction(
            vault,
            door,
            now,
            &wire::MoneyTransactionRequest {
                tz,
                txn_id: p.text("txn_id")?,
            },
        )?,
        ("money", "cashflow") => app_query::money::cashflow(
            vault,
            door,
            now,
            &wire::MoneyCashflowRequest {
                tz,
                through: p.text("through")?,
            },
        )?,
        ("money", "accounts") => {
            app_query::money::accounts(vault, door, now, &wire::MoneyAccountsRequest { tz })?
        }
        ("money", "rules") => app_query::money::rules(door)?,
        ("money", "categories") => app_query::money::categories(door)?,
        ("money", "target-sheet") => app_query::money::target_sheet(
            vault,
            door,
            now,
            &wire::MoneyTargetSheetRequest {
                tz,
                month: p.text("month")?,
                category_id: p.text("category_id")?,
                currency: p.text("currency")?,
                typing_amount_minor: p.opt_int("typing_amount_minor")?,
                typing_carry: p.flag("typing_carry")?,
            },
        )?,
        // The plan a statement would make: read once, dropped, nothing written.
        ("money", "import-plan") => {
            wire::app_query_response::Answer::MoneyImportPlan(app_query::money::import_plan(
                vault,
                &wire::MoneyImportPlanRequest {
                    tz,
                    source: en!(p, "source", "MONEY_SOURCE_", wire::MoneySource),
                    content: p.blob("content")?,
                    account_id: p.opt_text("account_id")?,
                    date_order: en!(p, "date_order", "MONEY_DATE_ORDER_", wire::MoneyDateOrder),
                    sign: en!(p, "sign", "MONEY_SIGN_CHOICE_", wire::MoneySignChoice),
                },
            )?)
        }
        ("money", "home-tile") => {
            wire::app_query_response::Answer::MoneyHomeTile(app_query::money::home_tile(
                vault,
                &wire::MoneyHomeTileRequest {
                    tz,
                    month: p.text("month")?,
                },
            )?)
        }
        ("money", "recurring") => {
            app_query::money::recurring(vault, door, now, &wire::MoneyRecurringRequest { tz })?
        }
        ("money", "search") => app_query::money::search(
            vault,
            door,
            now,
            &wire::MoneySearchRequest {
                tz,
                month: p.text("month")?,
                term: p.text("term")?,
                limit: p.limit(SEARCH_ROWS),
            },
        )?,

        // Health (#1129): no zone and no clock; the request states its day.
        ("health", "today") => {
            app_query::health::today(vault, door, now, &wire::HealthTodayRequest { tz })?
        }
        ("health", "series") => app_query::health::series(
            vault,
            door,
            now,
            &wire::HealthSeriesRequest {
                metric: en!(p, "metric", "HEALTH_METRIC_", wire::HealthMetric),
                range: en!(p, "range", "HEALTH_RANGE_", wire::HealthRange),
                tz,
            },
        )?,
        ("health", "trends") => app_query::health::trends(
            vault,
            door,
            now,
            &wire::HealthTrendsRequest {
                range: en!(p, "range", "HEALTH_TREND_RANGE_", wire::HealthTrendRange),
                tz,
            },
        )?,
        ("health", "workouts") => app_query::health::workouts(
            vault,
            door,
            &wire::HealthWorkoutsRequest {
                kind_concept_id: p.opt_text("kind_concept_id")?,
                limit: p.limit(0),
                after: p
                    .after()?
                    .map(|(started_at, activity_id)| wire::HealthWorkoutsCursor {
                        started_at,
                        activity_id,
                    }),
                tz,
            },
        )?,
        ("health", "workout") => app_query::health::workout(
            vault,
            door,
            &wire::HealthWorkoutRequest {
                activity_id: p.text("activity_id")?,
                tz,
            },
        )?,
        ("health", "follow-view") => {
            app_query::health::follow_view(vault, door, now, &wire::HealthFollowViewRequest { tz })?
        }
        _ => return Ok(None),
    };
    Ok(Some(answer))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(app: &str, query: &str) -> wire::LoadRequest {
        wire::LoadRequest {
            app: app.to_owned(),
            query: query.to_owned(),
            zone: "America/New_York".to_owned(),
            ..wire::LoadRequest::default()
        }
    }

    fn founded() -> (std::path::PathBuf, Vault) {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("made");
        let vault = Vault::create(dir.join("v.db")).expect("a vault");
        vault.found("Load", "Owner").expect("founded");
        (dir, vault)
    }

    /// The eight apps' manifests and the shell's own.
    fn every_manifest() -> Vec<(&'static str, &'static centraid_apps_kit::manifest::Manifest)> {
        let mut all: Vec<_> = catalog::APPS
            .iter()
            .map(|app| (app.id, app.manifest()))
            .collect();
        all.push((crate::shell::APP_ID, crate::shell::manifest()));
        all
    }

    /// What `read` asked of the request: the names, whether it took the limit
    /// and whether it took the cursor, and whether it had a reader at all.
    fn asked_of(
        vault: &Vault,
        request: &wire::LoadRequest,
    ) -> (BTreeSet<String>, bool, bool, bool) {
        let mut params = Params::new(request);
        let door = VaultDoor::new(vault);
        let now = vault.clock().now_text();
        let found = read(
            vault,
            &door,
            &now,
            &request.app,
            &request.query,
            &mut params,
        )
        .map(|answer| answer.is_some())
        // a reader that refuses an empty request still asked its arguments first
        .unwrap_or(true);
        (
            params.read.iter().map(|name| (*name).to_owned()).collect(),
            params.limit_taken,
            params.after_taken,
            found,
        )
    }

    /// THE MANIFEST NAME IS THE ONLY NAME: every query a manifest declares has a
    /// reader, and no reader answers a name no manifest declares.
    #[test]
    fn every_manifest_query_has_a_reader_and_no_reader_lacks_a_manifest_query() {
        let (dir, vault) = founded();
        for (id, manifest) in every_manifest() {
            for query in &manifest.queries {
                let (_, _, _, has_reader) = asked_of(&vault, &ask(id, &query.name));
                assert!(
                    has_reader,
                    "{id}.{} is declared by its manifest and has no reader",
                    query.name
                );
            }
        }
        // The names no manifest declares answer nothing.
        let mut params_request = ask("agenda", "no-such");
        assert!(!asked_of(&vault, &params_request).3);
        params_request.query = "typo".to_owned();
        assert!(!asked_of(&vault, &params_request).3);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A reader's arguments are the manifest's: every argument a reader takes is a
    /// property its query's input schema declares, and every property the schema
    /// declares is one the reader takes (`limit` and `after` ride the request).
    #[test]
    fn a_readers_arguments_are_the_properties_its_manifest_declares() {
        let (dir, vault) = founded();
        let mut wrong = Vec::new();
        for (id, manifest) in every_manifest() {
            for query in &manifest.queries {
                let (names, limit, after, _) = asked_of(&vault, &ask(id, &query.name));
                let mut declared: BTreeSet<String> = query.input["properties"]
                    .as_object()
                    .map(|properties| properties.keys().cloned().collect())
                    .unwrap_or_default();
                // `limit` and `after` ride the request itself: a manifest that declares
                // one needs a reader that takes it, and a reader may take a window
                // (a search's twenty) the manifest leaves to its default.
                for rider in ["limit", "after"] {
                    if declared.remove(rider) {
                        assert!(
                            if rider == "limit" { limit } else { after },
                            "{id}.{} declares `{rider}` and its reader takes none",
                            query.name
                        );
                    }
                }
                if names != declared {
                    wrong.push(format!(
                        "{id}.{}: the reader takes {names:?}, the manifest declares {declared:?}",
                        query.name
                    ));
                }
            }
        }
        let _ = std::fs::remove_dir_all(dir);
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    /// THE SHELL'S CATALOGUE is served by `load` and by nothing else: it answers its
    /// search, refuses a name it does not declare, and is no app (`act` has none).
    #[test]
    fn the_shell_catalogue_answers_the_vault_search_and_is_no_app() {
        let (dir, vault) = founded();
        let mut request = ask("shell", "search");
        request.params.insert(
            "term".to_owned(),
            wire::Value {
                kind: Some(wire::value::Kind::Text("nothing like this".to_owned())),
            },
        );
        let response = load(&vault, &request).expect("a search");
        assert!(matches!(
            response.answer.and_then(|answer| answer.answer),
            Some(wire::app_query_response::Answer::VaultSearch(_))
        ));
        assert!(load(&vault, &ask("shell", "no-such")).is_err());
        assert!(catalog::app("shell").is_none(), "the shell is not an app");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn arguments_are_read_by_name_and_a_stranger_is_refused() {
        let (dir, vault) = founded();
        let mut request = ask("agenda", "board");
        request.limit = 50;
        request.params.insert(
            "view".to_owned(),
            wire::Value {
                kind: Some(wire::value::Kind::Text("today".to_owned())),
            },
        );
        load(&vault, &request).expect("a board");

        request.params.insert(
            "typo".to_owned(),
            wire::Value {
                kind: Some(wire::value::Kind::Integer(1)),
            },
        );
        assert!(matches!(
            load(&vault, &request),
            Err(CoreError::InvalidRequest { detail }) if detail.contains("takes no `typo`")
        ));

        // A limit on a query that takes none, and a wrong type.
        let mut request = ask("agenda", "parties");
        request.limit = 5;
        assert!(load(&vault, &request).is_err());
        let mut request = ask("people", "person");
        request.params.insert(
            "party_id".to_owned(),
            wire::Value {
                kind: Some(wire::value::Kind::Integer(1)),
            },
        );
        assert!(load(&vault, &request).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
