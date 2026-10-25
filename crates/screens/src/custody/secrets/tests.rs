use super::*;

const SEED: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn ok() -> wire::SecretAnswer {
    wire::SecretAnswer {
        ok: true,
        ..Default::default()
    }
}

fn refused() -> wire::SecretAnswer {
    wire::SecretAnswer::default()
}

/// Run `ops` against the cache as a faithful shell would: every op took.
fn apply(secrets: &VaultSecrets, ops: &[wire::SecretOp]) {
    let answers = vec![ok(); ops.len()];
    secrets.absorb(ops, &answers);
}

fn listing(entries: &[(&str, &str)]) -> wire::SecretAnswer {
    wire::SecretAnswer {
        ok: true,
        entries: entries
            .iter()
            .map(|(key, value)| wire::SecretEntry {
                key: (*key).to_owned(),
                value: value.as_bytes().to_vec(),
            })
            .collect(),
        ..Default::default()
    }
}

fn words() -> Vec<String> {
    (0..WORDS).map(|_| "abandon".to_owned()).collect()
}

#[test]
fn nothing_is_known_until_the_shell_has_listed_both_stores() {
    let secrets = VaultSecrets::new();
    assert!(!secrets.loaded());
    assert_eq!(secrets.seed(), None);
    let ops = VaultSecrets::load_ops();
    secrets.absorb(&ops, &[listing(&[(LOCAL_SEED, SEED)]), listing(&[])]);
    assert!(secrets.loaded());
    assert_eq!(secrets.seed().as_deref(), Some(SEED));
}

#[test]
fn a_refused_load_leaves_it_unloaded() {
    let secrets = VaultSecrets::new();
    secrets.absorb(&VaultSecrets::load_ops(), &[refused(), refused()]);
    assert!(!secrets.loaded());
}

#[test]
fn the_synchronised_seed_wins_and_a_malformed_one_is_no_seed() {
    let secrets = VaultSecrets::new();
    secrets.absorb(
        &VaultSecrets::load_ops(),
        &[
            listing(&[(LOCAL_SEED, "short")]),
            listing(&[(SEED_KEY, SEED)]),
        ],
    );
    assert_eq!(secrets.seed().as_deref(), Some(SEED));
    assert!(secrets.seed_synced());
    let bad = VaultSecrets::new();
    bad.absorb(
        &VaultSecrets::load_ops(),
        &[listing(&[(LOCAL_SEED, "short")]), listing(&[])],
    );
    assert_eq!(bad.seed(), None, "present and malformed is no seed");
}

#[test]
fn a_seed_the_platform_synchronises_leaves_no_device_copy() {
    let secrets = VaultSecrets::new();
    let write = VaultSecrets::remember_seed(SEED, true);
    let first = write.first();
    let answers = vec![ok()];
    secrets.absorb(&first, &answers);
    assert!(write.synchronised(&answers));
    let second = write.second(&answers);
    apply(&secrets, &second);
    assert!(secrets.seed_synced());
    assert_eq!(secrets.device_get(LOCAL_SEED), None, "one seed and not two");
}

#[test]
fn a_platform_that_will_not_take_it_still_leaves_it_on_the_phone() {
    let secrets = VaultSecrets::new();
    let write = VaultSecrets::remember_seed(SEED, true);
    let answers = vec![refused()];
    secrets.absorb(&write.first(), &answers);
    assert!(!write.synchronised(&answers));
    apply(&secrets, &write.second(&answers));
    assert_eq!(secrets.seed().as_deref(), Some(SEED));
    assert!(!secrets.seed_synced());
}

#[test]
fn opting_out_keeps_the_seed_here_and_removes_the_synced_copy() {
    let secrets = VaultSecrets::new();
    secrets.absorb(
        &VaultSecrets::load_ops(),
        &[listing(&[]), listing(&[(SEED_KEY, SEED)])],
    );
    let write = VaultSecrets::remember_seed(SEED, false);
    let first = write.first();
    apply(&secrets, &first);
    assert!(write.second(&[ok(), ok()]).is_empty());
    assert!(!secrets.seed_synced());
    assert_eq!(secrets.seed().as_deref(), Some(SEED));
}

#[test]
fn an_empty_value_deletes() {
    let secrets = VaultSecrets::new();
    apply(&secrets, &[VaultSecrets::mark_words_saved()]);
    assert!(secrets.words_saved());
    apply(&secrets, &VaultSecrets::forget_seed());
    assert!(!secrets.words_saved());
    assert_eq!(secrets.seed(), None);
}

#[test]
fn the_words_are_kept_beside_the_seed_and_shown_again() {
    let secrets = VaultSecrets::new();
    apply(&secrets, &[VaultSecrets::remember_words(&words())]);
    assert_eq!(secrets.words(), Some(words()));
}

#[test]
#[should_panic(expected = "24 lowercase list words")]
fn words_that_are_not_24_list_words_are_a_caller_bug() {
    let _ = VaultSecrets::remember_words(&["abandon".to_owned()]);
}

