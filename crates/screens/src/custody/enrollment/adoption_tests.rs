//! The mapping batch must really land and read back before the foreground can move.
use super::*;
use crate::custody::keeper::{Effected, Foreground, FoundRefusal};
use crate::testing::{Driver, FakeShell};
use std::sync::Mutex;

#[derive(Default)]
struct StagingKeeper {
    prepared: Mutex<Vec<u32>>,
    adopted: Mutex<Vec<usize>>,
}

impl Keeper for StagingKeeper {
    fn prepare_restored(&self, restored: &HeldAt) -> Option<Vec<wire::SecretOp>> {
        self.prepared.lock().expect("lock").push(restored.index);
        Some(vec![wire::SecretOp {
            store: wire::SecretStore::Device as i32,
            op: wire::secret_op::Op::Set as i32,
            key: format!("{}{}", secrets::INDEX_PREFIX, restored.path),
            value: restored.index.to_string().into_bytes(),
        }])
    }
    fn adopt_restored(&self, restored: &[HeldAt]) -> Effected<usize> {
        self.adopted.lock().expect("lock").push(restored.len());
        Effected::new(restored.len())
    }
    fn found(&self, _: Option<&str>, _: &str) -> Effected<Found> {
        Effected::new(Found::Refused(FoundRefusal::NoCore))
    }
    fn rekey(&self) -> usize {
        0
    }
    fn indexed_holdings(&self) -> usize {
        0
    }
    fn holds_a_vault(&self) -> bool {
        false
    }
    fn foreground(&self) -> Option<Foreground> {
        None
    }
}

fn seeded_cache() -> VaultSecrets {
    let cache = VaultSecrets::new();
    cache.absorb(
        &[wire::SecretOp {
            store: wire::SecretStore::Synced as i32,
            op: wire::secret_op::Op::Get as i32,
            key: secrets::SEED_KEY.to_owned(),
            ..Default::default()
        }],
        &[wire::SecretAnswer {
            ok: true,
            found: true,
            value: "ab".repeat(64).into_bytes(),
            ..Default::default()
        }],
    );
    cache
}

fn answer() -> RestoreAnswer {
    RestoreAnswer {
        vaults: [7, 2]
            .into_iter()
            .map(|index| door::RestoredVaultAt {
                path: format!("public-{index}"),
                index,
                rows: 1,
                safety_number: String::new(),
                own: None,
                derivatives_total: 0,
                derivatives_landed: 0,
            })
            .collect(),
        ..Default::default()
    }
}

fn batch(step: Step<Result<usize, Refusal>>) -> Vec<wire::SecretOp> {
    match step {
        Step::Ask(Ask::Secrets(ops)) => ops,
        _ => panic!("a secret batch must precede adoption"),
    }
}

fn reply(env: &Env, shell: &mut FakeShell, ops: &[wire::SecretOp]) -> Reply {
    let answers = shell
        .batch(&wire::SecretBatch { ops: ops.to_vec() })
        .answers;
    env.secrets.absorb(ops, &answers);
    Reply::Secrets(answers)
}

#[test]
fn each_mapping_is_acknowledged_and_read_before_the_next_is_planned_and_one_mount_follows() {
    let driver = Driver::with_runtime(crate::Runtime::new(crate::Registry::default(), vec![]));
    driver.with_ctx(|ctx| {
        let cache = seeded_cache();
        let keeper = StagingKeeper::default();
        let env = Env {
            ctx,
            secrets: &cache,
            keeper: &keeper,
        };
        let mut shell = FakeShell::default();
        let mut adoption = Adoption::default();
        let answer = answer();
        let mut step = adoption.step(&env, &answer, None);
        for (position, index) in [7, 2].into_iter().enumerate() {
            let writes = batch(step);
            assert_eq!(*keeper.prepared.lock().expect("lock"), [7, 2][..=position]);
            assert!(keeper.adopted.lock().expect("lock").is_empty());
            let acknowledged = reply(&env, &mut shell, &writes);
            let reads = batch(adoption.step(&env, &answer, Some(acknowledged)));
            assert!(
                reads
                    .iter()
                    .all(|op| op.op == wire::secret_op::Op::Get as i32)
            );
            assert!(
                keeper.adopted.lock().expect("lock").is_empty(),
                "SET acknowledgement alone cannot mount"
            );
            let confirmed = reply(&env, &mut shell, &reads);
            step = adoption.step(&env, &answer, Some(confirmed));
            assert_eq!(cache.vault_index(&format!("public-{index}")), Some(index));
        }
        assert!(matches!(step, Step::Done(Ok(2))));
        assert_eq!(*keeper.adopted.lock().expect("lock"), [2]);
    });
}

