//! THE SEAT-MEDIATED FILL — enabled here, built in slot 4c (D-1020-L8).
//!
//! v0's `locker:fill` was the extension asking the **gateway** to unseal a
//! password. `queries/autofill-item.ts` already refuses, and its comment is
//! the honest statement of the gap: *filling has to be served by a host that
//! already holds `K` behind the member's unlock — the desktop shell — and
//! wiring that is a product decision, not a mechanical deletion.*
//!
//! This is that decision, made. The chain, end to end:
//!
//! | Where | What it does |
//! |---|---|
//! | the page | a member's explicit gesture, one field, one origin (`credential-gesture.ts`) |
//! | the extension | `locker:fill {row, origin}` over native messaging. **Not a seat**: no vault, no `K`, no ability to unwrap (census §E seam 5) |
//! | the native host | a local client of the seat, under the same peer-credential check as any other (issue `:122`) |
//! | **the seat** | matches the origin against the row's own stored policy, unwraps `K` behind the member's unlock, asks the gateway to receipt the fill, and answers a value with a 30-second life |
//! | the gateway | writes the `access.receipt` row with `kind: "fill"` and the origin — and never sees the password |
//!
//! ## Two things this module refuses to make easier
//!
//! **The extension never becomes a seat.** Its ceiling is *ask the seat to
//! reveal, receive a value with a 30-second life* — which is exactly
//! [`FillGrant`]'s shape, and why the value is not `Clone`.
//!
//! **The origin is matched against the row, not against the caller's word for
//! it.** `crates/apps/locker::origin` decides, over
//! `locker_item.url_match_policy` as stored, so a modified client that forges
//! `page_origin` is refused by the vault's own data. That is v0's
//! defence-in-depth intent — *reveal refuses wrong-site fills even if a
//! modified client forges page_origin* — with the refusal now on the side that
//! holds the key.
//!
//! ## `clearFillMaterial` is the extension's, and it is still owed
//!
//! v0 clears the credential on the message response, in the service worker
//! (`worker.ts:28`-`:30`), *so credential material does not survive the
//! message round-trip*. Nothing in this crate can do that for it. The
//! 30-second life is this side's half; the clearing is slot 4c's, and census
//! §E seam 4 records that **nothing tests that it happened** — which is a
//! finding for that lane, not a gap this one can close.

use super::unlock::{Reveal, RevealRefusal, RevealTarget, Unlock};

/// What the native host asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FillRequest {
    /// The login the picker chose.
    pub item_id: String,
    /// The page's origin, `scheme://host[:port]` — normalised by the caller and
    /// **re-normalised here**, because a caller's normalisation is a claim.
    pub page_origin: String,
    /// Which cell: `password` on a fill, `otp_seed` never (a one-time code is
    /// derived and the seed does not leave the seat).
    pub column: String,
}

/// ONE FILL, WITH A LIFE AND A RECEIPT.
///
/// Wraps a [`Reveal`], so it is not `Clone`, not `Debug`, and zeroed on drop
/// for the same reasons.
pub struct FillGrant {
    reveal: Reveal,
    /// The origin the receipt recorded. A surface shows it so a member can see
    /// *which page* was filled, which is the whole point of receipting a fill
    /// differently from a reveal.
    pub origin: String,
}

impl FillGrant {
    /// The value, while the window is open.
    pub fn value(&self, now_ms: i64) -> Result<&str, RevealRefusal> {
        self.reveal.value(now_ms)
    }

    #[must_use]
    pub fn receipt_id(&self) -> &str {
        &self.reveal.receipt_id
    }

    #[must_use]
    pub const fn expires_at_ms(&self) -> i64 {
        self.reveal.expires_at_ms()
    }
}

/// The columns a fill may ever ask for.
///
/// `password` only. **Not `otp_seed`**: v0 requests the code as a derivative
/// from `locker.totp_code` precisely so the seed never leaves the sealed
/// boundary, and a fill that could ask for the seed would hand a page a
/// credential that keeps working forever rather than for thirty seconds.
pub const FILLABLE_COLUMNS: [&str; 1] = ["password"];

