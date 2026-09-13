//! THE SEAT'S LOCKER PLANE: the unlock boundary, wired to the socket
//! (#1020 wave 4 lane extension, D-1020-X6; D-1020-L3, D-1020-L8).
//!
//! `crates/seat::locker` is the boundary — the passphrase wrap, the five-minute
//! session, the thirty-second reveal window, the origin match over the row's
//! own policy. What it has no opinion about is **where the wrapped blob lives**
//! and **who is allowed to ask**, and those are this file's two jobs, because
//! both are facts about a process on this machine rather than about crypto.
//!
//! ## Where the wrapped blob lives, and what is NOT beside it
//!
//! `<seat data dir>/locker/wrapped-key.json`, mode 0600, holding exactly one
//! [`WrappedKey`] — *the wrapped blob is all that is ever at rest*
//! (`packages/client/src/locker/locker-unlock.ts:13`–`:20`). The raw `K` is in
//! the seat's member-key custody (`centraid_vault::custody::member_key`) and
//! the two are deliberately different things: custody is what a recovery kit
//! restores, this is what a passphrase opens. Enrolment reads the first and
//! writes the second; **it never deletes the first**, because a member who
//! forgets a passphrase must still be able to re-enrol from the kit rather than
//! lose the vault's Locker.
//!
//! ## Who is allowed to ask
//!
//! | Message | Renderer | `native-host` | Why |
//! |---|---|---|---|
//! | `locker_enrol` | yes | **no** | it takes a passphrase |
//! | `locker_unlock` | yes | **no** | *a door that can raise the passphrase prompt is a door that can be used to phish it* — and the browser is the caller that would be phishing |
//! | `locker_lock` | yes | yes | locking is never an escalation, and a Companion that noticed a wrong-site page should be able to shut the session |
//! | `reveal_for_fill` | yes | yes | this is the fill, and the extension is its whole reason for existing |
//!
//! The refusal for the browser asking to unlock is [`RefusalCode::NotPermitted`],
//! the same code a child asking to mint a capability gets, because it is the
//! same mistake: a client asking for a power its kind does not have.
//!
//! ## The cell read is the sidecar's own, and the column is never caller text
//!
//! A fill needs the **ciphertext** of one sealed cell, and the Companion's
//! candidate projection deliberately excludes those columns (census §A8: *a
//! sealed cell never rides the payload*). So the read here is the sidecar's
//! own, in the shape `catalogue::content_by_digest` established — not in the
//! catalogue and not reachable by name from the socket. The column is resolved
//! against `centraid_seat::locker::unlock::SEALED_CELLS` and a name that is not
//! in it never reaches a query, so the one caller-supplied string that would
//! otherwise be spliced into `select` cannot be.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};
use centraid_seat::locker::unlock::{RevealRefusal, SEALED_CELLS};
use centraid_seat::locker::{
    FillRequest, Session, SessionState, WrappedKey, fill_grant, unwrap_member_key, wrap_member_key,
};

use super::catalogue::to_wire;

/// The file the wrapped key is at rest in, under the seat's data directory.
pub const WRAPPED_KEY_FILE: &str = "locker/wrapped-key.json";

/// Everything one seat process holds about Locker.
///
/// `Mutex<Session>` and not `Session` alone: [`Session`] is interior-mutable by
/// design (its clock is re-checked on every call) but replacing it on enrolment
/// is a whole-value swap, and a swap under concurrent reveals is the one race
/// that would hand a caller a key from a session it never unlocked.
pub struct LockerPlane {
    session: Mutex<Session>,
    data_dir: PathBuf,
    vault_id: String,
}

/// WHY A FILL OR AN UNLOCK DID NOT HAPPEN, as a code the local channel carries.
///
/// Distinct codes rather than one `refused`, for the reason
/// [`super::local::RefusalCode`] is: the caller's next action differs for each.
/// "Set a passphrase" and "type your passphrase" are different screens, and
/// "this page does not match this login" is not an error at all — it is the
/// policy working, and the Companion renders it as such.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockerCode {
    /// No wrapped key at rest: the shell offers enrolment.
    NotEnrolled,
    /// A wrapped key exists and the session is closed.
    Locked,
    /// The passphrase did not open the blob, or is shorter than the minimum.
    Passphrase,
    /// The reveal window closed.
    Expired,
    /// The row, the cell or the live key is not there.
    Missing,
    /// The page's origin does not match the login's stored policy.
    OriginMismatch,
    /// A cell that is never filled into a page (an OTP seed).
    NotFillable,
    /// The seat could not read or write its own custody.
    Custody,
}

