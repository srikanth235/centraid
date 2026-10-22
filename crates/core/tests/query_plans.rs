//! The plan regression (#1135): what SQLite will do for every read the apps hold,
//! over a year-3 vault, asked before anybody times it.
//!
//! A read that is fast over a few hundred rows and a scan of a table over a
//! year-three vault is found by a timing only after it has shipped and the corpus
//! has grown. `EXPLAIN QUERY PLAN` says it at once, so this test plans every
//! statement the product reads with, on the vault `search_budget` measures, and
//! fails on
//!
//! * **a full scan** (`SCAN <table>` with no index) of a table holding more than
//!   `scanFloorRows` rows, and
//! * **a sort after the read** (`USE TEMP B-TREE FOR ORDER BY`) on a paged read,
//!   which means the page cannot stop at its limit,
//!
//! unless the statement is in `contracts/ledgers/query-plans.json` with its home
//! and its reason. The ledger is down-only: its counts can fall and cannot rise,
//! and an entry nothing needs any more is itself a failure.
//!
//! ## What is planned
//!
//! **(a) Every page an app reads, as the vault composes it.** An app's read is a
//! `PageQuery` held as data; it becomes SQL in `Vault::keyset_page`, and only
//! there. So the sweep asks every `AppQuery` the core answers (with each filter,
//! sort and shelf that changes the statement) while the vault is tapped
//! (`Vault::tap_pages`), then plans what the tap kept. The `match` in
//! [`covers`] has no wildcard arm: a query added to the wire is a compile error
//! here until it is asked.
//!
//! **(b) Every hand-written `SELECT` and `WITH` in `crates/{vault,apps/kit,search,
//! ontology}/src`**, read from the source text and planned against the same vault
//! when SQLite can prepare it. A statement with a `format!` hole is a fragment
//! (its composed form is reached by (a)); one that will not prepare is counted
//! and named in the log, not skipped silently.
//!
//! The vault is closed and reopened before it is planned, as a phone's is: SQLite
//! learns the statistics of the tables a session read when the file closes, and a
//! plan taken on a vault founded a moment ago is a plan of a vault no member has.

mod year3_corpus;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use centraid_core::api_proto as wire;
use centraid_vault::plans::{full_scans, reads_big_table, sorts_after_read, statements_in_source};
use wire::app_query_request::Query as Q;

const TZ: &str = "America/Los_Angeles";

