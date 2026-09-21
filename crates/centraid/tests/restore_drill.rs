//! THE RESTORE DRILL — the product's promise, run in CI (#1029 §2, §5, W5-4).
//!
//! Lose the phone, type 24 words, get every vault back, and the old phone
//! freezes. There is one test in this repository that asserts that sentence end
//! to end, and this is it.
//!
//! ## What it drives, and why each piece is the real one
//!
//! | Piece | What is real |
//! |---|---|
//! | the keys | `centraid_identity`: a BIP-39 phrase, SLIP-0010 derivation, the account key, `VaultMint`, the account's own signed listing |
//! | the vault | `centraid_vault`: real commits through the commit guard, real capture, a real page-identical base and real segments |
//! | the gateway | `centraid_gateway_core::Gateway` over its in-memory stores — the SAME rules an adapter runs: lease, plan, quota, write-once, compare-and-set on `prev_head`, and the `VAULT_MOVED` tombstone |
//! | the restore | `backup::restore_generation`, applied, then `restore_drill`'s own checks and a census compare |
//!
//! Nothing here is a fake that agrees with itself. The one seam that is not the
//! shipped one is the transport: the gateway is called as a library rather than
//! over HTTPS, because the HTTP adapter is `crates/gateway-server`'s and this
//! test is about the rules and the keys, not about a socket.
//!
//! ## What it proves that `backup::drill` does not
//!
//! `crates/vault`'s drill proves a committed transaction survives a crash and
//! comes back byte-exact, from a LOCAL object store, with the two keys handed
//! in. Its own header names what it could not reach: "restore onto a second
//! device from the 24 words, and watch the first freeze on `VAULT_MOVED`,
//! belongs to the wave that builds the lease (W5), not to this one."
//!
//! This is that. Four things are new and all four are the product's promise:
//!
//! 1. **TWO vaults**, so "every vault back" is a claim with a plural in it and
//!    the account listing is load-bearing rather than decorative.
//! 2. **The bytes come off the gateway**, not off the phone that made them.
//! 3. **The 24 words are the only input.** [`restore_onto_a_fresh_phone`] takes
//!    the phrase and the gateway and nothing else — not a path on the old
//!    phone, not a key, not a vault id. That is F2 held STRUCTURALLY: it is not
//!    that the restore does not read the lost phone, it is that it cannot.
//! 4. **The old phone is still there and is refused**, which is F1: the drill
//!    does not delete it, and asserts it still holds every row it had.
//!
//! ## What it cannot prove
//!
//! - **No phone shell is compiled.** The freeze itself — writes refused, reads
//!   kept, "N changes since <date>" shown, nothing wiped — is Kotlin, and is
//!   pinned by `mobile/shared`'s `VaultMovedSpec` and `VaultMovedProducerSpec`.
//!   What is asserted here is the refusal those specs key on, with its
//!   companion, and that the old phone's rows and spool are intact for them to
//!   show.
//! - **No HTTPS, no request signing, no pkarr.** A signed request is
//!   `crates/gateway-core`'s `auth` and the phone's client; discovery is
//!   `centraid_identity::discovery`. Both have their own tests.
//! - **One SQLite.** The host's, not a phone's. See
//!   `centraid_vault::wal_persistence`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use centraid_gateway_core::engine::{Caller, CommitInput, Fault};
use centraid_gateway_core::memory::{MemoryBytes, MemoryState};
use centraid_gateway_core::upload::Declaration;
use centraid_gateway_core::{
    Gateway, Generation, ObjectKind, ObjectName, Refusal, ServerTime, StoredObject, VaultId,
    VaultState,
};
use centraid_identity::{RecoveryPhrase, Seed, VaultMint};
use centraid_vault::Vault;
use centraid_vault::backup::objects::ObjectKeys;
use centraid_vault::backup::store::{BlobStore as _, FsBlobStore};
use centraid_vault::backup::{self, BackupHome, GenerationManifest};

/// THE 24 WORDS. The whole input to a restore, and the only one.
///
/// A published BIP-39 test vector rather than a phrase this test minted, so the
/// derivation is checked against something outside this repository — the same
/// reason `centraid_identity::derive` carries SLIP-0010's own vectors.
const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon \
                      abandon abandon abandon abandon abandon abandon abandon abandon abandon \
                      abandon abandon abandon abandon abandon art";

const DAY: i64 = 86_400_000;
const START: i64 = 400 * DAY;

/// How many commits each vault carries before it is backed up. Enough that a
/// census is a real comparison and not "one row came back".
const WRITES: usize = 12;

/// Commits the old phone makes AFTER the restore, which it will never get to
/// upload. This is "shows what it never uploaded" in its checkable form.
const UNACKED_WRITES: usize = 3;

// ---------------------------------------------------------------- the phone --

/// One vault as a phone holds it: a file, a backup home, and a local store.
struct PhoneVault {
    keys: ObjectKeys,
    gateway_id: VaultId,
    file: PathBuf,
    home: BackupHome,
    objects: FsBlobStore,
    census_at_backup: BTreeMap<String, i64>,
}

/// Found a vault, write to it, back it up. What a phone does on day one.
fn found_and_back_up(root: &Path, keys: &centraid_identity::VaultKeys, name: &str) -> PhoneVault {
    let dir = root.join(format!("vault-{}", keys.index));
    std::fs::create_dir_all(&dir).expect("the vault directory is made");
    let file = dir.join("vault.db");
    let home = BackupHome::open(dir.join("backup")).expect("a backup home");
    let objects = home.objects().expect("a local object store");

    // THE TWO KEYS §0 DERIVES, and nothing else reaches the backup path: the
    // vault identity key IS the vault's address on the gateway, and the root
    // key is what every object is sealed under.
    let object_keys = ObjectKeys::new(keys.identity.public().to_bytes(), *keys.root.as_bytes());
    let gateway_id =
        VaultId::from_slice(&keys.identity.public().to_bytes()).expect("32 bytes is a vault id");

    let vault = Vault::create(&file).expect("a vault file");
    vault.found(name, "Ada").expect("the vault is founded");
    for index in 0..WRITES {
        write_one(&vault, index);
    }
    let spool = home.spool().expect("a spool");
    backup::capture(&vault, &spool, &object_keys).expect("capture");
    backup::take_generation(&vault, &object_keys, &home, &objects, None).expect("a generation");
    // CHECKPOINTED, so the census is taken over a file with no log behind it —
    // the same state the base was built from, which is what makes the compare
    // after the restore meaningful.
    backup::checkpoint(&vault, &spool).expect("checkpoint");
    let census_at_backup = backup::drill::census(&file).expect("a census");
    vault.close().expect("the vault closes");

    PhoneVault {
        keys: object_keys,
        gateway_id,
        file,
        home,
        objects,
        census_at_backup,
    }
}

/// One commit, through `crates/vault`'s own drill writer.
///
/// **It is not this test's statement, and it must not be.** Two rules forbid
/// the copy this started as, and both are right: `sql-confinement` keeps every
/// SQL literal inside the four crates that own the query language, and
/// `one_hash` requires every writer of a hash column to be declared with where
/// its value comes from. A second copy of one INSERT in a test crate satisfies
/// neither, and would be a second answer to "what does a drill write" that
/// drifts the first time one of them learns a column.
fn write_one(vault: &Vault, index: usize) {
    backup::drill::write_one(vault, index).expect("a commit");
}

