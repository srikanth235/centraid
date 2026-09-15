//! `centraid export` — the custody half of a portable copy (#1020, D-1020-R7).
//!
//! ## What this is, and what it deliberately is not
//!
//! `export` writes two things into `--out`:
//!
//! 1. a **snapshot generation** — the vault's bytes, content-addressed, the
//!    same artefact a backup generation is built from;
//! 2. `custody/recovery-kit.json` — password-wrapped, carrying the seal key,
//!    the identity seed and every live Locker key file.
//!
//! That path inside the bundle is v0's `PORTABLE_CUSTODY_KIT_PATH`, kept
//! because an owner who has one of these already knows where the kit lives.
//!
//! **The bundle stores ciphertext and the keys leave only inside that file.**
//! It is the same rule as every other gesture: a directory copy carries
//! ciphertext, and the kit is the one artefact that carries keys. What makes
//! `export` different from a copy is that it *writes the kit*, which is why it
//! requires a passphrase and refuses without one.
//!
//! What it is not: the full v0 portable export, which also carried the blob
//! bundle and an app-by-app manifest. That is a wave 3 concern — it needs the
//! content store. This lane owns custody, so this lane lands the custody half
//! and says so rather than shipping a bundle that silently omits the photos.

use std::path::{Path, PathBuf};

use centraid_vault::backup::{
    self, FsBlobStore, Keyring, LockerKeyEntry, RecoveryKitDocument, RecoveryKitTarget,
};
use centraid_vault::custody::KeyStore;
use centraid_vault::file::Vault;

use crate::exit;

/// Where the kit lives inside the bundle — v0's `PORTABLE_CUSTODY_KIT_PATH`.
pub const PORTABLE_CUSTODY_KIT_PATH: &str = "custody/recovery-kit.json";

pub struct ExportArgs {
    pub data_dir: Option<PathBuf>,
    pub out: Option<PathBuf>,
    pub password_file: Option<PathBuf>,
}

pub fn run(args: ExportArgs) -> u8 {
    let (Some(data_dir), Some(out)) = (args.data_dir, args.out) else {
        eprintln!("centraid: `export` needs --data-dir and --out.");
        return exit::USAGE;
    };
    let Some(password_file) = args.password_file else {
        eprintln!(
            "centraid: `export` needs --password-file. The bundle carries this vault's keys, so \
             an unwrapped export is not offered — not as a flag, not as a prompt, not at all."
        );
        return exit::USAGE;
    };
    match export(&data_dir, &out, &password_file) {
        Ok(report) => {
            println!("{report:#}");
            exit::OK
        }
        Err(message) => {
            eprintln!("centraid: {message}");
            exit::REFUSED
        }
    }
}

