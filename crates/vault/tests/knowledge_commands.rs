//! THE NINE `knowledge.*` COMMANDS AND THE FIVE `core.*` ONES NOTES WRITES
//! THROUGH (#1020 slot 4c).
//!
//! `crates/apps/notes/tests/parity.rs` replays a generated script and compares
//! rows; this suite is the other half of the same proof — the behaviours a
//! script cannot show, each one a claim a port gets wrong:
//!
//! 1. **A note's body is deduped on the TEXT.** Two notes with the same words
//!    share one content item; a third with a different FORMAT still shares the
//!    bytes and carries its OWN representation (#996 R20(b), drift ONT-28) —
//!    "a markdown note filed after an identical plain one was markdown to
//!    nobody".
//! 2. **A no-op edit records no occurrence.** Editing a note back to the body it
//!    already has deduplicates onto the same content id, and a revision that
//!    revised nothing is not recorded.
//! 3. **History never rewrites** (#996 R20(a)). A→B→A is three occurrences, a
//!    restore is a new FORWARD one, and a content id from another note's history
//!    is refused by name — which is a different answer from "no such version"
//!    and only detectable because a revision has an identity of its own.
//! 4. **A long body is refused before anything is minted**, and the budget is
//!    64 KiB rather than the 1 MiB replica ceiling (D-1020-N4).
//! 5. **Delete is trash and the bytes are RENTED.** A trashed note releases its
//!    body only when nothing else holds it, and restoring rents it back.
//! 6. **Unlink is temporal.** The row survives with `valid_to` set; a second
//!    assertion of the same relationship is then allowed again.
//! 7. **Every refusal is receipted, not thrown** — asserted through
//!    `Vault::execute`'s own answer, which is the shape a surface renders.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandOutcome, CommandStatus, Vault};
use serde_json::{Value, json};

/// A founded vault with the registry installed, and its owner's principal.
struct Notebook {
    scratch: common::Scratch,
    registry: Registry,
    principal: Principal,
}

impl Notebook {
    fn open(seed: &str) -> Self {
        let scratch = common::Scratch::founded(seed).expect("a vault is founded");
        let registry = Registry::with_system_commands().expect("the registry builds");
        registry
            .install(&scratch.vault)
            .expect("the registry's record installs");
        Self {
            scratch,
            registry,
            principal: Principal::owner("phone"),
        }
    }

    fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    fn run(&self, command: &str, input: Value) -> Value {
        let outcome = self.try_run(command, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "`{command}` refused: {:?} / {:?}",
            outcome.predicate,
            outcome.reason
        );
        outcome.output
    }

    /// Run a command and hand back whatever it settled as — including a
    /// receipted refusal, which is a VALUE and not an `Err`.
    fn try_run(&self, command: &str, input: Value) -> CommandOutcome {
        self.vault()
            .execute(
                &self.registry,
                &self.principal,
                &Command::new(command, input),
            )
            .unwrap_or_else(|error| panic!("`{command}` errored rather than answering: {error}"))
    }

    fn count(&self, sql: &str, binds: &[&str]) -> i64 {
        self.vault()
            .read(|connection| {
                let params: Vec<&dyn rusqlite::ToSql> = binds
                    .iter()
                    .map(|bind| bind as &dyn rusqlite::ToSql)
                    .collect();
                Ok(connection.query_row(sql, params.as_slice(), |row| row.get(0))?)
            })
            .expect("the count reads")
    }

    fn text(&self, sql: &str, binds: &[&str]) -> Option<String> {
        self.vault()
            .read(|connection| {
                let params: Vec<&dyn rusqlite::ToSql> = binds
                    .iter()
                    .map(|bind| bind as &dyn rusqlite::ToSql)
                    .collect();
                Ok(connection
                    .query_row(sql, params.as_slice(), |row| {
                        row.get::<_, Option<String>>(0)
                    })
                    .ok()
                    .flatten())
            })
            .expect("the read runs")
    }

