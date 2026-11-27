//! THE READ REGISTRY'S OWN TESTS (app-plane §2): every declared read passes the authorizer and
//! its shape's plan gate over the founded schema, and each rule is shown to fail on a read that
//! breaks it.

mod common;

use std::collections::BTreeSet;

use centraid_domain::READS;
use centraid_domain::apps::{self, entity};
use centraid_domain::read::plan::{Allowlist, Finding};
use centraid_domain::read::{Args, Key, Param, ParamTy, ReadDecl, ReadError, Shape, desc, param};
use common::World;

fn root() -> std::path::PathBuf {
    centraid_ontology::scratch::repo_root()
}

fn the_registry() -> &'static [ReadDecl] {
    READS
}

#[test]
fn every_declared_read_passes_its_authorizer_and_its_plan_gate() {
    let world = World::new("reads-gate");
    let reader = world.reader();
    let allowlist = Allowlist::load(&root()).expect("the ledger");
    let mut excused = BTreeSet::new();
    let mut names = BTreeSet::new();
    for read in the_registry() {
        assert!(names.insert(read.name), "{} is declared twice", read.name);
        let inspection = reader
            .inspect(read)
            .unwrap_or_else(|error| panic!("{}: {error}", read.name));
        let declared: BTreeSet<&str> = read.tables().collect();
        let touched: BTreeSet<&str> = inspection.touched.iter().map(String::as_str).collect();
        assert_eq!(
            declared, touched,
            "{}: reads ∪ across is what it touches",
            read.name
        );
        for finding in inspection.findings {
            assert!(
                finding.allowlistable() && allowlist.excuses(read.name),
                "{}: {finding}\nplan: {:#?}",
                read.name,
                inspection.plan
            );
            excused.insert(read.name.to_owned());
        }
    }
    let listed: BTreeSet<String> = allowlist.homes.iter().cloned().collect();
    assert_eq!(
        excused, listed,
        "an allowlist row no read needs any more is removed"
    );
    assert_eq!(
        allowlist.allowed,
        allowlist.homes.len(),
        "the ledger counts its rows"
    );
}

#[test]
fn every_name_is_a_module_and_a_read_and_every_paged_list_has_a_cursor() {
    for read in the_registry() {
        let (module, name) = read.name.split_once('.').expect("<module>.<read>");
        assert!(!module.is_empty() && !name.is_empty(), "{}", read.name);
        if read.shape == Shape::PagedList {
            assert!(
                !read.cursor.is_empty(),
                "{} is a PagedList with no cursor",
                read.name
            );
            assert!((1..=200).contains(&read.bound), "{}: page size", read.name);
        } else {
            assert!(read.cursor.is_empty(), "{} is not paged", read.name);
        }
    }
}

const HOME: &[Param] = &[param("home", ParamTy::Id)];
const BY_ID: &[Param] = &[param("id", ParamTy::Id)];
const ID_AND_KIND: &[Param] = &[param("id", ParamTy::Id), param("kind", ParamTy::Text)];
const TITLE: &[Param] = &[param("title", ParamTy::Text)];

const NULLABLE_KEYS: &[Key] = &[desc("id", "b"), desc("at", "a")];

const SCANS: ReadDecl = ReadDecl {
    name: "t.scan",
    shape: Shape::ByKey,
    sql: "SELECT id FROM entity WHERE title = :title",
    params: TITLE,
    reads: &["entity"],
    across: &[],
    bound: 1,
    cursor: &[],
};

#[test]
fn a_full_scan_fails_its_gate() {
    let world = World::new("reads-scan");
    let found = world
        .reader()
        .inspect(&SCANS)
        .expect("it prepares")
        .findings;
    assert!(
        found
            .iter()
            .any(|finding| matches!(finding, Finding::Scan(_))),
        "{found:?}"
    );
    assert!(found.iter().all(Finding::allowlistable) || found.len() > 1);
}

#[test]
fn a_temp_b_tree_outside_the_allowlist_fails_its_gate() {
    let world = World::new("reads-sort");
    let sorted = ReadDecl {
        name: "t.sorted",
        shape: Shape::BoundedChild,
        sql: "SELECT id FROM entity WHERE parent_id = :home ORDER BY title LIMIT 10",
        params: HOME,
        reads: &["entity"],
        bound: 10,
        ..SCANS
    };
    let found = world
        .reader()
        .inspect(&sorted)
        .expect("it prepares")
        .findings;
    assert!(
        found
            .iter()
            .any(|finding| matches!(finding, Finding::TempBTree(_))),
        "{found:?}"
    );
    let allowlist = Allowlist::load(&root()).expect("the ledger");
    assert!(
        !allowlist.excuses("t.sorted"),
        "nothing excuses a read that is not declared"
    );
}