impl LockerCode {
    /// The code as it appears in a `SeatMessage::Error`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotEnrolled => "locker-not-enrolled",
            Self::Locked => "locker-locked",
            Self::Passphrase => "locker-passphrase",
            Self::Expired => "locker-expired",
            Self::Missing => "locker-missing",
            Self::OriginMismatch => "locker-origin-mismatch",
            Self::NotFillable => "locker-not-fillable",
            Self::Custody => "locker-custody",
        }
    }
}

/// A refusal with the sentence the member reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockerRefusal {
    pub code: LockerCode,
    pub message: String,
}

impl LockerRefusal {
    fn of(code: LockerCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// A reveal refusal, lowered to a code and a sentence.
///
/// `RevealRefusal::Locked` becomes `locker-locked` and **not** a prompt: the
/// shell renders the Lock surface, this channel only reports.
fn from_reveal(refusal: &RevealRefusal) -> LockerRefusal {
    match refusal {
        RevealRefusal::Locked => LockerRefusal::of(
            LockerCode::Locked,
            "Locker is locked — unlock it in Centraid.",
        ),
        RevealRefusal::Expired => {
            LockerRefusal::of(LockerCode::Expired, "That reveal expired — ask again.")
        }
        other => LockerRefusal::of(LockerCode::Missing, other.to_string()),
    }
}

impl LockerPlane {
    /// Open the plane over a seat's data directory, reading nothing yet.
    ///
    /// Nothing is read here on purpose: a seat that failed to start because a
    /// Locker blob was unreadable would be a seat that cannot serve Tally
    /// either, and Locker is one app.
    #[must_use]
    pub fn new(data_dir: &Path, vault_id: &str) -> Self {
        let wrapped = read_wrapped(data_dir);
        let session = match &wrapped {
            Some(_) => Session::locked(vault_id),
            None => Session::not_enrolled(vault_id),
        };
        Self {
            session: Mutex::new(session),
            data_dir: data_dir.to_owned(),
            vault_id: vault_id.to_owned(),
        }
    }

    /// What a surface renders. Never the key, never the passphrase.
    pub fn state(&self, now_ms: i64) -> SessionState {
        self.session
            .lock()
            .map_or(SessionState::Locked, |session| session.state(now_ms))
    }

    /// Whether the session is open right now. Re-checks the clock, as
    /// [`Session::key`] does — a cached answer is a session that does not
    /// expire.
    pub fn unlocked(&self, now_ms: i64) -> bool {
        self.session
            .lock()
            .is_ok_and(|session| session.unlocked(now_ms))
    }

    /// Close the session now.
    pub fn lock(&self) {
        if let Ok(session) = self.session.lock() {
            session.lock();
        }
    }

    /// Wrap the seat's `K` under a member passphrase and store the blob.
    ///
    /// Refuses to overwrite an existing blob: re-enrolling would silently
    /// invalidate the passphrase the member already has, and "change my
    /// passphrase" is a different gesture that has to prove the old one.
    pub fn enrol(&self, passphrase: &str, key_id: &str) -> Result<(), LockerRefusal> {
        let path = self.data_dir.join(WRAPPED_KEY_FILE);
        if path.exists() {
            return Err(LockerRefusal::of(
                LockerCode::Passphrase,
                "this seat already has a Locker passphrase; changing it is a separate gesture",
            ));
        }
        let custody = centraid_vault::custody::member_key::MemberKeyCustody::on_seat(
            &self.data_dir,
            self.vault_id.clone(),
        );
        let key = custody.load(key_id).map_err(|error| {
            LockerRefusal::of(
                LockerCode::Custody,
                format!("this seat holds no member key to wrap: {error}"),
            )
        })?;
        let wrapped = wrap_member_key(passphrase, &self.vault_id, key_id, &key)
            .map_err(|error| LockerRefusal::of(LockerCode::Passphrase, error.to_string()))?;
        write_wrapped(&path, &wrapped).map_err(|error| {
            LockerRefusal::of(
                LockerCode::Custody,
                format!("writing the wrapped key: {error}"),
            )
        })?;
        // ENROLLING IS NOT UNLOCKING. The session becomes `Locked` rather than
        // open: the member has a passphrase now and has not yet typed it, and a
        // seat that unlocked itself as a side effect of enrolment would have
        // made the passphrase decorative for the first five minutes.
        let mut session = self.session.lock().map_err(|_| {
            LockerRefusal::of(LockerCode::Custody, "the Locker session is poisoned")
        })?;
        *session = Session::locked(&self.vault_id);
        Ok(())
    }

    /// Open the session from the wrapped blob.
    pub fn unlock(&self, passphrase: &str, now_ms: i64) -> Result<(), LockerRefusal> {
        let wrapped = read_wrapped(&self.data_dir).ok_or_else(|| {
            LockerRefusal::of(
                LockerCode::NotEnrolled,
                "set a Locker passphrase on this device first",
            )
        })?;
        let key = unwrap_member_key(passphrase, &wrapped).map_err(|error| {
            // ONE SENTENCE FOR EVERY WRONG PASSPHRASE. A distinguishable
            // "wrong passphrase" and "corrupt blob" would be a guessing oracle,
            // and the AEAD tag cannot tell them apart anyway.
            LockerRefusal::of(LockerCode::Passphrase, error.to_string())
        })?;
        let session = self.session.lock().map_err(|_| {
            LockerRefusal::of(LockerCode::Custody, "the Locker session is poisoned")
        })?;
        session.open(&wrapped.key_id, key, now_ms);
        Ok(())
    }

    /// Perform one fill, answering the value with its receipt and its life.
    ///
    /// `cells` and `receipts` are the two effects the seat cannot do itself —
    /// reading the sealed cell out of its own replica, and asking the gateway to
    /// receipt the fill — and they arrive as closures so this function holds no
    /// socket and no vault handle.
    pub fn fill(
        &self,
        request: &FillRequest,
        row: &FillRow,
        now_ms: i64,
        receipt: &dyn Fn(&str, &str) -> Result<String, String>,
    ) -> Result<FillAnswer, LockerRefusal> {
        let session = self.session.lock().map_err(|_| {
            LockerRefusal::of(LockerCode::Custody, "the Locker session is poisoned")
        })?;
        let cells = OneCell {
            ciphertext: row.ciphertext.clone(),
            key_id: row.key_id.clone(),
        };
        let receipts = Receipting { write: receipt };
        let unlock = centraid_seat::locker::Unlock {
            session: &session,
            cells: &cells,
            receipts: &receipts,
        };
        let grant = fill_grant(
            &unlock,
            request,
            row.url.as_deref(),
            &row.url_match_policy,
            now_ms,
        )
        .map_err(lower_fill)?;
        let value = grant
            .value(now_ms)
            .map_err(|refusal| from_reveal(&refusal))?;
        Ok(FillAnswer {
            value: value.to_owned(),
            receipt_id: grant.receipt_id().to_owned(),
            expires_at_ms: grant.expires_at_ms(),
            origin: grant.origin.clone(),
        })
    }
}

/// Lower a fill refusal to a code and a member sentence.
fn lower_fill(refusal: centraid_seat::locker::fill::FillRefusal) -> LockerRefusal {
    use centraid_seat::locker::fill::FillRefusal as F;
    match refusal {
        F::Reveal(inner) => from_reveal(&inner),
        F::OriginMismatch => LockerRefusal::of(
            LockerCode::OriginMismatch,
            // NOT AN ERROR. The policy working, and the one refusal a member
            // must never be invited to override.
            "this page is not the site this login is for",
        ),
        F::NotFillable { .. } => LockerRefusal::of(
            LockerCode::NotFillable,
            "that value is never filled into a page",
        ),
        other => LockerRefusal::of(LockerCode::Missing, other.to_string()),
    }
}

/// The one row a fill reads: its sealed cell, its key generation and its policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FillRow {
    pub ciphertext: String,
    pub key_id: Option<String>,
    pub url: Option<String>,
    pub url_match_policy: String,
}

impl FillRow {
    /// Whether this login's **own stored policy** admits a page origin.
    ///
    /// The row decides, never the caller: a login with no stored url admits
    /// nothing at all, which is the closed direction and the one v0's
    /// `NoStoredOrigin` refusal already takes.
    #[must_use]
    pub fn matches(&self, origin: &str) -> bool {
        self.url
            .as_deref()
            .filter(|url| !url.is_empty())
            .is_some_and(|url| {
                centraid_apps_locker::matches_origin(
                    &centraid_apps_locker::origin::OriginCandidate::new(
                        url,
                        centraid_apps_locker::MatchPolicy::of(Some(&self.url_match_policy)),
                    ),
                    origin,
                )
            })
    }
}

/// What a fill answers. **Not `Debug`**: the value is a password.
pub struct FillAnswer {
    pub value: String,
    pub receipt_id: String,
    pub expires_at_ms: i64,
    pub origin: String,
}

struct OneCell {
    ciphertext: String,
    key_id: Option<String>,
}

impl centraid_seat::locker::unlock::SealedCells for OneCell {
    fn cell(
        &self,
        _target: &centraid_seat::locker::RevealTarget,
    ) -> Result<Option<(String, Option<String>)>, RevealRefusal> {
        Ok(Some((self.ciphertext.clone(), self.key_id.clone())))
    }
}

struct Receipting<'a> {
    write: &'a dyn Fn(&str, &str) -> Result<String, String>,
}

