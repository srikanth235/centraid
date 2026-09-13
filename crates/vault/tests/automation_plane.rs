//! The automations lane's half of the vault: the store code over three ledger
//! tables, and the nine `enrich.*` commands (#1020, wave 4 lane automations).
//!
//! Every one of these is a claim the crate makes about a founded file rather
//! than about a function: the DDL is the band's, the statements are this
//! lane's, and this is where the two meet.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::ledger::{automation_cursor, automation_ingress, automation_state};
use centraid_vault::{Command, CommandStatus};

fn founded(seed: &str) -> common::Scratch {
    common::Scratch::founded(seed).expect("a vault is founded")
}

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new(seed: &str) -> Self {
        let scratch = founded(seed);
        let registry = Registry::with_system_commands().expect("the registry builds");
        registry
            .install(&scratch.vault)
            .expect("the record installs");
        Self { scratch, registry }
    }

    fn run(
        &self,
        command: &str,
        input: serde_json::Value,
    ) -> centraid_vault::commands::CommandOutcome {
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(command, input),
            )
            .unwrap_or_else(|error| panic!("{command} did not run: {error}"))
    }

    fn executed(&self, command: &str, input: serde_json::Value) -> serde_json::Value {
        let outcome = self.run(command, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{command}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn refused(&self, command: &str, input: serde_json::Value) -> String {
        let outcome = self.run(command, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "{command} must refuse"
        );
        outcome.reason.unwrap_or_default()
    }

    fn count(&self, sql: &str) -> i64 {
        self.scratch
            .vault
            .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
            .expect("the count reads")
    }

    /// One photograph, inserted directly: `media.add_asset` is the Photos
    /// lane's door and this file is testing what happens to one, not how it
    /// arrives.
    fn photograph(&self, asset_id: &str, width: i64, height: i64) {
        let content_id = format!("content-{asset_id}");
        let sha = format!(
            "{:0>64}",
            asset_id
                .bytes()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        self.scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.fixture");
                tx.connection().execute(
                    "INSERT INTO core_content_item
                       (content_id, content_uri, sha256, byte_size, created_at)
                     VALUES (?1, ?2, ?3, 1024, '2026-01-01T00:00:00.000Z')",
                    rusqlite::params![content_id, format!("blob:{sha}"), sha],
                )?;
                tx.connection().execute(
                    "INSERT INTO media_asset
                       (asset_id, content_id, kind, width, height, created_at, updated_at)
                     VALUES (?1, ?2, 'photo', ?3, ?4,
                             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                    rusqlite::params![asset_id, content_id, width, height],
                )?;
                Ok(())
            })
            .expect("the photograph lands");
    }
}

// ---------------------------------------------------------------------------
// `automation_state`: one table, two tenants, one reserved prefix.
// ---------------------------------------------------------------------------

#[test]
fn automation_state_is_a_kv_bag_and_absent_is_not_null() {
    let scratch = founded("state");
    let vault = &scratch.vault;
    assert_eq!(
        automation_state::get(vault, "poll/poll", "cursor").expect("reads"),
        None,
        "absent is a different answer from a stored null: a watcher with no \
         position reacts to what happens next"
    );
    automation_state::set(vault, "poll/poll", "cursor", "\"msg-9\"").expect("writes");
    assert_eq!(
        automation_state::get(vault, "poll/poll", "cursor").expect("reads"),
        Some("\"msg-9\"".to_owned())
    );
    automation_state::set(vault, "poll/poll", "cursor", "\"msg-10\"").expect("writes");
    assert_eq!(
        automation_state::get(vault, "poll/poll", "cursor").expect("reads"),
        Some("\"msg-10\"".to_owned()),
        "the second write is an upsert, not a second row"
    );
    automation_state::set(vault, "poll/poll", "total", "42").expect("writes");
    assert_eq!(
        automation_state::keys(vault, "poll/poll").expect("lists"),
        ["cursor", "total"]
    );
    assert!(automation_state::remove(vault, "poll/poll", "total").expect("removes"));
    assert!(!automation_state::remove(vault, "poll/poll", "total").expect("idempotent"));
}

/// THE RESERVED PREFIX. A handler may not squat on the namespace the runtime
/// may need back.
#[test]
fn a_handler_cannot_write_the_runtimes_reserved_key_prefix() {
    let scratch = founded("reserved");
    let error = automation_state::set(&scratch.vault, "poll/poll", "__trigger:cursor", "\"x\"")
        .expect_err("the prefix is reserved");
    assert!(
        error.to_string().contains("automation_trigger_cursor"),
        "the refusal says where a durable position actually lives: {error}"
    );
    // The scheduler's own tenant may, because it IS the runtime.
    automation_state::set(
        &scratch.vault,
        automation_state::SCHEDULER_ID,
        "__trigger:probe",
        "1",
    )
    .expect("the scheduler's own tenant writes");
}

#[test]
fn forgetting_an_automations_state_never_takes_the_schedulers_ledger_with_it() {
    let scratch = founded("forget");
    let vault = &scratch.vault;
    automation_state::set(vault, "poll/poll", "cursor", "\"a\"").expect("writes");
    automation_state::set(vault, automation_state::SCHEDULER_ID, "ledger", "{}").expect("writes");
    assert_eq!(
        automation_state::forget(vault, "poll/poll").expect("forgets"),
        1
    );
    assert!(
        automation_state::get(vault, automation_state::SCHEDULER_ID, "ledger")
            .expect("reads")
            .is_some()
    );
    assert!(
        automation_state::forget(vault, automation_state::SCHEDULER_ID).is_err(),
        "the scheduler's ledger is not an automation's state"
    );
}

// ---------------------------------------------------------------------------
// `automation_trigger_cursor`: the durable position, and its retention.
// ---------------------------------------------------------------------------

#[test]
fn a_cursor_round_trips_every_column_it_carries() {
    let scratch = founded("cursor");
    let vault = &scratch.vault;
    let cursor = automation_cursor::Cursor {
        source_kind: "event:pull.gmail:new-message:{}".to_owned(),
        position_json: Some("\"msg-9\"".to_owned()),
        pending_json: Some("{\"elements\":[]}".to_owned()),
        window_from: Some(1_000),
        window_to: Some(2_000),
        skipped: 3,
        gap_reason: Some("scheduler_gap".to_owned()),
        dead_letter_json: Some("[]".to_owned()),
        updated_at: 4_000,
    };
    automation_cursor::put(vault, "poll/poll", 0, &cursor).expect("writes");
    assert_eq!(
        automation_cursor::get(vault, "poll/poll", 0).expect("reads"),
        Some(cursor.clone())
    );
    assert_eq!(
        automation_cursor::get(vault, "poll/poll", 1).expect("reads"),
        None
    );
    // A PENDING BATCH IS DISCOVERABLE ON BOOT.
    assert_eq!(
        automation_cursor::pending(vault).expect("lists"),
        [automation_cursor::Slot {
            automation_id: "poll/poll".to_owned(),
            trigger_index: 0
        }]
    );
    let settled = automation_cursor::Cursor {
        pending_json: None,
        ..cursor
    };
    automation_cursor::put(vault, "poll/poll", 0, &settled).expect("writes");
    assert!(automation_cursor::pending(vault).expect("lists").is_empty());
}

/// RETENTION MUST NOT PRUNE A LIVE CURSOR, and an empty desired set is not a
/// request to delete everything.
#[test]
fn retention_follows_the_declared_slots_and_refuses_an_empty_set() {
    let scratch = founded("retain");
    let vault = &scratch.vault;
    let row = |kind: &str| automation_cursor::Cursor {
        source_kind: kind.to_owned(),
        updated_at: 1,
        ..automation_cursor::Cursor::default()
    };
    automation_cursor::put(vault, "poll/poll", 0, &row("cron")).expect("writes");
    automation_cursor::put(vault, "poll/poll", 1, &row("webhook")).expect("writes");
    automation_cursor::put(vault, "gone/gone", 0, &row("cron")).expect("writes");
    assert!(
        automation_cursor::retain(vault, &[]).is_err(),
        "an empty desired set is a reconcile that read no automations"
    );
    let kept = [
        automation_cursor::Slot {
            automation_id: "poll/poll".to_owned(),
            trigger_index: 0,
        },
        automation_cursor::Slot {
            automation_id: "poll/poll".to_owned(),
            trigger_index: 1,
        },
    ];
    assert_eq!(automation_cursor::retain(vault, &kept).expect("prunes"), 1);
    assert!(
        automation_cursor::get(vault, "poll/poll", 1)
            .expect("reads")
            .is_some()
    );
    assert!(
        automation_cursor::get(vault, "gone/gone", 0)
            .expect("reads")
            .is_none()
    );
    // Idempotent: a second pass with the same set removes nothing.
    assert_eq!(automation_cursor::retain(vault, &kept).expect("prunes"), 0);
}

// ---------------------------------------------------------------------------
// `trigger_ingress`: durable before it is a fire.
// ---------------------------------------------------------------------------

#[test]
fn an_ingress_delivery_is_stored_once_and_read_back_in_order() {
    let scratch = founded("ingress");
    let vault = &scratch.vault;
    let row = |delivery: &str, at: i64| automation_ingress::Ingress {
        source: "webhook".to_owned(),
        source_key: "hook1".to_owned(),
        delivery_id: delivery.to_owned(),
        received_at: at,
        payload_json: format!("{{\"n\":\"{delivery}\"}}"),
        expires_at: at + 1_000,
    };
    assert!(automation_ingress::store(vault, &row("d1", 10)).expect("stores"));
    // THE UNIQUE CONSTRAINT IS THE IDEMPOTENCY: a provider that retries gets
    // `false`, not an error.
    assert!(!automation_ingress::store(vault, &row("d1", 11)).expect("duplicate"));
    assert!(automation_ingress::store(vault, &row("d2", 12)).expect("stores"));
    assert!(automation_ingress::contains(vault, "webhook", "hook1", "d1").expect("reads"));
    assert!(!automation_ingress::contains(vault, "webhook", "hook1", "d9").expect("reads"));
    let all = automation_ingress::after(vault, "webhook", "hook1", 0, 10).expect("reads");
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].ingress.delivery_id, "d1");
    assert!(all[1].id > all[0].id, "the autoincrement id IS the order");
    // A BOUND REPORTS THE SIZE IT REACHES: the cap is the caller's batch cap.
    let one = automation_ingress::after(vault, "webhook", "hook1", 0, 1).expect("reads");
    assert_eq!(one.len(), 1);
    let after_first =
        automation_ingress::after(vault, "webhook", "hook1", all[0].id, 10).expect("reads");
    assert_eq!(after_first.len(), 1);
    assert_eq!(after_first[0].ingress.delivery_id, "d2");
    // A source outside the table's own CHECK is refused with a sentence
    // rather than a constraint name.
    let mut bad = row("d3", 13);
    bad.source = "email".to_owned();
    let error = automation_ingress::store(vault, &bad).expect_err("not a source");
    assert!(error.to_string().contains("webhook or poll"), "{error}");
}