    fn note(&self, title: &str, body: &str, format: &str) -> String {
        self.run(
            "knowledge.create_note",
            json!({ "title": title, "body_text": body, "format": format }),
        )["note_id"]
            .as_str()
            .expect("a note id")
            .to_owned()
    }
}

fn id(output: &Value, key: &str) -> String {
    output[key].as_str().expect("an id").to_owned()
}

// ---------------------------------------------------------------------------
// Bodies, dedupe and representations
// ---------------------------------------------------------------------------

/// THE SAME WORDS ARE ONE CONTENT ITEM, AND TWO NOTES ARE TWO NOTES.
#[test]
fn two_notes_with_the_same_body_share_the_bytes_and_keep_their_own_reading() {
    let vault = Notebook::open("notes-dedupe");
    let plain = vault.note("Shopping", "Milk and bread.", "plain");
    let markdown = vault.note("Shopping, again", "Milk and bread.", "markdown");
    assert_ne!(plain, markdown);

    let body_of = |note_id: &str| {
        vault
            .text(
                "SELECT body_content_id FROM knowledge_note WHERE note_id = ?1",
                &[note_id],
            )
            .expect("a body")
    };
    assert_eq!(
        body_of(&plain),
        body_of(&markdown),
        "the bytes are deduped on the text"
    );
    assert_eq!(
        vault.count("SELECT COUNT(*) FROM core_content_item", &[]),
        1,
        "one content item for one body"
    );

    // THE READING IS THE NOTE'S. Before #996 R20(b) the second note took the
    // first's media type off the deduped row, and "a markdown note filed after
    // an identical plain one was markdown to nobody".
    let reading = |note_id: &str| {
        vault.text(
            "SELECT media_type FROM core_content_representation
              WHERE owner_type = 'knowledge.note' AND owner_id = ?1",
            &[note_id],
        )
    };
    assert_eq!(reading(&plain).as_deref(), Some("text/plain"));
    assert_eq!(reading(&markdown).as_deref(), Some("text/markdown"));
}

/// A format outside the enum is refused by the SCHEMA, receipted, and mints
/// nothing.
#[test]
fn a_format_the_enum_does_not_name_is_a_receipted_refusal() {
    let vault = Notebook::open("notes-format");
    let refused = vault.try_run(
        "knowledge.create_note",
        json!({ "title": "Odd", "body_text": "x", "format": "latex" }),
    );
    assert_eq!(refused.status, CommandStatus::Failed);
    assert_eq!(refused.predicate.as_deref(), Some("schema"));
    assert!(!refused.receipt_id.is_empty(), "a deny is receipted too");
    assert_eq!(vault.count("SELECT COUNT(*) FROM knowledge_note", &[]), 0);
}