impl centraid_seat::locker::unlock::Receipts for Receipting<'_> {
    fn reveal(
        &self,
        target: &centraid_seat::locker::RevealTarget,
        kind: &str,
        origin: Option<&str>,
    ) -> Result<String, String> {
        // THE RECEIPT LANDS BEFORE THE PLAINTEXT EXISTS (D-1020-L3): the
        // closure writes it and the value is only produced if it returned an id.
        let _ = origin;
        (self.write)(&target.entity_id, kind)
    }
}

/// The sidecar's own read of one sealed cell.
///
/// `column` MUST come from [`SEALED_CELLS`] — [`sealed_column`] is the only way
/// to obtain one — because it lands in the query's `select` as text.
#[must_use]
pub fn cell_query(item_id: &str, column: SealedColumn) -> wire::PageQuery {
    to_wire(
        &PageQuery::new(
            "seat.locker.sealedCell",
            &format!("item_id, {}, key_id, url, url_match_policy", column.0),
            "locker_item",
            PageOrder::asc("item_id", "item_id"),
        )
        .filter(
            "item_id = ? AND deleted_at IS NULL",
            vec![PageBindValue::from(item_id)],
        ),
    )
}

/// A column name that is in the sealed registry. The only constructor is
/// [`sealed_column`], so an arbitrary string cannot become one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SealedColumn(&'static str);

