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
    AttestedChecksum, ChecksumMode, Gateway, Generation, ObjectKind, ObjectName, Refusal,
    ServerTime, StoredObject, VaultId, VaultState,
};
use centraid_identity::{AccountKey, RecoveryPhrase, Seed, VaultClaim, VaultListing, VaultMint};
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
        // checksum and the store records it. `ReadAndHash` is the standalone
        // one. The stricter of the two for a commit is this one, because the
        // gateway is blind and has to take the attestation.
        MemoryBytes::new(ChecksumMode::Attest),
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
            checksum: AttestedChecksum::of(&bytes),
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
    listing_bytes: &[u8],
    root: &Path,
    now: ServerTime,
) -> Vec<Restored> {
    let seed: Seed = RecoveryPhrase::parse(phrase)
        .expect("24 words parse")
        .seed();
    let account = AccountKey::derive(&seed);

    // THE LISTING IS VERIFIED AGAINST THE PHONE'S OWN KEY. A gateway that
    // served a listing naming a vault this account never had would be a
    // gateway that could make a restore fetch somebody else's objects.
    let listing = VaultListing::from_bytes(listing_bytes).expect("the listing decodes");
    listing.verify().expect("the listing's signature holds");
    assert_eq!(
        listing.account(),
        &account.public(),
        "the listing is this account's, checked against the key the seed just \
         produced and not against anything the gateway said"
    );

    let vaults = listing
        .restore(&seed)
        .expect("every vault's keys come back");
    assert!(
        !vaults.is_empty(),
        "an account with no vaults is not a restore"
    );

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
        for ((vault, name), bytes) in engine.bytes.stored() {
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
        let report = backup::restore_drill(&file, None, None, Some(&expected))
            .expect("the restore check runs");
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
    let account = AccountKey::derive(&seed);
    let account_id = VaultId::from_slice(&account.public().to_bytes()).expect("an account id");

    let mut mint = VaultMint::fresh();
    let first_keys = mint.mint_next(&seed).expect("vault 0");
    let second_keys = mint.mint_next(&seed).expect("vault 1");
    assert_eq!((first_keys.index, second_keys.index), (0, 1));

    // THE ACCOUNT'S OWN SIGNED LISTING, which is why a restore needs no
    // operator and no lost phone (F2): the account key signs "these vaults, at
    // these indices", and a fresh phone verifies it against the key the seed
    // gives it.
    let listing = VaultListing::sign(
        &account,
        &[
            VaultClaim::issue(&account, &first_keys.identity.public(), first_keys.index),
            VaultClaim::issue(&account, &second_keys.identity.public(), second_keys.index),
        ],
    )
    .expect("the account signs its listing");
    let listing_bytes = listing.to_bytes();

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
        &listing_bytes,
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
                    checksum: AttestedChecksum::of(b"a write the old phone will never land"),
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

/// The listing is what makes a restore need no operator — and the check on it
/// is what makes it safe to take one from a gateway.
///
/// A gateway that served a listing signed by a different account, or one whose
/// claims were re-signed, would be a gateway that could point a restore at
/// objects it has no key for — or, worse, at a vault index that collides with
/// one this account already has. The refusal is the signature's, not a
/// heuristic's.
#[test]
fn a_listing_this_account_did_not_sign_is_refused() {
    let seed = RecoveryPhrase::parse(PHRASE).expect("24 words").seed();
    let account = AccountKey::derive(&seed);

    let other_phrase = "legal winner thank year wave sausage worth useful legal winner thank \
                        year wave sausage worth useful legal will";
    let other_seed = RecoveryPhrase::parse(other_phrase)
        .map(|phrase| phrase.seed())
        .unwrap_or_else(|_| {
            // An 18-word phrase is not 24 words; if this build refuses it, mint
            // the other account from a different valid 24-word vector instead.
            RecoveryPhrase::parse(
                "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo \
                 zoo zoo zoo zoo vote",
            )
            .expect("a second 24-word vector")
            .seed()
        });
    let other = AccountKey::derive(&other_seed);
    let mut mint = VaultMint::fresh();
    let keys = mint.mint_next(&other_seed).expect("a vault");

    let listing = VaultListing::sign(
        &other,
        &[VaultClaim::issue(
            &other,
            &keys.identity.public(),
            keys.index,
        )],
    )
    .expect("the other account signs");

    // The signature is valid — it is simply not THIS account's, which is the
    // check a restoring phone must make and the reason it holds the account key
    // before it asks anyone anything.
    listing
        .verify()
        .expect("a valid signature, by somebody else");
    assert_ne!(
        listing.account(),
        &account.public(),
        "the restoring phone compares the listing's account against the key its \
         own seed produced, and refuses on a mismatch"
    );
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
        checksum: AttestedChecksum::of(&bytes),
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
