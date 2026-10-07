//! THE PHONE'S LOCKER SESSION (#1047, wave L1; D-5).
//!
//! D-5 rules the gesture: **the phone's biometric, the device passcode as
//! fallback, and a relock when Centraid leaves the foreground — no Locker
//! passphrase.** The OS prompt is the shell's (`LAContext`
//! `.deviceOwnerAuthentication`, `BiometricPrompt` with `DEVICE_CREDENTIAL`),
//! because only the shell can raise one; this module is the other half, and it
//! is the half that holds `K`:
//!
//! - **`K` is the 24 words' own leaf** — `seed / vault'(i) / locker'`
//!   (`centraid_identity::derive`, #1047 Q-1047-11) — derived at
//!   `centraid_open` with the vault's other keys, held in the core's memory in
//!   [`crate::phone::Keyring`] and never written down. A restore from the 24
//!   words re-derives it, so sealed secrets reopen on the restored phone. There
//!   is no key file and no random mint; a core opened without the seed has no
//!   `K` and refuses an unlock as `Unavailable`, the same honest state a drain
//!   without keys is.
//! - **The session holds `K` only after an unlock** ([`unlock`]), which the
//!   shell sends after the OS said yes. The first unlock on a vault that names
//!   no generation commits one `locker_key` row (ids only,
//!   `Vault::locker_generation`).
//! - **A reveal and a secret-bearing write need an open session** and are
//!   refused without one ([`reveal`], [`seal_command`]). The receipt of a
//!   reveal is written BEFORE the plaintext exists (D-1020-L3).
//! - **A one-time code is a reveal of what the seed makes, never of the seed**
//!   ([`totp`], Q-1047-16): `locker.totp_code` writes its receipt first, the
//!   `otp_seed` cell is opened under `K`, and RFC 6238's HMAC-SHA-1 is computed
//!   here — the one SHA-1 in the workspace, because every authenticator agrees
//!   on it — with `centraid_apps_locker::totp`'s fold. The six digits and their
//!   seconds are answered; the seed is not, and neither is logged. A
//!   [`reveal`] naming `otp_seed` is refused `SEED_NOT_SHOWN` before the
//!   session is consulted and before any receipt: the seed never leaves.
//! - **Idle ends a session** ([`crate::locker::SESSION_TIMEOUT_MS`], checked
//!   on every ask, never scheduled), and a relock zeroes the key.
//!
//! What this is NOT, said where it is enforced: a cryptographic binding of `K`
//! to the biometric (Q-1047-12, resolved 2026-09-28). `K` is derived from the
//! seed, the seed reaches this core from the shell's secure store at open, and
//! no OS keystore key stands between the biometric and either of them. The
//! presence gate is real — nothing in this process opens a Locker cell without
//! an unlock the shell reported — and it is an in-app gate above the OS lock
//! screen, not a second wall around the key. A keystore binding is meaningful
//! only once the seed itself is keystore-guarded, and it is not.

use std::sync::Mutex;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::commands::locker::{SEALED_ITEM_CELLS, SEALED_PLACEHOLDER};
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::custody::{LockerKeyError, decrypt_under_locker_key, encrypt_under_locker_key};
use centraid_vault::{Principal, Vault};

use super::session::REVEAL_WINDOW_MS;
use super::session::Session;
use crate::error::{CoreError, Result};

/// The commands whose sealed cells arrive as the member typed them and leave
/// as ciphertext under `K`: an item's five cells, and a custom field's value
/// (#1047 T2). `locker.set_passkey` is not here and never will be on the
/// phone: a passkey is storage only (L-passkey), no ceremony on the phone makes
/// one, and a plaintext `private_key` reaching the vault is refused there
/// (`passkey_is_sealed`) like every other plaintext secret.
pub const SEALING_COMMANDS: [&str; 3] = ["locker.add_item", "locker.edit_item", "locker.set_field"];

/// The session a handle holds: `None` until the first unlock.
pub type Cell = Mutex<Option<Session>>;