#[test]
fn expired_ingress_rows_are_pruned_and_live_ones_are_not() {
    let scratch = founded("prune");
    let vault = &scratch.vault;
    for (delivery, expires) in [("old", 100), ("fresh", 10_000)] {
        automation_ingress::store(
            vault,
            &automation_ingress::Ingress {
                source: "webhook".to_owned(),
                source_key: "hook1".to_owned(),
                delivery_id: delivery.to_owned(),
                received_at: 0,
                payload_json: "{}".to_owned(),
                expires_at: expires,
            },
        )
        .expect("stores");
    }
    assert_eq!(
        automation_ingress::prune_expired(vault, 500).expect("prunes"),
        1
    );
    assert!(automation_ingress::contains(vault, "webhook", "hook1", "fresh").expect("reads"));
    assert!(!automation_ingress::contains(vault, "webhook", "hook1", "old").expect("reads"));
}

// ---------------------------------------------------------------------------
// The `enrich.*` commands, through the gate order.
// ---------------------------------------------------------------------------

#[test]
fn an_embedding_is_one_row_per_target_and_model_and_the_stamp_is_opt_in() {
    let world = World::new("embed");
    world.photograph("asset-1", 100, 100);
    let first = world.executed(
        "enrich.upsert_embedding",
        serde_json::json!({
            "entity_type": "media.asset",
            "entity_id": "asset-1",
            "model": "clip-vit-b-32@1",
            "vector": [1.0, 0.0, 0.5],
        }),
    );
    assert_eq!(first["dim"], 3);
    assert_eq!(
        world.count("SELECT COUNT(*) FROM enrich_embedding WHERE target_id = 'asset-1'"),
        1
    );
    // AN EMBEDDING WITH NO CAPABILITY IS A VALUE, NOT A DERIVATION: stamping
    // it would make the walk skip a target no recipe has looked at.
    assert_eq!(
        world.count("SELECT COUNT(*) FROM enrich_derivation WHERE target_id = 'asset-1'"),
        0
    );
    // The same model again REPLACES the vector and keeps the id.
    let again = world.executed(
        "enrich.upsert_embedding",
        serde_json::json!({
            "entity_type": "media.asset",
            "entity_id": "asset-1",
            "model": "clip-vit-b-32@1",
            "vector": [0.0, 1.0, 0.0, 0.0],
            "capability": "embed-image",
        }),
    );
    assert_eq!(again["embedding_id"], first["embedding_id"]);
    assert_eq!(again["dim"], 4);
    assert_eq!(
        world.count("SELECT COUNT(*) FROM enrich_embedding WHERE target_id = 'asset-1'"),
        1
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM enrich_derivation
              WHERE target_id = 'asset-1' AND variant = 'embedding'"
        ),
        1
    );
    // ANOTHER MODEL IS ANOTHER ROW: 128-d and 512-d rows never meet.
    world.executed(
        "enrich.upsert_embedding",
        serde_json::json!({
            "entity_type": "media.asset",
            "entity_id": "asset-1",
            "model": "sface@1",
            "vector": [0.1, 0.2],
        }),
    );
    assert_eq!(
        world.count("SELECT COUNT(*) FROM enrich_embedding WHERE target_id = 'asset-1'"),
        2
    );
}