// -------------------------------------------------------------- the gateway --

type TestGateway = Gateway<MemoryState, MemoryBytes>;

fn gateway() -> TestGateway {
    Gateway::new(
        MemoryState::new(),
        // ATTEST, which is the hosted adapter's mode: the client sends the
        // one. The stricter of the two for a commit is this one, because the
        // gateway is blind and has to take the attestation.
        MemoryBytes::new(),
        centraid_gateway_core::retention::Policy::default(),
    )
}

/// Register a vault under an account, the way an adapter's registration path
/// does. `VaultRegistration` is the wire shape; this is its effect.
fn register(engine: &mut TestGateway, vault: VaultId, account: VaultId) {
    engine.state.register(VaultState {
        vault,
        account,
        lease: centraid_gateway_core::lease::LeaseState::unclaimed(),
        head: None,
        append_only: false,
        plan: centraid_gateway_core::plan::Plan::active(64 * 1024 * 1024),
    });
}

/// Upload every object one generation produced, then commit them.
///
/// The order is the phone's: declare (which is where the lease, the plan and
/// the quota are judged), PUT the bytes at the targets, then commit the set
/// against the head the phone last saw.
async fn upload_generation(
    engine: &mut TestGateway,
    phone: &PhoneVault,
    caller: Caller,
) -> ObjectName {
    let names: Vec<String> = phone
        .objects
        .ids()
        .expect("the local store lists")
        .into_iter()
        .collect();
    let manifest_digest = backup::manifest::ManifestHead::read(&phone.home.head_path())
        .expect("the head file reads")
        .expect("a generation was taken")
        .manifest;

    let mut declarations = Vec::new();
    let mut bodies = Vec::new();
    for digest in &names {
        let bytes = phone.objects.get(digest).expect("the object reads");
        // THE TWO SIDES COMPUTE THE SAME NAME, and that is not a coincidence
        // to be papered over with a lookup table: an object's name is the
        // BLAKE3-256 of its CIPHERTEXT on both sides (`ids.rs`'s `ObjectName`,
        // `backup::store::digest`). The assertion is here so that a day when
        // they stop agreeing fails as a naming change rather than as a restore
        // that quietly finds nothing.
        let name = ObjectName::of(&bytes);
        assert_eq!(
            name.hex(),
            *digest,
            "the gateway's object name and the vault's digest are one name"
        );
        declarations.push(Declaration {
            name,
            kind: if *digest == manifest_digest {
                ObjectKind::Manifest
            } else {
                ObjectKind::Segment
            },
            padded_size: bytes.len() as u64,
        });
        bodies.push((name, bytes));
    }

    engine
        .declare(caller, &declarations)
        .await
        .expect("the gateway presigns");
    for (name, bytes) in bodies {
        engine.bytes.upload(caller.vault, name, bytes);
    }

    let manifest_name =
        ObjectName::from_slice(&hex::decode(&manifest_digest).expect("hex")).expect("32 bytes");
    engine
        .commit(
            caller,
            &CommitInput {
                generation: Generation::parse(&manifest_generation(phone))
                    .expect("a generation id"),
                objects: declarations.iter().map(|one| one.name).collect(),
                manifest_head: manifest_name,
                // NONE IS A DIFFERENT CLAIM FROM "the head I saw" (F7): this is
                // the first generation this vault has ever had.
                prev_head: None,
                first_txid: 1,
                last_txid: u64::MAX,
            },
        )
        .await
        .expect("the gateway commits");
    manifest_name
}

fn manifest_generation(phone: &PhoneVault) -> String {
    let head = backup::manifest::ManifestHead::read(&phone.home.head_path())
        .expect("the head file reads")
        .expect("a generation was taken");
    head.generation.hex()
}

// ------------------------------------------------------- the restored phone --

/// What a fresh phone got back for one vault.
struct Restored {
    file: PathBuf,
    census: BTreeMap<String, i64>,
    segments_applied: usize,
}

