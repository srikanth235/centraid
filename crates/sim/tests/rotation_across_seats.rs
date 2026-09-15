//! ROTATION AS A DISTRIBUTED ORDER, PROVEN OVER EVERY SEED (#1020, D-1020-L4).
//!
//! ## The property, and why it needed a new proof
//!
//! v0's crash-safety argument for rotation rests on `keys/` and `vault.db`
//! being **on one host**: write `K′` to a new file, do one DB transaction, then
//! delete the old file. A crash between 1 and 2 leaves an orphan; between 2 and
//! 3, a retired file; the sweep reconciles either on open. *At no point is any
//! ciphertext under a key the DB does not name, and at no point are two keys
//! live.*
//!
//! After wave 4, step 1 is a key file **on a device** and step 2 is a command
//! batch **over a network** (census §F3 consequence 2). The argument has to be
//! re-derived, and the thing to re-derive it against is the order rather than
//! the bytes.
//!
//! ## What is simulated, and what deliberately is not
//!
//! This simulation drives the **order**: which of the rotation's steps happens
//! when, which seat is partitioned while it happens, and where a crash lands.
//! Every durable thing in it is real — a real `Vault` on a real SQLite file,
//! the real `locker.rotate_key` command through the real gate order, and three
//! real [`MemberKeyCustody`] directories with real key files.
//!
//! It does **not** go through `turmoil`, and that is a scope choice with a
//! reason rather than an omission: what is under test is a partial order over
//! three durable steps on three hosts, and datagram loss, reordering and
//! head-of-line blocking do not change it — a lost message is a step that did
//! not happen, which is exactly what this schedule expresses. The transport's
//! own proof is `tests/seeds.rs`, which runs the real sync driver over real
//! UDP under turmoil, and duplicating it here would buy a slower run and no new
//! claim.
//!
//! ## The four invariants, asserted after every step of every seed
//!
//! 1. **The DB never names a generation no seat can open.** The one
//!    unrecoverable outcome: the gateway cannot read a cell to re-encrypt it,
//!    so a vault naming a key nobody holds is a vault whose secrets are gone.
//! 2. **Two live rows are never representable** — `locker_key_live_idx` is on
//!    the predicate, and this asserts the count as well, because an index that
//!    was dropped would be a silent regression.
//! 3. **Every sealed cell opens**, from at least one seat, under the generation
//!    the DB names. The invariant that makes 1 and 2 worth having.
//! 4. **A seat that missed the envelope has a repair**, and the repair works:
//!    another live seat, or the recovery kit.
//!
//! Run count: `SIM_SEEDS` (default 25, the `pr` profile's), `SIM_SEED=<n>` for
//! one. A failure prints the seed and the whole step trace.

use centraid_vault::access::Principal;
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::custody::keystore::KeyStore;
use centraid_vault::custody::locker_key::{
    LOCKER_ENCRYPTED_COLUMNS, decrypt_under_locker_key, encrypt_under_locker_key,
};
use centraid_vault::custody::member_key::{
    MemberKeyCustody, fresh_transfer_secret, open_member_key, seal_member_key,
};
use centraid_vault::custody::rotation_scenario;
use centraid_vault::{Vault, VaultError};
use rand::{Rng as _, SeedableRng as _};
use rand_chacha::ChaCha8Rng;
use std::sync::Arc;

/// Three seats: the rotator, a seat that is reachable, and a seat that is not.
/// Three is the smallest number that has all three roles, and the property does
/// not get more true with thirty.
const SEATS: usize = 3;

/// How many secret-bearing items the vault holds. Small, because the batch's
/// completeness is a set property and not a throughput one.
const ITEMS: usize = 4;

/// Where a step can be interrupted. These are the windows the order has, and
/// the schedule picks one per seed — including `Nowhere`, because a run with no
/// fault is the one that proves the happy path still holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Interrupt {
    Nowhere,
    /// After the rotating seat wrote `K′` to its own keystore, before the
    /// batch. v0's window 1, across a network.
    AfterNewKeyFile,
    /// The batch was submitted and the gateway never answered — from the
    /// rotating seat's point of view, indistinguishable from a refusal.
    BatchAnswerLost,
    /// After the batch committed, before any envelope was sent. v0's window 2.
    BeforeEnvelopes,
    /// One seat's envelope was lost. The case a re-bootstrap exists for.
    OneEnvelopeLost,
    /// The rotating seat crashed after the batch and forgot it had sent
    /// anything — so it re-sends, and the re-send must not rotate twice.
    RotatorCrashedAfterBatch,
}