/// Answer one `LockerSessionRequest`.
///
/// # Errors
/// A vault that is not founded, a core opened without the seed (no `K` to
/// hold), or a receipt that could not be written — in which case nothing was
/// revealed.
pub fn answer(
    vault: &Vault,
    registry: &Registry,
    owner: &Principal,
    keys: Option<&crate::phone::Keyring>,
    cell: &Cell,
    request: &wire::LockerSessionRequest,
    changes: &crate::events::ChangeFeed,
) -> Result<wire::LockerSessionResponse> {
    use wire::locker_session_request::Step;
    let now = vault.clock().now_ms();
    match &request.step {
        None | Some(Step::State(_)) => Ok(state_of(cell, now)),
        Some(Step::Relock(_)) => {
            relock(cell);
            Ok(state_of(cell, now))
        }
        Some(Step::Unlock(_)) => unlock(vault, registry, owner, keys, cell, now, changes),
        Some(Step::Reveal(asked)) => reveal(vault, registry, owner, cell, now, asked, changes),
        Some(Step::Totp(asked)) => totp(vault, registry, owner, cell, now, asked, changes),
        Some(Step::Export(asked)) => {
            super::transfer::export(vault, registry, owner, cell, now, asked, changes)
        }
        Some(Step::ImportFile(asked)) => {
            super::transfer::import(vault, registry, owner, cell, now, asked, changes)
        }
    }
}

/// Zero the key. Idempotent.
pub fn relock(cell: &Cell) {
    if let Some(session) = lock_cell(cell).as_ref() {
        session.lock();
    }
}

pub(super) fn lock_cell(cell: &Cell) -> std::sync::MutexGuard<'_, Option<Session>> {
    // A poisoned lock still holds a session that must be lockable: recover the
    // guard rather than leave a key in memory behind a panic.
    cell.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(super) fn state_of(cell: &Cell, now_ms: i64) -> wire::LockerSessionResponse {
    let remaining = lock_cell(cell)
        .as_ref()
        .and_then(|session| match session.state(now_ms) {
            super::SessionState::Unlocked { remaining_ms } => Some(remaining_ms),
            super::SessionState::Locked => None,
        });
    wire::LockerSessionResponse {
        state: match remaining {
            Some(_) => wire::LockerSessionState::Unlocked,
            None => wire::LockerSessionState::Locked,
        } as i32,
        remaining_ms: remaining.and_then(|ms| u64::try_from(ms).ok()).unwrap_or(0),
        ..wire::LockerSessionResponse::default()
    }
}

fn generation_failure(error: &LockerKeyError) -> CoreError {
    CoreError::Invariant {
        context: format!("the Locker generation could not be named: {error}"),
    }
}

/// Run one registered command as the owner, and hand back its output.
pub(super) fn run(
    vault: &Vault,
    registry: &Registry,
    owner: &Principal,
    name: &str,
    input: serde_json::Value,
    changes: &crate::events::ChangeFeed,
) -> Result<serde_json::Value> {
    let outcome = vault.execute(registry, owner, &Command::new(name, input))?;
    changes.tables_changed(&outcome.tables);
    if outcome.status != CommandStatus::Executed {
        return Err(CoreError::Invariant {
            context: format!(
                "{name} did not execute: {}",
                outcome.reason.unwrap_or_default()
            ),
        });
    }
    Ok(outcome.output)
}