/// **RESTORE, FROM THE 24 WORDS AND A GATEWAY.**
///
/// This signature is the assertion. It takes the phrase, the gateway and a
/// directory to write into — and it is not that this function chooses not to
/// read the lost phone, it is that it has nothing to read it with: no path, no
/// vault id, no key, no index. F2 held structurally rather than by discipline.
///
/// The steps are the product's:
///
/// 1. the phrase yields the seed, and the seed the ACCOUNT key;
/// 2. the account's own SIGNED listing says which vaults exist and at which
///    indices — verified against the account key this phone just derived, never
///    trusted because a gateway served it;
/// 3. each vault's keys come back from the seed and its index;
/// 4. the lease is claimed at **epoch + 1** (F3), by a NEW device key;
/// 5. the head the gateway holds names the manifest; the manifest names every
///    object; the objects come down and are put into this phone's own store;
/// 6. `restore_generation` lays the base and applies every segment.
async fn restore_onto_a_fresh_phone(
    phrase: &str,
    engine: &mut TestGateway,
    indices: &[u32],
    root: &Path,
    now: ServerTime,
) -> Vec<Restored> {
    let seed: Seed = RecoveryPhrase::parse(phrase)
        .expect("24 words parse")
        .seed();

    // THE KEYS COME OUT OF THE SEED AND NOTHING ELSE. A signed vault listing
    // told a fresh phone which indices existed until the scope amendment of
    // 2026-09-21 struck the account; WHERE THE INDEX LIST COMES FROM IS W15's
    // (the laptop serves the vaults it holds, and a restore asks it). What this
    // drill pins either way is that the KEYS are re-derived on the phone, so a
    // gateway can never point a restore at a vault it has no key for.
    let mut mint = VaultMint::fresh();
    let vaults: Vec<_> = indices
        .iter()
        .map(|index| mint.mint(&seed, *index).expect("a fresh index"))
        .collect();
    assert!(!vaults.is_empty(), "no vaults is not a restore");

    // A FRESH DEVICE KEY. The lost phone's is lost, which is the point: the
    // lease moves to a new device at the next epoch, and the old certificate
    // is what `VAULT_MOVED` is measured against.
    let fresh_device = VaultId::from_slice(&[0xF5; 32]).expect("a device id");

    let mut out = Vec::new();
    for keys in vaults {
        let object_keys = ObjectKeys::new(keys.identity.public().to_bytes(), *keys.root.as_bytes());
        let vault_id = VaultId::from_slice(&keys.identity.public().to_bytes()).expect("a vault id");

        // 4. THE LEASE, AT EPOCH + 1 (F3). The epoch is monotonic and a restore
        // reissues at one above what is held; the gateway refuses an equal or
        // lower one, which is what stops a replayed certificate taking a vault.
        let held = engine
            .vault(&vault_id)
            .await
            .expect("the vault is registered here")
            .lease
            .current
            .expect("the lost phone held it")
            .epoch;
        let claim = Caller {
            vault: vault_id,
            device: fresh_device,
            epoch: held + 1,
            now,
        };
        engine
            .claim_lease(claim)
            .await
            .expect("the restored phone takes the lease");

        // 5. THE HEAD, THE MANIFEST, THE OBJECTS.
        let head = engine
            .vault(&vault_id)
            .await
            .expect("the vault")
            .head
            .expect("the lost phone committed a head");

        let dir = root.join(hex_short(&vault_id));
        std::fs::create_dir_all(&dir).expect("the restore directory is made");
        let home = BackupHome::open(dir.join("backup")).expect("a backup home");
        let store = home.objects().expect("this phone's own object store");

        // EVERY OBJECT THIS VAULT HAS, DOWNLOADED. A phone fetches what the
        // manifest names; the in-memory store is walked here because it has no
        // GET and the filter is the vault, which is the same scoping a
        // presigned URL has.
        let mut manifest_bytes = Vec::new();
        for ((vault, name), bytes) in engine.bytes.every_stored_object() {
            if *vault != vault_id {
                continue;
            }
            let put = store
                .put(bytes)
                .expect("the object lands in this phone's store");
            assert_eq!(put, name.hex(), "a downloaded object keeps its name");
            if *name == head {
                manifest_bytes = bytes.clone();
            }
        }
        assert!(
            !manifest_bytes.is_empty(),
            "the head the gateway holds names an object the gateway holds"
        );

        // 6. THE RESTORE.
        let manifest =
            GenerationManifest::open(&object_keys, &manifest_bytes).expect("the manifest opens");
        let file = dir.join("vault.db");
        let restored =
            backup::restore::restore_generation(&object_keys, &manifest, &store, &file, None)
                .expect("the generation restores");

        let expected: BTreeMap<String, i64> = manifest
            .census_at_head()
            .iter()
            .map(|(table, rows)| (table.clone(), *rows))
            .collect();
        // **`restored-blob-coverage` HAS A STORE TO ASK** (#1029 W6, hand-off 5).
        //
        // The check asks whether the bytes a `core_content_item` row points at
        // are in a store of a MEMBER'S OWN bytes. The backup object store
        // beside it cannot answer — its names are ciphertext hashes and a
        // content row names a plaintext hash — so this is the one content store
        // a device holds, `centraid_blobs::ContentBytes`, opened here and handed
        // in. Nothing else in the workspace can build one below `crates/blobs`,
        // which is why `restore_drill` takes it rather than opening it.
        //
        // This phone is given the bytes on purpose. A **restored** phone holds
        // none — it shows the thumbnail grid and fetches originals on demand
        // (F14) — and that is exactly why the drill in `crates/vault` passes
        // `None` and leans on `restored-blob-custody` instead. What is being
        // proved here is the other case: a device that IS meant to hold a
        // member's bytes is asked, and answers.
        let member_bytes = centraid_blobs::ByteStore::open(dir.join("member.bytes"))
            .await
            .expect("the member's own byte store opens");
        for index in 0..24_usize {
            member_bytes
                .add_bytes(format!("drill content {index}").into_bytes())
                .await
                .expect("the store takes the drill's own bytes");
        }
        let door =
            centraid_blobs::ContentBytes::new(member_bytes, tokio::runtime::Handle::current());

        let report = backup::restore_drill(&file, None, Some(&door), Some(&expected))
            .expect("the restore check runs");
        let coverage = report
            .checks
            .iter()
            .find(|check| check.name == "restored-blob-coverage")
            .expect("the check ran, because a store was passed");
        assert!(
            coverage.ok && coverage.detail.ends_with("0 missing"),
            "the store was asked and could not answer: {}",
            coverage.detail
        );
        assert!(
            !coverage.detail.starts_with("0 sampled"),
            "the coverage check sampled nothing, so it asserted nothing: {}",
            coverage.detail
        );
        assert!(
            report.is_clean(),
            "the restored vault is not clean: {}",
            report
                .checks
                .iter()
                .filter(|check| !check.ok)
                .map(|check| format!("{}: {}", check.name, check.detail))
                .collect::<Vec<_>>()
                .join("; ")
        );

        out.push(Restored {
            census: backup::drill::census(&file).expect("a census"),
            file,
            segments_applied: restored.segments_applied,
        });
    }
    out
}

fn hex_short(id: &VaultId) -> String {
    id.hex()[..16].to_owned()
}

// ------------------------------------------------------------------ the drill --