impl Interrupt {
    const ALL: [Self; 6] = [
        Self::Nowhere,
        Self::AfterNewKeyFile,
        Self::BatchAnswerLost,
        Self::BeforeEnvelopes,
        Self::OneEnvelopeLost,
        Self::RotatorCrashedAfterBatch,
    ];
}

/// One run's script, deterministic from a seed.
#[derive(Debug, Clone)]
struct Script {
    seed: u64,
    /// Which seat rotates.
    rotator: usize,
    /// Which seat is partitioned for the run.
    partitioned: usize,
    interrupt: Interrupt,
    /// How many rotations the script attempts. Two is the interesting case:
    /// a second rotation over a vault one seat has not caught up with.
    rotations: usize,
    /// Whether the stranded seat repairs from the kit rather than from a peer.
    repair_from_kit: bool,
}

impl Script {
    fn from_seed(seed: u64) -> Self {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        let rotator = rng.random_range(0..SEATS);
        // A partitioned ROTATOR is a distinct case from a partitioned peer, and
        // both are drawn: the first cannot submit its batch at all.
        let partitioned = rng.random_range(0..SEATS);
        // THE WINDOW IS ROUND-ROBINED OVER THE SEED, not drawn.
        //
        // A uniform draw over six windows does not cover all six in
        // twenty-five seeds — `the_default_seed_count_reaches_every_window_and_every_seat`
        // caught exactly that, which is what it is for. Coverage of the
        // *windows* is the thing this proof must guarantee rather than hope
        // for; the randomness belongs on the other axes, where it explores
        // combinations rather than deciding whether a case is tested at all.
        let interrupt = Interrupt::ALL[usize::try_from(seed).unwrap_or(0) % Interrupt::ALL.len()];
        Self {
            seed,
            rotator,
            partitioned,
            interrupt,
            rotations: 1 + usize::from(rng.random_bool(0.4)),
            repair_from_kit: rng.random_bool(0.5),
        }
    }
}

/// One seat: its own key custody and what it believes the live generation is.
struct Seat {
    index: usize,
    custody: MemberKeyCustody,
    /// The generation this seat can open cells under, as far as it knows.
    holds: Vec<String>,
}

impl Seat {
    fn opens(&self, key_id: &str) -> bool {
        self.holds.iter().any(|held| held == key_id)
    }

    fn key(&self, key_id: &str) -> Option<Vec<u8>> {
        self.custody.load(key_id).ok()
    }
}

/// The gateway, its vault, and the three seats.
struct World {
    dir: std::path::PathBuf,
    vault: Vault,
    registry: Registry,
    seats: Vec<Seat>,
    /// The recovery kit's contents: the generations a member could restore from
    /// a drawer. Written by the founding seat and topped up by each rotation
    /// the member exported after — so a script that never exports has a STALE
    /// kit, which is the case invariant 4 has to survive.
    kit: Vec<(String, Vec<u8>)>,
    trace: Vec<String>,
}

