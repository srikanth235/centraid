//! A note's own verbs against the v0 tables (#1214 K11): made at the top or in a notebook,
//! edited and moved, its `[[mentions]]`, its `about` edges and anchors, its journal day, its
//! assets, and what search and the backlinks read. The trash, a pin, a tag and a rename are the
//! shared verbs and are proved in `shared_verbs.rs`; here they only arrange a state. The rules the
//! database holds for these tables are in `schema_rules.rs`; the Markdown door is
//! `note_portable.rs`.

mod common;

use centraid_vault::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use centraid_vault::links;
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, Principal};
use common::world::World;
use serde_json::{Value, json};

/// A founded vault with a content store, and one probe command: it makes an item of any kind the
/// way every app's create does (through the command's context), so the kernel's hook runs for it.
fn world(seed: &str) -> World {
    let mut w = World {
        scratch: common::Scratch::founded_with_blobs(seed).expect("a vault"),
        registry: centraid_vault::commands::Registry::with_system_commands().expect("a registry"),
    };
    w.registry
        .register(CommandDefinition::plain(
            "probe.make",
            "probe",
            r#"{"type":"object","additionalProperties":true}"#,
            Idempotency::Idempotent,
            &[] as &[CommandCondition],
            probe_make,
        ))
        .expect("a probe");
    w
}

fn probe_make(ctx: &CommandCtx<'_, '_>) -> centraid_vault::Result<Value> {
    let kind = Kind::parse(ctx.required_str("kind")?).expect("a kind");
    let id =
        ctx.insert_entity_under(kind, ctx.required_str("title")?, ctx.optional_str("parent"))?;
    Ok(json!({ "id": id }))
}