/// A STAMP CLEARS THE TARGET'S FAILURE RECORD: producing the value is the
/// proof the poison is gone.
#[test]
fn counting_a_failure_then_succeeding_leaves_nothing_on_the_register() {
    let world = World::new("failure");
    world.photograph("asset-1", 100, 100);
    for expected in 1..=2 {
        let outcome = world.executed(
            "enrich.record_target_failure",
            serde_json::json!({
                "capability": "embed-image",
                "target_type": "media.asset",
                "target_id": "asset-1",
                "error": "the session would not load",
            }),
        );
        assert_eq!(outcome["failures"], expected);
        assert_eq!(outcome["declined"], false);
    }
    // The third reaches the default cap.
    let declined = world.executed(
        "enrich.record_target_failure",
        serde_json::json!({
            "capability": "embed-image",
            "target_type": "media.asset",
            "target_id": "asset-1",
        }),
    );
    assert_eq!(declined["failures"], 3);
    assert_eq!(declined["declined"], true);
    // Then it succeeds, and the register is clean.
    world.executed(
        "enrich.upsert_embedding",
        serde_json::json!({
            "entity_type": "media.asset",
            "entity_id": "asset-1",
            "model": "clip-vit-b-32@1",
            "vector": [1.0],
            "capability": "embed-image",
        }),
    );
    assert_eq!(
        world.count("SELECT COUNT(*) FROM enrich_target_failure WHERE target_id = 'asset-1'"),
        0,
        "a target that failed twice and then succeeded must not stay on the register"
    );
}