/// Decide and perform a fill.
///
/// `stored_url` and `stored_policy` come from the seat's own replica row — the
/// caller reads them with `crates/apps/locker::queries::autofill_item_statement`
/// and hands them here, so this function holds no statement and the app crate
/// holds no key.
pub fn fill_grant(
    unlock: &Unlock<'_>,
    request: &FillRequest,
    stored_url: Option<&str>,
    stored_policy: &str,
    now_ms: i64,
) -> Result<FillGrant, FillRefusal> {
    if !FILLABLE_COLUMNS.contains(&request.column.as_str()) {
        return Err(FillRefusal::NotFillable {
            column: request.column.clone(),
        });
    }
    // RE-NORMALISED HERE. The extension already normalised it; a caller's
    // normalisation is a claim, and this is the side that holds the key.
    let origin =
        centraid_apps_locker::page_origin(&request.page_origin).ok_or(FillRefusal::Malformed)?;
    let stored = stored_url
        .filter(|url| !url.is_empty())
        .ok_or(FillRefusal::NoStoredOrigin)?;
    let candidate = centraid_apps_locker::origin::OriginCandidate::new(
        stored,
        centraid_apps_locker::MatchPolicy::of(Some(stored_policy)),
    );
    if !centraid_apps_locker::matches_origin(&candidate, &origin) {
        return Err(FillRefusal::OriginMismatch);
    }
    let target = RevealTarget::new("locker.item", &request.item_id, &request.column);
    let reveal = unlock
        .reveal(&target, now_ms, "fill", Some(&origin))
        .map_err(FillRefusal::Reveal)?;
    Ok(FillGrant { reveal, origin })
}

/// WHY A FILL DID NOT HAPPEN. A blank answer and "the page does not match" are
/// different facts, and the Companion renders them differently: one is a bug
/// report and the other is the policy working.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FillRefusal {
    #[error("a login id and a normalised page origin are required")]
    Malformed,
    #[error("this login has no stored origin to match against")]
    NoStoredOrigin,
    /// **The policy working**, and the one refusal a member should never be
    /// invited to override.
    #[error("this page's origin does not match this login")]
    OriginMismatch,
    #[error("`{column}` is never filled into a page")]
    NotFillable { column: String },
    #[error(transparent)]
    Reveal(RevealRefusal),
}

#[cfg(test)]
mod tests {
    use super::super::session::Session;
    use super::super::unlock::{Receipts, SealedCells};
    use super::*;
    use std::cell::RefCell;

    fn key() -> Vec<u8> {
        vec![5_u8; 32]
    }

    struct Cell {
        ciphertext: String,
    }

    impl SealedCells for Cell {
        fn cell(
            &self,
            _target: &RevealTarget,
        ) -> Result<Option<(String, Option<String>)>, RevealRefusal> {
            Ok(Some((self.ciphertext.clone(), Some("key-1".to_owned()))))
        }
    }

    struct Rows(RefCell<Vec<(String, Option<String>)>>);

    impl Receipts for Rows {
        fn reveal(
            &self,
            _target: &RevealTarget,
            kind: &str,
            origin: Option<&str>,
        ) -> Result<String, String> {
            self.0
                .borrow_mut()
                .push((kind.to_owned(), origin.map(str::to_owned)));
            Ok("receipt-1".to_owned())
        }
    }

    /// A REFUSAL, WITHOUT ASKING THE GRANT TO BE `Debug`.
    ///
    /// `expect_err` wants `T: Debug` and [`FillGrant`] deliberately is not
    /// one — a `Debug` secret is a secret in a log line — so the assertions
    /// below go through this instead of weakening the type for the tests.
    fn refusal<T>(result: Result<T, FillRefusal>) -> FillRefusal {
        match result {
            Ok(_) => panic!("the fill was expected to be refused and was not"),
            Err(refusal) => refusal,
        }
    }

    fn cell() -> Cell {
        Cell {
            ciphertext: centraid_vault::custody::locker_key::encrypt_under_locker_key(
                &key(),
                "key-1",
                "item-1",
                "hunter2-and-more",
            )
            .expect("sealed"),
        }
    }

    fn request(origin: &str) -> FillRequest {
        FillRequest {
            item_id: "item-1".to_owned(),
            page_origin: origin.to_owned(),
            column: "password".to_owned(),
        }
    }