fn unlock(
    vault: &Vault,
    registry: &Registry,
    owner: &Principal,
    keys: Option<&crate::phone::Keyring>,
    cell: &Cell,
    now_ms: i64,
    changes: &crate::events::ChangeFeed,
) -> Result<wire::LockerSessionResponse> {
    let vault_id = vault.vault_id()?.ok_or_else(|| CoreError::InvalidRequest {
        detail: "this file is not a founded vault, so it has no Locker".to_owned(),
    })?;
    // `K` IS THE SEED'S (Q-1047-11). A core opened without it has nothing to
    // open a Locker with, and says so rather than minting a stand-in.
    let Some(keys) = keys else {
        return Err(CoreError::Unavailable {
            reason: "this core holds no vault keys, so it cannot open Locker; open it with a seed"
                .to_owned(),
        });
    };
    let key_id = vault
        .locker_generation()
        .map_err(|error| generation_failure(&error))?;
    // THE UNLOCK IS RECEIPTED, as `locker.auth` — it reveals no column and
    // names the vault, so the access history shows when this phone opened.
    let receipt = run(
        vault,
        registry,
        owner,
        "locker.reveal_receipt",
        serde_json::json!({
            "object_type": "locker.auth",
            "columns": ["session"],
            "kind": "auth",
        }),
        changes,
    )?;
    let mut held = lock_cell(cell);
    let session = held.get_or_insert_with(|| Session::locked(&vault_id));
    session.open(&key_id, keys.vault.locker.as_bytes().to_vec(), now_ms);
    drop(held);
    let mut answer = state_of(cell, now_ms);
    answer.receipt_id = receipt["receipt_id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    Ok(answer)
}

/// A copy of `K` held for one reveal, code or seal, **zeroed when it drops**
/// (#1047 L6).
///
/// The session zeroes its own bytes on lock (`Session::lock`); the copy a
/// caller works with was a plain `Vec` that went back to the allocator with
/// `K` still in it. The same `fill(0)` the session uses, on the copy.
pub(super) struct LiveKey(Vec<u8>);

impl std::ops::Deref for LiveKey {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for LiveKey {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

/// The key and its generation, if the session is open — and a touch, because
/// deliberate use is what keeps a session alive.
pub(super) fn open_key(cell: &Cell, now_ms: i64) -> Option<(String, LiveKey)> {
    let held = lock_cell(cell);
    let session = held.as_ref()?;
    let (key_id, key) = session.key(now_ms).ok()?;
    session.touch(now_ms);
    Some((key_id, LiveKey(key)))
}

fn reveal(
    vault: &Vault,
    registry: &Registry,
    owner: &Principal,
    cell: &Cell,
    now_ms: i64,
    asked: &wire::LockerReveal,
    changes: &crate::events::ChangeFeed,
) -> Result<wire::LockerSessionResponse> {
    let refused = |refusal: wire::LockerRevealRefusal| {
        let mut answer = state_of(cell, now_ms);
        answer.refusal = refusal as i32;
        answer
    };
    // THE SEED IS NEVER REVEALED (R-1047-D6). It is the second factor: a
    // phone that can show it can be read into another authenticator, and the
    // phone only ever needs the code [`totp`] makes. Refused first — before
    // the session is consulted (so the ask does not slide it) and before any
    // receipt — because no state of the vault makes the answer different.
    if asked.column == "otp_seed" {
        return Ok(refused(wire::LockerRevealRefusal::SeedNotShown));
    }
    // A PASSKEY'S KEY IS NEVER REVEALED (#1047 T2, L-passkey), for the same
    // reason and in the same place: a passkey is storage only, nothing on the
    // phone signs with it, and a key that can be shown can be copied out of
    // the one device that holds it.
    if asked.column == "private_key" {
        return Ok(refused(wire::LockerRevealRefusal::KeyNotShown));
    }
    // LOCKED IS A TYPED REFUSAL, NEVER A PROMPT: the shell shows its lock.
    let Some((live_id, live_key)) = open_key(cell, now_ms) else {
        return Ok(refused(wire::LockerRevealRefusal::Locked));
    };
    // A CUSTOM FIELD'S VALUE (#1047 T2) reveals through the item's own
    // door: the field must be a sealed field of a live item, its ciphertext
    // is bound to the FIELD's id, and the receipt names the item and the
    // field — never its label, never its value.
    let field = !asked.field_id.is_empty();
    let (sealed, bound_to) = if field {
        if asked.column != "value_sealed" {
            return Ok(refused(wire::LockerRevealRefusal::NotSealed));
        }
        (
            vault.locker_sealed_field_cell(&asked.item_id, &asked.field_id)?,
            asked.field_id.as_str(),
        )
    } else {
        (
            vault.locker_sealed_item_cell(&asked.item_id, &asked.column)?,
            asked.item_id.as_str(),
        )
    };
    let Some(sealed) = sealed else {
        return Ok(refused(wire::LockerRevealRefusal::NotSealed));
    };
    let Some(ciphertext) = sealed.ciphertext else {
        return Ok(refused(wire::LockerRevealRefusal::Empty));
    };
    // THE RECEIPT FIRST (D-1020-L3). A reveal that happened and was not
    // recorded is what the audit plane exists to make impossible, so a receipt
    // that did not land is an error here and no plaintext is produced.
    let mut receipt_input = serde_json::json!({
        "object_type": "locker.item",
        "item_id": asked.item_id,
        "columns": [asked.column],
        "kind": "reveal",
        "use": if asked.copy { "copy" } else { "show" },
    });
    if field {
        receipt_input["field_id"] = serde_json::Value::String(asked.field_id.clone());
    }
    let receipt = run(
        vault,
        registry,
        owner,
        "locker.reveal_receipt",
        receipt_input,
        changes,
    )?;
    // ONE `K` PER VAULT ON THE PHONE: the seed's leaf. A cell naming another
    // generation was sealed under a key this phone does not derive, and its
    // AAD makes that a clean `DID_NOT_OPEN`, never a wrong plaintext.
    let generation = sealed.key_id.unwrap_or(live_id);
    let opened = decrypt_under_locker_key(&live_key, &generation, bound_to, &ciphertext).ok();
    let Some(value) = opened else {
        return Ok(refused(wire::LockerRevealRefusal::DidNotOpen));
    };
    let mut answer = state_of(cell, now_ms);
    answer.revealed = Some(wire::LockerRevealed {
        item_id: asked.item_id.clone(),
        column: asked.column.clone(),
        field_id: asked.field_id.clone(),
        value,
        receipt_id: receipt["receipt_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        expires_in_ms: u64::try_from(REVEAL_WINDOW_MS).unwrap_or(30_000),
    });
    Ok(answer)
}

/// The HMAC, for the app-query tests' RFC comparison.
#[cfg(test)]
pub(crate) fn hmac_sha1_for_test(key: &[u8], message: &[u8]) -> Vec<u8> {
    hmac_sha1(key, message)
}

/// RFC 6238's HMAC: SHA-1 over the seed's bytes and the step's eight.
fn hmac_sha1(key: &[u8], message: &[u8]) -> Vec<u8> {
    use hmac::{Hmac, KeyInit as _, Mac as _};
    // HMAC takes a key of any length; the error arm is unreachable, and an
    // empty digest is what `totp::truncate` refuses rather than panicking.
    let Ok(mut mac) = Hmac::<sha1::Sha1>::new_from_slice(key) else {
        return Vec::new();
    };
    mac.update(message);
    mac.finalize().into_bytes().to_vec()
}

/// The code an item's seed makes at `now_ms`, receipted first.
///
/// The order is the reveal's (D-1020-L3): locked is a typed refusal; a seed
/// that is not there is `NOT_SEALED` or `EMPTY` before any receipt; then
/// `locker.totp_code` writes the receipt, and only then is the seed opened.
/// A receipt that did not land is an error and no code exists.
fn totp(
    vault: &Vault,
    registry: &Registry,
    owner: &Principal,
    cell: &Cell,
    now_ms: i64,
    asked: &wire::LockerTotpAsk,
    changes: &crate::events::ChangeFeed,
) -> Result<wire::LockerSessionResponse> {
    let item_id = asked.item_id.as_str();
    let refused = |refusal: wire::LockerRevealRefusal| {
        let mut answer = state_of(cell, now_ms);
        answer.refusal = refusal as i32;
        answer
    };
    let Some((live_id, live_key)) = open_key(cell, now_ms) else {
        return Ok(refused(wire::LockerRevealRefusal::Locked));
    };
    let Some(sealed) = vault.locker_sealed_item_cell(item_id, "otp_seed")? else {
        return Ok(refused(wire::LockerRevealRefusal::NotSealed));
    };
    let Some(ciphertext) = sealed.ciphertext else {
        return Ok(refused(wire::LockerRevealRefusal::Empty));
    };
    let receipt = run(
        vault,
        registry,
        owner,
        "locker.totp_code",
        serde_json::json!({ "item_id": item_id, "use": if asked.copy { "copy" } else { "show" } }),
        changes,
    )?;
    let generation = sealed.key_id.unwrap_or(live_id);
    let Ok(seed) = decrypt_under_locker_key(&live_key, &generation, item_id, &ciphertext) else {
        return Ok(refused(wire::LockerRevealRefusal::DidNotOpen));
    };
    let Some(code) = centraid_apps_locker::totp::code_at(&seed, now_ms, hmac_sha1) else {
        return Ok(refused(wire::LockerRevealRefusal::NotASeed));
    };
    let mut answer = state_of(cell, now_ms);
    answer.totp = Some(wire::LockerTotp {
        item_id: item_id.to_owned(),
        code: code.code,
        period_seconds: u32::try_from(code.period).unwrap_or(30),
        remaining_seconds: u32::try_from(code.remaining).unwrap_or(30),
        receipt_id: receipt["receipt_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    });
    Ok(answer)
}

/// SEAL WHAT THE MEMBER TYPED, BEFORE THE VAULT SEES IT.
///
/// `locker.add_item` and `locker.edit_item` refuse a plaintext secret
/// (`assert_sealed_cell`): the command plane holds no `K`, and the core does.
/// So every sealed item cell carrying a value — anything but empty and the round-tripped
/// placeholder, INCLUDING a value that happens to look like `lk1:` ciphertext,
/// because a shell never holds `K` and so never sends ciphertext — is sealed
/// here under the live generation against the item's own id, and `key_id` is
/// stated. On an edit that carries a password, `password_rotated` is computed
/// here by opening the stored one, because only the holder of `K` can tell a
/// changed password from a re-typed one (D-1020-L10b); a shell's own claim is
/// replaced.
///
/// A one-time-code seed is read once, here, through
/// `centraid_apps_locker::totp::seed_of` — a bare key in any spelling or an
/// `otpauth://totp/` link — and sealed as upper-case base32; an entry that is
/// not one is refused with the member's sentence before anything is sealed.
///
/// A write that carries no secret passes untouched and needs no session: a
/// retitle, a retag or a round-tripped placeholder is metadata, and the
/// command plane already says so (`carries_secret`).
///
/// # Errors
/// `InvalidRequest` when the input carries a secret and the session is not
/// open, or names no `item_id` to bind the ciphertext to.
pub fn seal_command(
    vault: &Vault,
    cell: &Cell,
    command: &wire::Command,
) -> Result<Option<Vec<u8>>> {
    if !SEALING_COMMANDS.contains(&command.name.as_str()) || command.input.is_empty() {
        return Ok(None);
    }
    let mut input: serde_json::Value =
        serde_json::from_slice(&command.input).map_err(|error| CoreError::InvalidRequest {
            detail: format!("a command's input is canonical JSON in bytes: {error}"),
        })?;
    if !input.is_object() {
        return Ok(None);
    }
    let plaintext = |value: &serde_json::Value| {
        value
            .as_str()
            .filter(|text| !text.is_empty() && *text != SEALED_PLACEHOLDER)
            .map(str::to_owned)
    };
    if command.name == "locker.set_field" {
        return seal_field(vault, cell, input, plaintext);
    }
    let mut carried: Vec<(&str, String)> = SEALED_ITEM_CELLS
        .iter()
        .filter_map(|column| plaintext(&input[*column]).map(|value| (*column, value)))
        .collect();
    for (column, value) in &mut carried {
        if *column == "otp_seed" {
            *value = centraid_apps_locker::totp::seed_of(value).map_err(|refusal| {
                CoreError::InvalidRequest {
                    detail: refusal.sentence().to_owned(),
                }
            })?;
        }
    }
    if carried.is_empty() {
        return Ok(None);
    }
    let now = vault.clock().now_ms();
    let Some((key_id, key)) = open_key(cell, now) else {
        return Err(CoreError::InvalidRequest {
            detail: "Locker is locked; a secret is sealed only while it is open".to_owned(),
        });
    };
    let item_id = input["item_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| CoreError::InvalidRequest {
            detail: "a Locker secret is sealed against its item's id, and none was named"
                .to_owned(),
        })?;
    // A NEW ITEM'S PASSWORD IS A CHANGE by definition; an edit's is one only
    // if it differs from what is stored.
    if command.name == "locker.add_item" && carried.iter().any(|(column, _)| *column == "password")
    {
        input["password_rotated"] = serde_json::Value::Bool(true);
    }
    if command.name == "locker.edit_item"
        && let Some((_, typed)) = carried.iter().find(|(column, _)| *column == "password")
    {
        let stored = vault
            .locker_sealed_item_cell(&item_id, "password")?
            .and_then(|cell| {
                let generation = cell.key_id.unwrap_or_else(|| key_id.clone());
                let ciphertext = cell.ciphertext?;
                (generation == key_id)
                    .then(|| decrypt_under_locker_key(&key, &key_id, &item_id, &ciphertext).ok())
                    .flatten()
            });
        input["password_rotated"] = serde_json::Value::Bool(stored.as_deref() != Some(typed));
    }
    for (column, value) in carried {
        let sealed =
            encrypt_under_locker_key(&key, &key_id, &item_id, &value).map_err(|error| {
                CoreError::Invariant {
                    context: format!("a Locker cell would not seal: {error}"),
                }
            })?;
        input[column] = serde_json::Value::String(sealed);
    }
    input["key_id"] = serde_json::Value::String(key_id);
    serde_json::to_vec(&input)
        .map(Some)
        .map_err(|error| CoreError::Invariant {
            context: format!("a sealed input is not JSON: {error}"),
        })
}

/// A CUSTOM SEALED FIELD'S VALUE, SEALED AGAINST THE FIELD'S OWN ID (#1047
/// T2). A plain field passes untouched; a sealed one carrying what the
/// member typed needs the open session and the id the shell minted for it
/// (D-1020-L9), because the ciphertext's additional data is that id.
fn seal_field(
    vault: &Vault,
    cell: &Cell,
    mut input: serde_json::Value,
    plaintext: impl Fn(&serde_json::Value) -> Option<String>,
) -> Result<Option<Vec<u8>>> {
    if input["kind"].as_str() != Some("sealed") {
        return Ok(None);
    }
    let Some(value) = plaintext(&input["value"]) else {
        return Ok(None);
    };
    let Some((key_id, key)) = open_key(cell, vault.clock().now_ms()) else {
        return Err(CoreError::InvalidRequest {
            detail: "Locker is locked; a secret is sealed only while it is open".to_owned(),
        });
    };
    let field_id = input["field_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| CoreError::InvalidRequest {
            detail: "a sealed field is sealed against its own id, and none was named".to_owned(),
        })?;
    let sealed = encrypt_under_locker_key(&key, &key_id, &field_id, &value).map_err(|error| {
        CoreError::Invariant {
            context: format!("a Locker field would not seal: {error}"),
        }
    })?;
    input["value"] = serde_json::Value::String(sealed);
    input["key_id"] = serde_json::Value::String(key_id);
    serde_json::to_vec(&input)
        .map(Some)
        .map_err(|error| CoreError::Invariant {
            context: format!("a sealed input is not JSON: {error}"),
        })
}

#[cfg(test)]
mod tests {
    use super::hmac_sha1;
    use centraid_apps_locker::totp;

    /// RFC 6238 APPENDIX B, SHA-1, AGAINST THE WHOLE CHAIN: the published
    /// seed (`12345678901234567890` as ASCII, base32
    /// `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`) through `seed_of`, the counter,
    /// this module's HMAC-SHA-1 and the truncation. The RFC prints eight
    /// digits; a six-digit code is the same number modulo 10^6, which is what
    /// every authenticator shows.
    #[test]
    fn rfc_6238_appendix_b_sha1_vectors() {
        let seed = totp::seed_of("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").expect("the RFC's seed");
        assert_eq!(
            totp::base32_decode(&seed).as_deref(),
            Some(&b"12345678901234567890"[..])
        );
        for (seconds, eight_digits) in [
            (59_i64, "94287082"),
            (1_111_111_109, "07081804"),
            (1_111_111_111, "14050471"),
            (1_234_567_890, "89005924"),
            (2_000_000_000, "69279037"),
            (20_000_000_000, "65353130"),
        ] {
            let code = totp::code_at(&seed, seconds * 1_000, hmac_sha1).expect("a code");
            assert_eq!(code.code, eight_digits[2..], "T = {seconds}");
            assert_eq!(code.period, 30);
        }
    }

    /// RFC 2202's first HMAC-SHA-1 case, so the primitive is proven apart
    /// from the TOTP fold that uses it.
    #[test]
    fn rfc_2202_hmac_sha1_case_one() {
        let digest = hmac_sha1(&[0x0b; 20], b"Hi There");
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(hex, "b617318655057264e28bc0b6fb378c8ef146be00");
    }
}