#[test]
fn a_permanent_failure_declines_on_the_first_count_and_a_capability_may_raise_its_own_cap() {
    let world = World::new("caps");
    world.photograph("asset-1", 100, 100);
    let permanent = world.executed(
        "enrich.record_target_failure",
        serde_json::json!({
            "capability": "transcript",
            "target_type": "media.asset",
            "target_id": "asset-1",
            "permanent": true,
            "reason": "too-large",
        }),
    );
    assert_eq!(permanent["failures"], 1);
    assert_eq!(permanent["declined"], true);
    // A slow display rung declares a longer cap of its own.
    world.photograph("asset-2", 100, 100);
    let patient = world.executed(
        "enrich.record_target_failure",
        serde_json::json!({
            "capability": "faces",
            "target_type": "media.asset",
            "target_id": "asset-2",
            "reason": "no-preview",
            "max_failures": 12,
        }),
    );
    assert_eq!(patient["declined"], false);
}

#[test]
fn faces_replace_only_the_proposals_and_the_stamp_carries_the_count() {
    let world = World::new("faces");
    world.photograph("asset-1", 200, 200);
    // One confirmed region the owner answered, which a re-run must not touch.
    world
        .scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.fixture");
            // The CHECK ties `confirmed_by_party_id` to `review_state`, so a
            // confirmed region names who confirmed it.
            let owner: String = tx.connection().query_row(
                "SELECT self_party_id FROM core_vault WHERE self_party_id IS NOT NULL",
                [],
                |row| row.get(0),
            )?;
            tx.connection().execute(
                "INSERT INTO media_face_region
                   (region_id, asset_id, bbox_json, confidence, review_state,
                    confirmed_by_party_id)
                 VALUES ('kept', 'asset-1', '[0,0,10,10]', 0.9, 'confirmed', ?1)",
                [&owner],
            )?;
            Ok(())
        })
        .expect("the answered region lands");
    let first = world.executed(
        "enrich.upsert_faces",
        serde_json::json!({
            "asset_id": "asset-1",
            "model": "yunet-arcface@1",
            "faces": [
                { "box": [10, 10, 30, 30], "confidence": 0.8, "embedding": [1.0, 0.0] },
                { "box": [80, 80, 20, 20], "confidence": 0.7, "embedding": [0.0, 1.0] }
            ],
        }),
    );
    assert_eq!(first["regions"], 2);
    assert_eq!(
        world.count("SELECT COUNT(*) FROM media_face_region WHERE asset_id = 'asset-1'"),
        3
    );
    assert_eq!(
        world
            .count("SELECT COUNT(*) FROM enrich_embedding WHERE target_type = 'media.face_region'"),
        2
    );
    // A RE-RUN replaces the proposals and leaves the owner's answer alone.
    world.executed(
        "enrich.upsert_faces",
        serde_json::json!({
            "asset_id": "asset-1",
            "model": "yunet-arcface@1",
            "faces": [{ "box": [5, 5, 40, 40], "confidence": 0.95, "embedding": [1.0, 0.0] }],
        }),
    );
    assert_eq!(
        world.count("SELECT COUNT(*) FROM media_face_region WHERE asset_id = 'asset-1'"),
        2
    );
    assert_eq!(
        world.count("SELECT COUNT(*) FROM media_face_region WHERE region_id = 'kept'"),
        1,
        "a detector re-run is not an argument against the owner's answer"
    );
    // A PHOTOGRAPH WITH NO FACES IS A FINISHED PHOTOGRAPH.
    world.photograph("asset-2", 50, 50);
    world.executed(
        "enrich.upsert_faces",
        serde_json::json!({ "asset_id": "asset-2", "model": "yunet-arcface@1", "faces": [] }),
    );
    let stamp: String = world
        .scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT payload_json FROM enrich_derivation
                  WHERE target_id = 'asset-2' AND variant = 'faces'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the stamp reads");
    assert_eq!(stamp, "{\"count\":0}");
}