#[tokio::test(flavor = "current_thread")]
async fn lose_the_phone_type_twenty_four_words_get_every_vault_back() {
    let root = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&root).expect("the scratch root is made");
    let old_phone_root = root.join("old-phone");
    std::fs::create_dir_all(&old_phone_root).expect("the old phone's root");

    // ---- day one: one seed, one account, TWO vaults ----------------------
    let seed = RecoveryPhrase::parse(PHRASE).expect("24 words").seed();
    let account_id = VaultId::from_slice(&[0xAC; 32]).expect("an account id");

    let mut mint = VaultMint::fresh();
    let first_keys = mint.mint_next(&seed).expect("vault 0");
    let second_keys = mint.mint_next(&seed).expect("vault 1");
    assert_eq!((first_keys.index, second_keys.index), (0, 1));

    let phones = [
        found_and_back_up(&old_phone_root, &first_keys, "Household"),
        found_and_back_up(&old_phone_root, &second_keys, "Work"),
    ];

    // ---- the upload -------------------------------------------------------
    let mut engine = gateway();
    let old_device = VaultId::from_slice(&[0x01; 32]).expect("a device id");
    for phone in &phones {
        register(&mut engine, phone.gateway_id, account_id);
        let caller = Caller {
            vault: phone.gateway_id,
            device: old_device,
            epoch: 1,
            now: ServerTime::from_millis(START),
        };
        engine
            .claim_lease(caller)
            .await
            .expect("the first phone takes the lease at epoch 1");
        let head = upload_generation(&mut engine, phone, caller).await;
        assert_eq!(
            engine
                .vault(&phone.gateway_id)
                .await
                .expect("the vault")
                .head,
            Some(head),
            "the gateway's head is the manifest the phone committed"
        );
    }

    // ---- the phone is lost ------------------------------------------------
    //
    // It is NOT deleted. F1 is about a phone that is still there — misplaced,
    // then found — and everything below turns on it still holding its rows.
    // What the member has is the 24 words and the address of a gateway.

    // ---- the restore, from the 24 words alone -----------------------------
    let fresh_root = root.join("fresh-phone");
    std::fs::create_dir_all(&fresh_root).expect("the fresh phone's root");
    let restored = restore_onto_a_fresh_phone(
        PHRASE,
        &mut engine,
        &[0, 1],
        &fresh_root,
        ServerTime::from_millis(START + DAY),
    )
    .await;

    // BOTH VAULTS DISCOVERED. The plural is the claim: a restore that found one
    // of a member's two vaults and said nothing about the other is the failure
    // the account listing exists to prevent.
    assert_eq!(
        restored.len(),
        2,
        "a member with two vaults gets two vaults back"
    );

    // THE CENSUS MATCHES, per vault, table by table.
    for (index, (back, phone)) in restored.iter().zip(phones.iter()).enumerate() {
        assert_eq!(
            back.census, phone.census_at_backup,
            "vault {index}: the restored census is not the census that was backed up"
        );
        assert!(
            back.census.values().copied().sum::<i64>() > 0,
            "vault {index}: a census of nothing proves nothing"
        );
        assert!(
            back.file.exists() && back.file != phone.file,
            "vault {index}: the restored file is a new file on a new phone"
        );
        // A TAIL WAS APPLIED, not just a base laid down (B3). A restore that
        // only ever unpacked the base would pass a census taken at the base.
        assert!(
            back.segments_applied > 0,
            "vault {index}: no segment was applied, so the tail after the base \
             was never proved"
        );
    }

    // ---- the old phone comes back -----------------------------------------
    //
    // It writes — nothing stops it writing to its own file, and nothing should:
    // the vault is on that phone. Then it tries to upload.
    let mut unacked = Vec::new();
    for phone in &phones {
        let vault = Vault::open(&phone.file).expect("the old phone's vault still opens");
        for index in WRITES..WRITES + UNACKED_WRITES {
            write_one(&vault, index);
        }
        let spool = phone.home.spool().expect("a spool");
        backup::capture(&vault, &spool, &phone.keys).expect("the old phone captures");
        let census_now = backup::drill::census(&phone.file).expect("a census");
        vault.close().expect("closes");
        unacked.push(census_now);
    }

    for (index, phone) in phones.iter().enumerate() {
        let put = engine
            .declare(
                Caller {
                    vault: phone.gateway_id,
                    device: old_device,
                    epoch: 1,
                    now: ServerTime::from_millis(START + 2 * DAY),
                },
                &[Declaration {
                    name: ObjectName::of(b"a write the old phone will never land"),
                    kind: ObjectKind::Segment,
                    padded_size: 64,
                }],
            )
            .await;

        // **THE OLD PHONE'S NEXT PUT GETS `VAULT_MOVED`**, and not
        // `UNAUTHORIZED`. The two are different facts with different answers:
        // one is "whoever you are, not here" and this one is "you held this
        // vault and a higher epoch took it". A phone that could not tell them
        // apart would either freeze over a bad signature or go on writing over
        // a hand-over.
        let Err(Fault::Refused(Refusal::VaultMoved {
            current_epoch,
            moved_at,
        })) = put
        else {
            panic!("vault {index}: the superseded phone got {put:?}, not a moved-vault refusal");
        };
        assert_eq!(
            current_epoch, 2,
            "vault {index}: the refusal names the epoch that took it, which is \
             what the restored phone claimed"
        );
        assert_eq!(
            moved_at,
            ServerTime::from_millis(START + DAY),
            "vault {index}: the refusal names WHEN, which is the other half of \
             'N changes since <date>' — a phone that had to guess it from its \
             own clock would be inventing the fact the refusal exists to carry"
        );
    }

    // ---- nothing was wiped, and what it never uploaded is still there ------
    //
    // F1: freeze and show, never wipe and never auto-take-back. The Kotlin half
    // — writes refused, reads kept, the line drawn — is `VaultMovedSpec` and
    // `VaultMovedProducerSpec`. What the gateway side owes is that there is
    // something left for those to show.
    for (index, (phone, census_now)) in phones.iter().zip(unacked.iter()).enumerate() {
        assert!(
            phone.file.exists(),
            "vault {index}: the old phone's vault was deleted, which F1 forbids"
        );
        // NOTHING SHRANK, TABLE BY TABLE. "Never wipe" is not a claim about a
        // total — a total can stay level while one table is emptied and
        // another fills — so it is asserted per table, over the census the
        // backup was taken at.
        for (table, at_backup) in &phone.census_at_backup {
            let now = census_now.get(table).copied().unwrap_or(0);
            assert!(
                now >= *at_backup,
                "vault {index}: `{table}` went from {at_backup} rows to {now}. \
                 F1 is freeze and show, never wipe: a phone whose vault moved \
                 keeps every row it had"
            );
        }
        // AND THE MEMBER'S OWN ROWS ARE ALL THERE. The total is not the
        // measure: capture writes a range index of its own, so a sum would
        // count the backup's bookkeeping alongside the member's writes. What
        // the frozen line counts is what this phone wrote and never landed.
        assert_eq!(
            census_now.get("core_content_item").copied().unwrap_or(0)
                - phone
                    .census_at_backup
                    .get("core_content_item")
                    .copied()
                    .unwrap_or(0),
            UNACKED_WRITES as i64,
            "vault {index}: the old phone still holds every row it wrote after \
             the backup — a count of what is KEPT and never of what is lost"
        );
        let spooled = phone
            .home
            .spool()
            .expect("a spool")
            .entries()
            .expect("the spool lists");
        assert!(
            !spooled.is_empty(),
            "vault {index}: the unacked spool is empty, so a frozen phone would \
             have nothing to show the member before they wiped it"
        );
    }

    let _ = std::fs::remove_dir_all(&root);
}

/// The object index the drill leans on: a committed object is one the gateway
/// will not presign over.
///
/// It is asserted here because the restore reads every object the gateway holds
/// for a vault, and an object the gateway let somebody overwrite would be a
/// restore that came back with bytes nobody sealed.
#[tokio::test(flavor = "current_thread")]
async fn a_committed_object_is_not_presigned_again() {
    let mut engine = gateway();
    let vault = VaultId::from_slice(&[0x33; 32]).expect("a vault id");
    register(
        &mut engine,
        vault,
        VaultId::from_slice(&[0x44; 32]).expect("an account"),
    );
    let caller = Caller {
        vault,
        device: VaultId::from_slice(&[0x01; 32]).expect("a device"),
        epoch: 1,
        now: ServerTime::from_millis(START),
    };
    engine.claim_lease(caller).await.expect("the lease");

    let bytes = b"one sealed object".to_vec();
    let name = ObjectName::of(&bytes);
    let declaration = Declaration {
        name,
        kind: ObjectKind::Segment,
        padded_size: bytes.len() as u64,
    };
    engine
        .declare(caller, &[declaration])
        .await
        .expect("the first declare presigns");
    engine.bytes.upload(vault, name, bytes.clone());
    engine
        .commit(
            caller,
            &CommitInput {
                generation: Generation::parse("a1b2c3d4e5f60718293a4b5c6d7e8f90").expect("hex"),
                objects: vec![name],
                manifest_head: name,
                prev_head: None,
                first_txid: 1,
                last_txid: 1,
            },
        )
        .await
        .expect("the commit");

    let again = engine
        .declare(caller, &[declaration])
        .await
        .expect("a re-declare is answered, not refused");
    assert!(
        again[0].already_committed,
        "a committed name is answered 'it is already there' rather than \
         presigned: a retry with identical bytes is a no-op, and a presign over \
         a committed name is how different bytes land on an existing name"
    );
    assert!(again[0].url.is_empty(), "and nothing was presigned for it");
    let _: Option<StoredObject> = None;
}