/// **THE INLINE BUDGET, AND IT IS NOT THE 1 MiB CEILING** (D-1020-N4).
///
/// A text body cannot redirect to the CAS — the FTS feed decodes it
/// in-transaction — so the command refuses at ~64 KiB. The 1 MiB figure is
/// `core.content_item`'s replica text ceiling, a rule about when a SEAT stops
/// carrying a value, and it is sixteen times looser. A body between the two is
/// refused here, which is the case that tells them apart.
#[test]
fn a_body_over_the_inline_budget_is_refused_before_anything_is_minted() {
    let vault = Notebook::open("notes-long-body");
    let under = "a".repeat(64 * 1024);
    let over = "a".repeat(64 * 1024 + 1);
    let between = "a".repeat(600 * 1024);

    vault.run(
        "knowledge.create_note",
        json!({ "title": "At the budget", "body_text": under }),
    );
    for (case, body) in [("just over", over), ("under 1 MiB", between)] {
        let refused = vault.try_run(
            "knowledge.create_note",
            json!({ "title": "Too long", "body_text": body }),
        );
        assert_eq!(refused.status, CommandStatus::Failed, "{case}");
        assert_eq!(
            refused.predicate.as_deref(),
            Some("body_text_within_budget"),
            "{case}"
        );
        let reason = refused.reason.unwrap_or_default();
        assert!(
            reason.contains("inline") && reason.contains("65536"),
            "{case}: {reason}"
        );
    }
    assert_eq!(
        vault.count("SELECT COUNT(*) FROM knowledge_note", &[]),
        1,
        "the refusals minted nothing"
    );
    assert_eq!(
        vault.count("SELECT COUNT(*) FROM core_content_item", &[]),
        1
    );

    // AND AN EDIT IS GATED TOO: the budget is about the body, not about which
    // command carries it.
    let note = vault.note("Short", "Two words.", "plain");
    let edit = vault.try_run(
        "knowledge.edit_note",
        json!({ "note_id": note, "body_text": "b".repeat(64 * 1024 + 1) }),
    );
    assert_eq!(edit.status, CommandStatus::Failed);
    assert_eq!(edit.predicate.as_deref(), Some("body_text_within_budget"));
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

/// A→B→A IS THREE OCCURRENCES, and the restore is the third.
#[test]
fn history_is_appended_to_and_a_restore_is_a_new_forward_occurrence() {
    let vault = Notebook::open("notes-history");
    let note = vault.note("Cabin", "Book the cabin.", "markdown");
    let first = vault
        .text(
            "SELECT body_content_id FROM knowledge_note WHERE note_id = ?1",
            &[&note],
        )
        .expect("a body");
    let edited = vault.run(
        "knowledge.edit_note",
        json!({ "note_id": note, "body_text": "Book the cabin. Ask about the dog." }),
    );
    let second = id(&edited, "body_content_id");
    assert_ne!(first, second);

    let restored = vault.run(
        "knowledge.restore_note_version",
        json!({ "note_id": note, "content_id": first }),
    );
    assert_eq!(id(&restored, "content_id"), first);

    // THREE occurrences, and the head names the restored body with a parent —
    // which is what says history was appended to rather than moved.
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM core_entity_revision
              WHERE entity_type = 'knowledge.note' AND entity_id = ?1",
            &[&note],
        ),
        3
    );
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM knowledge_note n
               JOIN core_entity_revision r ON r.revision_id = n.current_revision_id
              WHERE n.note_id = ?1 AND r.content_id = ?2 AND r.parent_revision_id IS NOT NULL",
            &[&note, &first],
        ),
        1
    );
    // AND THE SECOND GRAPH IS GONE: no content→content `revises` link, and no
    // such relation concept at all (drift ONT-22, #996 R20(a)).
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM core_link l
               JOIN core_concept c ON c.concept_id = l.relation_concept_id
              WHERE c.notation = 'revises'",
            &[],
        ),
        0
    );
}

/// A NO-OP EDIT RECORDS NO OCCURRENCE, because it revised nothing.
#[test]
fn an_edit_back_to_the_same_body_records_no_revision() {
    let vault = Notebook::open("notes-noop");
    let note = vault.note("Cabin", "Book the cabin.", "markdown");
    let before = vault.count(
        "SELECT COUNT(*) FROM core_entity_revision WHERE entity_id = ?1",
        &[&note],
    );
    vault.run(
        "knowledge.edit_note",
        json!({ "note_id": note, "body_text": "Book the cabin." }),
    );
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM core_entity_revision WHERE entity_id = ?1",
            &[&note],
        ),
        before,
        "dedup landed on the same content id, so nothing was revised"
    );
}

