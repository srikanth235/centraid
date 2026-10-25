//! The order the 24 words are kept in (#1047 E1, R-1047-E1...E5), asserted as
//! ORDER and REFUSAL: what is stored before what is asked, and what is never
//! stored at all. A scripted gateway answers the restore asks and a recording
//! shelf stands in for the keeper; the shell's two stores are the
//! [`FakeShell`]. The words are real phrases: the core's phrase door is the
//! one behind `seed`.

use std::collections::BTreeMap;
use std::sync::Arc;

use super::*;
use crate::custody::keeper::FakeKeeper;
use crate::testing::{Driver, FakeShell};

const ABANDON: &str = "abandon";

fn words_a() -> Vec<String> {
    let mut words = vec![ABANDON.to_owned(); 23];
    words.push("art".to_owned());
    words
}

fn words_b() -> Vec<String> {
    let mut words = vec!["zoo".to_owned(); 23];
    words.push("vote".to_owned());
    words
}

fn nonsense() -> Vec<String> {
    vec!["nonsense".to_owned(); 24]
}

/// One phone: its stores, its shelf, and a gateway that answers as scripted.
struct Phone {
    driver: Driver,
    shell: FakeShell,
    secrets: VaultSecrets,
    keeper: Arc<FakeKeeper>,
    log: Vec<String>,
    /// What the gateway answers unless `by_seed` has the seed.
    answer: Option<RestoreAnswer>,
    refusal: RestoreRefusal,
    by_seed: BTreeMap<String, RestoreAnswer>,
}

fn at(path: &str, index: u32, rows: i64) -> door::RestoredVaultAt {
    door::RestoredVaultAt {
        path: path.to_owned(),
        index,
        rows,
        safety_number: String::new(),
        own: None,
    }
}

fn answer(vaults: Vec<door::RestoredVaultAt>) -> RestoreAnswer {
    RestoreAnswer {
        vaults,
        ..RestoreAnswer::default()
    }
}

fn unclaimed(index: u32) -> UnclaimedVaultAt {
    UnclaimedVaultAt {
        index,
        vault_id: "ef".repeat(32),
        own: None,
    }
}

impl Phone {
    fn new() -> Self {
        let secrets = VaultSecrets::new();
        Self {
            driver: Driver::with_runtime(crate::Runtime::new(crate::Registry::default(), vec![])),
            shell: FakeShell::default(),
            keeper: FakeKeeper::watching(&secrets),
            secrets,
            log: Vec::new(),
            answer: None,
            refusal: RestoreRefusal::Unreachable,
            by_seed: BTreeMap::new(),
        }
    }

    /// Drive `job` to its answer the way a shell would answer each ask.
    fn run(&mut self, mut job: Job) -> Out {
        let Self {
            driver,
            shell,
            secrets,
            keeper,
            log,
            answer,
            refusal,
            by_seed,
        } = self;
        let keeper: Arc<dyn Keeper> = keeper.clone();
        driver.with_ctx(|ctx| {
            let env = Env {
                ctx,
                secrets,
                keeper: keeper.as_ref(),
            };
            let mut reply = None;
            loop {
                match job.step(&env, reply.take()) {
                    Step::Done(out) => return out,
                    Step::Ask(Ask::Secrets(ops)) => {
                        let done = shell.batch(&wire::SecretBatch { ops: ops.clone() });
                        secrets.absorb(&ops, &done.answers);
                        reply = Some(Reply::Secrets(done.answers));
                    }
                    Step::Ask(Ask::Probe) => {
                        reply = Some(Reply::Probe(wire::SyncedSecretsStatus {
                            synchronizing: shell.synchronizing,
                            restores_after_setup: shell.restores_after_setup,
                        }));
                    }
                    Step::Ask(Ask::Restore(request)) => {
                        let kind = if request.indices.is_empty() {
                            "restore"
                        } else {
                            "restore-stayed"
                        };
                        let seed = request.seed.as_ref().map(|seed| door::to_hex(seed));
                        let prefix = seed.as_deref().map(|s| s[..4].to_owned());
                        log.push(match &prefix {
                            Some(prefix) => format!(
                                "{kind} {prefix} payload={:?} indices={:?}",
                                request.payload, request.indices
                            ),
                            None => format!("{kind} seed={}", secrets.seed().is_some()),
                        });
                        let scripted = prefix
                            .and_then(|prefix| by_seed.get(&prefix).cloned())
                            .or_else(|| answer.clone());
                        reply = Some(Reply::Restored(scripted.ok_or(*refusal)));
                    }
                }
            }
        })
    }

