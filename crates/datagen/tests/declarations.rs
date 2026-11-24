//! Guard tests for Part 1 & Part 2 declarations, coverage, currency, and Locker safety.

use std::collections::BTreeMap;

use centraid_assist::native::meta;
use centraid_datagen::declarations::{CURRENCIES, Declarations};
use centraid_datagen::fixture_world::{self, FixtureRequest};
use centraid_datagen::intents::{audit_coverage, generate_pool};
use centraid_datagen::oracle::{check_currency_message, check_no_sealed, replay_intent};
use centraid_datagen::{Catalog, Split};

#[test]
fn every_live_declaration_and_argument_produces_at_least_one_intent() {
    let decls = Declarations::build().expect("declarations build");
    assert_eq!(decls.kinds.len(), 28, "expected all 28 live kinds");
    assert_eq!(decls.tools.len(), 8, "expected all 8 tools");

    let pool = generate_pool(&decls, 1, 5000, 500, 1000, 0);
    let audit = audit_coverage(&decls, &pool);
    assert!(
        audit.uncovered_tools.is_empty(),
        "live tools with 0 intents: {:?}",
        audit.uncovered_tools
    );
    assert!(
        audit.uncovered_args.is_empty(),
        "live tool arguments with 0 intents: {:?}",
        audit.uncovered_args
    );
    assert!(
        audit.uncovered_kinds.is_empty(),
        "live kinds with 0 intents: {:?}",
        audit.uncovered_kinds
    );
    assert!(
        audit.uncovered_kind_fields.is_empty(),
        "live (kind, field) pairs with 0 intents: {:?}",
        audit.uncovered_kind_fields
    );
    assert!(
        audit.uncovered_manifest_actions.is_empty(),
        "manifest actions with 0 intents: {:?}",
        audit.uncovered_manifest_actions
    );
    assert!(audit.is_complete());
}

#[test]
fn all_manifest_actions_have_declared_tool_paths() {
    let decls = Declarations::build().expect("declarations build");
    let expected = meta::manifest_actions();
    assert!(
        expected.len() >= 228,
        "expected >= 228 ALL_MANIFEST_ACTIONS, got {}",
        expected.len()
    );
    assert_eq!(decls.manifest_actions.len(), expected.len());
    for ma in expected {
        let found = decls
            .manifest_actions
            .iter()
            .find(|d| d.app == ma.app && d.action == ma.action && d.command == ma.command);
        assert!(
            found.is_some(),
            "missing manifest action declaration for {}.{}",
            ma.app,
            ma.action
        );
        let decl = found.expect("checked");
        assert!(
            !decl.tool_path.is_empty() && !decl.meaning_key.is_empty(),
            "manifest action {}.{} has empty tool_path or meaning_key",
            ma.app,
            ma.action
        );
    }
}

#[test]
fn money_worlds_mix_six_currencies_with_about_forty_percent_inr() {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let total = 200_usize;
    for i in 0..total {
        let req = FixtureRequest::simple(Split::Train, (i as u64) + 17, "transaction");
        let (world, target) = fixture_world::build(&req);
        assert_eq!(world.persona.currency, target.currency);
        *counts.entry(target.currency).or_default() += 1;
    }
    for c in CURRENCIES {
        assert!(
            counts.get(c).copied().unwrap_or(0) > 0,
            "missing currency {c} in fixture worlds: {counts:?}"
        );
    }
    let inr = counts.get("INR").copied().unwrap_or(0);
    assert!(
        (60..=100).contains(&inr),
        "expected ~40% INR out of {total}, got {inr} ({counts:?})"
    );
}