/// A REVISION BELONGS TO ONE OBJECT. A content id from another note's history
/// is refused — and so is one already current, which is a different refusal.
#[test]
fn a_foreign_or_already_current_version_is_refused_by_its_own_gate() {
    let vault = Notebook::open("notes-foreign");
    let mine = vault.note("Mine", "My words.", "plain");
    let theirs = vault.note("Theirs", "Their words.", "plain");
    let their_body = vault
        .text(
            "SELECT body_content_id FROM knowledge_note WHERE note_id = ?1",
            &[&theirs],
        )
        .expect("a body");
    let my_body = vault
        .text(
            "SELECT body_content_id FROM knowledge_note WHERE note_id = ?1",
            &[&mine],
        )
        .expect("a body");

    let foreign = vault.try_run(
        "knowledge.restore_note_version",
        json!({ "note_id": mine, "content_id": their_body }),
    );
    assert_eq!(foreign.status, CommandStatus::Failed);
    assert_eq!(foreign.predicate.as_deref(), Some("target_in_chain"));

    let already = vault.try_run(
        "knowledge.restore_note_version",
        json!({ "note_id": mine, "content_id": my_body }),
    );
    assert_eq!(already.status, CommandStatus::Failed);
    assert_eq!(already.predicate.as_deref(), Some("not_already_current"));
}

// ---------------------------------------------------------------------------
// Notebooks
// ---------------------------------------------------------------------------

/// ONE NOTEBOOK PER NOTE, and unfiling is as explicit an intent as filing.
#[test]
fn a_note_is_singly_placed_and_omitting_the_notebook_unfiles_it() {
    let vault = Notebook::open("notes-filing");
    let travel = id(
        &vault.run("knowledge.create_notebook", json!({ "name": "Travel" })),
        "notebook_id",
    );
    let recipes = id(
        &vault.run("knowledge.create_notebook", json!({ "name": "Recipes" })),
        "notebook_id",
    );
    let note = id(
        &vault.run(
            "knowledge.create_note",
            json!({ "title": "Chili", "body_text": "Brown the chuck.", "notebook_id": recipes }),
        ),
        "note_id",
    );
    let placements = |note_id: &str| {
        vault.count(
            "SELECT COUNT(*) FROM core_collection_entry
              WHERE target_type = 'knowledge.note' AND target_id = ?1",
            &[note_id],
        )
    };
    assert_eq!(placements(&note), 1);

    vault.run(
        "knowledge.move_note",
        json!({ "note_id": note, "notebook_id": travel }),
    );
    assert_eq!(placements(&note), 1, "moving refiles, never adds");
    assert_eq!(
        vault
            .text(
                "SELECT collection_id FROM core_collection_entry
              WHERE target_type = 'knowledge.note' AND target_id = ?1",
                &[&note],
            )
            .as_deref(),
        Some(travel.as_str())
    );

    vault.run("knowledge.move_note", json!({ "note_id": note }));
    assert_eq!(placements(&note), 0, "an omitted notebook unfiles");
}

/// TWO NOTEBOOKS WITH ONE NAME ARE INDISTINGUISHABLE, so both gates refuse —
/// and renaming a notebook to its OWN name is a no-op rather than a refusal.
#[test]
fn a_duplicate_notebook_name_is_refused_at_create_and_at_rename() {
    let vault = Notebook::open("notes-names");
    let travel = id(
        &vault.run("knowledge.create_notebook", json!({ "name": "Travel" })),
        "notebook_id",
    );
    let recipes = id(
        &vault.run("knowledge.create_notebook", json!({ "name": "Recipes" })),
        "notebook_id",
    );

    let clash = vault.try_run("knowledge.create_notebook", json!({ "name": "Travel" }));
    assert_eq!(clash.status, CommandStatus::Failed);
    assert_eq!(clash.predicate.as_deref(), Some("name_unused"));

    let rename_clash = vault.try_run(
        "knowledge.rename_notebook",
        json!({ "notebook_id": recipes, "name": "Travel" }),
    );
    assert_eq!(rename_clash.status, CommandStatus::Failed);
    assert_eq!(
        rename_clash.predicate.as_deref(),
        Some("name_unused_by_owner")
    );

    // Its own name: an idempotent no-op.
    vault.run(
        "knowledge.rename_notebook",
        json!({ "notebook_id": travel, "name": "Travel" }),
    );
}