#[test]
fn a_cursorless_paged_list_fails_its_gate() {
    let world = World::new("reads-cursorless");
    let cursorless = ReadDecl {
        name: "t.cursorless",
        shape: Shape::PagedList,
        sql: "SELECT id, created_at AS at FROM entity WHERE kind = 'photo' LIMIT :n",
        params: &[],
        reads: &["entity"],
        bound: 50,
        ..SCANS
    };
    let reader = world.reader();
    let found = reader.inspect(&cursorless).expect("it prepares").findings;
    assert!(
        found
            .iter()
            .any(|finding| matches!(finding, Finding::Shape(text) if text.contains("no cursor"))),
        "{found:?}"
    );
}

#[test]
fn a_sealed_column_is_denied_to_every_module() {
    let world = World::new("reads-sealed");
    let reader = world.reader();
    for (table, column) in [
        ("locker_item_field", "value_sealed"),
        ("locker_item_field", "value_blob"),
        ("locker_item_passkey", "private_key"),
    ] {
        let sql: &'static str = Box::leak(format!("SELECT {column} FROM {table}").into_boxed_str());
        let sealed = ReadDecl {
            name: "locker.sealed",
            shape: Shape::Aggregate,
            sql,
            params: &[],
            reads: Box::leak(
                vec![&*Box::leak(table.to_owned().into_boxed_str())].into_boxed_slice(),
            ),
            bound: 5,
            ..SCANS
        };
        assert!(
            matches!(reader.inspect(&sealed), Err(ReadError::Refused { why, .. }) if why.contains("sealed")),
            "{table}.{column} was read"
        );
    }
    // `SELECT *` reads them too.
    let star = ReadDecl {
        name: "locker.star",
        sql: "SELECT * FROM locker_item_field",
        params: &[],
        reads: &["locker_item_field"],
        shape: Shape::Aggregate,
        bound: 5,
        ..SCANS
    };
    assert!(matches!(
        reader.inspect(&star),
        Err(ReadError::Refused { .. })
    ));
}

#[test]
fn a_table_outside_reads_and_across_fails_to_prepare() {
    let world = World::new("reads-undeclared");
    let reader = world.reader();
    let joins = ReadDecl {
        name: "t.joins",
        sql: "SELECT e.id FROM entity e JOIN edge x ON x.from_id = e.id WHERE e.id = :id",
        params: BY_ID,
        ..SCANS
    };
    assert!(matches!(
        reader.inspect(&joins),
        Err(ReadError::Refused { why, .. }) if why.contains("edge")
    ));
    let over_declared = ReadDecl {
        name: "t.over",
        sql: "SELECT id FROM entity WHERE id = :id",
        params: BY_ID,
        across: &["edge"],
        ..SCANS
    };
    assert!(matches!(
        reader.inspect(&over_declared),
        Err(ReadError::Declared { .. })
    ));
}

#[test]
fn a_read_only_selects_and_calls_only_the_allowed_functions() {
    let world = World::new("reads-policy");
    let reader = world.reader();
    for (sql, why) in [
        ("SELECT random() FROM entity WHERE id = :id", "random"),
        (
            "SELECT date('now') FROM entity WHERE id = :id AND load_extension('x') IS NULL",
            "load_extension",
        ),
    ] {
        let wrong = ReadDecl {
            name: "t.policy",
            sql,
            params: BY_ID,
            ..SCANS
        };
        assert!(
            matches!(reader.inspect(&wrong), Err(ReadError::Refused { why: found, .. }) if found.contains(why) || why == "load_extension"),
            "{sql}"
        );
    }
    let writes = ReadDecl {
        name: "t.writes",
        sql: "DELETE FROM entity WHERE id = :id",
        params: BY_ID,
        ..SCANS
    };
    assert!(reader.inspect(&writes).is_err());
    assert!(
        reader
            .connection()
            .execute("DELETE FROM entity", [])
            .is_err()
    );
}

#[test]
fn a_parameter_the_statement_does_not_take_is_a_declaration_error() {
    let world = World::new("reads-params");
    let extra = ReadDecl {
        name: "t.extra",
        sql: "SELECT id FROM entity WHERE id = :id",
        params: ID_AND_KIND,
        ..SCANS
    };
    assert!(matches!(
        world.reader().inspect(&extra),
        Err(ReadError::Declared { .. })
    ));
}