fn export(data_dir: &Path, out: &Path, password_file: &Path) -> Result<serde_json::Value, String> {
    let password = std::fs::read_to_string(password_file)
        .map_err(|error| format!("reading {}: {error}", password_file.display()))?;
    let password = password.trim_end_matches(['\n', '\r']);
    // The floor is checked here, at the seal, which is the only place it
    // belongs: a kit written under a weaker policy must still open.
    backup::kit::assert_passphrase_floor(password).map_err(|error| error.to_string())?;

    let file = crate::cmd::sole_vault_file(data_dir)?;
    let vault =
        Vault::open(&file).map_err(|error| format!("opening {}: {error}", file.display()))?;
    let vault_id = vault
        .vault_id()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "this vault has not been founded — there is nothing to export".to_owned())?;
    let created_at = vault.clock().now_text();

    let keys = KeyStore::new(crate::cmd::keys_dir_in(data_dir));
    for warning in keys.take_warnings() {
        eprintln!("centraid: {warning}");
    }

    // The snapshot generation.
    std::fs::create_dir_all(out).map_err(|error| format!("creating {}: {error}", out.display()))?;
    let blobs = FsBlobStore::open(out.join("blobs")).map_err(|error| error.to_string())?;
    let master = keys
        .load_or_create("export.master.key")
        .map_err(|error| error.to_string())?;
    let keyring = Keyring::from_json(&serde_json::json!({
        "version": 1,
        "active": 1,
        "epochs": [{ "epoch": 1, "key": encode(&master), "createdAt": created_at }],
    }))
    .map_err(|error| error.to_string())?;
    let outcome = backup::take_generation(
        &vault,
        &blobs,
        &keyring,
        1,
        None,
        &[],
        &out.join("snapshots"),
    )
    .map_err(|error| error.to_string())?;

    // THE CUSTODY KIT, AND THE HALF THIS HOST CANNOT WRITE (#1020, D-1020-L1).
    //
    // Before wave 4 this read every live Locker key file out of the host's own
    // `keys/`. The gateway holds no member key now — that is the trust
    // premise, not a gap — so a kit written here carries the seal key and the
    // identity seed and **no member key**, and the Locker half comes from a
    // seat's own export.
    //
    // It is written down rather than left to be discovered: the kit's
    // fingerprint deliberately includes which Locker keys it carries, because
    // *a kit that lost one restores a vault whose secrets do not open* — a
    // real capability difference an owner must be able to notice. A kit with
    // none has a different fingerprint from a kit with one, which is correct.
    let names_a_member_key: Option<String> = vault
        .read(|connection| {
            centraid_vault::custody::locker_key::live_locker_key_id(connection).map_err(|error| {
                centraid_vault::VaultError::Invariant {
                    context: error.to_string(),
                }
            })
        })
        .map_err(|error| error.to_string())?;
    let locker_keys: Vec<LockerKeyEntry> = Vec::new();
    vault.close().map_err(|error| error.to_string())?;

    let kit = RecoveryKitDocument {
        created_at: created_at.clone(),
        keyring,
        targets: vec![RecoveryKitTarget {
            provider: "local".into(),
            target_id: format!("local:{}", out.join("blobs").display()),
            vault_id: vault_id.clone(),
            label: format!("exported {created_at}"),
            seal_key: keys
                .export("seal.key")
                .map_err(|error| error.to_string())?
                .as_deref()
                .map(encode),
            identity_seed: keys
                .export("identity.seed")
                .map_err(|error| error.to_string())?
                .as_deref()
                .map(encode),
            locker_keys,
        }],
    };
    let wrapped = backup::wrap_recovery_kit(&kit, password).map_err(|error| error.to_string())?;
    let kit_file = out.join(PORTABLE_CUSTODY_KIT_PATH);
    std::fs::create_dir_all(kit_file.parent().unwrap_or(out))
        .map_err(|error| format!("creating {}: {error}", kit_file.display()))?;
    std::fs::write(
        &kit_file,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&wrapped).map_err(|error| error.to_string())?
        ),
    )
    .map_err(|error| format!("writing {}: {error}", kit_file.display()))?;

    eprintln!(
        "centraid: exported {vault_id} into {} — the bundle holds ciphertext, and the keys are \
         only inside {PORTABLE_CUSTODY_KIT_PATH}. Keep the password somewhere the bundle is not.",
        out.display()
    );
    eprintln!(
        "centraid: content blobs are NOT in this bundle yet (wave 3 owns the content store); it \
         carries the vault and its custody."
    );
    if let Some(key_id) = &names_a_member_key {
        eprintln!(
            "centraid: this kit carries NO member key. {vault_id} names Locker key {key_id}, \
             which lives on a seat and never on this host — export a kit from a seat that \
             holds it, and keep both. Without the seat's kit this bundle restores a vault \
             whose Locker secrets cannot be opened."
        );
    }
    Ok(serde_json::json!({
        "command": "export",
        "vaultId": vault_id,
        "out": out.display().to_string(),
        "kit": kit_file.display().to_string(),
        "kitFingerprint": backup::recovery_kit_fingerprint(&kit),
        "generation": outcome.generation,
        "manifestHash": outcome.manifest_hash,
        "base": { "name": outcome.head.name, "digest": outcome.head.digest, "size": outcome.head.size },
        "bytes": outcome.bytes,
        "lockerKeys": kit.targets[0].locker_keys.len(),
        "memberKeyCustody": if names_a_member_key.is_some() { "seat" } else { "none" },
        "namesMemberKey": names_a_member_key,
        "carriesContentBlobs": false,
    }))
}

fn encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