impl SealedColumn {
    #[must_use]
    pub const fn name(self) -> &'static str {
        self.0
    }
}

/// Resolve a caller's column name against `locker_item`'s sealed registry.
///
/// `None` for anything else, including a column that exists on the table but is
/// not sealed — `title` is plaintext and revealing it is not a reveal.
#[must_use]
pub fn sealed_column(entity: &str, column: &str) -> Option<SealedColumn> {
    SEALED_CELLS
        .iter()
        .find(|(known, _)| *known == entity)
        .and_then(|(_, columns)| columns.iter().find(|known| **known == column))
        .map(|known| SealedColumn(known))
}

/// The vault's own id, as the sidecar's own read.
///
/// The seat needs it because the passphrase wrap's AAD is `vaultId‖keyId`
/// (D-1020-L4) — a blob wrapped under the wrong vault id is a blob that opens
/// for nothing, which is the point.
#[must_use]
pub fn vault_query() -> wire::PageQuery {
    to_wire(&PageQuery::new(
        "seat.locker.vault",
        "vault_id",
        "core_vault",
        PageOrder::asc("vault_id", "vault_id"),
    ))
}

/// The live key generation this vault names, as the sidecar's own read.
#[must_use]
pub fn live_key_query() -> wire::PageQuery {
    to_wire(
        &PageQuery::new(
            "seat.locker.liveKey",
            "key_id, created_at",
            "locker_key",
            PageOrder::asc("key_id", "key_id"),
        )
        .filter("retired_at IS NULL", Vec::<PageBindValue>::new()),
    )
}