/// DELETING A NOTEBOOK UNFILES AND NEVER DESTROYS, and a notebook that still
/// holds notebooks is refused.
#[test]
fn deleting_a_notebook_unfiles_its_notes_and_refuses_while_children_exist() {
    let vault = Notebook::open("notes-delete-notebook");
    let parent = id(
        &vault.run("knowledge.create_notebook", json!({ "name": "Trips" })),
        "notebook_id",
    );
    let child = id(
        &vault.run(
            "knowledge.create_notebook",
            json!({ "name": "Tahoe", "parent_notebook_id": parent }),
        ),
        "notebook_id",
    );
    let note = id(
        &vault.run(
            "knowledge.create_note",
            json!({ "title": "Shortlist", "body_text": "South Lake.", "notebook_id": child }),
        ),
        "note_id",
    );

    let refused = vault.try_run(
        "knowledge.delete_notebook",
        json!({ "notebook_id": parent }),
    );
    assert_eq!(refused.status, CommandStatus::Failed);
    assert_eq!(
        refused.predicate.as_deref(),
        Some("notebook_has_no_children")
    );

    let deleted = vault.run("knowledge.delete_notebook", json!({ "notebook_id": child }));
    assert_eq!(deleted["notes_unfiled"], json!(1));
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM knowledge_note WHERE note_id = ?1 AND deleted_at IS NULL",
            &[&note],
        ),
        1,
        "the member note survives, unfiled"
    );
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM core_collection_entry WHERE collection_id = ?1",
            &[&child],
        ),
        0
    );
}

// ---------------------------------------------------------------------------
// The trash
// ---------------------------------------------------------------------------

/// DELETE IS TRASH, AND THE BYTES ARE RENTED. A body another live note still
/// holds is not released; restoring rents a released one back.
#[test]
fn trashing_a_note_releases_only_a_body_nothing_else_holds() {
    let vault = Notebook::open("notes-trash");
    let shared_one = vault.note("One", "Shared words.", "plain");
    let shared_two = vault.note("Two", "Shared words.", "plain");
    let alone = vault.note("Alone", "My own words.", "plain");

    let kept = vault.run("knowledge.delete_note", json!({ "note_id": shared_one }));
    assert_eq!(
        kept["body_released"],
        json!(0),
        "the other note still rents those bytes"
    );

    let released = vault.run("knowledge.delete_note", json!({ "note_id": alone }));
    assert_eq!(released["body_released"], json!(1));
    let alone_body = vault
        .text(
            "SELECT body_content_id FROM knowledge_note WHERE note_id = ?1",
            &[&alone],
        )
        .expect("a body");
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM core_content_item
              WHERE content_id = ?1 AND deleted_at IS NOT NULL",
            &[&alone_body],
        ),
        1
    );

    // A TRASHED NOTE IS FROZEN: restore first, then edit.
    let frozen = vault.try_run(
        "knowledge.edit_note",
        json!({ "note_id": alone, "title": "No" }),
    );
    assert_eq!(frozen.status, CommandStatus::Failed);
    assert_eq!(frozen.predicate.as_deref(), Some("note_is_live"));

    vault.run("knowledge.restore_note", json!({ "note_id": alone }));
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM core_content_item
              WHERE content_id = ?1 AND deleted_at IS NULL",
            &[&alone_body],
        ),
        1,
        "restoring rents the bytes back"
    );
    let _ = shared_two;
}