impl World {
    /// A founded vault, `K` minted on seat 0, every secret sealed under it.
    fn founded(script: &Script) -> Self {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let clock = Arc::new(FixedClock::frozen());
        let vault = Vault::create_with(
            dir.join("vault.db"),
            Box::new(Arc::clone(&clock)),
            Box::new(SeededIds::new(format!("rotation-{}", script.seed).as_str())),
        )
        .expect("a vault");
        let founded = vault.found("The Household", "Ada").expect("founded");
        let registry = Registry::with_system_commands().expect("the registry");
        registry.install(&vault).expect("the record");

        let mut seats: Vec<Seat> = (0..SEATS)
            .map(|index| Seat {
                index,
                custody: MemberKeyCustody::with_store(
                    KeyStore::new(dir.join(format!("seat-{index}")).join("keys")),
                    founded.vault_id.clone(),
                ),
                holds: Vec::new(),
            })
            .collect();

        // FOUNDING IS ON A SEAT (D-1020-L1): seat 0 mints, and the vault
        // commits the id.
        let key_id = "gen-0".to_owned();
        let key = seats[0].custody.mint(&key_id).expect("minted");
        seats[0].holds.push(key_id.clone());
        vault
            .commit(|tx| {
                tx.set_producer("sim.founding");
                // THE STATEMENT IS IN `crates/vault`, NOT HERE. SQL lives only
                // under crates/{ontology,vault,seat,search} and
                // crates/apps/kit (`cargo xtask rules`' `sql-confinement`), and
                // `crates/sim` is not one of them — so the scenario's reads and
                // writes are `custody::rotation_scenario`'s, next to the plane
                // they are facts about.
                rotation_scenario::found_generation(
                    tx.connection(),
                    &key_id,
                    "2026-01-01T00:00:00.000Z",
                )?;
                Ok(())
            })
            .expect("the key plane is founded");

        // The other two seats receive it in an envelope. This is the flow, not
        // a shortcut: the gateway relays and cannot open.
        for (index, seat) in seats.iter_mut().enumerate().skip(1) {
            let secret = fresh_transfer_secret();
            let envelope = seal_member_key(
                &key,
                &secret,
                &founded.vault_id,
                &key_id,
                &format!("device-{index}"),
            )
            .expect("sealed");
            let received =
                open_member_key(&envelope, &secret, &format!("device-{index}")).expect("opened");
            seat.custody.adopt(&key_id, &received).expect("adopted");
            seat.holds.push(key_id.clone());
        }

        // The secrets, sealed by seat 0 under `gen-0`.
        vault
            .commit(|tx| {
                tx.set_producer("sim.corpus");
                let connection = tx.connection();
                for index in 0..ITEMS {
                    let item_id = format!("item-{index}");
                    // SEALED ON THE SEAT, planted by the vault. The helper
                    // takes ciphertext it cannot make: a gateway-side helper
                    // that sealed its own argument would be the key door this
                    // wave deleted.
                    let sealed = encrypt_under_locker_key(
                        &key,
                        &key_id,
                        &item_id,
                        &format!("secret-for-{item_id}"),
                    )
                    .map_err(|error| VaultError::Invariant {
                        context: error.to_string(),
                    })?;
                    rotation_scenario::plant_sealed_login(
                        connection,
                        &item_id,
                        &format!("Login {index}"),
                        "2026-01-01T00:00:00.000Z",
                        &key_id,
                        &sealed,
                    )?;
                }
                Ok(())
            })
            .expect("the corpus lands");

        let kit = vec![(key_id, key)];
        Self {
            dir,
            vault,
            registry,
            seats,
            kit,
            trace: vec!["founded: gen-0 on seat 0, three seats hold it".to_owned()],
        }
    }

    fn live(&self) -> Option<String> {
        self.vault
            .read(rotation_scenario::live_generation)
            .expect("the read answers")
    }

    fn live_rows(&self) -> i64 {
        self.vault
            .read(rotation_scenario::live_generations)
            .expect("the read answers")
    }

    /// Every sealed cell, with the generation its row names.
    fn cells(&self) -> Vec<rotation_scenario::SealedCell> {
        // WALKED FROM THE REGISTRY, not from a list here: a sealed column
        // added to `LOCKER_ENCRYPTED_COLUMNS` is covered by the invariants
        // below without anybody remembering to add it.
        self.vault
            .read(rotation_scenario::sealed_cells)
            .expect("the read answers")
    }

    /// THE INVARIANTS. Called after every step of every run.
    fn check(&self, step: &str) -> Vec<String> {
        let mut findings = Vec::new();

        // 2. Two live rows are never representable.
        let rows = self.live_rows();
        if rows != 1 {
            findings.push(format!(
                "[{step}] the vault names {rows} live generations; it must name exactly one"
            ));
        }

        let Some(live) = self.live() else {
            findings.push(format!(
                "[{step}] the vault names no live generation at all"
            ));
            return findings;
        };

        // 1. Some seat — or the kit — can open the generation the DB names.
        let holders: Vec<usize> = self
            .seats
            .iter()
            .filter(|seat| seat.opens(&live))
            .map(|seat| seat.index)
            .collect();
        let in_kit = self.kit.iter().any(|(key_id, _)| *key_id == live);
        if holders.is_empty() && !in_kit {
            findings.push(format!(
                "[{step}] the vault names {live} and no seat and no kit holds it — every Locker \
                 secret in this vault is unrecoverable"
            ));
            return findings;
        }

        // 3. Every sealed cell opens under the generation its row names, from
        //    a seat that holds it.
        let key = holders
            .first()
            .and_then(|index| self.seats[*index].key(&live))
            .or_else(|| {
                self.kit
                    .iter()
                    .find(|(key_id, _)| *key_id == live)
                    .map(|(_, key)| key.clone())
            });
        let Some(key) = key else {
            findings.push(format!("[{step}] {live} is named but not loadable"));
            return findings;
        };
        for (table, row_id, ciphertext, cell_key_id) in self.cells() {
            if cell_key_id != live {
                findings.push(format!(
                    "[{step}] {table}/{row_id} names generation `{cell_key_id}` while the vault \
                     names `{live}` — a cell under a key the DB does not name"
                ));
                continue;
            }
            if decrypt_under_locker_key(&key, &live, &row_id, &ciphertext).is_err() {
                findings.push(format!(
                    "[{step}] {table}/{row_id} does not open under the generation it names"
                ));
            }
        }
        findings
    }