    fn seed_of(&self, words: &[String]) -> String {
        self.driver
            .with_ctx(|ctx| door::seed(ctx, words))
            .expect("the words are a phrase")
    }

    fn kept(&mut self, words: Vec<String>) -> Option<Refusal> {
        match self.run(Job::keep(words, true, true)) {
            Out::Kept(refusal) => refusal,
            other => panic!("keep answered {other:?}"),
        }
    }

    fn restore(&mut self, words: Vec<String>, payload: &str) -> Restored {
        match self.run(Job::restore(words, payload)) {
            Out::Restored(restored) => restored,
            other => panic!("restore answered {other:?}"),
        }
    }

    fn held(&mut self, payload: &str) -> Restored {
        match self.run(Job::held(payload)) {
            Out::Restored(restored) => restored,
            other => panic!("held restore answered {other:?}"),
        }
    }

    fn standing(&mut self) -> Standing {
        match self.run(Job::assess()) {
            Out::Assessed(assessed) => assessed.standing,
            other => panic!("assess answered {other:?}"),
        }
    }

    fn rekey(&mut self, words: Vec<String>) -> Rekeyed {
        match self.run(Job::rekey(words)) {
            Out::Rekeyed(rekeyed) => rekeyed,
            other => panic!("rekey answered {other:?}"),
        }
    }

    /// The shell's stores, read into the cache.
    fn reload(&mut self) {
        assert_eq!(self.run(Job::reload()), Out::Done);
    }

    /// The seed arrived by the synchronised keychain: no words, no indices.
    fn arrive_by_sync(&mut self, seed: &str) {
        self.shell
            .synced
            .insert(secrets::SEED_KEY.to_owned(), seed.to_owned());
        self.reload();
    }

    /// The shelf recorded a vault's index (what founding does).
    fn record_index(&mut self, vault: &str, index: u32) {
        self.shell.device.insert(
            format!("{}{vault}", secrets::INDEX_PREFIX),
            index.to_string(),
        );
        self.shell
            .device
            .insert(secrets::INDEX_HIGH_WATER.to_owned(), index.to_string());
        self.reload();
    }
}

// --- making a vault ----------------------------------------------------------

#[test]
fn kept_words_are_stored_and_settled_before_the_vault_is_founded() {
    let mut phone = Phone::new();
    assert_eq!(phone.standing(), Standing::NoSeed);
    assert_eq!(phone.kept(words_a()), None);
    assert_eq!(phone.secrets.seed(), Some(phone.seed_of(&words_a())));
    assert!(phone.secrets.seed_settled());
    let made = phone.run(Job::make(None, None));
    assert_eq!(made, Out::Made(Found::Made("My vault".to_owned())));
    // A VAULT ON THE MEMBER'S KEY files nothing.
    assert_eq!(
        phone.keeper.log(),
        vec!["found own=None name=My vault seed=true".to_owned()]
    );
    assert!(phone.secrets.pending_filings().is_empty());
    // SHOWN AND KEPT counts as saved; kept unshown (the keychain held it) does not.
    assert!(phone.secrets.words_saved());
    let mut quiet = Phone::new();
    assert_eq!(
        quiet.run(Job::keep(words_a(), true, false)),
        Out::Kept(None)
    );
    assert!(!quiet.secrets.words_saved());
}