/// The purge window is thirty days from `ctx.now`, and a note that is not in the
/// trash cannot be restored.
#[test]
fn the_trash_window_is_thirty_days_and_a_live_note_cannot_be_restored() {
    let vault = Notebook::open("notes-window");
    let note = vault.note("Cabin", "Book it.", "plain");
    let live = vault.try_run("knowledge.restore_note", json!({ "note_id": note }));
    assert_eq!(live.status, CommandStatus::Failed);
    assert_eq!(live.predicate.as_deref(), Some("note_in_trash"));

    let trashed = vault.run("knowledge.delete_note", json!({ "note_id": note }));
    let purge_at = trashed["purge_at"].as_str().expect("an instant").to_owned();
    let deleted_at = vault
        .text(
            "SELECT deleted_at FROM knowledge_note WHERE note_id = ?1",
            &[&note],
        )
        .expect("an instant");
    let days = (centraid_vault::clock::parse_iso_ms(&purge_at).expect("an instant")
        - centraid_vault::clock::parse_iso_ms(&deleted_at).expect("an instant"))
        / 86_400_000;
    assert_eq!(days, 30);
}

// ---------------------------------------------------------------------------
// Links, anchors and attachments
// ---------------------------------------------------------------------------

/// UNLINK IS TEMPORAL, NOT DESTRUCTIVE — and that is what lets the same
/// relationship be reasserted afterwards.
#[test]
fn unlink_ends_a_link_rather_than_deleting_it_and_the_relation_may_be_reasserted() {
    let vault = Notebook::open("notes-links");
    let from = vault.note("Cabin", "Book it.", "plain");
    let to = vault.note("Budget", "About $180 a night.", "plain");

    let linked = vault.run(
        "core.link_entities",
        json!({
            "from_type": "knowledge.note", "from_id": from,
            "to_type": "knowledge.note", "to_id": to,
            "relation": "references",
        }),
    );
    let link_id = id(&linked, "link_id");
    assert_eq!(
        vault
            .text(
                "SELECT asserted_by FROM core_link WHERE link_id = ?1",
                &[&link_id],
            )
            .as_deref(),
        Some("owner")
    );

    let duplicate = vault.try_run(
        "core.link_entities",
        json!({
            "from_type": "knowledge.note", "from_id": from,
            "to_type": "knowledge.note", "to_id": to,
            "relation": "references",
        }),
    );
    assert_eq!(duplicate.status, CommandStatus::Failed);
    assert_eq!(
        duplicate.predicate.as_deref(),
        Some("no_identical_live_link")
    );

    vault.run("core.unlink_entities", json!({ "link_id": link_id }));
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM core_link WHERE link_id = ?1 AND valid_to IS NOT NULL",
            &[&link_id],
        ),
        1,
        "ended, not erased"
    );
    // AND NOW THE SAME RELATIONSHIP MAY BE REASSERTED.
    vault.run(
        "core.link_entities",
        json!({
            "from_type": "knowledge.note", "from_id": from,
            "to_type": "knowledge.note", "to_id": to,
            "relation": "references",
        }),
    );
}

/// LINKS DO NOT LINK LINKS, an entity cannot link to itself, and a relation the
/// vault does not know is refused rather than created.
#[test]
fn the_three_link_refusals_are_each_their_own_gate() {
    let vault = Notebook::open("notes-link-gates");
    let note = vault.note("Cabin", "Book it.", "plain");
    let other = vault.note("Budget", "About $180.", "plain");
    let link_id = id(
        &vault.run(
            "core.link_entities",
            json!({
                "from_type": "knowledge.note", "from_id": note,
                "to_type": "knowledge.note", "to_id": other,
                "relation": "references",
            }),
        ),
        "link_id",
    );

    let invented = vault.try_run(
        "core.link_entities",
        json!({
            "from_type": "knowledge.note", "from_id": note,
            "to_type": "knowledge.note", "to_id": other,
            "relation": "smells-like",
        }),
    );
    assert_eq!(invented.predicate.as_deref(), Some("relation_in_scheme"));

    let itself = vault.try_run(
        "core.link_entities",
        json!({
            "from_type": "knowledge.note", "from_id": note,
            "to_type": "knowledge.note", "to_id": note,
            "relation": "references",
        }),
    );
    assert_eq!(itself.predicate.as_deref(), Some("not_a_self_link"));

    let a_link = vault.try_run(
        "core.link_entities",
        json!({
            "from_type": "knowledge.note", "from_id": note,
            "to_type": "core.link", "to_id": link_id,
            "relation": "references",
        }),
    );
    assert_eq!(
        a_link.predicate.as_deref(),
        Some("endpoints_are_live_and_readable")
    );
    assert_eq!(
        a_link.reason.as_deref(),
        Some("Links do not link links."),
        "the sentence is the one a member reads"
    );
}

