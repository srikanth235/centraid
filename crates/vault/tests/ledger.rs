//! The `ledger` band, held to what v0 described (#1020, wave 4 lane assist,
//! D-1020-AS3).
//!
//! ## Why there is no migration in this slot, and what replaces it
//!
//! The brief asked for `contracts/migrations/<next>_ledger.sql` carrying the
//! band's fourteen tables. There is no such file, because **the band is already
//! on rung one**: wave 2 exported `contracts/migrations/001_baseline.sql` from
//! the whole v0 corpus rather than band by band, so every one of the fourteen
//! tables, the `run_summary` view, both indexes and all eight triggers were
//! already there, and `ledger` was already registered as a machinery band with
//! all fourteen tables in `localTables`. A second `CREATE TABLE conversations`
//! would simply fail.
//!
//! So the DDL is not this slot's to write — it is this slot's to **hold**, and
//! that is what this file does. Every claim D-1020-AS3 makes is a test here,
//! against a real founded vault rather than against the text of the baseline:
//! the closed vocabularies are checked by trying to insert a value outside
//! them, and the delete rules by deleting a parent and counting what went with
//! it. A test that read the SQL would prove the file says the right thing; this
//! proves SQLite does it.

use centraid_vault::ledger::schema::{
    self, AUTOMATION_OWNED, FTS_TABLE, LEDGER_INDEXES, LEDGER_TABLES, LEDGER_TRIGGERS,
    RUN_SUMMARY_VIEW,
};
use centraid_vault::ledger::store::{ConversationKind, Item, ItemKind, Store, TurnTrigger};
use centraid_vault::ledger::{archive, consent, health};
use centraid_vault::{Clock, FixedClock, SeededIds, Vault};

/// A founded vault with an injected clock and id source.
///
/// ONE OPEN PER TEST. `Vault::open` restarts `SeededIds`, so the first write
/// after a reopen collides with the first id the earlier open handed out (lane
/// X3 is fixing it at source); every test here founds its file once and keeps
/// the handle.
struct Fixture {
    vault: Vault,
    clock: std::sync::Arc<FixedClock>,
    _temp: tempfile::TempDir,
}

/// A fixed instant past the host clock, so a `purge_at` in a fixture is in the
/// future wherever this runs (common brief, wave 4 law 6).
const EPOCH: i64 = 1_800_000_000_000;

impl Fixture {
    /// Run raw SQL through the commit guard.
    ///
    /// The typed store cannot express a value outside a closed vocabulary, and
    /// that is the point: the CHECK is the backstop for a writer that is not
    /// the typed store, so the tests that exercise it have to be one.
    fn raw(&self, sql: &str) -> centraid_vault::Result<()> {
        self.vault
            .commit(|tx| {
                tx.set_producer("test");
                tx.connection()
                    .execute_batch(sql)
                    .map_err(|error| centraid_vault::VaultError::from_sqlite("test sql", error))
            })
            .map(|_| ())
    }

    fn count(&self, sql: &str) -> i64 {
        self.vault
            .read(|connection| {
                connection
                    .query_row(sql, [], |row| row.get::<_, i64>(0))
                    .map_err(|error| centraid_vault::VaultError::from_sqlite("test count", error))
            })
            .expect("a count")
    }
}

fn founded(seed: &str) -> Fixture {
    let temp = tempfile::tempdir().expect("tempdir");
    let path = temp.path().join("vault.db");
    let clock = std::sync::Arc::new(FixedClock::at(EPOCH));
    let vault = Vault::create_with(
        &path,
        Box::new(std::sync::Arc::clone(&clock)),
        Box::new(SeededIds::new(seed)),
    )
    .expect("founding a vault");
    Fixture {
        vault,
        clock,
        _temp: temp,
    }
}

#[test]
fn the_band_is_registered_as_machinery_and_never_leaves_the_gateway() {
    schema::assert_band_registration().expect("the band's registration is the registry's");
    // Restated as a count so a table added to the band without a `localTables`
    // entry is a failure here and not a silently replicated transcript.
    let local = centraid_ontology::registries::local_table_names();
    let inside = LEDGER_TABLES
        .iter()
        .filter(|table| local.contains(table))
        .count();
    assert_eq!(inside, 14);
}