    /// THE WHOLE PATH: a matching origin fills, and the receipt records the
    /// page it happened on.
    #[test]
    fn a_matching_origin_fills_and_the_receipt_names_the_page() {
        let cells = cell();
        let rows = Rows(RefCell::new(Vec::new()));
        let session = Session::unlocked_for_test("vault-1", "key-1", key(), 0);
        let unlock = Unlock {
            session: &session,
            cells: &cells,
            receipts: &rows,
        };
        let grant = fill_grant(
            &unlock,
            &request("https://www.bank.example"),
            Some("https://login.bank.example"),
            "registrable-domain",
            0,
        )
        .expect("filled");
        assert_eq!(grant.value(0).expect("in window"), "hunter2-and-more");
        assert_eq!(grant.origin, "https://www.bank.example");
        assert_eq!(grant.receipt_id(), "receipt-1");
        // A FILL IS RECEIPTED AS A FILL, WITH ITS ORIGIN — which is what makes
        // it distinguishable from a reveal in the access history.
        assert_eq!(
            rows.0.borrow()[0],
            (
                "fill".to_owned(),
                Some("https://www.bank.example".to_owned())
            )
        );
        // THIRTY SECONDS, and then nothing.
        assert_eq!(grant.expires_at_ms(), super::super::REVEAL_WINDOW_MS);
        assert_eq!(
            grant.value(super::super::REVEAL_WINDOW_MS),
            Err(RevealRefusal::Expired)
        );
    }

    /// THE POLICY IS THE ROW'S, NOT THE CALLER'S — and a mismatch writes no
    /// receipt, because nothing was revealed.
    #[test]
    fn a_wrong_site_is_refused_over_the_rows_own_policy() {
        let cells = cell();
        let rows = Rows(RefCell::new(Vec::new()));
        let session = Session::unlocked_for_test("vault-1", "key-1", key(), 0);
        let unlock = Unlock {
            session: &session,
            cells: &cells,
            receipts: &rows,
        };
        assert_eq!(
            refusal(fill_grant(
                &unlock,
                &request("https://bank.example.attacker.test"),
                Some("https://login.bank.example"),
                "registrable-domain",
                0,
            )),
            FillRefusal::OriginMismatch
        );
        // An exact-host login does not fill a sibling.
        assert_eq!(
            refusal(fill_grant(
                &unlock,
                &request("https://www.bank.example"),
                Some("https://login.bank.example"),
                "exact-host",
                0,
            )),
            FillRefusal::OriginMismatch
        );
        assert!(rows.0.borrow().is_empty());
    }

    /// AN OTP SEED IS NEVER FILLED. The code is a derivative; the seed stays.
    #[test]
    fn only_a_password_is_ever_filled_into_a_page() {
        let cells = cell();
        let rows = Rows(RefCell::new(Vec::new()));
        let session = Session::unlocked_for_test("vault-1", "key-1", key(), 0);
        let unlock = Unlock {
            session: &session,
            cells: &cells,
            receipts: &rows,
        };
        let mut seed = request("https://www.bank.example");
        seed.column = "otp_seed".to_owned();
        assert_eq!(
            refusal(fill_grant(
                &unlock,
                &seed,
                Some("https://bank.example"),
                "registrable-domain",
                0
            )),
            FillRefusal::NotFillable {
                column: "otp_seed".to_owned()
            }
        );
        assert!(rows.0.borrow().is_empty());
    }

    /// A LOCKED SEAT REFUSES A FILL AND DOES NOT PROMPT — the shell does.
    #[test]
    fn a_locked_seat_refuses_a_fill() {
        let cells = cell();
        let rows = Rows(RefCell::new(Vec::new()));
        let session = Session::locked("vault-1");
        let unlock = Unlock {
            session: &session,
            cells: &cells,
            receipts: &rows,
        };
        assert_eq!(
            refusal(fill_grant(
                &unlock,
                &request("https://www.bank.example"),
                Some("https://bank.example"),
                "registrable-domain",
                0,
            )),
            FillRefusal::Reveal(RevealRefusal::Locked)
        );
    }

    /// A URL IS NOT AN ORIGIN, even when the caller says it normalised one.
    #[test]
    fn the_callers_normalisation_is_re_done_here() {
        let cells = cell();
        let rows = Rows(RefCell::new(Vec::new()));
        let session = Session::unlocked_for_test("vault-1", "key-1", key(), 0);
        let unlock = Unlock {
            session: &session,
            cells: &cells,
            receipts: &rows,
        };
        for claimed in [
            "https://www.bank.example/login",
            "https://www.bank.example/",
            "bank.example",
            "",
        ] {
            assert_eq!(
                refusal(fill_grant(
                    &unlock,
                    &request(claimed),
                    Some("https://bank.example"),
                    "registrable-domain",
                    0,
                )),
                FillRefusal::Malformed,
                "{claimed}"
            );
        }
    }
}