#[test]
fn kept_restored_and_rekeyed_words_are_kept_on_this_phone_for_settings_never_synchronised() {
    let mut made = Phone::new();
    assert_eq!(made.kept(words_a()), None);
    assert_eq!(made.secrets.words(), Some(words_a()));
    assert_eq!(
        made.shell.device.get(secrets::LOCAL_WORDS),
        Some(&words_a().join(" "))
    );
    assert_eq!(
        made.shell.synced.get(secrets::SEED_KEY),
        Some(&made.seed_of(&words_a()))
    );

    let mut restored = Phone::new();
    restored.answer = Some(answer(vec![at("/v/a/vault.db", 0, 0)]));
    assert!(matches!(
        restored.restore(words_a(), "code"),
        Restored::Done { .. }
    ));
    assert_eq!(restored.secrets.words(), Some(words_a()));

    let mut rekeyed = Phone::new();
    rekeyed.record_index("v-a", 0);
    rekeyed.keeper.set_indexed(1);
    assert_eq!(rekeyed.rekey(words_a()), Rekeyed::Done(1));
    assert_eq!(rekeyed.secrets.words(), Some(words_a()));
}

#[test]
fn words_that_were_refused_or_a_restore_that_brought_nothing_back_keep_no_words() {
    let mut phone = Phone::new();
    assert_eq!(phone.kept(nonsense()), Some(Refusal::NotAPhrase));
    phone.answer = Some(RestoreAnswer::default());
    assert_eq!(phone.restore(words_a(), "code"), Restored::NothingHeld);
    assert_eq!(phone.secrets.words(), None);
    // WORDS THAT ARE NOT A PHRASE STORE NOTHING.
    assert_eq!(phone.secrets.seed(), None);
    assert!(!phone.secrets.seed_settled());
}

#[test]
fn a_seed_that_arrived_by_sync_has_no_words_and_forgetting_the_seed_forgets_the_words() {
    let mut synced = Phone::new();
    let seed = synced.seed_of(&words_a());
    synced.arrive_by_sync(&seed);
    assert_eq!(synced.secrets.words(), None);

    let mut made = Phone::new();
    assert_eq!(made.kept(words_a()), None);
    let forget = VaultSecrets::forget_seed();
    made.run(Job::write(forget));
    assert_eq!(made.secrets.words(), None);
}

#[test]
fn a_seed_this_phone_settled_makes_the_next_vault_without_words_and_a_synced_one_must_restore_first()
 {
    let mut settled = Phone::new();
    assert_eq!(settled.kept(words_a()), None);
    assert_eq!(settled.standing(), Standing::Settled);

    // THE SYNCED SEED: iCloud Keychain carried it here, and index 0 is a vault
    // the member already has on the backup device.
    let mut synced = Phone::new();
    let seed = synced.seed_of(&words_a());
    synced.arrive_by_sync(&seed);
    assert_eq!(synced.standing(), Standing::Unsettled);
}

// --- restoring ----------------------------------------------------------------

#[test]
fn a_restore_dials_with_nothing_stored_then_stores_the_seed_before_holding_what_came_back() {
    let mut phone = Phone::new();
    phone.answer = Some(answer(vec![
        at("/v/a/vault.db", 0, 10),
        at("/v/b/vault.db", 2, 0),
    ]));
    let Restored::Done { added, answer, .. } = phone.restore(words_a(), "code") else {
        panic!("a restore came back")
    };
    assert_eq!(added, 2);
    assert_eq!(
        phone
            .log
            .clone()
            .into_iter()
            .chain(phone.keeper.log())
            .collect::<Vec<_>>(),
        vec![
            "restore seed=false".to_owned(),
            "adopt [0, 2] seed=true".to_owned()
        ]
    );
    assert_eq!(phone.secrets.seed(), Some(phone.seed_of(&words_a())));
    assert!(phone.secrets.seed_settled());
    // A RESTORED VAULT'S PATH NEVER PRINTS: the answer's text is counts.
    assert!(!format!("{answer:?}").contains("/v/a/vault.db"));
}