#[test]
fn the_local_list_is_what_excludes_the_band_and_it_wins() {
    // A FINDING PINNED AS A TEST. Eleven of the fourteen ledger tables are in
    // v0's `replicatedTables` AS WELL AS its `localTables`, so
    // `is_replicated_table("items")` answers `true` — and a reader of that
    // function alone would conclude the assistant's transcript replicates to
    // every seat.
    //
    // It does not, because `localTables` wins: the commit guard logs those rows
    // with `local = 1` (`log/guard.rs:138`), and the log door filters
    // `local = 0` (`log/door.rs:191`). So the effective answer is the safe one.
    //
    // This test states the precedence rather than the membership, because the
    // membership is the part that is wrong and the precedence is the part the
    // product depends on. The registry overlap is a finding for the close pass,
    // recorded in the receipt: it must be narrowed in v0, not worked around
    // here.
    let local = centraid_ontology::registries::local_table_names();
    let overlapping: Vec<&str> = LEDGER_TABLES
        .into_iter()
        .filter(|table| centraid_ontology::registries::is_replicated_table(table))
        .collect();
    assert_eq!(
        overlapping.len(),
        11,
        "the overlap is a known v0 inconsistency; a change in its size is a change in the band's          exposure and must be re-judged, not re-counted: {overlapping:?}"
    );
    for table in overlapping {
        assert!(
            local.contains(&table),
            "{table} claims to be replicated and is NOT in the local list — that would actually \
             ship the transcript to every seat"
        );
    }
}

#[test]
fn every_object_the_band_needs_is_on_rung_one() {
    let fixture = founded("ledger-objects");
    let objects = fixture
        .vault
        .read(schema::objects)
        .expect("reading the schema");
    let named = |name: &str, kind: &str| {
        objects
            .iter()
            .any(|object| object.name == name && object.kind == kind)
    };
    for table in LEDGER_TABLES {
        assert!(named(table, "table"), "the baseline is missing {table}");
    }
    for index in LEDGER_INDEXES {
        assert!(named(index, "index"), "the baseline is missing {index}");
    }
    for trigger in LEDGER_TRIGGERS {
        assert!(
            named(trigger, "trigger"),
            "the baseline is missing {trigger}"
        );
    }
    assert!(named(RUN_SUMMARY_VIEW, "view"));
    assert!(named(FTS_TABLE, "table"), "the band's FTS index");

    // The two index PREDICATES, not just their names: `idx_items_turn_call`
    // is UNIQUE-partial and `idx_items_run_rollup` is the covering partial the
    // Insights rollup depends on. An index that lost its predicate would make
    // every `message_in` insert pay for a rollup it is not in.
    let turn_call = objects
        .iter()
        .find(|object| object.name == "idx_items_turn_call")
        .expect("present");
    assert!(turn_call.sql.contains("UNIQUE"));
    assert!(turn_call.sql.contains("call_id IS NOT NULL"));
    let rollup = objects
        .iter()
        .find(|object| object.name == "idx_items_run_rollup")
        .expect("present");
    assert!(rollup.sql.contains("'step'") && rollup.sql.contains("'delegate'"));
}

#[test]
fn the_band_carries_no_append_only_trigger() {
    // THE DIFFERENCE FROM `audit`, and the one that would break streaming. A
    // turn is amended as it arrives; a trigger that refused an UPDATE or a
    // DELETE on these tables would make the first item the last.
    let fixture = founded("ledger-mutable");
    let objects = fixture.vault.read(schema::objects).expect("schema");
    for object in objects.iter().filter(|object| object.kind == "trigger") {
        let touches_band = LEDGER_TABLES
            .iter()
            .any(|table| object.sql.contains(&format!(" ON {table} ")));
        if !touches_band {
            continue;
        }
        let lowered = object.sql.to_ascii_lowercase();
        assert!(
            !lowered.contains("raise(abort") && !lowered.contains("raise (abort"),
            "{} refuses a write to the band; the ledger is mutable",
            object.name
        );
    }
}

#[test]
fn the_five_automation_tables_are_part_of_the_one_band() {
    // §Cross-lane: assist owns the band and its DDL, automations owns the store
    // code over five of the fourteen. One band, one migration.
    for table in AUTOMATION_OWNED {
        assert!(
            LEDGER_TABLES.contains(&table),
            "{table} is the automations lane's state and must stay in this band"
        );
    }
}

