//! The command plane end to end: authority, the gate order, the audit chain,
//! and replay idempotency.

mod common;

use centraid_vault::access::{Principal, RowFilter, Scope, ScopeClamp};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, VaultError};

fn registry() -> Registry {
    Registry::with_system_commands().expect("the system registry builds")
}

fn installed(seed: &str) -> (common::Scratch, Registry) {
    let scratch = common::Scratch::founded(seed).expect("a vault is founded");
    let registry = registry();
    registry
        .install(&scratch.vault)
        .expect("the record installs");
    (scratch, registry)
}

#[test]
fn the_registry_carries_every_command_this_build_has() {
    let registry = registry();
    let count = |prefix: &str| {
        registry
            .names()
            .iter()
            .filter(|name| name.starts_with(prefix))
            .count()
    };
    // ONE ROW PER SCHEMA, AND THE TOTAL IS THEIR SUM — so "a schema nobody
    // counted" is still the invariant this test exists for, and a lane that
    // lands a schema adds one row rather than editing a number every other
    // lane is also editing (#1020, wave 4 lane Locker).
    let by_schema = [
        // Twenty-five `core.*` — the parties plane and Docs' whole write
        // surface (#1020 slot 4b, D-1020-DC3), Notes' link and attachment half
        // (slot 4c, D-1020-N6) and People's ontology primitive
        // `core.merge_party` (slot 4c, D-1020-PE2), which is twenty-five of
        // v0's twenty-seven. The two still absent are `core.merge_entity` and
        // `core.find_duplicate_parties`. Plus this build's own two for Docs on
        // the phone (#1047): `core.purge_document`, the destroy ruling D-1 of
        // 2026-09-25 gave Docs' trash, and `core.create_text_document`, the Add
        // sheet's "Text". And the vault switcher's `core.rename_vault`, the
        // one writer of `core_vault.display_name` after founding.
        ("core.", 28_usize),
        // The whole 9-command `knowledge.*` schema (wave 4 slot 4c).
        ("knowledge.", 9),
        // The whole 20-command `media.*` schema (wave 4 lane Photos), plus
        // `media.derive_missing` — this build's own backfill sweep, which is
        // not one of v0's and which the gateway runs at start (#1025 S3,
        // D-1025-S7-53).
        ("media.", 21),
        // NO `enrich.*` AT ALL (#1029 §1, open question 9). Nine commands
        // went: `request_enrichment` queued a row for an enrichment WORKER,
        // `record_consent` recorded a harness's egress consent,
        // `mark_requests_drained` and `record_target_failure` were that
        // worker's own bookkeeping, `upsert_embedding`, `upsert_faces` and
        // `rebuild_face_clusters` were its writes, and `regenerate` /
        // `regenerate_all` re-queued it. The worker was `crates/automations`
        // over `crates/assist`, and both are deleted — so every one of them
        // had exactly one caller and it is gone.
        ("enrich.", 0),
        // v0's twenty `locker.*` plus `reveal_receipt`, which the core's
        // reveal writes. `rotate_key` went with the multi-seat custody plane
        // (#1047 slice D1), and `watchtower` with the weak/reused scoring
        // (Q-1047-16).
        ("locker.", 20),
        // The 26 of v0's 28-command `people.*` schema that outlived Tally (the two
        // debt commands left with it, #1099) and the whole 4-command `social.*`
        // one (wave 4 lane People), plus `people.purge_person` — the destroy
        // People's trash needed to meet #1015 D1.
        ("people.", 27),
        ("social.", 4),
        // The whole 16-command `schedule.*` schema — events, occurrences,
        // projects, sections and tasks (wave 4 lane Schedule) — plus
        // `schedule.purge_task`, the Tasks trash's destroy (#1015 D1).
        ("schedule.", 17),
        // The on-device chat's five writers (#1078, R-CHAT-1): `save_turn`,
        // `rename_thread`, `delete_thread` and `clear`, and `settle_proposal`,
        // which records how a parked write's card ended (#1088, rung twelve).
        ("chat.", 5),
        // The 20 `money.*` (#1099): accounts, the statement import, a line's
        // category, name, void and transfer, plans, rules and their history pass,
        // the stated balance and layout, and the member's own categories.
        ("money.", 20),
        // The phone link's six (#1127): `link`, `touch`, `detach` and `forget`, and the origin's
        // two, `origin` and `retire_origin` (R-1127-9).
        ("phone.", 6),
    ];
    let total: usize = by_schema.iter().map(|(_, expected)| *expected).sum();
    assert_eq!(
        registry.len(),
        total,
        "the registry carries a schema this count does not name"
    );
    for (prefix, expected) in by_schema {
        assert_eq!(count(prefix), expected, "{prefix}");
    }
    assert!(registry.get("media.answer_face_proposal").is_some());
    assert!(registry.get("enrich.request_enrichment").is_none());
    assert!(registry.get("enrich.upsert_faces").is_none());
    assert!(registry.get("core.add_party").is_some());
    assert!(registry.get("core.add_document").is_some());
    assert!(registry.get("core.set_extracted_text").is_some());
    assert!(registry.get("core.attach").is_some());
    assert!(registry.get("core.link_entities").is_some());
    assert!(registry.get("knowledge.create_note").is_some());
    assert!(registry.get("knowledge.restore_note_version").is_some());
    assert!(registry.get("core.merge_party").is_some());
    assert!(registry.get("core.rename_vault").is_some());
    assert!(registry.get("people.add_person").is_some());
    assert!(registry.get("people.save_contact_channel").is_some());
    assert!(registry.get("social.send_message").is_some());
    // A NAMED ABSENCE, not an oversight: `core.merge_entity` merges two
    // ENTITIES rather than two parties and no People action invokes it, and
    // `core.find_duplicate_parties` is the read half of a surface that does
    // not exist yet (census §A5).
    assert!(registry.get("core.merge_entity").is_none());
    assert!(registry.get("core.find_duplicate_parties").is_none());
    // Tally is deleted from v0 (#1099): none of its commands, nor People's two debt commands.
    assert!(registry.get("tally.add_expense").is_none());
    assert!(registry.get("people.add_debt").is_none());
    assert!(registry.get("people.settle_debt").is_none());
    // The three `schedule.*` names other lanes and surfaces call BY NAME:
    // Notes' `send-to-tasks`, the extension's `capture:task` frame and its
    // `agenda:add` frame.
    assert!(registry.get("schedule.add_task").is_some());
    assert!(registry.get("schedule.organize_task").is_some());
    assert!(registry.get("schedule.propose_event").is_some());
    assert!(registry.get("locker.reveal_receipt").is_some());
    assert!(registry.get("tally.does_not_exist").is_none());
    // A duplicate name is refused rather than overwritten: two definitions
    // under one name means whichever registered last runs.
    let mut second = registry;
    let error = second
        .register(
            centraid_vault::commands::core::definitions()
                .into_iter()
                .next()
                .expect("there is one"),
        )
        .expect_err("a duplicate must be refused");
    assert!(error.to_string().contains("registered twice"), "{error}");
}