    /// Re-encrypt every sealed cell on a seat, as the batch the gateway
    /// applies. Returns `None` when the seat cannot open the current
    /// generation — which is a seat that must re-bootstrap before it may
    /// rotate.
    fn batch(
        &self,
        seat: usize,
        from: &str,
        to: &str,
        new_key: &[u8],
    ) -> Option<serde_json::Value> {
        let old = self.seats[seat].key(from)?;
        let mut cells = Vec::new();
        for (table, row_id, ciphertext, cell_key_id) in self.cells() {
            if cell_key_id != from {
                return None;
            }
            let plain = decrypt_under_locker_key(&old, from, &row_id, &ciphertext).ok()?;
            let resealed = encrypt_under_locker_key(new_key, to, &row_id, &plain).ok()?;
            let column = LOCKER_ENCRYPTED_COLUMNS
                .iter()
                .find(|(known, _, _)| *known == table)
                .and_then(|(_, _, columns)| columns.first())
                .copied()?;
            cells.push(serde_json::json!({
                "table": table,
                "row_id": row_id,
                "column": column,
                "value": resealed
            }));
        }
        Some(serde_json::json!(cells))
    }

    fn submit(&self, from: &str, to: &str, cells: serde_json::Value) -> CommandStatus {
        self.vault
            .execute(
                &self.registry,
                &Principal::owner("rotating-seat"),
                &Command::new(
                    "locker.rotate_key",
                    serde_json::json!({
                        "key_id": to,
                        "previous_key_id": from,
                        "cells": cells
                    }),
                ),
            )
            .map_or(CommandStatus::Failed, |outcome| outcome.status)
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// One rotation, under one script's interrupt. Returns the findings.
fn rotate_once(world: &mut World, script: &Script, generation: usize) -> Vec<String> {
    let mut findings = Vec::new();
    let from = world.live().expect("a live generation");
    let to = format!("gen-{generation}");
    let rotator = script.rotator;

    // ---- STEP 1: the rotating seat writes `K′` to ITS OWN keystore ---------
    // The old file is untouched, which is what makes a crash here a sweepable
    // orphan rather than a loss.
    let new_key = world.seats[rotator].custody.mint(&to).expect("minted");
    world
        .trace
        .push(format!("step 1: seat {rotator} minted {to}"));
    findings.extend(world.check("after step 1"));

    if script.interrupt == Interrupt::AfterNewKeyFile {
        // THE ORPHAN. The DB still names `from`, nothing was re-encrypted, and
        // the extra file on the rotating seat opens nothing. The invariants
        // must hold exactly as they did before the attempt.
        world
            .trace
            .push("interrupt: after the new key file".to_owned());
        findings.extend(world.check("stopped after step 1"));
        assert_eq!(
            world.live().as_deref(),
            Some(from.as_str()),
            "seed {}: an orphan key file moved the live generation",
            script.seed
        );
        // The seat sweeps its own orphan at next open.
        world.seats[rotator].custody.forget(&to).expect("swept");
        findings.extend(world.check("after the orphan sweep"));
        return findings;
    }

    // A PARTITIONED ROTATOR CANNOT SUBMIT. The rotation simply does not
    // happen, which is the correct outcome and not a failure.
    if script.partitioned == rotator {
        world.trace.push(format!(
            "seat {rotator} is partitioned; the batch never arrives"
        ));
        findings.extend(world.check("batch never submitted"));
        world.seats[rotator].custody.forget(&to).expect("swept");
        findings.extend(world.check("after the orphan sweep"));
        return findings;
    }

    // ---- STEP 2: ONE BATCH, at the gateway --------------------------------
    let Some(cells) = world.batch(rotator, &from, &to, &new_key) else {
        // The seat cannot open the current generation, so it may not rotate.
        // It must re-bootstrap first — which is invariant 4's repair.
        world.trace.push(format!(
            "seat {rotator} cannot open {from}; it must re-bootstrap"
        ));
        findings.extend(world.check("rotation refused for lack of the current key"));
        return findings;
    };
    let status = world.submit(&from, &to, cells.clone());
    world
        .trace
        .push(format!("step 2: the batch answered {status:?}"));
    assert_eq!(
        status,
        CommandStatus::Executed,
        "seed {}: the batch was refused; trace:\n{}",
        script.seed,
        world.trace.join("\n")
    );
    world.seats[rotator].holds.push(to.clone());
    findings.extend(world.check("after step 2"));

    if script.interrupt == Interrupt::BatchAnswerLost {
        // THE ANSWER WAS LOST, NOT THE WRITE. The rotating seat does not know
        // it succeeded and re-sends. The re-send must NOT rotate twice: the
        // vault's live generation is already `to`, so `previous_key_id` no
        // longer matches and the command refuses with the sentence that says
        // so. That refusal is the idempotency this order needs.
        let again = world.submit(&from, &to, cells);
        world
            .trace
            .push(format!("the lost answer's re-send answered {again:?}"));
        assert_eq!(
            again,
            CommandStatus::Failed,
            "seed {}: a re-sent batch rotated a second time",
            script.seed
        );
        findings.extend(world.check("after the re-send was refused"));
    }

    if script.interrupt == Interrupt::RotatorCrashedAfterBatch {
        // The rotating seat forgot it had rotated and tries the WHOLE thing
        // again from `from`. Same refusal, for the same reason.
        let again = world.submit(
            &from,
            &format!("gen-{generation}-retry"),
            serde_json::json!([]),
        );
        assert_eq!(
            again,
            CommandStatus::Failed,
            "seed {}: a crashed rotator's retry rotated from a retired generation",
            script.seed
        );
        findings.extend(world.check("after the crashed rotator's retry"));
    }

    if script.interrupt == Interrupt::BeforeEnvelopes {
        // STOPPED BEFORE ANY ENVELOPE. Only the rotating seat can open the
        // vault's own secrets — which is DEGRADED but not lost, and the
        // invariants say exactly that: the DB names a generation *a* seat
        // holds.
        world
            .trace
            .push("interrupt: before the envelopes".to_owned());
        findings.extend(world.check("stopped before the envelopes"));
        for peer in 0..SEATS {
            if peer == rotator {
                continue;
            }
            assert!(
                !world.seats[peer].opens(&to),
                "seed {}: a seat holds a generation nobody sent it",
                script.seed
            );
        }
        return findings;
    }

    // ---- STEP 3: the envelopes, and each seat's own delete -----------------
    let vault_id = world
        .vault
        .read(rotation_scenario::vault_id)
        .expect("the vault names itself");
    let mut stranded = None;
    for peer in 0..SEATS {
        if peer == rotator {
            continue;
        }
        let lost = script.partitioned == peer
            || (script.interrupt == Interrupt::OneEnvelopeLost && stranded.is_none());
        if lost {
            stranded = Some(peer);
            world.trace.push(format!("seat {peer}'s envelope was lost"));
            continue;
        }
        let secret = fresh_transfer_secret();
        let envelope =
            seal_member_key(&new_key, &secret, &vault_id, &to, &format!("device-{peer}"))
                .expect("sealed");
        let received =
            open_member_key(&envelope, &secret, &format!("device-{peer}")).expect("opened");
        world.seats[peer]
            .custody
            .adopt(&to, &received)
            .expect("adopted");
        world.seats[peer].holds.push(to.clone());
        // AND ONLY THEN does the seat delete the old generation — v0's step 3,
        // "after their own copy is confirmed".
        world.seats[peer].custody.forget(&from).expect("forgotten");
        world.seats[peer].holds.retain(|held| *held != from);
        findings.extend(world.check(&format!("after seat {peer} adopted {to}")));
    }
    // The rotating seat drops the old one last.
    world.seats[rotator]
        .custody
        .forget(&from)
        .expect("forgotten");
    world.seats[rotator].holds.retain(|held| *held != from);
    findings.extend(world.check("after the rotator forgot the old generation"));

    // ---- INVARIANT 4: the stranded seat has a repair, and it works ---------
    if let Some(peer) = stranded {
        assert!(
            !world.seats[peer].opens(&to),
            "seed {}: the stranded seat was not stranded",
            script.seed
        );
        // It still holds the OLD generation, which now opens nothing — so
        // every read of a secret on it fails, distinguishably, and the repair
        // is one of two.
        let repaired = if script.repair_from_kit {
            // The kit. Only if the member exported one after the rotation —
            // and a STALE kit is a real state, so this asserts which.
            world
                .kit
                .iter()
                .find(|(key_id, _)| *key_id == to)
                .map(|(_, key)| key.clone())
        } else {
            // Any live seat.
            (0..SEATS)
                .find(|other| *other != peer && world.seats[*other].opens(&to))
                .and_then(|other| world.seats[other].key(&to))
        };
        match repaired {
            Some(key) => {
                world.seats[peer].custody.adopt(&to, &key).expect("adopted");
                world.seats[peer].holds.push(to.clone());
                world.seats[peer].custody.forget(&from).expect("forgotten");
                world.seats[peer].holds.retain(|held| *held != from);
                world
                    .trace
                    .push(format!("seat {peer} re-bootstrapped {to}"));
                findings.extend(world.check(&format!("after seat {peer} re-bootstrapped")));
            }
            None => {
                // A stale kit and no reachable peer is a real, recoverable
                // state: the seat waits. What must NOT be true is that the
                // vault named a generation nobody at all holds — and the
                // invariant check above already asserted that, because the
                // rotating seat holds it.
                world
                    .trace
                    .push(format!("seat {peer} has no repair yet and waits"));
                assert!(
                    world.seats[rotator].opens(&to),
                    "seed {}: nobody holds the live generation",
                    script.seed
                );
            }
        }
    }

    // The member exports a kit after a completed rotation, which is what keeps
    // the kit from being the stale artefact above.
    if !script.repair_from_kit {
        world.kit = vec![(to.clone(), new_key)];
    }
    findings
}

fn seeds() -> Vec<u64> {
    if let Ok(one) = std::env::var("SIM_SEED")
        && let Ok(seed) = one.parse::<u64>()
    {
        return vec![seed];
    }
    let count: u64 = std::env::var("SIM_SEEDS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(25);
    (0..count).collect()
}

/// THE PROOF.
#[test]
fn rotation_holds_its_invariants_across_seats_over_every_seed() {
    let mut failures: Vec<String> = Vec::new();
    let seeds = seeds();
    assert!(!seeds.is_empty(), "SIM_SEEDS resolved to no seeds");

    for seed in &seeds {
        let script = Script::from_seed(*seed);
        let mut world = World::founded(&script);
        let mut findings = world.check("founded");
        for generation in 1..=script.rotations {
            findings.extend(rotate_once(&mut world, &script, generation));
        }
        if !findings.is_empty() {
            failures.push(format!(
                "\n\nSIM_SEED={seed}\n\nReproduce with:\n  SIM_SEED={seed} cargo test -p \
                 centraid-sim --test rotation_across_seats\n\nScript: {script:?}\n\nTrace:\n  \
                 {}\n\n{} finding(s):\n  {}",
                world.trace.join("\n  "),
                findings.len(),
                findings.join("\n  ")
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "rotation broke its invariants on {} of {} seed(s):{}",
        failures.len(),
        seeds.len(),
        failures.join("")
    );
}

/// THE SCHEDULE IS NOT DEGENERATE, and this is the assertion that says so.
///
/// A generator that drew `Interrupt::Nowhere` for every seed would make the
/// test above a happy-path test with a long comment. This asserts the 25 seeds
/// `pr` runs actually reach **every** window, every rotator and both repairs —
/// which is how a reader knows the proof covers what it claims.
#[test]
fn the_default_seed_count_reaches_every_window_and_every_seat() {
    let scripts: Vec<Script> = (0..25).map(Script::from_seed).collect();
    for interrupt in Interrupt::ALL {
        assert!(
            scripts.iter().any(|script| script.interrupt == interrupt),
            "no seed in the default 25 reaches {interrupt:?}"
        );
    }
    for seat in 0..SEATS {
        assert!(
            scripts.iter().any(|script| script.rotator == seat),
            "no seed in the default 25 rotates on seat {seat}"
        );
        assert!(
            scripts.iter().any(|script| script.partitioned == seat),
            "no seed in the default 25 partitions seat {seat}"
        );
    }
    assert!(
        scripts.iter().any(|script| script.repair_from_kit),
        "no seed repairs from the kit"
    );
    assert!(
        scripts.iter().any(|script| !script.repair_from_kit),
        "no seed repairs from a peer"
    );
    assert!(
        scripts.iter().any(|script| script.rotations > 1),
        "no seed rotates twice"
    );
    // A PARTITIONED ROTATOR is its own case and the generator must reach it.
    assert!(
        scripts
            .iter()
            .any(|script| script.rotator == script.partitioned),
        "no seed partitions the seat that rotates"
    );
}