/// An item of `kind` titled `title`, made through a command, in a home when its kind needs one.
fn made(w: &World, kind: Kind, title: &str) -> String {
    let (needs_home, named): (bool, bool) = w
        .vault()
        .read(|c| {
            Ok(c.query_row(
                "SELECT may_be_top = 0, may_be_named FROM entity_kind WHERE code = ?1",
                [kind.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("a kind row");
    let home = needs_home.then(|| {
        let holder: String = w.one(
            "SELECT home_kind FROM home_shape WHERE kind = ?1 ORDER BY home_kind LIMIT 1",
            &[kind.as_str()],
        );
        made(w, Kind::parse(&holder).expect("a kind"), "Holder")
    });
    w.ok(
        "probe.make",
        json!({ "kind": kind.as_str(), "title": if named { title } else { "" }, "parent": home }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned()
}

fn note(w: &World, title: &str, body: &str) -> String {
    w.ok("note.create", json!({ "title": title, "body": body }))["id"]
        .as_str()
        .expect("an id")
        .to_owned()
}

/// A note's mentions as `(wikilink, target)`, in order.
fn mentions(w: &World, note: &str) -> Vec<(String, Option<String>)> {
    w.vault()
        .read(|c| {
            Ok(c.prepare(
                "SELECT wikilink, to_id FROM mention WHERE note_id = ?1 ORDER BY ordinal",
            )?
            .query_map([note], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .expect("mentions")
}

fn versions(w: &World, id: &str) -> i64 {
    w.one("SELECT COUNT(*) FROM revision WHERE entity_id = ?1", &[id])
}

fn plan(w: &World, sql: &str) -> String {
    w.vault()
        .read(|c| {
            let mut statement = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.join(" | "))
        })
        .expect("a plan")
}

// ---------------------------------------------------------------------------------------------
// 1. Create, edit, move
// ---------------------------------------------------------------------------------------------

#[test]
fn a_note_is_made_at_the_top_or_in_a_notebook_edited_and_moved_through_entity_move() {
    let w = world("note_home");
    let first = w.container("notebook", "First");
    let second = w.container("notebook", "Second");
    let top = note(&w, "Loose", "words");
    let filed = w.ok(
        "note.create",
        json!({ "title": "Filed", "body": "b", "notebook_id": first }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        w.one::<Option<String>>("SELECT parent_id FROM entity WHERE id = ?1", &[&top]),
        None
    );
    assert_eq!(
        w.one::<String>("SELECT parent_id FROM entity WHERE id = ?1", &[&filed]),
        first
    );
    assert_eq!(
        w.one::<String>("SELECT parent_kind FROM entity WHERE id = ?1", &[&filed]),
        "notebook"
    );
    // An edit changes the words and the title and leaves the home.
    w.ok(
        "note.edit",
        json!({ "id": filed, "body": "second", "title": "Filed again", "format": "plain" }),
    );
    assert_eq!(
        w.one::<String>("SELECT body FROM note WHERE id = ?1", &[&filed]),
        "second"
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&filed]),
        "Filed again"
    );
    assert_eq!(
        w.one::<String>("SELECT format FROM note WHERE id = ?1", &[&filed]),
        "plain"
    );
    // The shared verb moves it between notebooks and to the top, and a no-op writes nothing.
    assert_eq!(
        w.ok("entity.move", json!({ "id": filed, "parent": second }))["moved"],
        true
    );
    assert_eq!(
        w.one::<String>("SELECT parent_id FROM entity WHERE id = ?1", &[&filed]),
        second
    );
    assert_eq!(
        w.ok("entity.move", json!({ "id": filed, "parent": second }))["moved"],
        false
    );
    w.ok("entity.move", json!({ "id": filed, "parent": null }));
    assert_eq!(
        w.one::<Option<String>>("SELECT parent_id FROM entity WHERE id = ?1", &[&filed]),
        None
    );
    // A notebook may sit in a notebook, and a note goes in the inner one.
    w.ok("entity.move", json!({ "id": second, "parent": first }));
    w.ok("entity.move", json!({ "id": filed, "parent": second }));
    assert_eq!(
        w.one::<String>("SELECT parent_id FROM entity WHERE id = ?1", &[&filed]),
        second
    );
}

#[test]
fn a_note_is_refused_in_what_is_not_a_notebook_and_a_bad_edit_is_refused_in_a_sentence() {
    let w = world("note_refusals");
    let person = w.person("Ada");
    let a_note = note(&w, "Plan", "x");
    for holder in [
        &person,
        &a_note,
        &"01900000-0000-7000-8000-00000000dead".to_owned(),
    ] {
        let sentence = w.refused(
            "note.create",
            json!({ "title": "T", "notebook_id": holder }),
        );
        assert!(!sentence.is_empty());
    }
    assert!(
        w.refused("note.create", json!({ "title": "  " }))
            .contains("title")
    );
    let big = "x".repeat(65 * 1024);
    assert!(
        w.refused("note.create", json!({ "title": "Big", "body": big }))
            .contains("budget")
    );
    assert!(
        w.refused("note.edit", json!({ "id": a_note, "title": " " }))
            .contains("title")
    );
    assert!(
        w.refused("note.edit", json!({ "id": person, "body": "x" }))
            .contains("not a note")
    );
    // A trashed note is frozen.
    w.ok("entity.trash", json!({ "id": a_note }));
    assert!(
        w.refused("note.edit", json!({ "id": a_note, "body": "y" }))
            .contains("trash")
    );
    assert_eq!(
        w.one::<String>("SELECT body FROM note WHERE id = ?1", &[&a_note]),
        "x"
    );
}

#[test]
fn a_notebooks_notes_by_last_edited_is_one_seek_on_entity_with_no_join() {
    let w = world("note_plan");
    let book = w.container("notebook", "Book");
    for n in 0..3 {
        w.ok(
            "note.create",
            json!({ "title": format!("n{n}"), "notebook_id": book }),
        );
    }
    // The notebook's notes, newest edit first: the home index answers in order.
    let in_notebook = plan(
        &w,
        "SELECT id FROM entity WHERE parent_id = 'x' AND kind = 'note' AND deleted_at IS NULL
          ORDER BY updated_at DESC, id DESC LIMIT 50",
    );
    assert!(in_notebook.contains("entity_by_home"), "{in_notebook}");
    assert!(!in_notebook.contains("TEMP B-TREE"), "{in_notebook}");
    assert!(!in_notebook.contains("SCAN"), "{in_notebook}");
    assert_eq!(in_notebook.matches("entity").count(), 2, "{in_notebook}");
    // The top level has no home to seek, and has its own index.
    let at_top = plan(
        &w,
        "SELECT id FROM entity WHERE parent_id IS NULL AND kind = 'note' AND deleted_at IS NULL
          ORDER BY updated_at DESC, id DESC LIMIT 50",
    );
    assert!(at_top.contains("entity_by_updated"), "{at_top}");
    assert!(!at_top.contains("TEMP B-TREE"), "{at_top}");
}

#[test]
fn an_autosave_folds_into_one_version_and_an_edit_that_changes_nothing_writes_nothing() {
    let w = world("note_autosave");
    let id = note(&w, "Plan", "first");
    let quiet = |body: &str| {
        w.scratch.clock.advance_ms(1_000);
        let outcome = w
            .vault()
            .execute(
                &w.registry,
                &Principal::owner("phone"),
                &Command::new("note.edit", json!({ "id": id, "body": body })).quiet(),
            )
            .expect("runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{:?}",
            outcome.reason
        );
    };
    quiet("second");
    assert_eq!(
        versions(&w, &id),
        1,
        "the first save keeps the words it replaced"
    );
    quiet("third");
    quiet("fourth");
    assert_eq!(versions(&w, &id), 1, "the next saves fold into it");
    // A save that is not an autosave is a version of its own.
    w.ok("note.edit", json!({ "id": id, "body": "fifth" }));
    assert_eq!(versions(&w, &id), 2);
    // The same words again change nothing: no version, and `updated_at` does not move.
    let stamp = w.stamp(&id);
    w.ok("note.edit", json!({ "id": id, "body": "fifth" }));
    assert_eq!(versions(&w, &id), 2);
    assert_eq!(w.stamp(&id), stamp);
}

#[test]
fn a_stale_save_is_refused_a_fresh_one_answers_the_next_revision_and_a_trashed_note_is_stale_trashed()
 {
    let w = world("note_stale");
    let id = note(&w, "Plan", "first");
    let one = w.ok(
        "note.edit",
        json!({ "id": id, "body": "second", "expected_rev": 0 }),
    );
    assert_eq!(one["rev"], 1);
    let outcome = w.run(
        "note.edit",
        json!({ "id": id, "body": "mine", "expected_rev": 0 }),
    );
    assert_eq!(outcome.status, CommandStatus::Failed);
    assert_eq!(outcome.predicate.as_deref(), Some("stale_revision"));
    assert_eq!(
        w.one::<String>("SELECT body FROM note WHERE id = ?1", &[&id]),
        "second"
    );
    assert!(outcome.tables.is_empty(), "a refused save writes nothing");
    let same = w.ok(
        "note.edit",
        json!({ "id": id, "body": "second", "expected_rev": 1 }),
    );
    assert_eq!(
        same["rev"], 1,
        "a save that changes nothing keeps the revision"
    );
    w.ok("entity.trash", json!({ "id": id }));
    let trashed = w.run(
        "note.edit",
        json!({ "id": id, "body": "x", "expected_rev": 1 }),
    );
    assert_eq!(trashed.predicate.as_deref(), Some("stale_trashed"));
}

// ---------------------------------------------------------------------------------------------
// 2. Mentions
// ---------------------------------------------------------------------------------------------

#[test]
fn mentions_are_rebuilt_on_every_save_and_keep_every_occurrence_and_every_waiting_title() {
    let w = world("mentions_rebuilt");
    let alex = note(&w, "Alex", "");
    let id = note(
        &w,
        "Today",
        "met [[Alex]] and [[alex]] about [[Nobody Yet]]",
    );
    // The same title twice keeps both rows, an unresolved title keeps its row.
    assert_eq!(
        mentions(&w, &id),
        [
            ("Alex".to_owned(), Some(alex.clone())),
            ("alex".to_owned(), Some(alex.clone())),
            ("Nobody Yet".to_owned(), None),
        ]
    );
    // A save rebuilds from the words alone: the unresolved title survives an edit that keeps it,
    // a removed one is gone, a new one appears.
    w.ok(
        "note.edit",
        json!({ "id": id, "body": "[[Nobody Yet]] then [[Brand New]]" }),
    );
    assert_eq!(
        mentions(&w, &id),
        [
            ("Nobody Yet".to_owned(), None),
            ("Brand New".to_owned(), None)
        ]
    );
    // A save that leaves the words alone does not touch them; a title-only edit neither.
    w.ok("note.edit", json!({ "id": id, "title": "Today again" }));
    assert_eq!(mentions(&w, &id).len(), 2);
    // A version put back rebuilds from the words it brings: the mentions are the restored text's.
    let seq = w.one::<i64>(
        "SELECT seq FROM revision WHERE entity_id = ?1 AND body LIKE '%Alex%' ORDER BY seq LIMIT 1",
        &[&id],
    );
    w.ok("note.restore_version", json!({ "id": id, "seq": seq }));
    assert_eq!(
        mentions(&w, &id).len(),
        3,
        "back to Alex, alex and Nobody Yet"
    );
    w.ok(
        "note.edit",
        json!({ "id": id, "body": "[[Nobody Yet]] then [[Brand New]]" }),
    );
    // A note never names itself, and emptying the words empties the table for the note.
    w.ok("note.edit", json!({ "id": id, "body": "[[Today again]]" }));
    assert_eq!(mentions(&w, &id), [("Today again".to_owned(), None)]);
    w.ok("note.edit", json!({ "id": id, "body": "" }));
    assert!(mentions(&w, &id).is_empty());
}

#[test]
fn two_items_sharing_a_title_keep_both() {
    let w = world("mentions_twins");
    let one = note(&w, "Twin", "");
    let two = note(&w, "Twin", "");
    let id = note(&w, "Says", "[[Twin]]");
    let rows = mentions(&w, &id);
    assert_eq!(rows.len(), 2, "{rows:?}");
    let targets: std::collections::BTreeSet<_> =
        rows.iter().filter_map(|(_, to)| to.clone()).collect();
    assert_eq!(targets, [one, two].into_iter().collect());
}

#[test]
fn creating_or_renaming_any_linkable_item_resolves_the_mentions_waiting_for_its_title() {
    let w = world("mentions_resolve");
    let linkable = w.kinds_linkable(true);
    assert!(
        linkable.len() > 3,
        "the lookup names several linkable kinds"
    );
    for kind in linkable {
        // Made after the note that names it.
        let made_title = format!("Made {}", kind.as_str());
        let waiting = note(
            &w,
            &format!("w-made-{}", kind.as_str()),
            &format!("[[{made_title}]]"),
        );
        assert_eq!(mentions(&w, &waiting)[0].1, None);
        let item = made(&w, kind, &made_title);
        assert_eq!(
            mentions(&w, &waiting)[0].1.as_deref(),
            Some(item.as_str()),
            "{} made",
            kind.as_str()
        );
        // Renamed into the title another note waits for, case folded.
        let renamed_title = format!("Renamed {}", kind.as_str());
        let waiting = note(
            &w,
            &format!("w-renamed-{}", kind.as_str()),
            &format!("[[{}]]", renamed_title.to_uppercase()),
        );
        w.ok(
            "entity.retitle",
            json!({ "id": item, "title": renamed_title }),
        );
        assert_eq!(
            mentions(&w, &waiting)[0].1.as_deref(),
            Some(item.as_str()),
            "{} renamed",
            kind.as_str()
        );
    }
    // A note renamed through its own edit resolves what waits for the new title too.
    let waiting = note(&w, "waits", "[[Later Name]]");
    let target = note(&w, "Earlier Name", "");
    w.ok("note.edit", json!({ "id": target, "title": "Later Name" }));
    assert_eq!(
        mentions(&w, &waiting)[0].1.as_deref(),
        Some(target.as_str())
    );
}

#[test]
fn a_reading_a_chat_a_container_or_a_label_is_never_a_target() {
    let w = world("mentions_never");
    let never = w.kinds_linkable(false);
    assert!(
        never.len() > 3,
        "the lookup names several non-linkable kinds"
    );
    for kind in never {
        let title = format!("Same {}", kind.as_str());
        let id = note(&w, &format!("n-{}", kind.as_str()), &format!("[[{title}]]"));
        // Made after: the hook offers it the waiting row and the kind says no.
        made(&w, kind, &title);
        assert_eq!(mentions(&w, &id)[0].1, None, "{}", kind.as_str());
        // Already there when the note is saved: the rebuild does not name it either.
        w.ok(
            "note.edit",
            json!({ "id": id, "body": format!("[[{title}]] again") }),
        );
        assert_eq!(mentions(&w, &id)[0].1, None, "{}", kind.as_str());
    }
}

#[test]
fn a_rename_of_the_target_does_not_rewrite_the_note_and_a_purge_makes_its_mentions_wait_again() {
    let w = world("mentions_target");
    let target = note(&w, "Alex", "");
    let id = note(&w, "Says", "see [[Alex]]");
    assert_eq!(mentions(&w, &id)[0].1.as_deref(), Some(target.as_str()));
    let stamp = w.stamp(&id);
    w.ok(
        "entity.retitle",
        json!({ "id": target, "title": "Alexander" }),
    );
    assert_eq!(
        w.one::<String>("SELECT body FROM note WHERE id = ?1", &[&id]),
        "see [[Alex]]",
        "the words are the member's"
    );
    assert_eq!(
        mentions(&w, &id),
        [("Alex".to_owned(), Some(target.clone()))],
        "the row keeps the item it named"
    );
    assert_eq!(
        w.stamp(&id),
        stamp,
        "a rename elsewhere is not an edit of the note"
    );
    // A purge turns the row back to waiting, and a later item of the title picks it up.
    w.ok("entity.trash", json!({ "id": target }));
    w.ok("entity.purge", json!({ "id": target }));
    assert_eq!(mentions(&w, &id), [("Alex".to_owned(), None)]);
    let again = note(&w, "Alex", "");
    assert_eq!(mentions(&w, &id)[0].1.as_deref(), Some(again.as_str()));
    // A trashed item is not named by a save.
    w.ok("entity.trash", json!({ "id": again }));
    w.ok("note.edit", json!({ "id": id, "body": "see [[Alex]] now" }));
    assert_eq!(mentions(&w, &id)[0].1, None);
}

#[test]
fn the_resolving_reads_are_index_seeks() {
    let w = world("mentions_plans");
    note(&w, "Alex", "");
    let by_title = plan(
        &w,
        "SELECT e.id FROM entity_kind k CROSS JOIN entity e ON e.kind = k.code
          WHERE k.linkable = 1 AND e.title = 'x' COLLATE NOCASE AND e.deleted_at IS NULL
          ORDER BY e.created_at, e.id",
    );
    assert!(by_title.contains("entity_by_title_nocase"), "{by_title}");
    let waiting = plan(
        &w,
        "UPDATE mention SET to_id = 'x' WHERE to_id IS NULL AND wikilink = 'y' COLLATE NOCASE",
    );
    assert!(waiting.contains("mention_by_words"), "{waiting}");
    let backlinks = plan(&w, "SELECT note_id FROM mention WHERE to_id = 'x'");
    assert!(backlinks.contains("mention_by_target"), "{backlinks}");
}

#[test]
fn mentioned_in_for_any_item_reads_the_mention_rows() {
    let w = world("mentions_backlinks");
    let item = note(&w, "Ada", "");
    let a = note(&w, "A", "about [[Ada]]");
    let b = note(&w, "B", "also [[Ada]] and [[ada]]");
    let linked = w.vault().read(|c| links::linked(c, &item)).expect("linked");
    let ids: Vec<&str> = linked.iter().map(|l| l.id.as_str()).collect();
    assert!(
        ids.contains(&a.as_str()) && ids.contains(&b.as_str()),
        "{ids:?}"
    );
    assert!(
        linked.iter().all(|l| l.in_text),
        "written in a note's words"
    );
    // The other direction: what a note names.
    let from_a = w.vault().read(|c| links::linked(c, &a)).expect("linked");
    assert!(from_a.iter().any(|l| l.id == item));
}

// ---------------------------------------------------------------------------------------------
// 4. About and anchors
// ---------------------------------------------------------------------------------------------

#[test]
fn an_about_is_an_edge_with_or_without_an_anchor_and_an_anchor_survives_a_save() {
    let w = world("note_about");
    let ada = w.person("Ada");
    let bob = w.person("Bob");
    let id = note(&w, "Meeting", "Ada said a thing. Bob did not.");
    w.ok("edge.add", json!({ "from": id, "rel": "about", "to": ada }));
    w.ok(
        "edge.add",
        json!({ "from": id, "rel": "about", "to": bob, "anchor": { "v": 1, "from": 20, "to": 30 } }),
    );
    let anchors = |to: &str| {
        w.one::<Option<String>>(
            "SELECT anchor FROM edge WHERE from_id = ?1 AND rel = 'about' AND to_id = ?2",
            &[&id, to],
        )
    };
    assert_eq!(anchors(&ada), None);
    let held: Value = serde_json::from_str(&anchors(&bob).expect("an anchor")).unwrap();
    assert_eq!(held["from"], 20);
    // A save rebuilds the mentions and leaves the edges, anchors included.
    w.ok(
        "note.edit",
        json!({ "id": id, "body": "Rewritten with [[Nobody]] in it." }),
    );
    assert_eq!(anchors(&ada), None);
    assert_eq!(
        serde_json::from_str::<Value>(&anchors(&bob).expect("still anchored")).unwrap()["to"],
        30
    );
    // An `about` is never a mention, and a mention is never an `about`.
    assert_eq!(mentions(&w, &id), [("Nobody".to_owned(), None)]);
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM edge WHERE from_id = ?1", &[&id]),
        2
    );
    // Only a note's `about` may wear an anchor.
    let task_like = w.person("Cy");
    let sentence = w.refused(
        "edge.add",
        json!({ "from": ada, "rel": "related", "to": task_like, "anchor": { "v": 1 } }),
    );
    assert!(!sentence.is_empty());
}

// ---------------------------------------------------------------------------------------------
// 5. Journal
// ---------------------------------------------------------------------------------------------

#[test]
fn a_journal_day_is_set_changed_and_cleared_and_being_about_the_owner_is_not_one() {
    let w = world("note_journal");
    let owner = common::self_person(w.vault()).expect("the owner");
    let entry = w.ok(
        "note.create",
        json!({ "title": "Tuesday", "body": "good day", "journal_on": "2026-02-24" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // Backdated: the day is not the day it was written.
    assert_eq!(
        w.one::<String>("SELECT journal_on FROM note WHERE id = ?1", &[&entry]),
        "2026-02-24"
    );
    w.ok(
        "note.edit",
        json!({ "id": entry, "journal_on": "2026-02-25" }),
    );
    assert_eq!(
        w.one::<String>("SELECT journal_on FROM note WHERE id = ?1", &[&entry]),
        "2026-02-25"
    );
    // An edit that does not say the day leaves it.
    w.ok("note.edit", json!({ "id": entry, "body": "better day" }));
    assert_eq!(
        w.one::<String>("SELECT journal_on FROM note WHERE id = ?1", &[&entry]),
        "2026-02-25"
    );
    // About the owner is just an edge: the note is not a journal entry.
    let about_me = note(&w, "Reflection", "me");
    w.ok(
        "edge.add",
        json!({ "from": about_me, "rel": "about", "to": owner }),
    );
    let later = w.ok(
        "note.create",
        json!({ "title": "Wednesday", "journal_on": "2026-02-26" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let day = w.strings("SELECT id FROM note WHERE journal_on = '2026-02-25'", &[]);
    assert_eq!(day, std::slice::from_ref(&entry));
    let newest_first = w.strings(
        "SELECT id FROM note WHERE journal_on IS NOT NULL ORDER BY journal_on DESC, id DESC",
        &[],
    );
    assert_eq!(newest_first, [later, entry.clone()]);
    assert!(!newest_first.contains(&about_me));
    // The day's read and the newest-first read are the journal index.
    for sql in [
        "SELECT id FROM note WHERE journal_on = '2026-02-25'",
        "SELECT id FROM note WHERE journal_on IS NOT NULL ORDER BY journal_on DESC, id DESC LIMIT 20",
    ] {
        let p = plan(&w, sql);
        assert!(p.contains("note_by_journal"), "{p}");
        assert!(!p.contains("TEMP B-TREE"), "{p}");
    }
    // Clearing the day makes it an ordinary note again.
    w.ok("note.edit", json!({ "id": entry, "journal_on": null }));
    assert_eq!(
        w.one::<Option<String>>("SELECT journal_on FROM note WHERE id = ?1", &[&entry]),
        None
    );
    // A day is a date.
    for bad in ["yesterday", "2026-13-40", "2026-2-3"] {
        let sentence = w.refused("note.edit", json!({ "id": entry, "journal_on": bad }));
        assert!(sentence.contains("not a day"), "{sentence}");
        let sentence = w.refused("note.create", json!({ "title": "x", "journal_on": bad }));
        assert!(sentence.contains("not a day"), "{sentence}");
    }
}

// ---------------------------------------------------------------------------------------------
// 6. Assets
// ---------------------------------------------------------------------------------------------

fn put(w: &World, bytes: &[u8]) -> String {
    w.vault()
        .blobs()
        .expect("a store")
        .put(bytes)
        .expect("stored")
}

fn assets(w: &World, note: &str) -> Vec<String> {
    w.strings(
        "SELECT name FROM note_asset WHERE note_id = ?1 ORDER BY position, id",
        &[note],
    )
}

fn add_asset(w: &World, note: &str, name: &str, bytes: &[u8]) -> String {
    let hash = put(w, bytes);
    w.ok(
        "note.asset_add",
        json!({ "id": note, "blob": hash, "name": name, "media_type": "image/png" }),
    )["asset_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn an_asset_is_added_reordered_and_removed_and_is_in_no_list_or_search() {
    let w = world("note_assets");
    let id = note(&w, "Trip", "see the picture");
    let items = w.one::<i64>("SELECT COUNT(*) FROM entity", &[]);
    let one = add_asset(&w, &id, "harbourview.png", b"one");
    let two = add_asset(&w, &id, "ferry.png", b"two");
    let three = add_asset(&w, &id, "dock.png", b"three");
    assert_eq!(
        assets(&w, &id),
        ["harbourview.png", "ferry.png", "dock.png"]
    );
    // It is a child row, not an item: no entity of its own, and nothing searches it.
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM entity", &[]), items);
    assert_eq!(
        w.one::<i64>(
            "SELECT count(*) FROM search WHERE search MATCH 'harbourview'",
            &[]
        ),
        0
    );
    // The order is the member's.
    w.ok(
        "note.asset_reorder",
        json!({ "id": id, "order": [&three, &one, &two] }),
    );
    assert_eq!(
        assets(&w, &id),
        ["dock.png", "harbourview.png", "ferry.png"]
    );
    assert!(
        w.refused("note.asset_reorder", json!({ "id": id, "order": [&one] }))
            .contains("each")
    );
    // Removing one keeps its bytes: the version of the note that had it names them.
    let removed = w.ok("note.asset_remove", json!({ "id": id, "asset_id": two }));
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM blob WHERE hash = ?1",
            &[removed["blob"].as_str().unwrap()]
        ),
        1
    );
    assert_eq!(assets(&w, &id), ["dock.png", "harbourview.png"]);
    assert!(
        w.refused("note.asset_remove", json!({ "id": id, "asset_id": two }))
            .contains("not in this note")
    );
    // Refusals: bytes the store does not hold, a name missing, a trashed note.
    assert!(
        w.refused(
            "note.asset_add",
            json!({ "id": id, "blob": "0".repeat(64), "name": "x", "media_type": "image/png" })
        )
        .contains("not in this vault's store")
    );
    let hash = put(&w, b"four");
    assert!(
        w.refused(
            "note.asset_add",
            json!({ "id": id, "blob": hash, "name": " ", "media_type": "image/png" })
        )
        .contains("name")
    );
    w.ok("entity.trash", json!({ "id": id }));
    assert!(
        w.refused(
            "note.asset_add",
            json!({ "id": id, "blob": hash, "name": "x", "media_type": "image/png" })
        )
        .contains("trash")
    );
}

#[test]
fn an_asset_goes_with_its_note_and_its_bytes_are_released_when_the_note_is_purged() {
    let w = world("note_asset_purge");
    let id = note(&w, "Trip", "x");
    let hash = put(&w, b"photo bytes");
    w.ok(
        "note.asset_add",
        json!({ "id": id, "blob": hash, "name": "p.png", "media_type": "image/png" }),
    );
    // Trashed with the note: still its child, still held.
    w.ok("entity.trash", json!({ "id": id }));
    assert_eq!(assets(&w, &id), ["p.png"]);
    let purged = w.ok("entity.purge", json!({ "id": id }));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM note_asset", &[]),
        0,
        "the child row went with the note"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM revision_blob WHERE blob = ?1",
            &[&hash]
        ),
        0
    );
    assert_eq!(
        purged["released"],
        json!([hash]),
        "nothing names the bytes any more"
    );
}

#[test]
fn an_earlier_version_gets_its_asset_back_on_restore() {
    let w = world("note_asset_restore");
    let id = note(&w, "Trip", "x");
    let hash = put(&w, b"keepsake");
    let asset = w.ok(
        "note.asset_add",
        json!({ "id": id, "blob": hash, "name": "keep.png", "media_type": "image/png" }),
    )["asset_id"]
        .as_str()
        .unwrap()
        .to_owned();
    // The asset is removed: the version that kept it names its bytes, so they are not released.
    w.ok("note.asset_remove", json!({ "id": id, "asset_id": asset }));
    assert!(assets(&w, &id).is_empty());
    assert_eq!(
        w.one::<String>(
            "SELECT slot FROM revision_blob WHERE blob = ?1 LIMIT 1",
            &[&hash]
        ),
        format!("asset:{asset}")
    );
    let seq = w.one::<i64>(
        "SELECT seq FROM revision WHERE entity_id = ?1 ORDER BY seq DESC LIMIT 1",
        &[&id],
    );
    // `note.restore_version` is the words alone; the shared restore puts the whole note back.
    w.ok("note.restore_version", json!({ "id": id, "seq": seq }));
    assert!(assets(&w, &id).is_empty());
    w.ok("history.restore_version", json!({ "id": id, "seq": seq }));
    assert_eq!(assets(&w, &id), ["keep.png"]);
    assert_eq!(
        w.one::<String>("SELECT blob FROM note_asset WHERE note_id = ?1", &[&id]),
        hash
    );
}

// ---------------------------------------------------------------------------------------------
// 7. Search
// ---------------------------------------------------------------------------------------------

#[test]
fn a_notes_title_and_body_are_searchable_now_and_in_earlier_versions() {
    let w = world("note_search");
    let id = note(&w, "Quokka plan", "marmoset words");
    let now = |word: &str| {
        w.one::<i64>(
            "SELECT count(DISTINCT e.id) FROM search s JOIN entity e ON e.n = s.rowid
              WHERE search MATCH ?1 AND e.id = ?2",
            &[&format!("\"{word}\""), &id],
        )
    };
    let before = |word: &str| {
        w.one::<i64>(
            "SELECT count(DISTINCT e.id) FROM search_past t JOIN entity e ON e.n = (t.rowid >> 24)
              WHERE search_past MATCH ?1",
            &[&format!("\"{word}\"")],
        )
    };
    assert_eq!((now("quokka"), now("marmoset")), (1, 1));
    assert_eq!(
        before("marmoset"),
        0,
        "nothing was said before the first save"
    );
    w.ok(
        "note.edit",
        json!({ "id": id, "body": "wombat words", "title": "Numbat plan" }),
    );
    assert_eq!((now("wombat"), now("numbat")), (1, 1));
    assert_eq!(
        (now("marmoset"), now("quokka")),
        (0, 0),
        "not in the present"
    );
    assert_eq!(
        before("marmoset"),
        1,
        "but found in the version that said it"
    );
    assert_eq!(before("quokka"), 1);
    // The notebook's name finds its notes.
    let book = w.container("notebook", "Cartography");
    w.ok("entity.move", json!({ "id": id, "parent": book }));
    assert_eq!(now("cartography"), 1);
}

#[test]
fn restoring_a_version_with_an_earlier_title_resolves_the_mentions_waiting_for_it() {
    let w = world("note_restore_title");
    let target = note(&w, "Old Name", "");
    w.ok("note.edit", json!({ "id": target, "title": "New Name" }));
    let waiting = note(&w, "waits", "[[Old Name]]");
    assert_eq!(mentions(&w, &waiting)[0].1, None);
    let seq = w.one::<i64>(
        "SELECT seq FROM revision WHERE entity_id = ?1 ORDER BY seq LIMIT 1",
        &[&target],
    );
    w.ok(
        "history.restore_version",
        json!({ "id": target, "seq": seq }),
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&target]),
        "Old Name"
    );
    assert_eq!(
        mentions(&w, &waiting)[0].1.as_deref(),
        Some(target.as_str())
    );
}