#[test]
fn a_restore_that_left_a_vault_with_the_old_phone_holds_only_what_it_claimed() {
    let mut phone = Phone::new();
    phone.answer = Some(RestoreAnswer {
        vaults: vec![at("/v/a/vault.db", 0, 0)],
        unclaimed: vec![unclaimed(1)],
        ..RestoreAnswer::default()
    });
    let Restored::Done { added, answer, .. } = phone.restore(words_a(), "code") else {
        panic!("a restore came back")
    };
    assert_eq!(added, 1);
    assert_eq!(phone.keeper.log(), vec!["adopt [0] seed=true".to_owned()]);
    assert_eq!(
        answer
            .unclaimed
            .iter()
            .map(|vault| vault.index)
            .collect::<Vec<_>>(),
        vec![1]
    );
}

#[test]
fn a_vault_that_stayed_is_asked_for_again_by_index_from_the_seed_already_stored() {
    let mut phone = Phone::new();
    phone.answer = Some(RestoreAnswer {
        vaults: vec![at("/v/a/vault.db", 0, 0)],
        unclaimed: vec![unclaimed(1)],
        ..RestoreAnswer::default()
    });
    assert!(matches!(
        phone.restore(words_a(), "code"),
        Restored::Done { .. }
    ));
    phone.answer = Some(answer(vec![at("/v/c/vault.db", 1, 0)]));
    let prefix = phone.seed_of(&words_a())[..4].to_owned();
    let again = phone.run(Job::stayed(&[unclaimed(1)], "ab"));
    let Out::Restored(Restored::Done { added, .. }) = again else {
        panic!("the retry came back")
    };
    assert_eq!(added, 1);
    assert_eq!(
        phone.log[1],
        format!("restore-stayed {prefix} payload=\"ab\" indices=[1]")
    );
    assert_eq!(
        phone.keeper.log().last().map(String::as_str),
        Some("adopt [1] seed=true")
    );
    // STILL REFUSED, NOTHING HELD: the vaults already here are untouched.
    phone.answer = None;
    phone.refusal = RestoreRefusal::NotTaken;
    assert_eq!(
        phone.run(Job::stayed(&[unclaimed(1)], "")),
        Out::Restored(Restored::NotTaken)
    );
    // NO SEED HERE, NO RETRY: nothing is dialled.
    let mut bare = Phone::new();
    assert_eq!(
        bare.run(Job::stayed(&[unclaimed(1)], "")),
        Out::Restored(Restored::Refused(Refusal::NotAPhrase))
    );
    assert!(bare.log.is_empty());
}

#[test]
fn a_synchronised_seed_restores_with_no_words_and_is_settled_once_vaults_came_back() {
    let mut phone = Phone::new();
    let seed = phone.seed_of(&words_a());
    phone.arrive_by_sync(&seed);
    assert_eq!(phone.standing(), Standing::Unsettled);
    phone.answer = Some(answer(vec![
        at("/v/a/vault.db", 0, 0),
        at("/v/c/vault.db", 1, 0),
    ]));
    let Restored::Done { added, .. } = phone.held("code") else {
        panic!("a held restore came back")
    };
    assert_eq!(added, 2);
    assert_eq!(
        phone.log,
        vec![format!(
            "restore {} payload=\"code\" indices=[]",
            &seed[..4]
        )]
    );
    assert_eq!(
        phone.keeper.log(),
        vec!["adopt [0, 1] seed=true".to_owned()]
    );
    assert_eq!(phone.standing(), Standing::Settled);
    assert_eq!(phone.secrets.words(), None);
}

#[test]
fn the_keychains_seed_is_not_the_backups_typed_words_replace_it_while_no_vault_opens_with_it() {
    let mut phone = Phone::new();
    let held = phone.seed_of(&words_a());
    phone.arrive_by_sync(&held);
    phone.answer = Some(answer(vec![at("/v/b/vault.db", 0, 0)]));
    assert!(matches!(
        phone.restore(words_b(), "code"),
        Restored::Done { .. }
    ));
    assert_eq!(phone.secrets.seed(), Some(phone.seed_of(&words_b())));
}