fn read_wrapped(data_dir: &Path) -> Option<WrappedKey> {
    let text = std::fs::read_to_string(data_dir.join(WRAPPED_KEY_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_wrapped(path: &Path, wrapped: &WrappedKey) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(wrapped)?;
    std::fs::write(path, format!("{text}\n"))?;
    // 0600, for the same reason the socket is: the blob is useless without the
    // passphrase and there is still no reason for another account to hold a
    // copy to grind against.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seat_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("a temp dir")
    }

    /// Plant a member key in the seat's custody the way founding would.
    fn plant(dir: &Path, vault_id: &str, key_id: &str) -> Vec<u8> {
        let custody = centraid_vault::custody::member_key::MemberKeyCustody::on_seat(
            dir,
            vault_id.to_owned(),
        );
        custody.mint(key_id).expect("minted")
    }

    /// A cell sealed under the planted key, as the replica would hold it.
    fn sealed(key: &[u8], key_id: &str, item_id: &str, value: &str) -> String {
        centraid_vault::custody::locker_key::encrypt_under_locker_key(key, key_id, item_id, value)
            .expect("sealed")
    }

    fn row(ciphertext: String, key_id: &str) -> FillRow {
        FillRow {
            ciphertext,
            key_id: Some(key_id.to_owned()),
            url: Some("https://login.bank.example".to_owned()),
            url_match_policy: "registrable-domain".to_owned(),
        }
    }

    fn request(origin: &str) -> FillRequest {
        FillRequest {
            item_id: "item-1".to_owned(),
            page_origin: origin.to_owned(),
            column: "password".to_owned(),
        }
    }

    /// THE WHOLE PATH ON THIS SIDE: enrol, unlock, fill — and the value only
    /// exists because a receipt was written first.
    #[test]
    fn a_member_enrols_unlocks_and_the_fill_carries_a_receipt() {
        let dir = seat_dir();
        let key = plant(dir.path(), "vault-1", "key-1");
        let plane = LockerPlane::new(dir.path(), "vault-1");
        assert_eq!(plane.state(0), SessionState::NotEnrolled);
        plane
            .enrol("a-long-enough-passphrase", "key-1")
            .expect("enrolled");
        // The blob is at rest and the session is still closed: enrolling is not
        // unlocking.
        assert_eq!(
            LockerPlane::new(dir.path(), "vault-1").state(0),
            SessionState::Locked
        );
        plane
            .unlock("a-long-enough-passphrase", 0)
            .expect("unlocked");
        assert!(
            matches!(plane.state(0), SessionState::Unlocked { .. }),
            "the session is open after a correct passphrase"
        );

        let written = std::cell::RefCell::new(Vec::new());
        let answer = plane
            .fill(
                &request("https://www.bank.example"),
                &row(sealed(&key, "key-1", "item-1", "hunter2-and-more"), "key-1"),
                0,
                &|item, kind| {
                    written
                        .borrow_mut()
                        .push((item.to_owned(), kind.to_owned()));
                    Ok("receipt-7".to_owned())
                },
            )
            .expect("filled");
        assert_eq!(answer.value, "hunter2-and-more");
        assert_eq!(answer.receipt_id, "receipt-7");
        assert_eq!(answer.origin, "https://www.bank.example");
        assert_eq!(
            answer.expires_at_ms,
            centraid_seat::locker::REVEAL_WINDOW_MS
        );
        assert_eq!(
            written.into_inner(),
            vec![("item-1".to_owned(), "fill".to_owned())]
        );
    }

    /// A WRONG PASSPHRASE SAYS ONE THING, and the session stays closed.
    #[test]
    fn a_wrong_passphrase_does_not_open_the_session() {
        let dir = seat_dir();
        plant(dir.path(), "vault-1", "key-1");
        let plane = LockerPlane::new(dir.path(), "vault-1");
        plane
            .enrol("a-long-enough-passphrase", "key-1")
            .expect("enrolled");
        let refusal = plane
            .unlock("a-long-enough-passphras", 0)
            .expect_err("refused");
        assert_eq!(refusal.code, LockerCode::Passphrase);
        assert_eq!(plane.state(0), SessionState::Locked);
    }

    /// RE-ENROLMENT IS REFUSED, so a second passphrase cannot silently retire
    /// the one the member has.
    #[test]
    fn a_second_enrolment_is_refused_rather_than_overwriting() {
        let dir = seat_dir();
        plant(dir.path(), "vault-1", "key-1");
        let plane = LockerPlane::new(dir.path(), "vault-1");
        plane
            .enrol("a-long-enough-passphrase", "key-1")
            .expect("enrolled");
        assert_eq!(
            plane
                .enrol("another-long-passphrase", "key-1")
                .expect_err("refused")
                .code,
            LockerCode::Passphrase
        );
        // And the first passphrase still opens it.
        plane
            .unlock("a-long-enough-passphrase", 0)
            .expect("unlocked");
    }

    /// A LOCKED SEAT REFUSES A FILL AND WRITES NO RECEIPT.
    #[test]
    fn a_locked_seat_refuses_a_fill_and_receipts_nothing() {
        let dir = seat_dir();
        let key = plant(dir.path(), "vault-1", "key-1");
        let plane = LockerPlane::new(dir.path(), "vault-1");
        plane
            .enrol("a-long-enough-passphrase", "key-1")
            .expect("enrolled");
        let asked = std::cell::Cell::new(false);
        let refusal = plane
            .fill(
                &request("https://www.bank.example"),
                &row(sealed(&key, "key-1", "item-1", "hunter2-and-more"), "key-1"),
                0,
                &|_, _| {
                    asked.set(true);
                    Ok("receipt-1".to_owned())
                },
            )
            .map(|_| ())
            .expect_err("refused");
        assert_eq!(refusal.code, LockerCode::Locked);
        assert!(!asked.get(), "a refused fill must not write a receipt");
    }

    /// THE ORIGIN IS THE ROW'S. A forged page origin is refused by the vault's
    /// own data, and the refusal is the policy working.
    #[test]
    fn a_forged_page_origin_is_refused_over_the_rows_policy() {
        let dir = seat_dir();
        let key = plant(dir.path(), "vault-1", "key-1");
        let plane = LockerPlane::new(dir.path(), "vault-1");
        plane
            .enrol("a-long-enough-passphrase", "key-1")
            .expect("enrolled");
        plane
            .unlock("a-long-enough-passphrase", 0)
            .expect("unlocked");
        let refusal = plane
            .fill(
                &request("https://bank.example.attacker.test"),
                &row(sealed(&key, "key-1", "item-1", "hunter2-and-more"), "key-1"),
                0,
                &|_, _| Ok("receipt-1".to_owned()),
            )
            .map(|_| ())
            .expect_err("refused");
        assert_eq!(refusal.code, LockerCode::OriginMismatch);
    }

    /// THE COLUMN CANNOT BE CALLER TEXT. Only the sealed registry's own names
    /// resolve, so nothing else can reach a `select`.
    #[test]
    fn only_a_sealed_column_name_resolves() {
        assert_eq!(
            sealed_column("locker.item", "password").map(SealedColumn::name),
            Some("password")
        );
        assert_eq!(
            sealed_column("locker.item_field", "value_sealed").map(SealedColumn::name),
            Some("value_sealed")
        );
        for bad in [
            "title",
            "password, title",
            "password) --",
            "*",
            "",
            "PASSWORD",
        ] {
            assert!(
                sealed_column("locker.item", bad).is_none(),
                "{bad:?} must not resolve to a column"
            );
        }
        // A sealed column of ANOTHER entity does not resolve for this one.
        assert!(sealed_column("locker.item", "value_sealed").is_none());
    }

    /// The sidecar's cell read projects plain columns and binds the id.
    #[test]
    fn the_cell_read_binds_the_id_and_projects_plain_columns() {
        let column = sealed_column("locker.item", "password").expect("sealed");
        let query = cell_query("item-1", column);
        assert_eq!(
            query.select,
            ["item_id", "password", "key_id", "url", "url_match_policy"]
        );
        assert_eq!(query.from, "locker_item");
        assert_eq!(
            query.r#where.as_deref(),
            Some("item_id = ? AND deleted_at IS NULL")
        );
        assert_eq!(query.bind.len(), 1);
        let live = live_key_query();
        assert_eq!(live.from, "locker_key");
        assert_eq!(live.r#where.as_deref(), Some("retired_at IS NULL"));
        assert!(live.bind.is_empty(), "the live key read takes no bind");
    }

    /// THE BLOB IS 0600 AND THE RAW KEY IS STILL IN CUSTODY — a forgotten
    /// passphrase is re-enrolable from the kit rather than terminal.
    #[test]
    fn the_blob_is_private_and_enrolment_keeps_custody() {
        let dir = seat_dir();
        plant(dir.path(), "vault-1", "key-1");
        let plane = LockerPlane::new(dir.path(), "vault-1");
        plane
            .enrol("a-long-enough-passphrase", "key-1")
            .expect("enrolled");
        let path = dir.path().join(WRAPPED_KEY_FILE);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).expect("stat").permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "the wrapped key is 0600");
        }
        let text = std::fs::read_to_string(&path).expect("read");
        let wrapped: WrappedKey = serde_json::from_str(&text).expect("parsed");
        assert_eq!(wrapped.key_id, "key-1");
        assert_eq!(wrapped.iterations, centraid_seat::locker::WRAP_ITERATIONS);
        let custody = centraid_vault::custody::member_key::MemberKeyCustody::on_seat(
            dir.path(),
            "vault-1".to_owned(),
        );
        assert!(
            custody.load("key-1").is_ok(),
            "enrolment must not remove the key the recovery kit restores"
        );
    }
}