#[test]
fn a_seed_is_settled_by_the_flag_or_by_any_recorded_index() {
    let secrets = VaultSecrets::new();
    assert!(!secrets.seed_settled());
    apply(&secrets, &[VaultSecrets::settle_seed()]);
    assert!(secrets.seed_settled());
    let by_index = VaultSecrets::new();
    apply(&by_index, &by_index.remember_vault_index("v1", 0));
    assert!(by_index.seed_settled());
}

#[test]
fn the_high_water_mark_is_never_lowered_by_forgetting_a_vault() {
    let secrets = VaultSecrets::new();
    assert_eq!(secrets.next_vault_index(), 0);
    apply(&secrets, &secrets.remember_vault_index("a", 0));
    apply(&secrets, &secrets.remember_vault_index("b", 3));
    assert_eq!(secrets.next_vault_index(), 4);
    apply(&secrets, &secrets.remember_vault_index("c", 1));
    assert_eq!(
        secrets.next_vault_index(),
        4,
        "a lower index does not lower the mark"
    );
    apply(&secrets, &[VaultSecrets::forget_vault_index("b")]);
    assert_eq!(secrets.vault_index("b"), None);
    assert_eq!(secrets.next_vault_index(), 4);
}

#[test]
fn the_index_is_spent_before_the_found_and_given_back_only_while_highest() {
    let secrets = VaultSecrets::new();
    apply(&secrets, &secrets.remember_vault_index("a", 0));
    let (index, ops) = secrets.reserve_vault_index("/vaults/b.db");
    assert_eq!(index, 1);
    apply(&secrets, &ops);
    assert_eq!(
        secrets.pending_found(),
        Some(PendingFound {
            index: 1,
            path: "/vaults/b.db".to_owned(),
            own: None
        })
    );
    assert_eq!(secrets.next_vault_index(), 2, "spent before the found");
    apply(&secrets, &secrets.release_vault_index(1));
    assert_eq!(secrets.pending_found(), None);
    assert_eq!(
        secrets.next_vault_index(),
        1,
        "a refused found gives it back"
    );

    let (second, ops) = secrets.reserve_vault_index("/vaults/c.db");
    apply(&secrets, &ops);
    apply(&secrets, &secrets.remember_vault_index("c", second));
    let (_, ops) = secrets.reserve_vault_index("/vaults/d.db");
    apply(&secrets, &ops);
    // `c` is no longer the highest: releasing its index must not lower the mark.
    apply(&secrets, &secrets.release_vault_index(second));
    assert_eq!(secrets.next_vault_index(), 3);
}

#[test]
fn a_pending_found_on_an_entrys_seed_names_the_entry() {
    let secrets = VaultSecrets::new();
    apply(
        &secrets,
        &[VaultSecrets::reserve_own_found(
            "/v/x.db",
            "abcdabcdabcdabcd",
        )],
    );
    assert_eq!(
        secrets.pending_found(),
        Some(PendingFound {
            index: 0,
            path: "/v/x.db".to_owned(),
            own: Some("abcdabcdabcdabcd".to_owned())
        })
    );
    assert!(
        !secrets.any_vault_index(),
        "an entry's index never moves the member's mark"
    );
    apply(&secrets, &[VaultSecrets::clear_pending_found()]);
    assert_eq!(secrets.pending_found(), None);
}

#[test]
fn a_vault_key_is_the_members_seed_at_its_index_or_its_entrys() {
    let secrets = VaultSecrets::new();
    assert_eq!(secrets.vault_key("a"), None, "no seed, no key");
    apply(&secrets, &VaultSecrets::remember_seed(SEED, false).first());
    assert_eq!(
        secrets.vault_key("a"),
        None,
        "no index, no key: never a guess at 0"
    );
    apply(&secrets, &secrets.remember_vault_index("a", 2));
    let key = secrets.vault_key("a").unwrap();
    assert_eq!(
        key,
        VaultKey {
            index: 2,
            own: None
        }
    );
    assert_eq!(secrets.seed_for(&key).as_deref(), Some(SEED));

    let id = VaultSecrets::fresh_entry_id();
    assert_eq!(id.len(), 16);
    let other = SEED.replace('0', "f");
    let write = secrets.keep_own_seed(&id, &other, "Work", false);
    assert!(write.first().is_empty());
    apply(&secrets, &write.second(&[]));
    apply(&secrets, &VaultSecrets::bind_own_vault("w", &id, 0));
    let own = secrets.vault_key("w").unwrap();
    assert_eq!(
        own,
        VaultKey {
            index: 0,
            own: Some(id.clone())
        }
    );
    assert_eq!(secrets.seed_for(&own).as_deref(), Some(other.as_str()));
    assert!(
        secrets.next_vault_index() == 3,
        "the entry's vault moved no mark"
    );
    assert_eq!(secrets.own_seed_of("w").as_deref(), Some(id.as_str()));
}