#[test]
fn failed_or_short_write_acknowledgements_never_mount() {
    let driver = Driver::with_runtime(crate::Runtime::new(crate::Registry::default(), vec![]));
    driver.with_ctx(|ctx| {
        for answers in [vec![], vec![wire::SecretAnswer::default()]] {
            let cache = seeded_cache();
            let keeper = StagingKeeper::default();
            let env = Env {
                ctx,
                secrets: &cache,
                keeper: &keeper,
            };
            let mut adoption = Adoption::default();
            assert_eq!(batch(adoption.step(&env, &answer(), None)).len(), 1);
            assert!(matches!(
                adoption.step(&env, &answer(), Some(Reply::Secrets(answers))),
                Step::Done(Err(Refusal::StoreRefused))
            ));
            assert!(keeper.adopted.lock().expect("lock").is_empty());
            assert_eq!(*keeper.prepared.lock().expect("lock"), [7]);
        }
    });
}

#[test]
fn missing_wrong_failed_or_short_readbacks_never_mount_or_prepare_the_next_vault() {
    let driver = Driver::with_runtime(crate::Runtime::new(crate::Registry::default(), vec![]));
    driver.with_ctx(|ctx| {
        for answers in [
            vec![],
            vec![wire::SecretAnswer {
                ok: true,
                ..Default::default()
            }],
            vec![wire::SecretAnswer {
                ok: true,
                found: true,
                value: b"8".to_vec(),
                ..Default::default()
            }],
            vec![wire::SecretAnswer {
                ok: false,
                found: true,
                value: b"7".to_vec(),
                ..Default::default()
            }],
        ] {
            let cache = seeded_cache();
            let keeper = StagingKeeper::default();
            let env = Env {
                ctx,
                secrets: &cache,
                keeper: &keeper,
            };
            let mut adoption = Adoption::default();
            let writes = batch(adoption.step(&env, &answer(), None));
            let reads = batch(adoption.step(
                &env,
                &answer(),
                Some(Reply::Secrets(vec![
                    wire::SecretAnswer {
                        ok: true,
                        ..Default::default()
                    };
                    writes.len()
                ])),
            ));
            assert_eq!(reads.len(), 1);
            assert!(matches!(
                adoption.step(&env, &answer(), Some(Reply::Secrets(answers))),
                Step::Done(Err(Refusal::StoreRefused))
            ));
            assert!(keeper.adopted.lock().expect("lock").is_empty());
            assert_eq!(*keeper.prepared.lock().expect("lock"), [7]);
        }
    });
}

#[test]
fn losing_the_seed_before_commit_refuses_even_after_exact_mapping_readback() {
    let driver = Driver::with_runtime(crate::Runtime::new(crate::Registry::default(), vec![]));
    driver.with_ctx(|ctx| {
        let cache = seeded_cache();
        let keeper = StagingKeeper::default();
        let env = Env {
            ctx,
            secrets: &cache,
            keeper: &keeper,
        };
        let mut shell = FakeShell::default();
        let mut adoption = Adoption::default();
        let mut answer = answer();
        answer.vaults.truncate(1);
        let writes = batch(adoption.step(&env, &answer, None));
        let acknowledged = reply(&env, &mut shell, &writes);
        let reads = batch(adoption.step(&env, &answer, Some(acknowledged)));
        let confirmed = reply(&env, &mut shell, &reads);
        cache.absorb(
            &[wire::SecretOp {
                store: wire::SecretStore::Synced as i32,
                op: wire::secret_op::Op::Delete as i32,
                key: secrets::SEED_KEY.to_owned(),
                ..Default::default()
            }],
            &[wire::SecretAnswer {
                ok: true,
                ..Default::default()
            }],
        );
        assert!(matches!(
            adoption.step(&env, &answer, Some(confirmed)),
            Step::Done(Err(Refusal::StoreRefused))
        ));
        assert!(keeper.adopted.lock().expect("lock").is_empty());
    });
}