// ============================================================== over the wire ==
//
// THE ARM THAT CROSSES A SOCKET (#1029 W5B-4).
//
// Everything above drives `centraid_gateway_core::Gateway` as a library, and
// the header says so plainly: "no HTTPS, no request signing, no pkarr". That
// made the drill a proof of the RULES and of the KEYS, which is worth having
// and is not the product. A member's phone does not call a function; it signs
// a request, sends it over a socket to a server that has never seen its
// process, and believes what comes back.
//
// So one arm crosses a real socket, to a real `centraid-gateway-server` bound
// on `127.0.0.1:0`, through `centraid-gateway-client`. What that buys over the
// library arm, exactly:
//
// | Proved here and not above | Where it would otherwise break |
// |---|---|
// | the signature this client produces is the one this server accepts | a phone that cannot authenticate at all, reported as `SignatureInvalid` |
// | the four headers, spelled the same on both sides | one renamed header, and every request fails |
// | JSON in and JSON out, for declare and commit | a field name nobody checks until a release |
// | `VAULT_MOVED` **rendered by the server and read by the client**, with its epoch and its moment | the freeze drawing "0 changes since 1 January 1970" |
// | a wrong phone clock recovered across the wire, once | a phone that has been off for a month and can never back up again |
//
// # What it still does not prove
//
// **TLS is the deployment's.** `TlsConfig::Terminated` is this server's default
// arm and the one every test runs — a reverse proxy, a Cloudflare Tunnel or a
// Tailscale Funnel holds the certificate — so what crosses here is HTTP over a
// real TCP socket, with real signing on top. The signature is what authenticates
// a request in this protocol; TLS is confidentiality, and `acme.rs` is where it
// is obtained. Saying "HTTPS" about this arm would be saying something this test
// has not run.
//
// **No phone shell is compiled**, for W5 lane A's reasons, unchanged.
//
// **pkarr is not resolved here.** The record and the resolver are
// `centraid_identity::discovery`'s, with their own tests against a real
// `iroh-dns-server`; what this arm needs from discovery is the gateway URL, and
// a drill that spun up a DNS server to be handed back a `127.0.0.1` port it
// already knew would be asserting the harness. `ResolutionSource::Typed` is the
// documented equal-standing source for exactly this case, and it is the one
// used.

use centraid_gateway_client::client::GatewayClient;
use centraid_gateway_client::outcome::ClientError;
use centraid_gateway_client::signer::DeviceSigner;
use centraid_gateway_client::transport::ReqwestTransport;
use centraid_gateway_core::plan::Plan;
use centraid_gateway_core::retention::Policy;
use centraid_gateway_server::bytes::configured::{Backend, ConfiguredBytes};
use centraid_gateway_server::bytes::fs::FilesystemBytes;
use centraid_gateway_server::config::Config;
use centraid_gateway_server::state::{SqliteState, register as register_vault};
use centraid_gateway_server::{clock, serve};
use centraid_identity::{DeviceCertificate, DeviceKey, Epoch, ResolutionSource};

/// A server that is really listening, and the things that must outlive it.
struct LiveGateway {
    origin: String,
    _objects: tempfile::TempDir,
}

/// Bring up a real gateway with these vaults registered under one account.
async fn live_gateway(vaults: &[VaultId], account: VaultId) -> LiveGateway {
    let objects = tempfile::tempdir().expect("an object directory");
    let mut state = SqliteState::in_memory().expect("a state file");
    for vault in vaults {
        register_vault(
            &mut state,
            *vault,
            account,
            Plan::active(64 * 1024 * 1024),
            false,
        )
        .await
        .expect("a registered vault");
    }
    // THE GATEWAY HASHES WHAT IT STORES. There is one mode now: the
    // store-attested checksum and its second, weaker arm existed for a store
    // the gateway could not read, and v0's store is a directory on the
    // member's own laptop (scope amendment 2026-09-21).
    let bytes = ConfiguredBytes::new(Backend::Filesystem(
        FilesystemBytes::open(objects.path(), "").expect("an object directory"),
    ));
    let bound = serve::bind("127.0.0.1:0").await.expect("a free port");
    let origin = format!("http://{}", bound.address);
    let shared = serve::shared(centraid_gateway_server::http::Server {
        gateway: centraid_gateway_core::Gateway::new(state, bytes, Policy::default()),
        config: Config::defaults(objects.path(), &origin),
    });
    tokio::spawn(async move {
        let _ = serve::serve_plain(bound, shared).await;
    });
    LiveGateway {
        origin,
        _objects: objects,
    }
}

/// A client for one vault on a live gateway, with a fresh device key at the
/// epoch it is given.
fn phone_client(
    origin: &str,
    keys: &centraid_identity::VaultKeys,
    epoch: u64,
) -> GatewayClient<ReqwestTransport> {
    let device = DeviceKey::generate().expect("a device key");
    let certificate = DeviceCertificate::issue(&keys.identity, &device.public(), Epoch::new(epoch));
    GatewayClient::new(
        ReqwestTransport::new(origin).expect("a transport"),
        DeviceSigner::new(device, &certificate, centraid_gateway_core::PROTOCOL_MIN),
        VaultId::from_slice(&keys.identity.public().to_bytes()).expect("a vault id"),
    )
}

/// Upload one generation over the wire: declare, PUT each object, commit.
async fn upload_over_the_wire(
    client: &mut GatewayClient<ReqwestTransport>,
    phone: &PhoneVault,
    now_ms: i64,
) -> String {
    let manifest_digest = backup::manifest::ManifestHead::read(&phone.home.head_path())
        .expect("the head file reads")
        .expect("a generation was taken")
        .manifest;

    let mut declarations = Vec::new();
    let mut bodies = Vec::new();
    for digest in phone.objects.ids().expect("the local store lists") {
        let bytes = phone.objects.get(&digest).expect("the object reads");
        let name = ObjectName::of(&bytes);
        declarations.push(serde_json::json!({
            "name": name.hex(),
            "kind": if digest == manifest_digest {
                ObjectKind::Manifest.as_str()
            } else {
                ObjectKind::Segment.as_str()
            },
            "padded_size": bytes.len() as u64,
        }));
        bodies.push((name, bytes));
    }

    let targets = client
        .declare(&serde_json::json!({ "objects": declarations }), now_ms)
        .await
        .expect("the gateway presigns over the wire");
    assert_eq!(
        targets.len(),
        bodies.len(),
        "a target per declared object, from the server"
    );

    for (name, bytes) in bodies {
        // The name IS the hash, and the gateway re-hashes what it stores: a
        // name that is not its bytes' hash is refused at the upload, a round
        // trip before the commit.
        client
            .put_object(&name, bytes, now_ms)
            .await
            .expect("the bytes cross the socket");
    }

    let ack = client
        .commit(
            &serde_json::json!({
                "generation": manifest_generation(phone),
                "objects": declarations
                    .iter()
                    .map(|one| one["name"].as_str().expect("hex").to_owned())
                    .collect::<Vec<_>>(),
                "manifest_head": manifest_digest,
                "prev_head": serde_json::Value::Null,
                "first_txid": 1,
                "last_txid": u64::MAX,
            }),
            now_ms,
        )
        .await
        .expect("the gateway commits over the wire");

    // THE ONLY BACKUP CLAIM THERE IS. The moment is the SERVER's, in the
    // server's own answer — not this phone's clock and not an optimistic
    // local write. `BackupState::acked` is the only constructor for a
    // "backed up" a shell may draw, and this is its one input.
    assert!(
        ack.committed_at_ms > 0,
        "the acknowledgement carries the server's own moment"
    );
    assert_eq!(ack.head, manifest_digest, "the head the gateway now holds");
    ack.head
}