/// AN ANCHOR IS A LOCATOR, so an inline selector rides the link atomically, a
/// second one replaces it, and clearing it is a HARD delete.
#[test]
fn an_anchor_is_upserted_with_the_link_and_clearing_it_deletes_the_row() {
    let vault = Notebook::open("notes-anchor");
    let from = vault.note("Cabin", "Book the cabin. Ask about the dog.", "markdown");
    let to = vault.note("Dog", "She is fine with kennels.", "plain");
    let link_id = id(
        &vault.run(
            "core.link_entities",
            json!({
                "from_type": "knowledge.note", "from_id": from,
                "to_type": "knowledge.note", "to_id": to,
                "relation": "references",
                "selector": {
                    "exact": "the dog", "prefix": "Ask about ", "suffix": "", "start": 26
                },
            }),
        ),
        "link_id",
    );
    let selector = vault
        .text(
            "SELECT selector_json FROM core_link_anchor WHERE link_id = ?1",
            &[&link_id],
        )
        .expect("a selector");
    let parsed: Value = serde_json::from_str(&selector).expect("the selector is JSON");
    assert_eq!(parsed["exact"], json!("the dog"));
    assert_eq!(parsed["start"], json!(26));

    // Re-anchoring UPSERTS: one anchor per link, by the table's own UNIQUE.
    vault.run(
        "core.anchor_link",
        json!({
            "link_id": link_id,
            "selector": { "exact": "cabin", "prefix": "Book the ", "suffix": ".", "start": 9 },
        }),
    );
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM core_link_anchor WHERE link_id = ?1",
            &[&link_id],
        ),
        1
    );

    // Clearing it is a hard delete — a locator is presentation, not history.
    vault.run("core.anchor_link", json!({ "link_id": link_id }));
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM core_link_anchor WHERE link_id = ?1",
            &[&link_id],
        ),
        0
    );
    assert_eq!(
        vault.count(
            "SELECT COUNT(*) FROM core_link WHERE link_id = ?1 AND valid_to IS NULL",
            &[&link_id],
        ),
        1,
        "the link is untouched"
    );
}

/// THE FIRST ATTACHMENT IS PRIMARY, and DETACHING THE LAST REFERENCE RELEASES
/// THE BYTES (#916, adversarial BUG-6).
#[test]
fn the_first_attachment_is_primary_and_the_last_detach_releases_the_bytes() {
    let vault = Notebook::open("notes-attach");
    let note = vault.note("Cabin", "Book it.", "plain");
    let first = vault.run(
        "core.attach",
        json!({
            "subject_type": "knowledge.note", "subject_id": note,
            "data_uri": "data:text/plain;charset=utf-8,the%20confirmation",
            "role": "receipt",
        }),
    );
    assert_eq!(first["is_primary"], json!(1));
    let second = vault.run(
        "core.attach",
        json!({
            "subject_type": "knowledge.note", "subject_id": note,
            "data_uri": "data:text/plain;charset=utf-8,the%20directions",
        }),
    );
    assert_eq!(second["is_primary"], json!(0));
    // A role nothing declared for text is `other`, not `photo`.
    assert_eq!(
        vault
            .text(
                "SELECT role FROM core_attachment WHERE attachment_id = ?1",
                &[&id(&second, "attachment_id")],
            )
            .as_deref(),
        Some("other")
    );
    // THE ATTACHMENT'S OWN READING of the bytes.
    assert_eq!(
        vault
            .text(
                "SELECT media_type FROM core_content_representation
                  WHERE owner_type = 'core.attachment' AND owner_id = ?1",
                &[&id(&first, "attachment_id")],
            )
            .as_deref(),
        Some("text/plain")
    );

    let detached = vault.run(
        "core.detach",
        json!({ "attachment_id": id(&first, "attachment_id") }),
    );
    assert_eq!(
        detached["content_released"],
        json!(1),
        "nothing else referenced those bytes"
    );

    let gone = vault.try_run(
        "core.detach",
        json!({ "attachment_id": id(&first, "attachment_id") }),
    );
    assert_eq!(gone.status, CommandStatus::Failed);
    assert_eq!(gone.predicate.as_deref(), Some("attachment_exists"));
}