#[test]
fn a_turn_and_its_items_count_and_roll_up() {
    let fixture = founded("ledger-rollup");
    let store = Store::new(&fixture.vault);
    let conversation = store
        .ensure_conversation(ConversationKind::Chat, "owner", None, "A question")
        .expect("open");
    let turn = store
        .open_turn(
            &conversation.id,
            TurnTrigger::Interactive,
            None,
            None,
            Some(120),
        )
        .expect("open a turn");

    for (ordinal, kind) in [
        (0, ItemKind::MessageIn),
        (1, ItemKind::Step),
        (2, ItemKind::Step),
        (3, ItemKind::Tool),
    ] {
        store
            .append_item(
                &turn.id,
                &Item {
                    kind: kind.as_str(),
                    ordinal,
                    call_id: (kind == ItemKind::Tool).then(|| "call-1".to_owned()),
                    model: Some("a-model".to_owned()),
                    harness: Some("codex".to_owned()),
                    input_tokens: Some(10),
                    output_tokens: Some(5),
                    ..Item::default()
                },
            )
            .expect("append");
    }

    let reread = store
        .conversation(&conversation.id)
        .expect("read")
        .expect("present");
    assert_eq!(reread.item_count, 4, "the item_count trigger");
    assert_eq!(
        reread.turn_count, 1,
        "turn_count has NO trigger — the store increments it"
    );

    // An open turn has no run_summary at all: the view is `WHERE ended_at IS
    // NOT NULL`, and an absence is the honest answer for a turn still running.
    assert!(store.run_summary(&turn.id).expect("read").is_none());

    store.close_turn(&turn.id, true, None).expect("close");
    let summary = store
        .run_summary(&turn.id)
        .expect("read")
        .expect("an ended turn has a summary");
    assert_eq!(summary.step_count, Some(2));
    assert_eq!(summary.tool_count, Some(1));
    assert_eq!(summary.model.as_deref(), Some("a-model"));
    assert_eq!(summary.harness.as_deref(), Some("codex"));
    assert_eq!(
        summary.effort, None,
        "no item confirmed an effort, and a default must never be inferred"
    );
}