/// A name for each query on the wire, and a compile error when one is added.
///
/// Add the new query to [`requests`] when this stops compiling: the sweep is
/// only as wide as the list it asks.
fn covers(query: &Q) -> &'static str {
    match query {
        Q::AgendaUpcoming(_) => "agenda.upcoming",
        Q::AgendaDayContext(_) => "agenda.day_context",
        Q::AgendaParties(_) => "agenda.parties",
        Q::AgendaSearch(_) => "agenda.search",
        Q::AgendaEvent(_) => "agenda.event",
        Q::TasksBoard(_) => "tasks.board",
        Q::TasksTask(_) => "tasks.task",
        Q::TasksProjects(_) => "tasks.projects",
        Q::TasksSearch(_) => "tasks.search",
        Q::TasksCatchUp(_) => "tasks.catch_up",
        Q::TasksTrash(_) => "tasks.trash",
        Q::DocsDrive(_) => "docs.drive",
        Q::DocsSearch(_) => "docs.search",
        Q::DocsDocument(_) => "docs.document",
        Q::DocsActivity(_) => "docs.activity",
        Q::NotesLibrary(_) => "notes.library",
        Q::NotesNotebooks(_) => "notes.notebooks",
        Q::NotesJournal(_) => "notes.journal",
        Q::NotesSearch(_) => "notes.search",
        Q::NotesTrash(_) => "notes.trash",
        Q::NotesHistory(_) => "notes.history",
        Q::NotesLinkTargets(_) => "notes.link_targets",
        Q::NotesNote(_) => "notes.note",
        Q::PeopleRoster(_) => "people.roster",
        Q::PeopleTouch(_) => "people.touch",
        Q::PeoplePerson(_) => "people.person",
        Q::PeopleSearch(_) => "people.search",
        Q::PeopleTrash(_) => "people.trash",
        Q::LockerItems(_) => "locker.items",
        Q::LockerItem(_) => "locker.item",
        Q::LockerSearch(_) => "locker.search",
        Q::LockerReview(_) => "locker.review",
        Q::LockerAccess(_) => "locker.access",
        Q::ChatThreads(_) => "chat.threads",
        Q::ChatThread(_) => "chat.thread",
        Q::ChatCard(_) => "chat.card",
        Q::VaultSearch(_) => "vault.search",
        Q::PhotosSearch(_) => "photos.search",
        Q::PhotosDuplicates(_) => "photos.duplicates",
        Q::MoneySpending(_) => "money.spending",
        Q::MoneyActivity(_) => "money.activity",
        Q::MoneyTransaction(_) => "money.transaction",
        Q::MoneyCashflow(_) => "money.cashflow",
        Q::MoneyAccounts(_) => "money.accounts",
        Q::MoneyRules(_) => "money.rules",
        Q::MoneyCategories(_) => "money.categories",
        Q::MoneyTargetSheet(_) => "money.target_sheet",
        Q::MoneyRecurring(_) => "money.recurring",
        Q::MoneySearch(_) => "money.search",
        Q::HealthToday(_) => "health.today",
        Q::HealthSeries(_) => "health.series",
        Q::HealthTrends(_) => "health.trends",
        Q::HealthWorkouts(_) => "health.workouts",
        Q::HealthWorkout(_) => "health.workout",
        Q::HealthFollowView(_) => "health.follow_view",
    }
}