#[test]
fn a_page_walk_serves_each_row_once_newest_first_and_the_extra_row_only_decides_next() {
    let world = World::new("reads-walk");
    let book = world.notebook("Everything");
    let made: Vec<String> = (0..120)
        .map(|at| world.note(&format!("Note {at:03}"), &book))
        .collect();
    let reader = world.reader();
    let args = Args::new().text("home", &book).text("kind", "note");
    let mut seen = Vec::new();
    let mut after = None;
    let mut pages = 0;
    loop {
        let mut asked = args.clone();
        if let Some(cursor) = &after {
            asked = asked.after(cursor);
        }
        let page = reader.run(&entity::IN_HOME, &asked).expect("a page");
        pages += 1;
        assert!(page.rows.len() <= entity::IN_HOME.decl.bound);
        seen.extend(page.rows.iter().map(|row| row.id.clone()));
        match page.next {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    assert_eq!(pages, 3, "120 rows at 50 a page");
    let mut newest_first = made.clone();
    newest_first.reverse();
    assert_eq!(seen, newest_first);
}

#[test]
fn a_reload_rereads_what_was_loaded_in_one_statement_and_caps_it() {
    let world = World::new("reads-reload");
    let book = world.notebook("Everything");
    for at in 0..60 {
        world.note(&format!("Note {at:03}"), &book);
    }
    let reader = world.reader();
    let args = Args::new().text("home", &book).text("kind", "note");
    let loaded = reader
        .reload(&entity::IN_HOME, &args, 60)
        .expect("a reload");
    assert_eq!(loaded.rows.len(), 60);
    assert!(loaded.next.is_none());
    let capped = reader
        .reload(&entity::IN_HOME, &args, 10_000)
        .expect("a reload");
    assert_eq!(capped.rows.len(), 60, "fewer rows than the cap exist");
    let short = reader
        .reload(&entity::IN_HOME, &args, 55)
        .expect("a reload");
    assert_eq!(short.rows.len(), 55);
    assert!(short.next.is_some(), "what was dropped is still there");
}

#[test]
fn a_cursor_of_another_read_or_another_arity_is_refused_as_a_stale_list() {
    let world = World::new("reads-foreign");
    let book = world.notebook("Everything");
    for at in 0..60 {
        world.note(&format!("Note {at:03}"), &book);
    }
    let reader = world.reader();
    let first = reader
        .run(
            &entity::IN_HOME,
            &Args::new().text("home", &book).text("kind", "note"),
        )
        .expect("a page");
    let cursor = first.next.expect("more rows");
    // Another read's cursor.
    let foreign = reader.run(
        &entity::STARRED,
        &Args::new().text("kind", "note").after(cursor.clone()),
    );
    assert!(matches!(foreign, Err(ReadError::StaleCursor)));
    assert_eq!(
        foreign.err().map(|error| error.to_string()).as_deref(),
        Some("This list changed. Reload.")
    );
    // Not a cursor at all.
    assert!(matches!(
        reader.run(
            &entity::STARRED,
            &Args::new().text("kind", "note").after("c1.nonsense")
        ),
        Err(ReadError::StaleCursor)
    ));
}

#[test]
fn a_parameter_that_is_missing_extra_or_mistyped_is_refused() {
    let world = World::new("reads-args");
    let reader = world.reader();
    assert!(matches!(
        reader.run(&entity::HELD_COUNTS, &Args::new()),
        Err(ReadError::Param {
            why: "is missing",
            ..
        })
    ));
    assert!(matches!(
        reader.run(&entity::HELD_COUNTS, &Args::new().text("home", "a b")),
        Err(ReadError::Param { .. })
    ));
    assert!(matches!(
        reader.run(
            &entity::HELD_COUNTS,
            &Args::new().text("home", "x").int("n", 3)
        ),
        Err(ReadError::Param {
            why: "is not declared",
            ..
        })
    ));
}

#[test]
fn a_holder_counts_what_it_holds_and_its_trash_lists_only_what_was_trashed_alone() {
    let world = World::new("reads-held");
    let book = world.notebook("Recipes");
    let kept = world.note("Dal", &book);
    let gone = world.note("Soup", &book);
    world.ok("entity.trash", serde_json::json!({ "id": gone }));
    let reader = world.reader();
    let held = reader
        .run(&entity::HELD_COUNTS, &Args::new().text("home", &book))
        .expect("counts");
    assert_eq!(
        held.rows
            .iter()
            .map(|held| (held.kind.as_str(), held.count))
            .collect::<Vec<_>>(),
        vec![("note", 1)]
    );
    world.ok("entity.trash", serde_json::json!({ "id": book }));
    let trash = reader
        .run(&apps::notes::TRASH, &Args::new())
        .expect("a trash");
    let listed: Vec<&str> = trash.rows.iter().map(|row| row.id.as_str()).collect();
    assert!(
        listed.contains(&book.as_str()),
        "the notebook was trashed on its own"
    );
    assert!(
        listed.contains(&gone.as_str()),
        "so was the note trashed earlier"
    );
    assert!(
        !listed.contains(&kept.as_str()),
        "a note that went with its notebook is listed with it, never alone"
    );
}

#[test]
fn a_keyset_key_may_not_be_null() {
    let world = World::new("reads-null");
    let reader = world.reader();
    let nullable = centraid_domain::read::read(
        ReadDecl {
            name: "t.nullable",
            shape: Shape::PagedList,
            sql: "SELECT id, deleted_at AS at FROM entity \
                  WHERE kind = 'notebook' AND id < :b AND :a IS NOT NULL \
                  ORDER BY id DESC LIMIT :n",
            params: &[],
            reads: &["entity"],
            across: &[],
            bound: 2,
            cursor: NULLABLE_KEYS,
        },
        |row| row.get::<_, String>("id"),
    );
    world.notebook("One");
    world.notebook("Two");
    world.notebook("Three");
    assert!(reader.run(&nullable, &Args::new()).is_err());
}

fn rust_sources(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

fn product_part(source: &str) -> &str {
    source.split("\n#[cfg(test)]").next().unwrap_or(source)
}

#[test]
fn every_index_has_a_reader() {
    let world = World::new("reads-indexes");
    let reader = world.reader();
    let mut plans = Vec::new();
    for read in the_registry() {
        let inspection = reader
            .inspect(read)
            .unwrap_or_else(|error| panic!("{}: {error}", read.name));
        plans.extend(inspection.plan.into_iter().map(|line| line.detail));
    }
    let repo = root();
    let mut files = Vec::new();
    for dir in [
        "crates/vault/src",
        "crates/domain/src",
        "crates/search/src",
        "crates/ontology/src",
    ] {
        rust_sources(&repo.join(dir), &mut files);
    }
    files.sort();
    for file in &files {
        let text = std::fs::read_to_string(file).expect("source reads");
        for statement in centraid_vault::plans::statements_in_source(product_part(&text)) {
            if statement.is_dynamic() {
                continue;
            }
            if let Ok(plan) = world.vault.explain_query_plan(&statement.sql, &[]) {
                plans.extend(plan);
            }
        }
    }
    let unread = world.vault.unread_indexes(&plans).expect("unread indexes");
    // Exact ratchet: unique constraint plus remaining unread indexes.
    let awaiting: Vec<String> = [
        "locker_item_field.locker_item_field_by_url",
        "message.message_by_notice",
        "person.person_by_cadence",
        "person_date.person_date_one_of_a_single_kind",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    assert_eq!(
        unread, awaiting,
        "unread indexes changed; add a reader or shrink awaiting"
    );
}

#[test]
fn glance_reads_run_through_the_registered_reads() {
    let world = World::new("reads-glance");
    let book = world.notebook("Notes");
    let held = world
        .vault
        .read(|conn| Ok(centraid_domain::glance::entity_held(conn, &book)?))
        .expect("entity_held");
    assert!(held);
    let missing = world
        .vault
        .read(|conn| Ok(centraid_domain::glance::entity_held(conn, "no-such-id")?))
        .expect("entity_held missing");
    assert!(!missing);

    let event_id = world.made(
        "event.propose",
        serde_json::json!({
            "title": "Standup",
            "starts": "2026-06-15T09:00",
            "ends": "2026-06-15T09:30",
            "timing": "floating",
        }),
    );
    let long_id = world.made(
        "event.propose",
        serde_json::json!({
            "title": "Summer trip",
            "starts": "2026-06-01",
            "ends": "2026-06-20",
            "timing": "all-day",
        }),
    );
    let due_id = world.made(
        "task.add",
        serde_json::json!({
            "title": "Send invoice",
            "due": "2026-06-15",
        }),
    );
    let sched_id = world.made(
        "task.add",
        serde_json::json!({
            "title": "Water plants",
            "scheduled_on": "2026-06-15",
        }),
    );
    let today = world
        .vault
        .read(|conn| {
            Ok(centraid_domain::glance::today(
                conn,
                &centraid_domain::glance::Day {
                    day: "2026-06-15",
                    from: "2026-06-15T00:00:00.000Z",
                    to: "2026-06-16T00:00:00.000Z",
                    floating_from: "2026-06-15T00:00",
                    floating_to: "2026-06-15T23:59",
                },
            )?)
        })
        .expect("today");
    let event_ids: Vec<&str> = today.events.iter().map(|i| i.id.as_str()).collect();
    let task_ids: Vec<&str> = today.tasks.iter().map(|i| i.id.as_str()).collect();
    assert!(event_ids.contains(&event_id.as_str()), "{event_ids:?}");
    assert!(event_ids.contains(&long_id.as_str()), "{event_ids:?}");
    assert!(task_ids.contains(&due_id.as_str()), "{task_ids:?}");
    assert!(task_ids.contains(&sched_id.as_str()), "{task_ids:?}");
}