#[test]
fn a_held_restore_with_no_seed_or_one_the_backup_answered_with_nothing_settles_nothing() {
    let mut none = Phone::new();
    assert_eq!(none.held(""), Restored::Refused(Refusal::NotAPhrase));
    assert!(none.log.is_empty());

    let mut empty = Phone::new();
    let seed = empty.seed_of(&words_a());
    empty.arrive_by_sync(&seed);
    empty.answer = Some(RestoreAnswer::default());
    assert_eq!(empty.held(""), Restored::NothingHeld);
    assert_eq!(empty.standing(), Standing::Unsettled);
}

#[test]
fn a_backup_that_holds_nothing_or_does_not_answer_leaves_this_phone_exactly_as_it_was() {
    let mut phone = Phone::new();
    phone.answer = Some(RestoreAnswer::default());
    assert_eq!(phone.restore(words_a(), "code"), Restored::NothingHeld);
    phone.answer = None;
    assert_eq!(phone.restore(words_a(), "code"), Restored::Unreachable);
    assert_eq!(phone.secrets.seed(), None);
}

#[test]
fn a_refused_claim_or_a_backup_this_phone_would_not_accept_is_its_own_outcome_and_stores_nothing() {
    let mut phone = Phone::new();
    phone.refusal = RestoreRefusal::NotTaken;
    assert_eq!(phone.restore(words_a(), "code"), Restored::NotTaken);
    phone.refusal = RestoreRefusal::DidNotCheck;
    assert_eq!(phone.restore(words_a(), "code"), Restored::DidNotCheck);
    assert_eq!(phone.secrets.seed(), None);
    assert_eq!(phone.secrets.words(), None);

    let mut held = Phone::new();
    let seed = held.seed_of(&words_a());
    held.arrive_by_sync(&seed);
    held.refusal = RestoreRefusal::DidNotCheck;
    assert_eq!(held.held(""), Restored::DidNotCheck);
    assert_eq!(held.standing(), Standing::Unsettled);
}

#[test]
fn different_words_never_replace_the_seed_this_phones_vaults_open_with() {
    let mut phone = Phone::new();
    assert_eq!(phone.kept(words_a()), None);
    phone.record_index("v-a", 0);
    let member = phone.secrets.seed();
    assert_eq!(
        phone.rekey(words_b()),
        Rekeyed::Refused(Refusal::DifferentWords)
    );
    assert!(phone.log.is_empty());
    // R-1047-E18: other words are a vault on its own words; a backup that
    // answers nothing stores nothing for them.
    assert_eq!(phone.restore(words_b(), "code"), Restored::Unreachable);
    assert_eq!(phone.secrets.seed(), member);
    assert!(phone.secrets.own_seeds().is_empty());
}

// --- re-keying ------------------------------------------------------------------

#[test]
fn re_keying_stores_the_seed_and_reopens_the_vaults_that_have_an_index() {
    let mut phone = Phone::new();
    phone.record_index("v-a", 3);
    phone.keeper.set_indexed(1);
    assert_eq!(phone.rekey(words_a()), Rekeyed::Done(1));
    assert_eq!(phone.secrets.seed(), Some(phone.seed_of(&words_a())));
    assert_eq!(phone.keeper.log(), vec!["rekey seed=true".to_owned()]);
}

#[test]
fn re_keying_a_phone_with_no_recorded_index_stores_nothing_and_says_only_a_restore_can_key_it() {
    let mut phone = Phone::new();
    assert_eq!(phone.rekey(words_a()), Rekeyed::NoneToKey);
    assert_eq!(phone.secrets.seed(), None);
    assert!(phone.keeper.log().is_empty());
}

#[test]
fn the_same_words_handed_back_again_are_not_a_conflict() {
    let mut phone = Phone::new();
    assert_eq!(phone.kept(words_a()), None);
    phone.record_index("v-a", 0);
    phone.keeper.set_indexed(1);
    assert_eq!(phone.rekey(words_a()), Rekeyed::Done(1));
    assert_eq!(phone.secrets.seed(), Some(phone.seed_of(&words_a())));
}