#[test]
fn an_entry_synchronised_lists_with_its_label_and_a_refusal_falls_back_to_the_phone() {
    let secrets = VaultSecrets::new();
    let id = VaultSecrets::fresh_entry_id();
    let write = secrets.keep_own_seed(&id, SEED, "Joint\tvault\n", true);
    let first = write.first();
    let both = vec![ok(), ok()];
    secrets.absorb(&first, &both);
    assert!(write.synchronised(&both));
    assert!(write.second(&both).is_empty());
    let listed = secrets.own_seeds();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].label, "Joint vault", "a label is one clean line");
    assert_eq!(
        format!("{:?}", listed[0]),
        format!("OwnSeed({id}, Joint vault, <redacted>)")
    );

    let fallback = VaultSecrets::new();
    let write = fallback.keep_own_seed(&id, SEED, "Joint", true);
    let answers = vec![ok(), refused()];
    fallback.absorb(&write.first(), &answers);
    assert!(!write.synchronised(&answers));
    apply(&fallback, &write.second(&answers));
    assert_eq!(fallback.own_seed(&id).as_deref(), Some(SEED));
    assert_eq!(fallback.own_seeds()[0].label, "Joint");
    assert_eq!(
        fallback.own_seed_matching(SEED).as_deref(),
        Some(id.as_str())
    );
}

#[test]
fn forgetting_an_entry_removes_every_trace() {
    let secrets = VaultSecrets::new();
    let id = VaultSecrets::fresh_entry_id();
    let write = secrets.keep_own_seed(&id, SEED, "Joint", true);
    let answers = vec![ok(), ok()];
    secrets.absorb(&write.first(), &answers);
    apply(&secrets, &[VaultSecrets::remember_own_words(&id, &words())]);
    apply(&secrets, &[secrets.add_pending_filing(&id, "Joint")]);
    assert_eq!(secrets.own_words(&id), Some(words()));
    assert_eq!(
        secrets.pending_filings(),
        vec![(id.clone(), "Joint".to_owned())]
    );
    apply(&secrets, &VaultSecrets::bind_own_vault("j", &id, 0));
    apply(&secrets, &secrets.forget_own_vault("j"));
    assert_eq!(secrets.own_seed(&id), None);
    assert!(secrets.own_seeds().is_empty());
    assert_eq!(secrets.own_words(&id), None);
    assert!(secrets.pending_filings().is_empty());
    assert_eq!(secrets.own_seed_of("j"), None);
}

#[test]
fn relabelling_changes_the_line_wherever_it_is_listed() {
    let secrets = VaultSecrets::new();
    let id = VaultSecrets::fresh_entry_id();
    let write = secrets.keep_own_seed(&id, SEED, "Old", true);
    secrets.absorb(&write.first(), &[ok(), ok()]);
    apply(&secrets, &secrets.label_own_seed(&id, " New "));
    assert_eq!(secrets.own_seeds()[0].label, "New");
}

#[test]
fn nothing_the_cache_holds_reaches_a_debug_line() {
    let secrets = VaultSecrets::new();
    apply(&secrets, &VaultSecrets::remember_seed(SEED, false).first());
    assert!(!format!("{secrets:?}").contains(SEED));
    assert!(!format!("{:?}", VaultSecrets::remember_seed(SEED, true)).contains(SEED));
}

#[test]
#[should_panic(expected = "128 lowercase hex characters")]
fn writing_a_malformed_seed_is_refused_at_the_call() {
    let _ = VaultSecrets::remember_seed("not a seed", true);
}

#[test]
fn a_saved_copy_is_a_claim_kept_apart_from_the_key() {
    let secrets = VaultSecrets::new();
    assert!(!secrets.words_saved());
    apply(&secrets, &[VaultSecrets::mark_words_saved()]);
    assert!(secrets.words_saved());
    // Forgetting the seed forgets the claim, and the words with it.
    apply(&secrets, &[VaultSecrets::remember_words(&words())]);
    apply(&secrets, &VaultSecrets::forget_seed());
    assert!(!secrets.words_saved());
    assert_eq!(secrets.words(), None);
    assert_eq!(secrets.seed(), None);
}

#[test]
fn a_vaults_own_key_waits_to_be_filed_until_it_is_filed_or_forgotten() {
    let secrets = VaultSecrets::new();
    assert!(secrets.pending_filings().is_empty());
    apply(&secrets, &[secrets.add_pending_filing("0123456789abcdef", "Family")]);
    apply(&secrets, &[secrets.add_pending_filing("fedcba9876543210", "Work")]);
    assert_eq!(secrets.pending_filings().len(), 2);
    // Filing two at once leaves neither standing, not the last one's list.
    apply(
        &secrets,
        &secrets.clear_pending_filings(&[
            "0123456789abcdef".to_owned(),
            "fedcba9876543210".to_owned(),
        ]),
    );
    assert!(secrets.pending_filings().is_empty());
    apply(&secrets, &[secrets.add_pending_filing("0123456789abcdef", "Family")]);
    apply(&secrets, &secrets.clear_pending_filing("0123456789abcdef"));
    assert!(secrets.pending_filings().is_empty());
}
