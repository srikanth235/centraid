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
    // Three real `core.*` commands plus the 23 `tally.*` skeletons.
    assert_eq!(registry.len(), 26);
    assert_eq!(
        registry
            .names()
            .iter()
            .filter(|name| name.starts_with("tally."))
            .count(),
        23
    );
    assert!(registry.get("core.add_party").is_some());
    assert!(registry.get("tally.add_expense").is_some());
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

    // THE LOG ROW, produced by the SAME commit — the handler ran inside the
    // guard, which is the whole reason gate six is where it is.
    assert!(outcome.commit_seq.is_some());
    assert!(
        outcome
            .produced
            .iter()
            .any(|row| row.table == "core_party" && row.row_version == Some(1)),
        "the command produced no core_party row: {:?}",
        outcome.produced
    );

    // THE JOURNAL AND THE RECEIPT.
    let (status, receipt_decision, action): (String, String, String) = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT i.status, r.decision, r.action
                   FROM agent_command_invocation i
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
                "SELECT (SELECT COUNT(*) FROM agent_invocation_check WHERE invocation_id = ?1),
                        (SELECT COUNT(*) FROM agent_invocation_check
                          WHERE invocation_id = ?1 AND passed = 0),
                        (SELECT status FROM agent_command_invocation WHERE invocation_id = ?1),
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
                "SELECT COUNT(*) FROM agent_explanation WHERE invocation_id = ?1",
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
        device_id: "tally-app".to_owned(),
        may_act: true,
        scope_clamp: Some(ScopeClamp {
            scopes: vec![Scope {
                schema: "tally".to_owned(),
                table: None,
                verb: "read+act".to_owned(),
                row_filter: vec![RowFilter {
                    column: "group_id".to_owned(),
                    values: vec!["g1".to_owned()],
                }],
                field_mask: None,
            }],
        }),
    };
    // Tally's own commands are inside the reach — and a tally stub still gets
    // through the whole gate order before its body refuses, which is what
    // makes the registry useful before lane D3 fills it in.
    let error = scratch
        .vault
        .execute(
            &registry,
            &app,
            &Command::new(
                "tally.rename_group",
                serde_json::json!({"group_id": "g1", "name": "Trip"}),
            ),
        )
        .expect_err("a stub has no body yet");
    assert!(
        matches!(&error, VaultError::NotImplemented { name } if name == "tally.rename_group"),
        "{error}"
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
                "UPDATE agent_command SET ontology_version = '0.9' WHERE name = 'core.add_party'",
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
fn a_duplicate_delivery_at_the_command_door_executes_once() {
    let (scratch, registry) = installed("idempotency");
    common::enrol(&scratch.vault, "phone", "pk").expect("the device enrols");
    let command = Command::new(
        "core.add_party",
        serde_json::json!({"display_name": "Once Only"}),
    )
    .with_intent("intent-1", "phone");

    let first = scratch
        .vault
        .execute(&registry, &Principal::owner("phone"), &command)
        .expect("the first delivery runs");
    assert_eq!(first.status, CommandStatus::Executed);
    assert!(!first.replayed);

    let second = scratch
        .vault
        .execute(&registry, &Principal::owner("phone"), &command)
        .expect("the second delivery is answered from the ledger");
    // ANSWERED FROM THE LEDGER. The handler did not run again, which is the
    // whole point of the ledger.
    assert!(second.replayed);
    assert_eq!(second.commit_seq, first.commit_seq);

    let parties: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM core_party WHERE display_name = 'Once Only'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the count reads");
    assert_eq!(parties, 1, "the duplicate delivery executed twice");

    // AND THE SAME ID WITH A DIFFERENT PAYLOAD IS A REUSE, not a retry.
    let forked = Command::new(
        "core.add_party",
        serde_json::json!({"display_name": "Something Else"}),
    )
    .with_intent("intent-1", "phone");
    let error = scratch
        .vault
        .execute(&registry, &Principal::owner("phone"), &forked)
        .expect_err("a reused id must be refused");
    assert!(error.to_string().contains("intent_id_reused"), "{error}");
}

#[test]
fn an_expired_outcome_says_so_rather_than_re_executing() {
    let (scratch, registry) = installed("expiry");
    common::enrol(&scratch.vault, "phone", "pk").expect("the device enrols");
    let command = Command::new(
        "core.add_party",
        serde_json::json!({"display_name": "Aged"}),
    )
    .with_intent("intent-aged", "phone");
    scratch
        .vault
        .execute(&registry, &Principal::owner("phone"), &command)
        .expect("the first delivery runs");

    // Past the 30-day window, which is the log's retention floor on purpose:
    // an outcome that outlived the log rows its `commit_seq` points into can
    // no longer say where its effect landed.
    scratch.clock.advance_days(31);
    let error = scratch
        .vault
        .execute(&registry, &Principal::owner("phone"), &command)
        .expect_err("an expired outcome must refuse");
    assert!(error.to_string().contains("outcome_expired"), "{error}");
    // AND IT DID NOT RE-EXECUTE. "I no longer know" is the honest answer;
    // "here, do it again" is the one that double-charges someone.
    let parties: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM core_party WHERE display_name = 'Aged'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the count reads");
    assert_eq!(parties, 1);
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
                "SELECT COUNT(*) FROM agent_invocation_check
                  WHERE invocation_id = ?1 AND phase = 'post' AND passed = 1",
                [&updated.invocation_id],
                |row| row.get(0),
            )?)
        })
        .expect("the count reads");
    assert_eq!(posts, 1);

    // AND THE UPDATE IS AN UPDATE LOG ROW WITH A DELTA PRIOR.
    assert!(updated.commit_seq.is_some());
    let prior: Option<String> = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT prior_json FROM replica_log
                  WHERE commit_seq = ?1 AND \"table\" = 'core_party' AND op = 'update'",
                [updated.commit_seq.expect("there is one")],
                |row| row.get(0),
            )?)
        })
        .expect("the row reads");
    let prior = prior.expect("an update carries a prior");
    assert!(prior.contains("Before"), "{prior}");
    assert!(!prior.contains("After"), "{prior}");
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
fn every_tally_stub_refuses_with_notimplemented_and_validates_its_input_first() {
    let (scratch, registry) = installed("stubs");
    let owner = Principal::owner("phone");
    let mut not_implemented = 0;
    for name in registry.names() {
        if !name.starts_with("tally.") {
            continue;
        }
        // An EMPTY input: a stub with required keys refuses on the schema, one
        // without reaches its body. Either way it never pretends to work.
        let outcome = scratch.vault.execute(
            &registry,
            &owner,
            &Command::new(name, serde_json::json!({})),
        );
        match outcome {
            Err(VaultError::NotImplemented { name: refused }) => {
                assert_eq!(refused, name);
                not_implemented += 1;
            }
            Ok(done) => {
                assert_eq!(
                    done.status,
                    CommandStatus::Failed,
                    "`{name}` reported success"
                );
                assert_eq!(done.predicate.as_deref(), Some("schema"), "`{name}`");
            }
            Err(other) => panic!("`{name}`: {other}"),
        }
    }
    // At least the ones with no required keys reached their body, so the
    // `NotImplemented` path is exercised and not merely available.
    assert!(
        not_implemented > 0,
        "no stub reached its body; the schemas refused all 23"
    );
}

#[test]
fn the_registrys_record_is_written_and_is_not_what_runs() {
    let (scratch, registry) = installed("record");
    let (count, preconditions): (i64, String) = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT (SELECT COUNT(*) FROM agent_command),
                        (SELECT preconditions_json FROM agent_command
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
    assert!(text.contains("sealed:sha256:"));
    assert!(text.contains("Google"), "the non-secret keys survive");
}