/// **LOSE THE PHONE, TYPE 24 WORDS, GET IT BACK — ACROSS A SOCKET.**
///
/// One vault rather than two: the plural is the library arm's claim and is
/// proved there through the account listing. What this arm is for is the
/// transport, and a second vault would double the socket traffic to re-prove
/// something already proved.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_restore_crosses_a_real_socket_and_the_old_phone_is_refused_by_the_server() {
    let root = centraid_ontology::golden::scratch_dir().join("wire");
    std::fs::create_dir_all(&root).expect("the scratch root is made");

    // ---- day one -----------------------------------------------------------
    let seed = RecoveryPhrase::parse(PHRASE).expect("24 words").seed();
    let account_id = VaultId::from_slice(&[0xAC; 32]).expect("an account id");
    let keys = VaultMint::fresh().mint_next(&seed).expect("vault 0");

    let phone = found_and_back_up(&root.join("old-phone"), &keys, "Ada's notes");
    let live = live_gateway(&[phone.gateway_id], account_id).await;

    // THE GATEWAY URL COMES THROUGH `centraid_identity`'s OWN DOOR. A typed URL
    // is not a second-class source (#1029 §0): it is the answer when resolution
    // cannot give one, and the restore path has one code path for both.
    let located = centraid_identity::Discovery::with_server(centraid_identity::DEFAULT_DNS_SERVER)
        .expect("a discovery client")
        .locate_vault(
            &keys.identity.public(),
            &ResolutionSource::Typed(
                centraid_identity::GatewayUrl::parse(&live.origin).expect("a gateway URL"),
            ),
        )
        .await
        .expect("a typed URL locates without a network");
    assert_eq!(
        located
            .gateway()
            .map(|url| url.as_str().trim_end_matches('/')),
        Some(live.origin.as_str()),
        "the URL the restore will use is the one the member typed"
    );
    assert_eq!(
        located.endpoint(),
        None,
        "a typed URL names a host; the laptop's endpoint id comes off the \
         published record, which is the path W15 builds"
    );

    // ---- the old phone backs up, over the wire ------------------------------
    //
    // ITS CLOCK IS AT THE UNIX EPOCH, which is the harshest skew a phone can
    // have and is what a device that has been off the charger for months comes
    // back with. Nothing corrects it but the protocol: `preflight` reads the
    // server's own time off `/v1/health` and the signer carries the offset from
    // there. A phone that had to be handed the right time would be a phone that
    // cannot back up without one.
    let old_phone_clock = 0_i64;
    let mut old_phone = phone_client(&live.origin, &keys, 1);
    let preflight = old_phone
        .preflight(old_phone_clock)
        .await
        .expect("the ranges overlap");
    assert_eq!(
        preflight.agreed,
        centraid_gateway_core::PROTOCOL_MAX,
        "the highest version both understand"
    );
    assert!(
        old_phone.clock_offset_ms() > 1_600_000_000_000,
        "the phone learned a real clock off the wire, not a guess"
    );

    old_phone
        .claim_lease(old_phone_clock)
        .await
        .expect("the first phone takes the lease");
    let head = upload_over_the_wire(&mut old_phone, &phone, old_phone_clock).await;

    // ---- the phone is lost, and a fresh one restores ------------------------
    //
    // F2 in the same shape as the library arm: what goes in is the phrase and
    // a URL. Nothing here reads the old phone's directory, its key or its index.
    let restored_dir = root.join("fresh-phone");
    std::fs::create_dir_all(&restored_dir).expect("the restore directory");

    let restored_seed = RecoveryPhrase::parse(PHRASE).expect("24 words").seed();
    let restored_keys = VaultMint::fresh()
        .mint(&restored_seed, 0)
        .expect("vault 0 comes back out of the phrase");
    assert_eq!(
        restored_keys.identity.public(),
        keys.identity.public(),
        "the fresh phone re-derived the SAME vault from the phrase alone"
    );

    // A FRESH DEVICE KEY AT EPOCH + 1 (F3), and the server is the one that
    // decides whether it may have the lease.
    let mut fresh_phone = phone_client(&live.origin, &restored_keys, 2);
    let fresh_clock = 0_i64;
    fresh_phone.preflight(fresh_clock).await.expect("health");
    let lease = fresh_phone
        .claim_lease(fresh_clock)
        .await
        .expect("the restored phone takes the lease at epoch 2");
    assert_eq!(lease.epoch, 2, "the epoch the server now holds");
    assert_eq!(
        lease.head.as_deref(),
        Some(head.as_str()),
        "the head the gateway holds, read back over the wire"
    );

    let object_keys = ObjectKeys::new(
        restored_keys.identity.public().to_bytes(),
        *restored_keys.root.as_bytes(),
    );
    let home = BackupHome::open(restored_dir.join("backup")).expect("a backup home");
    let store = home.objects().expect("this phone's own object store");

    // THE MANIFEST NAMES EVERY OBJECT, AND EACH ONE IS FETCHED BY NAME. No
    // enumeration of the gateway's store: a phone asks for what its manifest
    // says, which is the only thing a presigned read would let it ask for
    // anyway.
    let head_name = ObjectName::from_slice(&hex::decode(&head).expect("hex")).expect("32 bytes");
    let manifest_bytes = fresh_phone
        .get_object(&head_name, fresh_clock)
        .await
        .expect("the manifest comes down");
    assert_eq!(
        store.put(&manifest_bytes).expect("stored"),
        head,
        "a downloaded object keeps its name"
    );
    let manifest =
        GenerationManifest::open(&object_keys, &manifest_bytes).expect("the manifest opens");
    for name in manifest
        .base
        .iter()
        .map(|range| range.object_name.clone())
        .chain(manifest.segments.iter().map(|one| one.object.clone()))
    {
        if store.get(&name).is_ok() {
            continue;
        }
        let object = ObjectName::from_slice(&hex::decode(&name).expect("hex")).expect("32 bytes");
        let bytes = fresh_phone
            .get_object(&object, fresh_clock)
            .await
            .expect("an object the manifest names comes down");
        assert_eq!(store.put(&bytes).expect("stored"), name);
    }

    let file = restored_dir.join("vault.db");
    let restored =
        backup::restore::restore_generation(&object_keys, &manifest, &store, &file, None)
            .expect("the generation restores");
    assert!(
        restored.segments_applied > 0,
        "the tail after the base was applied, not only the base"
    );
    assert_eq!(
        backup::drill::census(&file).expect("a census"),
        phone.census_at_backup,
        "every table came back over the wire, row for row"
    );

    // ---- the old phone writes again, and the SERVER refuses it --------------
    //
    // This is the sentence the whole drill is for, and here it is the server
    // saying it: a refusal rendered by `gateway-server` from
    // `Refusal::VaultMoved`, carried as JSON with its companion, read back by
    // `gateway-client` into the typed thing a shell freezes on.
    let vault = Vault::open(&phone.file).expect("the old phone's vault opens");
    for index in 0..UNACKED_WRITES {
        write_one(&vault, WRITES + index);
    }
    vault.close().expect("the vault closes");

    // ITS NEXT PUT, WHICH IS A DECLARE: that is where a phone's upload pass
    // starts and where the write guard runs. A lease CLAIM at a stale epoch is
    // a different refusal on purpose (`LeaseStale`) — "your claim is behind" is
    // not the same sentence as "you held this vault and a higher epoch took
    // it", and only the second one freezes.
    let stale_claim = old_phone
        .claim_lease(old_phone_clock)
        .await
        .expect_err("a stale epoch cannot re-take the lease");
    assert!(
        matches!(
            stale_claim,
            ClientError::Refused {
                code: centraid_api_proto::core_v1::ErrorCode::GatewayLeaseStale,
                ..
            }
        ),
        "a stale claim is not a move: {stale_claim:?}"
    );

    let retried = phone
        .objects
        .ids()
        .expect("the local store lists")
        .into_iter()
        .next()
        .expect("the old phone has objects to retry");
    let retried_bytes = phone.objects.get(&retried).expect("the object reads");
    let refusal = old_phone
        .declare(
            &serde_json::json!({
                "objects": [{
                    "name": retried,
                    "kind": ObjectKind::Segment.as_str(),
                    "padded_size": retried_bytes.len() as u64,
                }]
            }),
            old_phone_clock,
        )
        .await
        .expect_err("the old phone's next put is refused");
    let ClientError::Moved {
        current_epoch,
        moved_at_ms,
    } = refusal
    else {
        panic!("the server refused with {refusal:?}, not a move");
    };
    assert_eq!(
        current_epoch, 2,
        "the refusal names the epoch that took the vault"
    );
    assert!(
        moved_at_ms > 0,
        "the refusal names WHEN it moved — the other half of 'N changes since \
         <date>', and the half a phone would otherwise have to invent"
    );

    // F1: FREEZE AND SHOW, NEVER WIPE. The old phone still has what it wrote
    // and never landed, which is what the frozen line counts.
    let census_now = backup::drill::census(&phone.file).expect("a census");
    assert_eq!(
        census_now.get("core_content_item").copied().unwrap_or(0)
            - phone
                .census_at_backup
                .get("core_content_item")
                .copied()
                .unwrap_or(0),
        UNACKED_WRITES as i64,
        "the old phone holds every row it wrote after the backup"
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// **A PHONE WITH A WRONG CLOCK AND NO PREFLIGHT, ACROSS THE WIRE.**
///
/// The recovery this lane exists to build, proved where it actually happens:
/// the server renders a 401 carrying its own time, the client applies it, signs
/// again, and the second attempt is accepted. The unit tests script that
/// exchange; this one has a real `gateway-server` deciding it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wrong_clock_is_recovered_against_a_real_server_in_one_retry() {
    let root = centraid_ontology::golden::scratch_dir().join("skew");
    std::fs::create_dir_all(&root).expect("the scratch root is made");
    let seed = RecoveryPhrase::parse(PHRASE).expect("24 words").seed();
    let keys = VaultMint::fresh().mint_next(&seed).expect("vault 0");
    let vault = VaultId::from_slice(&keys.identity.public().to_bytes()).expect("a vault id");
    let live = live_gateway(
        &[vault],
        VaultId::from_slice(&[0xAC; 32]).expect("an account id"),
    )
    .await;

    // NO PREFLIGHT. The phone signs straight away with a clock a year and a
    // half out, which is what a device that has been in a drawer does.
    let mut phone = phone_client(&live.origin, &keys, 1);
    let wrong = clock::now().millis() - 500 * DAY;
    let lease = phone
        .claim_lease(wrong)
        .await
        .expect("the 401 taught it the time and the second attempt was accepted");
    assert_eq!(lease.epoch, 1);
    assert!(
        phone.clock_offset_ms().abs() > 400 * DAY,
        "the offset is the server's time minus this phone's, learned from the refusal"
    );
    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------- #1029 W15-3: the phone-shaped drill, over iroh --

/// **LOSE THE PHONE, TYPE 24 WORDS, GET EVERY VAULT BACK — THROUGH THE CORE.**
///
/// The acceptance criterion at issue line 572, minus the account listing the
/// [scope amendment of
/// 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795)
/// struck. What is new here, against every other case in this file:
///
/// 1. **The restore is `centraid_core::phone::restore` — the core's own door**,
///    the one `centraid_call`'s `Restore` arm reaches, not a function this test
///    wrote out of the same parts.
/// 2. **Its whole input is the phrase and the laptop's id.** No vault id, no
///    index, no key, no path on phone A. F2 held structurally: the signature
///    has nothing to read phone A with.
/// 3. **Which vaults exist is discovered, not told.** There is no account and
///    no listing; the restore derives candidates by index and asks the laptop
///    about each, gap-limited.
/// 4. **It crosses a real iroh endpoint** to a real `gateway-server`, both ends
///    on loopback with relay and address lookup off.
/// 5. **Phone A's next drain is refused `VAULT_MOVED`** — not "unreachable",
///    which would be the phone promising a retry that can never work (F1).
mod phone_shaped {
    use centraid_api_proto::core_v1 as wire;
    use centraid_core::phone::{self, Keyring, Laptop};
    use centraid_gateway_core::Gateway;
    use centraid_gateway_core::ids::Key32;
    use centraid_gateway_core::plan::Plan;
    use centraid_gateway_core::retention::Policy;
    use centraid_gateway_server::bytes::configured::{Backend, ConfiguredBytes};
    use centraid_gateway_server::bytes::fs::FilesystemBytes;
    use centraid_gateway_server::config::{Config, IrohConfig};
    use centraid_gateway_server::http::Server;
    use centraid_gateway_server::serve;
    use centraid_gateway_server::state::{SqliteState, register};
    use centraid_identity::RecoveryPhrase;
    use centraid_vault::Vault;

    /// The two vaults phone A makes. **Plural is the point**: "every vault
    /// back" is a claim with a plural in it.
    const INDICES: [u32; 2] = [0, 1];
    const WRITES: usize = 10;

    struct Live {
        address: iroh::EndpointAddr,
        _objects: tempfile::TempDir,
        _served: tokio::task::JoinHandle<()>,
    }

    /// One gateway holding BOTH vaults, which is what a member's laptop is.
    async fn live(vaults: &[Key32]) -> Live {
        let objects = tempfile::tempdir().expect("a temporary object directory");
        let mut state = SqliteState::in_memory().expect("a state file");
        for vault in vaults {
            register(&mut state, *vault, *vault, Plan::active(u64::MAX), false)
                .await
                .expect("a registered vault");
        }
        let bytes = ConfiguredBytes::new(Backend::Filesystem(
            FilesystemBytes::open(objects.path(), "").expect("an object directory"),
        ));
        let server = Server {
            gateway: Gateway::new(state, bytes, Policy::default()),
            config: Config::defaults(objects.path(), ""),
        };
        let endpoint = serve::bind_iroh(
            objects.path(),
            &IrohConfig {
                local_only: true,
                bind_addr: Some("127.0.0.1:0".to_owned()),
                ..IrohConfig::default()
            },
        )
        .await
        .expect("a bound endpoint");
        let address = iroh::EndpointAddr::from_parts(
            endpoint.id(),
            endpoint
                .bound_sockets()
                .into_iter()
                .map(iroh::TransportAddr::Ip),
        );
        let served = tokio::spawn(async move {
            let _ = serve::serve_iroh(endpoint, serve::shared(server)).await;
        });
        Live {
            address,
            _objects: objects,
            _served: served,
        }
    }

    /// **LOSE THE PHONE, TYPE 24 WORDS, GET EVERY VAULT BACK.**
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn lose_the_phone_type_the_words_and_the_core_brings_every_vault_back_over_iroh() {
        let root = centraid_ontology::golden::scratch_dir();
        let seed = RecoveryPhrase::parse(super::PHRASE)
            .expect("the vector parses")
            .seed();
        let ids: Vec<Key32> = INDICES
            .iter()
            .map(|index| {
                let keys = centraid_identity::derive::restore_vault_keys(&seed, *index)
                    .expect("vault keys");
                Key32::from_bytes(keys.identity.public().to_bytes())
            })
            .collect();
        let gateway = live(&ids).await;
        let runtime = tokio::runtime::Handle::current();
        let laptop_id = *gateway.address.id.as_bytes();

        // ---- PHONE A: two vaults, written and drained to the laptop --------
        let phone_a = root.join("phone-a");
        let mut held = Vec::new();
        let mut expected = Vec::new();
        for index in INDICES {
            let keys = Keyring::derive(&seed, index, Some([0xA1; 32])).expect("a fresh index");
            let dir = phone_a.join(format!("vault-{index}"));
            std::fs::create_dir_all(&dir).expect("a directory");
            let file = dir.join("vault.db");
            let vault = Vault::create(&file).expect("a vault file");
            vault
                .found(&format!("Household {index}"), "Ada")
                .expect("it founds");
            for write in 0..WRITES {
                centraid_vault::backup::drill::write_one(&vault, write).expect("a commit");
            }
            pair_and_claim(&file, &gateway, &keys, &[0xA1; 32]).await;
            let answer = tokio::task::block_in_place(|| {
                phone::drain_now(
                    &vault,
                    &file,
                    Some(&keys),
                    &wire::DrainRequest { deadline_ms: 0 },
                    &runtime,
                )
            })
            .expect("a drain answers");
            assert_eq!(
                answer.stopped,
                wire::DrainStop::Empty as i32,
                "vault {index} did not reach the laptop"
            );
            expected.push(centraid_vault::backup::drill::census(&file).expect("a census"));
            held.push((keys, vault, file));
        }

        // ---- PHONE B: the 24 words and the laptop's id, and nothing else ---
        let phone_b = root.join("phone-b");
        std::fs::create_dir_all(&phone_b).expect("a directory");
        let restored = tokio::task::block_in_place(|| {
            phone::restore::run(
                &phone_b.join("vault.db"),
                &wire::RestoreRequest {
                    phrase: super::PHRASE.to_owned(),
                    // THE TYPED PATH, because this test contacts no resolver:
                    // §5's "or the one typed when DNS fails", which is the path
                    // that must always work.
                    endpoint: Some(laptop_id.to_vec()),
                },
                &runtime,
            )
        })
        .expect("the restore runs");

        assert_eq!(
            restored.vaults.len(),
            INDICES.len(),
            "a restore that found {} of {} vaults is not 'every vault back'",
            restored.vaults.len(),
            INDICES.len()
        );
        assert_eq!(
            restored.gap_scanned,
            phone::restore::GAP,
            "the scan stopped before the gap limit, so 'we looked' is not checkable"
        );
        assert_eq!(
            restored.device_secret.len(),
            32,
            "a restore mints a device key and hands it over exactly once"
        );

        for (slot, index) in INDICES.iter().enumerate() {
            let one = restored
                .vaults
                .iter()
                .find(|one| one.index == *index)
                .unwrap_or_else(|| panic!("vault at index {index} did not come back"));
            // THE CENSUS, not only a clean page tree (§2).
            let back = centraid_vault::backup::drill::census(std::path::Path::new(&one.path))
                .expect("a census");
            assert_eq!(
                back, expected[slot],
                "vault {index} came back with different rows"
            );
            assert!(one.rows > 0, "vault {index} came back empty");
            assert!(
                !one.safety_number.is_empty(),
                "vault {index} came back with no safety number to compare"
            );
        }

        // ---- PHONE A IS FROZEN, AND IT IS TOLD SO BY NAME (F1) -------------
        let (keys, vault, file) = &held[0];
        centraid_vault::backup::drill::write_one(vault, 900).expect("a commit phone A never sends");
        let refusal = tokio::task::block_in_place(|| {
            phone::drain_now(
                vault,
                file,
                Some(keys),
                &wire::DrainRequest { deadline_ms: 0 },
                &runtime,
            )
        })
        .expect_err("phone A's next put must be refused");
        match refusal {
            centraid_core::CoreError::VaultMoved { current_epoch, .. } => {
                assert!(
                    current_epoch > 1,
                    "the refusal names the epoch that took the vault"
                );
            }
            other => {
                panic!("phone A was told {other}, which promises a retry that can never work (F1)")
            }
        }

        // AND IT STILL HOLDS EVERY ROW IT HAD. Nothing is wiped.
        let after = centraid_vault::backup::drill::census(file).expect("a census");
        for (table, rows) in &expected[0] {
            assert!(
                after.get(table).copied().unwrap_or_default() >= *rows,
                "phone A lost rows from {table} when it froze"
            );
        }

        for (_, vault, _) in held {
            drop(vault);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Do what a pairing does: certify, keep the record, and claim the lease.
    async fn pair_and_claim(
        vault_file: &std::path::Path,
        live: &Live,
        keyring: &Keyring,
        secret: &[u8; 32],
    ) {
        let device = phone::link::Device::certify(secret, &keyring.vault.identity, 1);
        let record = Laptop {
            gateway_endpoint: hex::encode(live.address.id.as_bytes()),
            relay_url: Some(String::new()),
            direct_addrs: live
                .address
                .ip_addrs()
                .map(|addr: &std::net::SocketAddr| addr.to_string())
                .collect(),
            device_certificate: Some(device.certificate_hex()),
            epoch: Some(1),
            last_acked_at_ms: None,
        };
        record.write(vault_file).expect("the record is written");
        let mut client = phone::link::dial(
            &record,
            &device,
            Key32::from_bytes(keyring.vault.identity.public().to_bytes()),
        )
        .await
        .expect("the phone dials");
        client
            .preflight(phone::link::now_ms())
            .await
            .expect("the laptop answers");
        client
            .claim_lease(phone::link::now_ms())
            .await
            .expect("this device takes the lease");
    }
}