#[test]
fn currency_message_check_enforces_forms_and_rejects_mismatch() {
    for good in [
        "spent ₹500 on groceries",
        "paid Rs 1200 for dinner",
        "budget is Rs. 2500",
        "total in INR 8000",
        "5000 rupees on rent",
        "2 lakh budget",
        "1 crore savings",
    ] {
        assert!(
            check_currency_message(good, "INR").is_ok(),
            "failed: {good}"
        );
    }
    assert!(check_currency_message("spent $50 on dinner", "INR").is_err());
    assert!(check_currency_message("spent 500 on dinner", "INR").is_err());
    assert!(check_currency_message("spent $50 on lunch", "USD").is_ok());
    assert!(check_currency_message("spent €45 on lunch", "EUR").is_ok());
    assert!(check_currency_message("spent £30 on lunch", "GBP").is_ok());
    assert!(check_currency_message("spent AED 120 on lunch", "AED").is_ok());
    assert!(check_currency_message("spent S$25 on lunch", "SGD").is_ok());
    assert!(check_currency_message("spent ₹500 on lunch", "USD").is_err());
}

#[test]
fn locker_reveal_and_worlds_never_leak_sealed_placeholders() {
    let decls = Declarations::build().expect("declarations");
    let catalog = Catalog::from_declarations(&decls);
    let pool = generate_pool(&decls, 42, 0, 0, 0, 0);
    let reveal_spec = pool
        .iter()
        .find(|s| s.covered_cells.iter().any(|c| c == "do/locker item/reveal"))
        .expect("reveal intent exists");

    let doc_text = serde_json::to_string(&reveal_spec.world.doc).expect("json");
    assert!(check_no_sealed(&doc_text).is_ok());
    assert!(doc_text.contains("\"sealed\""));

    let scratch = tempfile::tempdir().expect("tempdir");
    let replayed = replay_intent(
        reveal_spec,
        &catalog,
        &["reveal the password for my bank login".to_owned()],
        scratch.path(),
    )
    .expect("seed ok");
    let record = replayed.expect("reveal replay succeeds on runtime");
    let record_text = serde_json::to_string(&record).expect("json");
    assert!(check_no_sealed(&record_text).is_ok());
}

#[test]
fn train_floors_and_heldout_created_person_names_are_enforced() {
    use centraid_datagen::intent::{Intent, Val};
    use centraid_datagen::pools;

    let decls = Declarations::build().expect("declarations build");
    let pool = generate_pool(&decls, 1, 5000, 500, 1000, 30);

    let mut cell_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut kf_counts: BTreeMap<(String, String), usize> = BTreeMap::new();
    let mut arg_counts: BTreeMap<(String, String), usize> = BTreeMap::new();

    for spec in &pool {
        if spec.split == Split::Train {
            for c in &spec.covered_cells {
                *cell_counts.entry(c.clone()).or_default() += 1;
            }
            for kf in &spec.covered_kind_fields {
                *kf_counts.entry(kf.clone()).or_default() += 1;
            }
            for ta in &spec.covered_tool_args {
                *arg_counts.entry(ta.clone()).or_default() += 1;
            }
        } else {
            for turn in &spec.scenario.turns {
                if let Intent::Create { kind, fields } = &turn.intent
                    && kind == "person"
                {
                    for ch in fields {
                        if ch.field == "name"
                            && let Val::Text(full) = &ch.value
                        {
                            let first = full.split_whitespace().next().unwrap_or("");
                            assert!(
                                !pools::NEW_FIRST_TRAIN.contains(&first),
                                "held-out/val split {:?} created person name `{full}` used train pool",
                                spec.split
                            );
                        }
                    }
                }
            }
        }
    }

    for (cell, count) in &cell_counts {
        assert!(*count >= 30, "train cell `{cell}` below floor 30: {count}");
    }
    for kd in decls.kinds.iter().filter(|k| k.live) {
        for fd in kd.fields.iter().filter(|f| f.live) {
            let count = kf_counts
                .get(&(kd.name.clone(), fd.name.clone()))
                .copied()
                .unwrap_or(0);
            assert!(
                count >= 30,
                "train (kind, field) `({}.{})` below floor 30: {count}",
                kd.name,
                fd.name
            );
        }
    }
    for td in decls.tools.iter().filter(|t| t.live) {
        for ad in td.args.iter().filter(|a| a.live) {
            let count = arg_counts
                .get(&(td.name.clone(), ad.name.clone()))
                .copied()
                .unwrap_or(0);
            assert!(
                count >= 30,
                "train live arg `{}.{}` below floor 30: {count}",
                td.name,
                ad.name
            );
        }
    }
}