#[test]
fn a_real_command_writes_its_row_its_log_row_and_its_receipt() {
    let (scratch, registry) = installed("addparty");
    let outcome = scratch
        .vault
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new(
                "core.add_party",
                serde_json::json!({"display_name": "Ada Lovelace", "kind": "person"}),
            ),
        )
        .expect("the command runs");
    assert_eq!(outcome.status, CommandStatus::Executed);
    assert!(!outcome.replayed);
    let party_id = outcome.output["party_id"]
        .as_str()
        .expect("the output names the party")
        .to_owned();

    // THE ROW.
    let (name, kind): (String, String) = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT display_name, kind FROM core_party WHERE party_id = ?1",
                [&party_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("the row reads");
    assert_eq!(name, "Ada Lovelace");
    assert_eq!(kind, "person");

    // THE CENSUS, from the SAME commit — the handler ran inside the guard,
    // which is the whole reason gate six is where it is, and the
    // `update_hook` therefore saw its rows (#1029 §1).
    assert!(
        outcome.tables.iter().any(|table| table == "core_party"),
        "the command changed no core_party row: {:?}",
        outcome.tables
    );

    // THE JOURNAL AND THE RECEIPT.
    let (status, receipt_decision, action): (String, String, String) = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT i.status, r.decision, r.action
                   FROM command_invocation i
                   JOIN access_receipt r ON r.invocation_id = i.invocation_id
                  WHERE i.invocation_id = ?1",
                [&outcome.invocation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("the journal reads");
    assert_eq!(status, "executed");
    assert_eq!(receipt_decision, "allow");
    assert_eq!(action, "act core.add_party");

    // THE CHAIN HOLDS.
    let findings = scratch
        .vault
        .read(centraid_vault::audit::verify_receipt_chain)
        .expect("the chain reads");
    assert_eq!(findings.join("\n"), "");
}

#[test]
fn every_precondition_is_written_as_a_check_row_and_the_first_failure_denies() {
    let (scratch, registry) = installed("precondition");
    let outcome = scratch
        .vault
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new(
                "core.update_party",
                serde_json::json!({"party_id": "nobody", "display_name": "X"}),
            ),
        )
        .expect("the command runs and is denied");
    assert_eq!(outcome.status, CommandStatus::Failed);
    // THE AUTHOR'S SENTENCE, not the predicate.
    let reason = outcome.reason.expect("a deny carries a sentence");
    assert_eq!(
        reason,
        "there is no editable person or organisation with that id"
    );
    // AND THE RAW PREDICATE STILL REACHES THE AUDIT TRAIL.
    assert_eq!(
        outcome.predicate.as_deref(),
        Some("party_exists_and_editable")
    );

    let (checks, failed, status, decision): (i64, i64, String, String) = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT (SELECT COUNT(*) FROM command_invocation_check WHERE invocation_id = ?1),
                        (SELECT COUNT(*) FROM command_invocation_check
                          WHERE invocation_id = ?1 AND passed = 0),
                        (SELECT status FROM command_invocation WHERE invocation_id = ?1),
                        (SELECT decision FROM access_receipt WHERE invocation_id = ?1)",
                [&outcome.invocation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?)
        })
        .expect("the journal reads");
    assert_eq!(checks, 1, "the precondition's result was not written");
    assert_eq!(failed, 1);
    assert_eq!(status, "failed");
    // A DENY IS RECEIPTED. A refusal with no receipt is a refusal nobody can
    // audit, and the deny path is durable for exactly that reason.
    assert_eq!(decision, "deny");
    let explanations: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM command_explanation WHERE invocation_id = ?1",
                [&outcome.invocation_id],
                |row| row.get(0),
            )?)
        })
        .expect("the count reads");
    assert_eq!(explanations, 1);
}