#[test]
fn a_re_delivered_tool_result_updates_one_item_rather_than_adding_a_second() {
    let fixture = founded("ledger-upsert");
    let store = Store::new(&fixture.vault);
    let conversation = store
        .ensure_conversation(ConversationKind::Chat, "owner", None, "")
        .expect("open");
    let turn = store
        .open_turn(&conversation.id, TurnTrigger::Interactive, None, None, None)
        .expect("turn");
    let opening = Item {
        kind: ItemKind::Tool.as_str(),
        ordinal: 0,
        call_id: Some("c-9".to_owned()),
        args_json: Some(r#"{"sql":"select 1"}"#.to_owned()),
        ..Item::default()
    };
    store
        .append_item(&turn.id, &opening)
        .expect("open the call");
    store
        .append_item(
            &turn.id,
            &Item {
                output_json: Some(r#"{"rows":1}"#.to_owned()),
                ..opening.clone()
            },
        )
        .expect("close the call");
    store.close_turn(&turn.id, true, None).expect("close");
    let summary = store.run_summary(&turn.id).expect("read").expect("present");
    assert_eq!(
        summary.tool_count,
        Some(1),
        "ACP delivers the call and its result separately; two rows would double the count"
    );
}

#[test]
fn the_closed_vocabularies_refuse_a_value_outside_them() {
    let fixture = founded("ledger-checks");
    fixture
        .raw(
            "INSERT INTO conversations (id, kind, user_id, created_at, updated_at) \
             VALUES ('c1', 'chat', 'o', 1, 1);",
        )
        .expect("a legal kind");
    for bad in ["Chat", "thread", ""] {
        assert!(
            fixture
                .raw(&format!(
                    "INSERT INTO conversations (id, kind, user_id, created_at, updated_at) \
                     VALUES ('x', '{bad}', 'o', 1, 1);"
                ))
                .is_err(),
            "conversations.kind accepted {bad:?}"
        );
    }
    fixture
        .raw(
            "INSERT INTO turns (id, conversation_id, seq, trigger, started_at) \
             VALUES ('t1', 'c1', 0, 'interactive', 1);",
        )
        .expect("a legal trigger");
    assert!(
        fixture
            .raw(
                "INSERT INTO turns (id, conversation_id, seq, trigger, started_at) \
                 VALUES ('t2', 'c1', 1, 'webhook', 1);",
            )
            .is_err(),
        "turns.trigger accepted a value outside the six"
    );
    assert!(
        fixture
            .raw("UPDATE turns SET feedback = 'meh' WHERE id = 't1';")
            .is_err()
    );
    fixture
        .raw("UPDATE turns SET feedback = 'up' WHERE id = 't1';")
        .expect("up is one of two");
    fixture
        .raw("UPDATE turns SET feedback = NULL WHERE id = 't1';")
        .expect("NULL is no feedback, which is not a third value");

    assert!(
        fixture
            .raw(
                "INSERT INTO items (id, turn_id, ordinal, kind, started_at) \
                 VALUES ('i0','t1',0,'thought',1);",
            )
            .is_err(),
        "items.kind accepted a fifth kind"
    );
    fixture
        .raw(
            "INSERT INTO items (id, turn_id, ordinal, kind, cost_source, started_at) \
             VALUES ('i1', 't1', 0, 'step', 'harness', 1);",
        )
        .expect("a legal cost_source");
    assert!(
        fixture
            .raw(
                "INSERT INTO items (id, turn_id, ordinal, kind, cost_source, started_at) \
                 VALUES ('i2', 't1', 1, 'step', 'guessed', 1);",
            )
            .is_err()
    );
    assert!(
        fixture
            .raw(
                "INSERT INTO harness_health (workspace_context, harness_kind, failure_class) \
                 VALUES ('w', 'codex', 'confused');",
            )
            .is_err(),
        "harness_health.failure_class accepted a ninth class"
    );
    // The consent table's pairing CHECK: a ladder grant needs a subsystem and a
    // direct grant must not have one, so there is no row that is both.
    assert!(
        fixture
            .raw(
                "INSERT INTO conversation_provider_consent \
                 (conversation_id, harness_kind, source, subsystem, granted_at) \
                 VALUES ('c1', 'codex', 'ladder', '', 1);",
            )
            .is_err(),
        "a ladder grant with no subsystem must be refused"
    );
    assert!(
        fixture
            .raw(
                "INSERT INTO conversation_provider_consent \
                 (conversation_id, harness_kind, source, subsystem, granted_at) \
                 VALUES ('c1', 'codex', 'direct', 'builder', 1);",
            )
            .is_err(),
        "a direct grant naming a subsystem must be refused"
    );
}

#[test]
fn three_edges_cascade_and_the_parent_turn_link_deliberately_does_not() {
    let fixture = founded("ledger-cascade");
    fixture
        .raw(
            "INSERT INTO conversations (id, kind, user_id, created_at, updated_at) \
               VALUES ('c1','chat','o',1,1); \
             INSERT INTO turns (id, conversation_id, seq, trigger, started_at) \
               VALUES ('t1','c1',0,'interactive',1); \
             INSERT INTO items (id, turn_id, ordinal, kind, started_at) \
               VALUES ('i1','t1',0,'step',1); \
             INSERT INTO attachments (id, item_id, hash, mime, size_bytes, created_at) \
               VALUES ('a1','i1','h','text/plain',3,1);",
        )
        .expect("a three-level tree");

    // A sub-run whose parent is recorded LATER. With a foreign key on
    // `parent_turn_id` this insert would fail, and v0's comment says exactly
    // that: a sub-run's parent may be recorded after this row in one batch.
    fixture
        .raw(
            "INSERT INTO turns (id, conversation_id, seq, parent_turn_id, trigger, started_at) \
             VALUES ('t2','c1',1,'t-not-yet-written','interactive',1);",
        )
        .expect("parent_turn_id is a plain column, not a constraint");

    fixture
        .raw("DELETE FROM conversations WHERE id = 'c1';")
        .expect("delete the root");
    for (table, what) in [
        ("turns", "turns.conversation_id"),
        ("items", "items.turn_id"),
        ("attachments", "attachments.item_id"),
    ] {
        assert_eq!(
            fixture.count(&format!("SELECT COUNT(*) FROM {table}")),
            0,
            "{what} did not cascade"
        );
    }
}

#[test]
fn a_breaker_opens_permanently_for_auth_and_only_one_caller_claims_the_probe() {
    let fixture = founded("ledger-health");
    health::record_failure(
        &fixture.vault,
        "w-1",
        "codex",
        "auth",
        Some(health::PERMANENT),
        "run `codex login`",
    )
    .expect("record");
    let row = health::one(&fixture.vault, "w-1", "codex", "auth")
        .expect("read")
        .expect("present");
    assert_eq!(row.breaker_until, Some(health::PERMANENT));
    assert_eq!(row.consecutive_failures, 1);
    assert!(
        health::is_open(row.breaker_until, i64::MAX),
        "the sentinel must never read as expired"
    );

    // A finite breaker that has passed: exactly one claim succeeds.
    let now = fixture.clock.now_ms();
    health::record_failure(
        &fixture.vault,
        "w-1",
        "grok",
        "timeout",
        Some(now - 1),
        "quiet",
    )
    .expect("record");
    assert!(health::claim_half_open(&fixture.vault, "w-1", "grok", "timeout", now).expect("claim"));
    assert!(
        !health::claim_half_open(&fixture.vault, "w-1", "grok", "timeout", now).expect("claim"),
        "a second fire must not also be told yes"
    );

    // Success clears the run and the deadline.
    health::record_success(&fixture.vault, "w-1", "grok", "timeout").expect("ok");
    let row = health::one(&fixture.vault, "w-1", "grok", "timeout")
        .expect("read")
        .expect("present");
    assert_eq!(row.consecutive_failures, 0);
    assert_eq!(row.breaker_until, None);
    assert_eq!(row.half_open_claimed_at, None);
}

#[test]
fn the_permanent_class_sorts_above_every_finite_deadline() {
    let fixture = founded("ledger-order");
    let now = fixture.clock.now_ms();
    health::record_failure(
        &fixture.vault,
        "w",
        "codex",
        "timeout",
        Some(now + 60_000),
        "t",
    )
    .expect("record");
    health::record_failure(
        &fixture.vault,
        "w",
        "codex",
        "auth",
        Some(health::PERMANENT),
        "a",
    )
    .expect("record");
    let classes = health::classes_for(&fixture.vault, "w", "codex").expect("read");
    assert_eq!(
        classes.first().map(|row| row.failure_class.as_str()),
        Some("auth"),
        "the status surface shows the WORST class, and -1 is worse than any deadline"
    );
}

#[test]
fn consent_is_a_question_and_a_revocation_is_kept() {
    let fixture = founded("ledger-consent");
    let store = Store::new(&fixture.vault);
    let conversation = store
        .ensure_conversation(
            ConversationKind::Automation,
            "owner",
            Some("demo/nightly"),
            "Nightly",
        )
        .expect("open");

    assert!(
        !consent::has(
            &fixture.vault,
            &conversation.id,
            "codex",
            consent::Subsystem::Automations
        )
        .expect("read"),
        "nothing is consented by default"
    );
    consent::grant(
        &fixture.vault,
        &conversation.id,
        "codex",
        consent::Source::Ladder(consent::Subsystem::Automations),
    )
    .expect("grant");
    assert!(
        consent::has(
            &fixture.vault,
            &conversation.id,
            "codex",
            consent::Subsystem::Automations
        )
        .expect("read")
    );
    // A grant for one subsystem is not a grant for another, and a grant for
    // one provider is not a grant for a similar one.
    assert!(
        !consent::has(
            &fixture.vault,
            &conversation.id,
            "codex",
            consent::Subsystem::Builder
        )
        .expect("read")
    );
    assert!(
        !consent::has(
            &fixture.vault,
            &conversation.id,
            "gemini",
            consent::Subsystem::Automations
        )
        .expect("read"),
        "the egress-no-widen invariant, at the table"
    );

    consent::revoke(
        &fixture.vault,
        &conversation.id,
        "codex",
        consent::Source::Ladder(consent::Subsystem::Automations),
    )
    .expect("revoke");
    assert!(
        !consent::has(
            &fixture.vault,
            &conversation.id,
            "codex",
            consent::Subsystem::Automations
        )
        .expect("read")
    );
    assert!(
        consent::live(&fixture.vault, &conversation.id)
            .expect("read")
            .is_empty()
    );
    assert_eq!(
        fixture.count(
            "SELECT COUNT(*) FROM conversation_provider_consent WHERE revoked_at IS NOT NULL"
        ),
        1,
        "a withdrawn consent is kept, carrying when it was withdrawn"
    );
}

#[test]
fn an_automation_conversation_is_ensured_once() {
    let fixture = founded("ledger-ensure");
    let store = Store::new(&fixture.vault);
    let first = store
        .ensure_conversation(
            ConversationKind::Automation,
            "owner",
            Some("demo/nightly"),
            "Nightly",
        )
        .expect("open");
    let second = store
        .ensure_conversation(
            ConversationKind::Automation,
            "owner",
            Some("demo/nightly"),
            "Nightly",
        )
        .expect("open again");
    assert_eq!(
        first.id, second.id,
        "a second conversation would split the Insights rollup in half"
    );
}

#[test]
fn the_archive_pass_seals_a_cold_range_prunes_it_and_leaves_the_recent_turns() {
    let fixture = founded("ledger-archive");
    let store = Store::new(&fixture.vault);
    let conversation = store
        .ensure_conversation(ConversationKind::Chat, "owner", None, "Long")
        .expect("open");
    let mut turn_ids = Vec::new();
    for index in 0..6 {
        // A fixed clock moved forward by hand: the retention rule is about
        // edges, and a host clock cannot be moved.
        if index > 0 {
            fixture.clock.advance_days(1);
        }
        let turn = store
            .open_turn(&conversation.id, TurnTrigger::Interactive, None, None, None)
            .expect("turn");
        store
            .append_item(
                &turn.id,
                &Item {
                    kind: ItemKind::Step.as_str(),
                    ordinal: 0,
                    text: Some(format!("answer {index}")),
                    ..Item::default()
                },
            )
            .expect("item");
        store.close_turn(&turn.id, true, None).expect("close");
        turn_ids.push(turn.id);
    }

    let policy = archive::Policy {
        // Everything older than the last two days.
        cold_before_ms: EPOCH + 3 * 86_400_000,
        keep_turns: 2,
        max_turns_per_segment: 10,
    };
    let range = archive::select_range(&fixture.vault, &conversation.id, &policy)
        .expect("select")
        .expect("there is a cold range");
    assert_eq!(range.seq_from, 0);
    assert_eq!(
        range.seq_to, 3,
        "the last two turns are kept whatever their age, and turn 4 is not cold"
    );

    let payload = archive::segment_payload(&fixture.vault, &range).expect("seal");
    assert_eq!(
        payload["turns"].as_array().map(Vec::len),
        Some(4),
        "the segment carries the transcript it is replacing"
    );

    let digest = "a".repeat(64);
    let archive_id = archive::record_segment(
        &fixture.vault,
        &range,
        &digest,
        512,
        1_024,
        4,
        &["h1".to_owned()],
    )
    .expect("record");
    // Refused before the bytes go anywhere: a 63-character digest is not a
    // sha256, and the table's CHECK would say so in constraint language.
    assert!(archive::record_segment(&fixture.vault, &range, "short", 1, 1, 1, &[]).is_err());

    let pruned = archive::prune(&fixture.vault, &archive_id).expect("prune");
    assert_eq!(pruned, 4);
    assert_eq!(
        archive::prune(&fixture.vault, &archive_id).expect("prune again"),
        0,
        "the prune is idempotent: a retried pass must not delete a re-populated range"
    );

    let remaining = store.turn_ids(&conversation.id).expect("list");
    assert_eq!(remaining.len(), 2, "the two kept turns survive");
    let reread = store
        .conversation(&conversation.id)
        .expect("read")
        .expect("present");
    assert_eq!(reread.turn_count, 2);
    assert_eq!(reread.item_count, 2, "the items went with their turns");

    // Nothing is selected twice: the already-sealed range is excluded.
    let again = archive::select_range(&fixture.vault, &conversation.id, &policy).expect("select");
    assert!(again.is_none());
}

#[test]
fn a_pinned_turn_is_never_sealed_and_breaks_the_range_at_it() {
    let fixture = founded("ledger-pinned");
    let store = Store::new(&fixture.vault);
    let conversation = store
        .ensure_conversation(ConversationKind::Chat, "owner", None, "Pinned")
        .expect("open");
    let mut ids = Vec::new();
    for index in 0..5 {
        if index > 0 {
            fixture.clock.advance_ms(1_000);
        }
        let turn = store
            .open_turn(&conversation.id, TurnTrigger::Interactive, None, None, None)
            .expect("turn");
        store.close_turn(&turn.id, true, None).expect("close");
        ids.push(turn.id);
    }
    fixture
        .raw("UPDATE turns SET pinned = 1 WHERE seq = 1;")
        .expect("pin the second turn");

    let range = archive::select_range(
        &fixture.vault,
        &conversation.id,
        &archive::Policy {
            cold_before_ms: i64::MAX,
            keep_turns: 0,
            max_turns_per_segment: 10,
        },
    )
    .expect("select")
    .expect("a range");
    assert_eq!(
        (range.seq_from, range.seq_to),
        (0, 0),
        "a pin in the middle of a cold stretch ends the contiguous range at it, \
         rather than sealing a segment with a hole in it"
    );
}

/// The generated fixture, so the band's declared shape is one file both sides
/// answer.
const FIXTURE: &str = include_str!("../../../contracts/assist/ledger-fixture.json");

#[test]
fn the_founded_file_matches_the_generated_band_fixture() {
    let fixture: serde_json::Value =
        serde_json::from_str(FIXTURE).expect("the fixture is generated and formatted");
    let fixture_names = |key: &str| -> Vec<String> {
        fixture[key]
            .as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .filter_map(|value| value.as_str().map(str::to_owned))
            .collect()
    };

    assert_eq!(fixture["band"], "ledger");
    assert_eq!(fixture["mutable"], true);
    assert_eq!(fixture["tableCount"], 14);
    assert_eq!(
        fixture_names("tables"),
        LEDGER_TABLES.map(str::to_owned).to_vec(),
        "the Rust list and the generated one must be the same fourteen in the same order"
    );

    let fixture = founded_fixture();
    let objects = fixture.vault.read(schema::objects).expect("schema");
    let present = |name: &str, kind: &str| {
        objects
            .iter()
            .any(|object| object.name == name && object.kind == kind)
    };

    // EVERY index and trigger the band declares, not just the two and the eight
    // this crate names in Rust. Twenty-three indexes is the number that matters
    // for the Insights load, and an index dropped by a future migration is a
    // slow screen rather than a failure — which is exactly the kind of thing a
    // test has to catch.
    let declared: serde_json::Value = serde_json::from_str(FIXTURE).expect("parse");
    for index in declared["indexes"].as_array().expect("an array") {
        let name = index.as_str().expect("a name");
        assert!(
            present(name, "index"),
            "the baseline is missing index {name}"
        );
    }
    for trigger in declared["triggers"].as_array().expect("an array") {
        let name = trigger.as_str().expect("a name");
        assert!(
            present(name, "trigger"),
            "the baseline is missing trigger {name}"
        );
    }
    for view in declared["views"].as_array().expect("an array") {
        let name = view.as_str().expect("a name");
        assert!(present(name, "view"), "the baseline is missing view {name}");
    }

    // The delete rules, from the DDL the fixture was read out of: nine
    // references, every one of them CASCADE. `turns.parent_turn_id` is not in
    // that list at all — it has no `REFERENCES` clause, which is the point.
    let rules = declared["deleteRules"].as_array().expect("an array");
    assert_eq!(rules.len(), 9);
    assert!(
        rules.iter().all(|rule| rule["onDelete"] == "cascade"),
        "a non-cascading reference in this band would leave orphaned items behind a pruned turn"
    );
    assert!(
        declared["plainColumns"]
            .as_array()
            .expect("an array")
            .iter()
            .any(|column| column == "turns.parent_turn_id")
    );

    // The closed vocabularies, checked against the enums this crate exposes.
    let vocabulary = |column: &str| -> Vec<String> {
        declared["vocabularies"]
            .as_array()
            .expect("an array")
            .iter()
            .find(|entry| entry["column"] == column)
            .map(|entry| {
                entry["values"]
                    .as_array()
                    .expect("values")
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    assert_eq!(
        vocabulary("trigger"),
        centraid_vault::ledger::schema::TURN_TRIGGERS
    );
    assert_eq!(
        vocabulary("feedback"),
        centraid_vault::ledger::schema::TURN_FEEDBACK
    );
    assert_eq!(
        vocabulary("cost_source"),
        centraid_vault::ledger::schema::COST_SOURCES
    );
    assert_eq!(
        vocabulary("failure_class"),
        centraid_vault::ledger::schema::FAILURE_CLASSES
    );
}

/// A founded vault for the fixture test. Separate from [`founded`] only so the
/// seed is its own.
fn founded_fixture() -> Fixture {
    founded("ledger-fixture")
}