// --- a vault on its own words (R-1047-E18) ----------------------------------------

#[test]
fn own_words_are_kept_under_an_entry_of_their_own_never_the_members_slot() {
    let mut phone = Phone::new();
    assert_eq!(phone.kept(words_a()), None);
    let Out::OwnKept(Ok(id)) = phone.run(Job::keep_own(words_b(), "Family")) else {
        panic!("the own words were kept")
    };
    assert_eq!(phone.secrets.seed(), Some(phone.seed_of(&words_a())));
    assert_eq!(phone.secrets.own_seed(&id), Some(phone.seed_of(&words_b())));
    assert_eq!(phone.secrets.own_words(&id), Some(words_b()));
    assert_eq!(phone.secrets.words(), Some(words_a()));
    phone.run(Job::make(Some(id.clone()), Some("Family")));
    let log = phone.keeper.log();
    assert_eq!(
        log.last().map(String::as_str),
        Some(format!("found own=Some(\"{id}\") name=Family seed=true").as_str())
    );
    // MADE, THEN RECORDED to be filed in the main vault's Locker on its next
    // unlock, under the made vault's name (R-ONBOARD-10).
    assert_eq!(
        phone.secrets.pending_filings(),
        vec![(id.clone(), "Family".to_owned())]
    );
    let labels: Vec<String> = phone
        .secrets
        .own_seeds()
        .into_iter()
        .map(|e| e.label)
        .collect();
    assert_eq!(labels, vec!["Family".to_owned()]);
}

#[test]
fn a_held_restore_asks_for_the_members_seed_and_every_vault_on_its_own_words() {
    let mut phone = Phone::new();
    let member = phone.seed_of(&words_a());
    phone.arrive_by_sync(&member);
    let id = VaultSecrets::fresh_entry_id();
    let own_seed = phone.seed_of(&words_b());
    phone.shell.synced.insert(
        format!("{}{id}", secrets::OWN_SEED_PREFIX),
        own_seed.clone(),
    );
    phone
        .shell
        .synced
        .insert(secrets::OWN_SEED_INDEX.to_owned(), format!("{id}\tFamily"));
    phone.reload();
    phone.answer = Some(answer(vec![at("/v/x/vault.db", 0, 0)]));
    let Restored::Done { added, answer, .. } = phone.held("") else {
        panic!("a held restore came back")
    };
    assert_eq!(added, 2);
    assert_eq!(
        answer
            .vaults
            .iter()
            .map(|v| v.own.clone())
            .collect::<Vec<_>>(),
        vec![None, Some(id.clone())]
    );
    assert_eq!(
        phone.log,
        vec![
            format!("restore {} payload=\"\" indices=[]", &member[..4]),
            format!("restore {} payload=\"\" indices=[]", &own_seed[..4]),
        ]
    );
    assert_eq!(
        phone.keeper.log(),
        vec![
            "adopt [0] seed=true".to_owned(),
            format!("adopt [0@{id}] seed=true")
        ]
    );
    assert_eq!(phone.standing(), Standing::Settled);
}

#[test]
fn words_that_are_not_the_members_on_a_phone_whose_vaults_open_with_the_members_restore_as_a_vault_on_its_own_words()
 {
    let mut phone = Phone::new();
    assert_eq!(phone.kept(words_a()), None);
    phone.record_index("v-a", 0);
    phone.answer = Some(answer(vec![at("/v/b/vault.db", 0, 0)]));
    let Restored::Done { answer, .. } = phone.restore(words_b(), "code") else {
        panic!("a restore came back")
    };
    let own = answer.vaults[0]
        .own
        .clone()
        .expect("the vault is tagged with its entry");
    assert_eq!(phone.secrets.seed(), Some(phone.seed_of(&words_a())));
    assert_eq!(
        phone.secrets.own_seed(&own),
        Some(phone.seed_of(&words_b()))
    );
    // TYPED AGAIN, the same entry answers, not a second one.
    assert!(matches!(
        phone.restore(words_b(), "code"),
        Restored::Done { .. }
    ));
    assert_eq!(phone.secrets.own_seeds().len(), 1);
}