#[test]
fn a_malformed_input_is_refused_and_the_message_never_carries_a_secret() {
    let (scratch, registry) = installed("schema");
    // `additionalProperties: false` — an unrecognised key is a caller that
    // believes it asked for something.
    let outcome = scratch
        .vault
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new(
                "core.add_party",
                serde_json::json!({"display_name": "A", "nope": 1}),
            ),
        )
        .expect("the command runs and is denied");
    assert_eq!(outcome.status, CommandStatus::Failed);
    assert_eq!(outcome.predicate.as_deref(), Some("schema"));
    assert!(
        outcome
            .reason
            .as_deref()
            .expect("there is a reason")
            .contains("nope"),
        "{:?}",
        outcome.reason
    );
    // A missing required key, and an enum the schema does not admit.
    for bad in [
        serde_json::json!({}),
        serde_json::json!({"display_name": "A", "kind": "agent"}),
        serde_json::json!({"display_name": ""}),
    ] {
        let outcome = scratch
            .vault
            .execute(
                &registry,
                &Principal::owner("phone"),
                &Command::new("core.add_party", bad.clone()),
            )
            .expect("the command runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "`{bad}` was accepted"
        );
    }
    // No party was created by any of them.
    let parties: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM core_party WHERE display_name = 'A'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the count reads");
    assert_eq!(parties, 0);
}

#[test]
fn a_read_only_device_is_denied_and_the_deny_is_receipted() {
    let (scratch, registry) = installed("readonly");
    let widget = Principal::OwnerDevice {
        device_id: "widget".to_owned(),
        may_act: false,
        scope_clamp: None,
    };
    let outcome = scratch
        .vault
        .execute(
            &registry,
            &widget,
            &Command::new("core.add_party", serde_json::json!({"display_name": "A"})),
        )
        .expect("the command runs and is denied");
    assert_eq!(outcome.status, CommandStatus::Failed);
    assert_eq!(outcome.predicate.as_deref(), Some("authority"));
    assert!(
        outcome
            .reason
            .as_deref()
            .expect("there is a reason")
            .contains("read-only"),
        "{:?}",
        outcome.reason
    );
    // AUTHORITY IS JUDGED BEFORE THE SCHEMA. A device that may not act is
    // denied without its input being validated, so a malformed input from an
    // unauthorised caller is an authority answer and not a schema one.
    let outcome = scratch
        .vault
        .execute(
            &registry,
            &widget,
            &Command::new("core.add_party", serde_json::json!({"nope": 1})),
        )
        .expect("the command runs");
    assert_eq!(outcome.predicate.as_deref(), Some("authority"));
}