#[test]
fn a_face_box_outside_the_photograph_refuses_before_any_row_is_written() {
    let world = World::new("boxes");
    world.photograph("asset-1", 100, 100);
    let reason = world.refused(
        "enrich.upsert_faces",
        serde_json::json!({
            "asset_id": "asset-1",
            "model": "yunet-arcface@1",
            "faces": [
                { "box": [0, 0, 10, 10], "confidence": 0.9, "embedding": [1.0] },
                { "box": [90, 90, 30, 30], "confidence": 0.9, "embedding": [1.0] }
            ],
        }),
    );
    assert!(reason.contains("outside the photograph"), "{reason}");
    assert_eq!(
        world.count("SELECT COUNT(*) FROM media_face_region"),
        0,
        "a partial recognition would stamp the asset as done with half its faces"
    );
    // And a photograph that is gone is refused by the precondition's own
    // sentence rather than by a foreign-key error.
    let gone = world.refused(
        "enrich.upsert_faces",
        serde_json::json!({ "asset_id": "nope", "model": "m", "faces": [] }),
    );
    assert!(gone.contains("no longer in the library"), "{gone}");
}

/// THE ONE THAT ASKS. An answer is recorded in the consent plane, a changed
/// answer revokes and re-writes, and an identical one is left alone.
#[test]
fn a_consent_answer_is_immutable_and_a_change_revokes_rather_than_edits() {
    let world = World::new("consent");
    let granted = world.executed(
        "enrich.record_consent",
        serde_json::json!({
            "capability": "faces",
            "egress": "provider",
            "decision": "granted",
        }),
    );
    assert_eq!(granted["changed"], true);
    assert_eq!(granted["scope_ref"], "");
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM share_authority
              WHERE subject_type = 'enrich.scope' AND revoked_at IS NULL"
        ),
        1
    );
    // THE SAME ANSWER AGAIN IS ONE ANSWER.
    let again = world.executed(
        "enrich.record_consent",
        serde_json::json!({
            "capability": "faces",
            "egress": "provider",
            "decision": "granted",
        }),
    );
    assert_eq!(again["changed"], false);
    assert_eq!(
        world.count("SELECT COUNT(*) FROM share_authority WHERE subject_type = 'enrich.scope'"),
        1
    );
    // A CHANGED ANSWER revokes the old row and writes a new one, so the
    // history is auditable.
    let declined = world.executed(
        "enrich.record_consent",
        serde_json::json!({
            "capability": "faces",
            "egress": "provider",
            "decision": "declined",
        }),
    );
    assert_eq!(declined["changed"], true);
    assert_eq!(
        world.count("SELECT COUNT(*) FROM share_authority WHERE subject_type = 'enrich.scope'"),
        2
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM share_authority
              WHERE subject_type = 'enrich.scope' AND revoked_at IS NOT NULL"
        ),
        1
    );
}