#[test]
fn a_vault_on_its_own_words_the_backup_holds_nothing_for_is_named_not_left_out() {
    let mut both = Phone::new();
    let member = both.seed_of(&words_a());
    both.arrive_by_sync(&member);
    let id = VaultSecrets::fresh_entry_id();
    let own_seed = both.seed_of(&words_b());
    both.shell.synced.insert(
        format!("{}{id}", secrets::OWN_SEED_PREFIX),
        own_seed.clone(),
    );
    both.shell
        .synced
        .insert(secrets::OWN_SEED_INDEX.to_owned(), format!("{id}\tFamily"));
    both.reload();
    both.by_seed.insert(
        member[..4].to_owned(),
        answer(vec![at("/v/x/vault.db", 0, 0)]),
    );
    both.by_seed
        .insert(own_seed[..4].to_owned(), RestoreAnswer::default());
    let Restored::Done { added, missing, .. } = both.held("") else {
        panic!("a held restore came back")
    };
    assert_eq!(added, 1);
    assert_eq!(missing, vec!["Family".to_owned()]);
}

// --- the shell's answers -----------------------------------------------------------

#[test]
fn a_synchronised_store_that_refuses_the_seed_leaves_it_on_this_phone_only() {
    // Block Store without Google Play services: the seed must still be kept, on
    // this phone, or a vault could never be opened keyed (R-1047-E6).
    let mut phone = Phone::new();
    phone.shell.synced_works = false;
    assert_eq!(phone.kept(words_a()), None);
    assert_eq!(phone.secrets.seed(), Some(phone.seed_of(&words_a())));
    assert!(!phone.secrets.seed_synced());
    assert!(phone.shell.synced.is_empty());
}

#[test]
fn the_runner_ignores_an_answer_it_is_not_waiting_for_and_folds_a_secret_answer_into_the_cache() {
    let phone = Phone::new();
    let mut runner = Runner::default();
    let keeper: Arc<dyn Keeper> = phone.keeper.clone();
    let secrets = phone.secrets.clone();
    phone.driver.with_ctx(|ctx| {
        let env = Env {
            ctx,
            secrets: &secrets,
            keeper: keeper.as_ref(),
        };
        let started = runner.begin(Job::reload(), &env);
        assert!(runner.busy());
        assert_eq!(started.effects.len(), 1);
        // A probe answer is not what a reload awaits.
        let stray = wire::EffectResult {
            effect_id: 1,
            outcome: Some(wire::effect_result::Outcome::SyncedStatus(
                wire::SyncedSecretsStatus::default(),
            )),
        };
        assert!(runner.answered(&stray, &env).is_none());
        let mut shell = FakeShell::default();
        shell
            .device
            .insert(secrets::LOCAL_WORDS.to_owned(), words_a().join(" "));
        let Some(wire::effect::Kind::Secrets(batch)) = started.effects[0].kind.clone() else {
            panic!("a reload sends a secret batch")
        };
        let answered = wire::EffectResult {
            effect_id: 1,
            outcome: Some(wire::effect_result::Outcome::Secrets(shell.batch(&batch))),
        };
        let progress = runner
            .answered(&answered, &env)
            .expect("the reload awaited it");
        assert_eq!(progress.out, Some(Out::Done));
        assert!(!runner.busy());
        assert!(secrets.loaded());
        assert_eq!(secrets.words(), Some(words_a()));
    });
}

#[test]
fn a_job_and_what_it_holds_never_print_a_word() {
    let job = Job::restore(words_a(), "code");
    assert!(!format!("{job:?}").contains(ABANDON));
    let answer = RestoreAnswer::default();
    assert!(
        !format!(
            "{:?}",
            Restored::Done {
                answer,
                added: 1,
                missing: vec![]
            }
        )
        .contains('/')
    );
}