#[test]
fn an_apps_declared_reach_is_a_ceiling_on_its_commands() {
    let (scratch, registry) = installed("clamp");
    let app = Principal::OwnerDevice {
        device_id: "money-app".to_owned(),
        may_act: true,
        scope_clamp: Some(ScopeClamp {
            scopes: vec![Scope {
                schema: "money".to_owned(),
                table: None,
                verb: "read+act".to_owned(),
                row_filter: vec![RowFilter {
                    column: "account_id".to_owned(),
                    values: vec!["a1".to_owned()],
                }],
                field_mask: None,
            }],
        }),
    };
    // Money's own commands are inside the reach, so the whole gate order runs
    // and the command's OWN precondition is what answers — not the authority
    // gate. `a1` is not an account in this scratch vault, so the sentence is the
    // account condition's and the predicate names it (#1020, D-1020-T3).
    let outcome = scratch
        .vault
        .execute(
            &registry,
            &app,
            &Command::new(
                "money.edit_account",
                serde_json::json!({"account_id": "a1", "name": "Trip"}),
            ),
        )
        .expect("the command runs inside the app's reach");
    assert_eq!(outcome.status, CommandStatus::Failed);
    assert_eq!(outcome.predicate.as_deref(), Some("account_is_money"));
    assert_eq!(
        outcome.reason.as_deref(),
        Some("There is no Money account with that id.")
    );

    // `core.*` is outside it.
    let outcome = scratch
        .vault
        .execute(
            &registry,
            &app,
            &Command::new("core.add_party", serde_json::json!({"display_name": "A"})),
        )
        .expect("the command runs and is denied");
    assert_eq!(outcome.status, CommandStatus::Failed);
    assert!(
        outcome
            .reason
            .as_deref()
            .expect("there is a reason")
            .contains("declared reach"),
        "{:?}",
        outcome.reason
    );
}

#[test]
fn a_stale_registration_is_an_ontology_mismatch_and_not_a_compatibility_range() {
    let (scratch, registry) = installed("ontology");
    // COMPATIBILITY IS EQUALITY ON PURPOSE (#310): there is one served
    // ontology version, so a mismatch is a stale REGISTRATION.
    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.stale");
            tx.connection().execute(
                "UPDATE command_definition SET ontology_version = '0.9' WHERE name = 'core.add_party'",
                [],
            )?;
            Ok(())
        })
        .expect("the forge commits");
    let error = scratch
        .vault
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new("core.add_party", serde_json::json!({"display_name": "A"})),
        )
        .expect_err("a stale registration is refused");
    match error {
        VaultError::OntologyVersionMismatch {
            name,
            registered,
            served,
        } => {
            assert_eq!(name, "core.add_party");
            assert_eq!(registered, "0.9");
            assert_eq!(served, "1.0");
        }
        other => panic!("expected OntologyVersionMismatch, got {other}"),
    }
}

#[test]
fn tagging_an_item_is_idempotent_and_the_same_label_returns_the_same_edge() {
    let (scratch, registry) = installed("tag");
    let note = common::insert_note(&scratch.vault, "Holiday").expect("a note is written");
    let first = scratch
        .vault
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new(
                "core.tag_item",
                serde_json::json!({
                    "subject_type": "knowledge.note",
                    "subject_id": note,
                    "label": "  Beach   Day "
                }),
            ),
        )
        .expect("the command runs");
    assert_eq!(first.status, CommandStatus::Executed);
    // The notation is the display label lowercased and whitespace-collapsed.
    assert_eq!(first.output["notation"], "beach day");

    let again = scratch
        .vault
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new(
                "core.tag_item",
                serde_json::json!({
                    "subject_type": "knowledge.note",
                    "subject_id": note,
                    "label": "BEACH DAY"
                }),
            ),
        )
        .expect("the command runs");
    // A DIFFERENT SPELLING OF THE SAME LABEL IS THE SAME TAG, because the
    // notation is what the concept is keyed on.
    assert_eq!(again.output["tag_id"], first.output["tag_id"]);
    assert_eq!(again.output["concept_id"], first.output["concept_id"]);
    let tags: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row("SELECT COUNT(*) FROM core_tag", [], |row| row.get(0))?)
        })
        .expect("the count reads");
    assert_eq!(tags, 1);

    // An owner-asserted tag names a party and carries NO confidence — the
    // exact inverse of an enrichment-derived one, and the table's own CHECK is
    // what makes the two shapes mutually exclusive.
    let (party, confidence): (Option<String>, Option<f64>) = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT tagged_by_party_id, confidence FROM core_tag",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("the row reads");
    assert!(party.is_some());
    assert_eq!(confidence, None);

    // A dead subject is refused by the precondition, with a sentence.
    let outcome = scratch
        .vault
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new(
                "core.tag_item",
                serde_json::json!({
                    "subject_type": "knowledge.note",
                    "subject_id": "no-such-note",
                    "label": "x"
                }),
            ),
        )
        .expect("the command runs and is denied");
    assert_eq!(outcome.status, CommandStatus::Failed);
    assert!(
        outcome
            .reason
            .as_deref()
            .expect("there is a reason")
            .contains("no live knowledge.note"),
        "{:?}",
        outcome.reason
    );
}