#[test]
fn a_drained_request_is_not_drained_twice_and_a_leased_one_waits() {
    let world = World::new("drain");
    let first = world.executed(
        "enrich.request_enrichment",
        serde_json::json!({
            "entity_type": "media.asset",
            "reason": "manual",
            "capability": "faces",
        }),
    );
    let request_id = first["request_id"].as_str().expect("an id").to_owned();
    let drained = world.executed(
        "enrich.mark_requests_drained",
        serde_json::json!({ "request_ids": [request_id.clone()] }),
    );
    assert_eq!(drained["drained"], 1);
    let again = world.executed(
        "enrich.mark_requests_drained",
        serde_json::json!({ "request_ids": [request_id] }),
    );
    assert_eq!(again["drained"], 0, "a drained request stays drained");
    // A LEASED REQUEST IS NOT DRAINABLE: the device that took it may still be
    // working, and draining it here would drop the member's ask on the floor.
    let leased = world.executed(
        "enrich.request_enrichment",
        serde_json::json!({
            "entity_type": "media.asset",
            "reason": "manual",
            "capability": "ocr",
        }),
    );
    let leased_id = leased["request_id"].as_str().expect("an id").to_owned();
    world
        .scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.fixture");
            tx.connection().execute(
                // The CHECKs pair all three lease columns: a lease names the
                // device that took it and carries the token it proves that
                // with, so a half-written lease is unrepresentable.
                "UPDATE enrich_request
                    SET lease_expires_at = '2099-01-01T00:00:00.000Z',
                        lease_device_id = 'phone',
                        lease_token = 'token-1'
                  WHERE request_id = ?1",
                [&leased_id],
            )?;
            Ok(())
        })
        .expect("the lease lands");
    let held = world.executed(
        "enrich.mark_requests_drained",
        serde_json::json!({ "request_ids": [leased_id] }),
    );
    assert_eq!(held["drained"], 0);
}