/// A file cannot be pinned to something the allow-list does not name, and the
/// refusal is receipted rather than turned into SQL.
#[test]
fn an_unknown_attachment_subject_is_refused_by_the_allow_list() {
    let vault = Notebook::open("notes-attach-subject");
    let refused = vault.try_run(
        "core.attach",
        json!({
            "subject_type": "core.vault", "subject_id": "whatever",
            "data_uri": "data:text/plain,x",
        }),
    );
    assert_eq!(refused.status, CommandStatus::Failed);
    // The SCHEMA's enum catches it first, which is the earliest honest gate.
    assert_eq!(refused.predicate.as_deref(), Some("schema"));
}

/// **A CREATED NOTE'S `updated_at` IS THE VAULT'S CLOCK, NOT THE HOST'S**
/// (R-1020-35; #1020, D-1020-N10).
///
/// `create_note` inserts the row and then repoints `current_revision_id` — and
/// `knowledge_note_touch_updated_at` fires `WHEN NEW.row_version =
/// OLD.row_version` and stamps `updated_at` with `strftime('now')` whenever the
/// update does not carry a new one. So the second statement of every note
/// creation overwrote the injected clock with the machine's wall clock.
///
/// It is invisible in production, where the two are the same instant, and it is
/// not invisible anywhere the clock is injected: the library sorts newest
/// `updated_at` first, so **a parity fixture's page order became a fact about
/// the host** rather than about the data. Four of the six notes in
/// `contracts/apps/notes/rows.json` carried `(host-clock)` before this, and the
/// Rust replay — which reads the tokenised rows — ordered them by `note_id`
/// while v0 had ordered them by microseconds nobody can reproduce.
///
/// Fixed at source on both sides: this command carries `updated_at` through the
/// repoint, and so does v0's (`packages/vault/src/commands/knowledge.ts`).
#[test]
fn a_created_notes_updated_at_is_the_injected_clock() {
    let vault = Notebook::open("notes-clock");
    let note = vault.note("Cabin", "Book it.", "plain");
    let now = vault.vault().clock().now_text();
    let (created, updated) = vault
        .vault()
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT created_at, updated_at FROM knowledge_note WHERE note_id = ?1",
                [&note],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )?)
        })
        .expect("the note reads");
    assert_eq!(
        created, updated,
        "a note nobody has edited was last updated when it was created"
    );
    assert_eq!(
        updated, now,
        "and that instant is the vault's clock, not the machine's"
    );
}

/// A NOTEBOOK HAS THE SAME SHAPE and does NOT have the problem, because
/// `create_notebook` writes one statement. Asserted so a later edit that adds a
/// second one is caught here rather than in a fixture's page order.
#[test]
fn a_created_notebook_is_written_in_one_statement() {
    let vault = Notebook::open("notes-clock-notebook");
    let notebook = id(
        &vault.run("knowledge.create_notebook", json!({ "name": "Travel" })),
        "notebook_id",
    );
    let version: i64 = vault.count(
        "SELECT row_version FROM core_collection WHERE collection_id = ?1",
        &[&notebook],
    );
    assert_eq!(version, 1, "one gesture, one version");
}