/// Every query on the wire, in each shape that changes the statement it runs:
/// each shelf, view, sort and filter a screen offers, and a term of each kind.
#[allow(clippy::too_many_lines)]
fn requests(word: &str) -> Vec<Q> {
    let tz = || TZ.to_owned();
    let word = word.to_owned();
    let some = |prefix: &str| format!("{prefix}-000100");
    let mut asked = vec![
        Q::AgendaUpcoming(wire::AgendaUpcomingRequest {
            from: "2025-01-01".to_owned(),
            to: "2025-03-01".to_owned(),
            tz: tz(),
        }),
        Q::AgendaUpcoming(wire::AgendaUpcomingRequest {
            tz: tz(),
            ..Default::default()
        }),
        Q::AgendaDayContext(wire::AgendaDayContextRequest {
            from: "2025-06-01".to_owned(),
            to: "2025-06-08".to_owned(),
            tz: tz(),
        }),
        Q::AgendaParties(wire::AgendaPartiesRequest {}),
        Q::AgendaSearch(wire::AgendaSearchRequest {
            term: word.clone(),
            limit: 50,
            tz: tz(),
        }),
        Q::AgendaEvent(wire::AgendaEventRequest {
            event_id: some("event"),
            tz: tz(),
            ..Default::default()
        }),
        Q::TasksTask(wire::TasksTaskRequest {
            task_id: some("task"),
            tz: tz(),
        }),
        Q::TasksProjects(wire::TasksProjectsRequest { tz: tz() }),
        Q::TasksSearch(wire::TasksSearchRequest {
            term: word.clone(),
            limit: 50,
            tz: tz(),
        }),
        Q::TasksCatchUp(wire::TasksCatchUpRequest { tz: tz() }),
        Q::TasksTrash(wire::TasksTrashRequest { tz: tz() }),
        Q::DocsSearch(wire::DocsSearchRequest {
            term: word.clone(),
            limit: 50,
            tz: tz(),
        }),
        Q::DocsDocument(wire::DocsDocumentRequest {
            document_id: some("document"),
            tz: tz(),
        }),
        Q::DocsActivity(wire::DocsActivityRequest {
            document_id: some("document"),
            tz: tz(),
        }),
        Q::NotesNotebooks(wire::NotesNotebooksRequest {}),
        Q::NotesJournal(wire::NotesJournalRequest {
            window: 100,
            tz: tz(),
        }),
        Q::NotesSearch(wire::NotesSearchRequest {
            term: word.clone(),
            tz: tz(),
        }),
        Q::NotesTrash(wire::NotesTrashRequest { tz: tz() }),
        Q::NotesHistory(wire::NotesHistoryRequest {
            note_id: some("note"),
            tz: tz(),
        }),
        Q::NotesLinkTargets(wire::NotesLinkTargetsRequest {
            term: word.clone(),
            tz: tz(),
        }),
        Q::NotesNote(wire::NotesNoteRequest {
            note_id: some("note"),
            tz: tz(),
        }),
        Q::PeopleTouch(wire::PeopleTouchRequest { tz: tz() }),
        Q::PeoplePerson(wire::PeoplePersonRequest {
            party_id: some("person"),
            tz: tz(),
        }),
        Q::PeopleSearch(wire::PeopleSearchRequest {
            term: word.clone(),
            limit: 50,
            tz: tz(),
        }),
        Q::PeopleTrash(wire::PeopleTrashRequest { tz: tz() }),
        Q::LockerItem(wire::LockerItemRequest {
            item_id: some("locker"),
            tz: tz(),
        }),
        Q::LockerSearch(wire::LockerSearchRequest {
            term: word.clone(),
            limit: 50,
            tz: tz(),
        }),
        Q::LockerReview(wire::LockerReviewRequest { tz: tz() }),
        Q::LockerAccess(wire::LockerAccessRequest {
            item_id: some("locker"),
            limit: 50,
            tz: tz(),
        }),
        Q::LockerAccess(wire::LockerAccessRequest {
            limit: 50,
            tz: tz(),
            ..Default::default()
        }),
        Q::ChatThreads(wire::ChatThreadsRequest {
            limit: 50,
            term: String::new(),
        }),
        Q::ChatThreads(wire::ChatThreadsRequest {
            limit: 50,
            term: word.clone(),
        }),
        Q::ChatThread(wire::ChatThreadRequest {
            thread_id: some("thread"),
        }),
        Q::ChatCard(wire::ChatCardRequest {
            app: "notes".to_owned(),
            entity: "note".to_owned(),
            id: some("note"),
        }),
        Q::ChatCard(wire::ChatCardRequest {
            app: "photos".to_owned(),
            entity: "photo".to_owned(),
            id: some("photo"),
        }),
        Q::VaultSearch(wire::VaultSearchRequest {
            term: word.clone(),
            tz: tz(),
        }),
        Q::PhotosSearch(wire::PhotosSearchRequest {
            term: word.clone(),
            limit: 50,
            correct: true,
        }),
        Q::PhotosDuplicates(wire::PhotosDuplicatesRequest {}),
        Q::MoneySpending(wire::MoneySpendingRequest {
            tz: tz(),
            month: "2025-06".to_owned(),
        }),
        Q::MoneyTransaction(wire::MoneyTransactionRequest {
            tz: tz(),
            txn_id: some("txn"),
        }),
        Q::MoneyCashflow(wire::MoneyCashflowRequest {
            tz: tz(),
            through: "2026-06".to_owned(),
        }),
        Q::MoneyAccounts(wire::MoneyAccountsRequest { tz: tz() }),
        Q::MoneyRules(wire::MoneyRulesRequest {}),
        Q::MoneyCategories(wire::MoneyCategoriesRequest {}),
        Q::MoneyTargetSheet(wire::MoneyTargetSheetRequest {
            tz: tz(),
            month: "2025-06".to_owned(),
            category_id: some("category"),
            currency: "USD".to_owned(),
            ..Default::default()
        }),
        Q::MoneyRecurring(wire::MoneyRecurringRequest { tz: tz() }),
        Q::MoneySearch(wire::MoneySearchRequest {
            tz: tz(),
            month: String::new(),
            term: word.clone(),
            limit: 50,
        }),
        Q::HealthToday(wire::HealthTodayRequest { tz: tz() }),
        Q::HealthTrends(wire::HealthTrendsRequest {
            range: wire::HealthTrendRange::Days30 as i32,
            tz: tz(),
        }),
        Q::HealthTrends(wire::HealthTrendsRequest {
            range: wire::HealthTrendRange::Year as i32,
            tz: tz(),
        }),
        Q::HealthWorkouts(wire::HealthWorkoutsRequest {
            limit: 50,
            tz: tz(),
            ..Default::default()
        }),
        Q::HealthWorkout(wire::HealthWorkoutRequest {
            activity_id: some("activity"),
            tz: tz(),
        }),
        Q::HealthFollowView(wire::HealthFollowViewRequest { tz: tz() }),
    ];
    for view in [
        wire::TasksView::Today,
        wire::TasksView::Upcoming,
        wire::TasksView::Inbox,
        wire::TasksView::Anytime,
        wire::TasksView::All,
        wire::TasksView::Logbook,
    ] {
        for project in [String::new(), "project-000001".to_owned()] {
            asked.push(Q::TasksBoard(wire::TasksBoardRequest {
                tz: tz(),
                limit: 100,
                view: view as i32,
                project_id: project,
            }));
        }
    }
    for shelf in [
        wire::DocsShelf::All,
        wire::DocsShelf::Folder,
        wire::DocsShelf::Starred,
        wire::DocsShelf::Recent,
        wire::DocsShelf::Trash,
    ] {
        for sort in [
            wire::DocsSort::Changed,
            wire::DocsSort::Name,
            wire::DocsSort::Kind,
            wire::DocsSort::Size,
        ] {
            asked.push(Q::DocsDrive(wire::DocsDriveRequest {
                shelf: shelf as i32,
                folder_id: "folder-000001".to_owned(),
                sort: sort as i32,
                ascending: sort == wire::DocsSort::Name,
                limit: 100,
                tz: tz(),
                ..Default::default()
            }));
        }
    }
    asked.push(Q::DocsDrive(wire::DocsDriveRequest {
        shelf: wire::DocsShelf::All as i32,
        r#type: wire::DocsTypeFilter::Pdf as i32,
        modified: wire::DocsModifiedFilter::Last30Days as i32,
        label: "tag-000001".to_owned(),
        limit: 100,
        tz: tz(),
        ..Default::default()
    }));
    for sort in [
        wire::NotesSort::Updated,
        wire::NotesSort::Created,
        wire::NotesSort::Title,
    ] {
        asked.push(Q::NotesLibrary(wire::NotesLibraryRequest {
            window: 500,
            sort: sort as i32,
            tz: tz(),
            ..Default::default()
        }));
    }
    asked.push(Q::NotesLibrary(wire::NotesLibraryRequest {
        window: 500,
        pinned_only: true,
        tz: tz(),
        ..Default::default()
    }));
    asked.push(Q::NotesLibrary(wire::NotesLibraryRequest {
        window: 500,
        notebook_id: "notebook-000001".to_owned(),
        tz: tz(),
        ..Default::default()
    }));
    asked.push(Q::NotesLibrary(wire::NotesLibraryRequest {
        window: 500,
        unfiled_only: true,
        tz: tz(),
        ..Default::default()
    }));
    asked.push(Q::NotesLibrary(wire::NotesLibraryRequest {
        window: 500,
        tag_concept_ids: vec!["tag-000001".to_owned(), "tag-000002".to_owned()],
        tz: tz(),
        ..Default::default()
    }));
    for filter in [
        wire::PeopleRosterFilter::All,
        wire::PeopleRosterFilter::Starred,
        wire::PeopleRosterFilter::Due,
    ] {
        for sort in [wire::PeopleRosterSort::Recent, wire::PeopleRosterSort::Name] {
            asked.push(Q::PeopleRoster(wire::PeopleRosterRequest {
                limit: 100,
                filter: filter as i32,
                sort: sort as i32,
                tz: tz(),
            }));
        }
    }
    asked.push(Q::LockerItems(wire::LockerItemsRequest {
        archived: false,
        limit: 100,
        tz: tz(),
    }));
    asked.push(Q::LockerItems(wire::LockerItemsRequest {
        archived: true,
        limit: 100,
        tz: tz(),
    }));
    for (account, filter, category) in [
        (None, wire::MoneyCategoryFilter::Any, ""),
        (
            Some("account-000001".to_owned()),
            wire::MoneyCategoryFilter::Any,
            "",
        ),
        (None, wire::MoneyCategoryFilter::Uncategorised, ""),
        (None, wire::MoneyCategoryFilter::Is, "category-000001"),
    ] {
        asked.push(Q::MoneyActivity(wire::MoneyActivityRequest {
            tz: tz(),
            month: "2025-06".to_owned(),
            account_id: account,
            category_filter: filter as i32,
            category_id: category.to_owned(),
            limit: 100,
            after: None,
        }));
    }
    for metric in [
        wire::HealthMetric::Steps,
        wire::HealthMetric::SleepMin,
        wire::HealthMetric::ActiveEnergyKcal,
        wire::HealthMetric::ExerciseMin,
        wire::HealthMetric::RestingHrBpm,
        wire::HealthMetric::WeightKg,
    ] {
        for range in [
            wire::HealthRange::Week,
            wire::HealthRange::Month,
            wire::HealthRange::Year,
        ] {
            asked.push(Q::HealthSeries(wire::HealthSeriesRequest {
                metric: metric as i32,
                range: range as i32,
                tz: tz(),
            }));
        }
    }
    asked
}