/// REGENERATION IS TWO ACTS: drop the stamp, and requeue the target. Neither
/// touches the derived value.
#[test]
fn regenerating_one_target_drops_both_halves_stamps_and_requeues_it() {
    let world = World::new("regen");
    world.photograph("asset-1", 100, 100);
    world.executed(
        "enrich.upsert_embedding",
        serde_json::json!({
            "entity_type": "media.asset",
            "entity_id": "asset-1",
            "model": "clip-vit-b-32@1",
            "vector": [1.0],
            "capability": "embed-image",
        }),
    );
    // Name exactly one half, and the other is resolved.
    let outcome = world.executed(
        "enrich.regenerate",
        serde_json::json!({ "capability": "embed-image", "content_id": "content-asset-1" }),
    );
    assert_eq!(outcome["deleted"], 1);
    assert_eq!(
        world.count("SELECT COUNT(*) FROM enrich_derivation WHERE capability = 'embed-image'"),
        0
    );
    // THE VALUE IS UNTOUCHED: deleting it early would blank a working search
    // index for the length of a backlog walk.
    assert_eq!(
        world.count("SELECT COUNT(*) FROM enrich_embedding WHERE target_id = 'asset-1'"),
        1
    );
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM enrich_request
              WHERE capability = 'embed-image' AND reason = 'manual'"
        ),
        1
    );
    // Naming both halves, or neither, is refused — the two capabilities stamp
    // different halves of one photograph.
    for input in [
        serde_json::json!({ "capability": "embed-image", "asset_id": "asset-1",
                            "content_id": "content-asset-1" }),
        serde_json::json!({ "capability": "embed-image" }),
    ] {
        let reason = world.refused("enrich.regenerate", input);
        assert!(reason.contains("exactly one"), "{reason}");
    }
}

#[test]
fn regenerating_a_whole_capability_resets_every_cursor_its_recipe_keeps() {
    let world = World::new("regen-all");
    world.photograph("asset-1", 100, 100);
    world.executed(
        "enrich.upsert_faces",
        serde_json::json!({ "asset_id": "asset-1", "model": "yunet-arcface@1", "faces": [] }),
    );
    // A walk that has got somewhere.
    for key in ["cursor", "consentCursor"] {
        automation_state::set(&world.scratch.vault, "faces/faces", key, "\"asset-900\"")
            .expect("writes");
    }
    let outcome = world.executed(
        "enrich.regenerate_all",
        serde_json::json!({ "capability": "faces" }),
    );
    assert_eq!(outcome["deleted"], 1);
    assert_eq!(outcome["automation_ref"], "faces/faces");
    assert_eq!(outcome["cursors_reset"], 2);
    for key in ["cursor", "consentCursor"] {
        assert_eq!(
            automation_state::get(&world.scratch.vault, "faces/faces", key).expect("reads"),
            Some("\"\"".to_owned()),
            "{key} must go back to the beginning of the library"
        );
    }
    // A capability no bundled recipe owns is refused with the list.
    let reason = world.refused(
        "enrich.regenerate_all",
        serde_json::json!({ "capability": "place-names" }),
    );
    assert!(reason.contains("no bundled recipe owns"), "{reason}");
    assert!(reason.contains("embed-image"), "{reason}");
}

/// The clustering, through the command, over a founded file.
#[test]
fn rebuilding_face_clusters_is_idempotent_and_groups_within_one_model() {
    let world = World::new("clusters");
    world.photograph("asset-1", 200, 200);
    world.photograph("asset-2", 200, 200);
    for (asset, vector) in [("asset-1", [1.0, 0.0]), ("asset-2", [0.99, 0.02])] {
        world.executed(
            "enrich.upsert_faces",
            serde_json::json!({
                "asset_id": asset,
                "model": "yunet-arcface@1",
                "faces": [{ "box": [0, 0, 50, 50], "confidence": 0.9, "embedding": vector }],
            }),
        );
    }
    let first = world.executed("enrich.rebuild_face_clusters", serde_json::json!({}));
    assert_eq!(
        first["clusters"], 1,
        "two of the same face are one stranger"
    );
    assert_eq!(first["clustered"], 2);
    assert!(first["updated"].as_i64().unwrap_or_default() > 0);
    // STATELESS AND IDEMPOTENT: unchanged data writes nothing.
    let second = world.executed("enrich.rebuild_face_clusters", serde_json::json!({}));
    assert_eq!(second["clusters"], 1);
    assert_eq!(
        second["updated"], 0,
        "unchanged data must dirty no WAL page and wake no replica"
    );
}