#[test]
fn updating_a_party_reads_back_exactly_what_it_was_sent() {
    let (scratch, registry) = installed("update");
    let created = scratch
        .vault
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new(
                "core.add_party",
                serde_json::json!({"display_name": "Before"}),
            ),
        )
        .expect("the command runs");
    let party_id = created.output["party_id"]
        .as_str()
        .expect("an id")
        .to_owned();

    let updated = scratch
        .vault
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new(
                "core.update_party",
                serde_json::json!({"party_id": party_id, "display_name": "After",
                                   "sort_name": "After, The"}),
            ),
        )
        .expect("the command runs");
    assert_eq!(updated.status, CommandStatus::Executed);
    // The POSTCONDITION is what proves it, and it is written as a check row.
    let posts: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM command_invocation_check
                  WHERE invocation_id = ?1 AND phase = 'post' AND passed = 1",
                [&updated.invocation_id],
                |row| row.get(0),
            )?)
        })
        .expect("the count reads");
    assert_eq!(posts, 1);

    // AND THE UPDATE REPORTED THE TABLE IT CHANGED. The prior image it used
    // to be checked against lived in `replica_log`, which is deleted with the
    // replica plane (#1029 §1); what a screen needs, and all it ever needed,
    // is that `core_party` moved.
    assert!(
        updated.tables.iter().any(|table| table == "core_party"),
        "{:?}",
        updated.tables
    );
}

#[test]
fn a_reach_scheme_is_refused_by_name_rather_than_dropped_in_silence() {
    // D-1020-D1-14. The failure this avoids: the app believes it bound an
    // email and nothing did.
    let (scratch, registry) = installed("reach");
    let outcome = scratch.vault.execute(
        &registry,
        &Principal::owner("phone"),
        &Command::new(
            "core.add_party",
            serde_json::json!({
                "display_name": "Ada",
                "identifiers": [{"scheme": "email", "value": "ada@example.com"}]
            }),
        ),
    );
    let error = outcome.expect_err("a reach scheme must be refused");
    assert!(
        error.to_string().contains("social.save_contact_channel"),
        "the refusal does not name the command that takes it: {error}"
    );
    // And a register scheme binds.
    let bound = scratch
        .vault
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new(
                "core.add_party",
                serde_json::json!({
                    "display_name": "Ada",
                    "identifiers": [{"scheme": "handle", "value": "@ada"}]
                }),
            ),
        )
        .expect("the command runs");
    assert_eq!(bound.output["identifiers_bound"], 1);

    // A SECOND PARTY CLAIMING THE SAME IDENTIFIER IS A FORK, refused with the
    // name of whoever holds it — so the app can offer that party instead.
    let error = scratch
        .vault
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new(
                "core.add_party",
                serde_json::json!({
                    "display_name": "Someone Else",
                    "identifiers": [{"scheme": "handle", "value": "@ada"}]
                }),
            ),
        )
        .expect_err("a fork must be refused");
    assert!(error.to_string().contains("already identifies"), "{error}");
    assert!(error.to_string().contains("Ada"), "{error}");
}

#[test]
fn the_registrys_record_is_written_and_is_not_what_runs() {
    let (scratch, registry) = installed("record");
    let (count, preconditions): (i64, String) = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT (SELECT COUNT(*) FROM command_definition),
                        (SELECT preconditions_json FROM command_definition
                          WHERE name = 'core.update_party')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("the record reads");
    assert_eq!(count, i64::try_from(registry.len()).unwrap_or(-1));
    // The RECORD is the predicate's NAME: a predicate is a function and does
    // not serialise, so the row says what is registered and the Rust
    // definition says what runs.
    assert_eq!(preconditions, "[\"party_exists_and_editable\"]");
}

#[test]
fn a_secret_input_is_tokenised_before_the_journal_and_the_token_is_stable() {
    // The journal is append-only, so a secret written into it is permanent.
    // No shipped command declares a sealed input yet — Locker's do, in wave 4
    // — so this holds the mechanism rather than a command.
    let input = serde_json::json!({"label": "Google", "access_token": "ya29.SECRET"});
    let redacted = centraid_vault::audit::redact_command_input(&input, &["access_token"]);
    let text = serde_json::to_string(&redacted).expect("it serialises");
    assert!(!text.contains("ya29.SECRET"));
    assert!(text.contains("sealed:blake3:"));
    assert!(text.contains("Google"), "the non-secret keys survive");
}