/// One finding of a sweep, by the statement's identity in the ledger.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Finding {
    /// `page` or `statement`.
    kind: &'static str,
    /// A page's spec name, or a statement's source file.
    home: String,
    /// The statement on one line, cut to its first 110 characters.
    statement: String,
    problem: String,
    /// What SQLite said it would do, for whoever reads the failure.
    plan: Vec<String>,
}

fn cut(text: &str) -> String {
    text.chars().take(120).collect()
}

/// Every `.rs` file under `dir`, skipping what is test support rather than
/// product: generators, the tests' own module files and the binaries.
fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name == "bin") {
                continue;
            }
            sources(&path, out);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            if matches!(
                name,
                "fixtures.rs" | "search_corpus.rs" | "testdoor.rs" | "scratch.rs"
            ) || name.ends_with("_tests.rs")
                || name == "tests.rs"
            {
                continue;
            }
            out.push(path);
        }
    }
}

/// A source file without its trailing `#[cfg(test)]` module.
fn product_part(source: &str) -> &str {
    source
        .find("#[cfg(test)]")
        .map_or(source, |at| &source[..at])
}

#[derive(serde::Deserialize)]
struct Ledger {
    #[serde(rename = "scanFloorRows")]
    scan_floor_rows: i64,
    pages: Allowed,
    statements: Allowed,
}

#[derive(serde::Deserialize)]
struct Allowed {
    allowed: usize,
    entries: Vec<Entry>,
}

#[derive(serde::Deserialize)]
struct Entry {
    home: String,
    #[serde(default)]
    statement: String,
    reason: String,
}

impl Entry {
    fn names(&self, finding: &Finding) -> bool {
        self.home == finding.home && finding.statement.starts_with(&self.statement)
    }
}

fn ledger() -> Ledger {
    let path = centraid_ontology::scratch::repo_root().join("contracts/ledgers/query-plans.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is committed: {error}", path.display()));
    serde_json::from_str(&text).expect("the ledger reads")
}

#[test]
fn every_read_plans_without_a_table_scan_or_a_sort_unless_the_ledger_says_why() {
    let ledger = ledger();
    let mut corpus = year3_corpus::found_rows();
    let word = corpus.counts.word_held_by(None, 40, 5).to_owned();
    let asked = requests(&word);

    // The vault a phone has: every query asked once and the file closed, so
    // SQLite has the statistics of what was read.
    let mut failed = Vec::new();
    for query in &asked {
        if let Err(error) = ask(&corpus.handle, query.clone()) {
            failed.push(format!("{}: {error}", covers(query)));
        }
    }
    corpus.reopen();

    // The tap is the vault's; the asking is the handle's, which takes the same
    // lock, so the tap is started and read outside the asking.
    corpus
        .handle
        .with_vault(|vault| {
            vault.tap_pages();
            Ok(())
        })
        .expect("the tap starts");
    let mut names = BTreeSet::new();
    for query in &asked {
        names.insert(covers(query));
        if let Err(error) = ask(&corpus.handle, query.clone()) {
            failed.push(format!("{} (again): {error}", covers(query)));
        }
    }
    let tapped = corpus
        .handle
        .with_vault(|vault| Ok(vault.take_tapped_pages()))
        .expect("the tap is read");

    corpus
        .handle
        .with_vault(|vault| {
            let rows = vault.table_rows()?;
            let big: BTreeSet<String> = rows
                .iter()
                .filter(|(_, count)| **count > ledger.scan_floor_rows)
                .map(|(table, _)| table.clone())
                .collect();
            println!(
                "query plans — {} entities; {} tables hold more than {} rows: {}",
                corpus.counts.entities,
                big.len(),
                ledger.scan_floor_rows,
                big.iter().cloned().collect::<Vec<_>>().join(", ")
            );

            let mut findings: BTreeSet<Finding> = BTreeSet::new();

            // (a) the pages the apps read, as the vault composes them.
            let mut seen = BTreeSet::new();
            let mut distinct = 0usize;
            for page in &tapped {
                if !seen.insert(page.page.sql.clone()) {
                    continue;
                }
                distinct += 1;
                let plan = vault.explain_query_plan(&page.page.sql, &page.page.binds)?;
                for table in full_scans(&plan, &page.page.sql, &big) {
                    findings.insert(Finding {
                        kind: "page",
                        home: page.name.clone(),
                        statement: cut(&normalized(&page.page.sql)),
                        problem: format!("reads all of `{table}`"),
                        plan: plan.clone(),
                    });
                }
                if sorts_after_read(&plan) && reads_big_table(&plan, &page.page.sql, &big) {
                    findings.insert(Finding {
                        kind: "page",
                        home: page.name.clone(),
                        statement: cut(&normalized(&page.page.sql)),
                        problem: "sorts the rows it read from a big table".to_owned(),
                        plan: plan.clone(),
                    });
                }
            }
            println!(
                "pages — {} app queries asked ({} distinct), {} page reads, {} distinct statements \
                 planned; {} asked queries answered an error: {}",
                asked.len(),
                names.len(),
                tapped.len(),
                distinct,
                failed.len(),
                failed.join(" | ")
            );
            assert!(
                distinct >= 40,
                "the sweep reached {distinct} page statements; asking the apps' queries found fewer \
                 than the product holds"
            );

            // (b) the statements the crates write by hand.
            let root = centraid_ontology::scratch::repo_root();
            let mut files = Vec::new();
            for dir in [
                "crates/vault/src",
                "crates/apps/kit/src",
                "crates/search/src",
                "crates/ontology/src",
            ] {
                sources(&root.join(dir), &mut files);
            }
            files.sort();
            let (mut planned, mut dynamic, mut unprepared) = (0usize, 0usize, Vec::new());
            for file in &files {
                let text = std::fs::read_to_string(file).expect("a source reads");
                let home = file
                    .strip_prefix(&root)
                    .unwrap_or(file)
                    .to_string_lossy()
                    .replace('\\', "/");
                for statement in statements_in_source(product_part(&text)) {
                    if statement.is_dynamic() {
                        dynamic += 1;
                        continue;
                    }
                    let plan = match vault.explain_query_plan(&statement.sql, &[]) {
                        Ok(plan) => plan,
                        Err(_) => {
                            unprepared.push(format!("{home}:{}", statement.line));
                            continue;
                        }
                    };
                    planned += 1;
                    let one_line = cut(&statement.normalized());
                    for table in full_scans(&plan, &statement.sql, &big) {
                        findings.insert(Finding {
                            kind: "statement",
                            home: home.clone(),
                            statement: one_line.clone(),
                            problem: format!("reads all of `{table}`"),
                            plan: plan.clone(),
                        });
                    }
                    if sorts_after_read(&plan)
                        && statement.sql.to_ascii_uppercase().contains("LIMIT")
                        && reads_big_table(&plan, &statement.sql, &big)
                    {
                        findings.insert(Finding {
                            kind: "statement",
                            home: home.clone(),
                            statement: one_line,
                            problem: "sorts the rows it read from a big table, and is limited"
                                .to_owned(),
                            plan,
                        });
                    }
                }
            }
            println!(
                "statements — {} files, {planned} planned, {dynamic} composed with a hole \
                 (reached through the pages), {} that will not prepare alone: {}",
                files.len(),
                unprepared.len(),
                unprepared.join(", ")
            );

            // The ledger: what is allowed is exactly what is found.
            let mut unexplained = Vec::new();
            let mut used: BTreeSet<(&str, usize)> = BTreeSet::new();
            for finding in &findings {
                let entries = if finding.kind == "page" {
                    &ledger.pages.entries
                } else {
                    &ledger.statements.entries
                };
                match entries.iter().position(|entry| entry.names(finding)) {
                    Some(at) => {
                        used.insert((finding.kind, at));
                    }
                    None => unexplained.push(format!(
                        "{} `{}` — {}: {}\n      plan: {}",
                        finding.kind,
                        finding.home,
                        finding.problem,
                        finding.statement,
                        finding.plan.join(" ; ")
                    )),
                }
            }
            let mut dead = Vec::new();
            for (kind, section) in [("page", &ledger.pages), ("statement", &ledger.statements)] {
                for (at, entry) in section.entries.iter().enumerate() {
                    assert!(
                        !entry.reason.trim().is_empty(),
                        "the ledger's {kind} `{}` has no reason",
                        entry.home
                    );
                    if !used.contains(&(kind, at)) {
                        dead.push(format!("{kind} `{}` {}", entry.home, entry.statement));
                    }
                }
                assert_eq!(
                    section.allowed,
                    section.entries.len(),
                    "the ledger counts {} allowed {kind}s and lists {}",
                    section.allowed,
                    section.entries.len()
                );
            }
            println!(
                "findings — {} found, {} allowed by the ledger, {} not",
                findings.len(),
                findings.len() - unexplained.len(),
                unexplained.len()
            );
            assert!(
                unexplained.is_empty(),
                "a read plans badly over a year-3 vault and is not in contracts/ledgers/\
                 query-plans.json. Add the index it wants to the baseline rather than the \
                 allowlist; an entry needs the statement's home and the one-line reason it is \
                 fine:\n  {}",
                unexplained.join("\n  ")
            );
            assert!(
                dead.is_empty(),
                "the ledger allows what no longer plans badly; remove it (and lower its count):\n  {}",
                dead.join("\n  ")
            );
            Ok(())
        })
        .expect("the plans are asked");
}

fn normalized(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn ask(handle: &centraid_core::Handle, query: Q) -> Result<(), String> {
    handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                query: Some(query),
            })),
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Every wire query has an entry in [`requests`]: the names it asks are the names
/// [`covers`] knows. The wire has 55 queries (`app_query.proto`'s `oneof query`);
/// a new one is a compile error in [`covers`], and this count says it was also
/// asked.
#[test]
fn the_sweep_asks_every_query_the_wire_has() {
    let asked: BTreeSet<&str> = requests("word").iter().map(covers).collect();
    assert_eq!(asked.len(), 55, "{asked:?}");
}
