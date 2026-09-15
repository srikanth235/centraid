//! WATCHTOWER — weak, reused, and the last four digits of a card, derived where
//! `K` is (D-1020-L6).
//!
//! ## What moved, and why it had to
//!
//! In v0 `locker.watchtower` is a **vault command**: it unseals every secret
//! inside the gateway's sealed boundary, derives the three facts, and returns
//! them without a password ever leaving the gateway (`unseals:
//! ["locker.item.password", "locker.item.card_number"]`,
//! `packages/vault/src/commands/locker.ts`). That worked because the gateway
//! held `K`.
//!
//! After wave 4 it does not. `locker.watchtower` and `locker.totp_code` are the
//! two `act` scopes in Locker's manifest that **need plaintext to compute**
//! (census §F3 consequence 3), and a gateway that cannot unseal cannot compute
//! either. So both become **seat-side derivations over values the seat revealed
//! inside its own reveal window**, and the commands stay in the catalogue as
//! the receipted door they always were: the seat asks, the gateway records that
//! a derivation happened over N rows, and the derivation runs where `K` is.
//!
//! The options, and why this one (D-1020-L6):
//!
//! - **(a) delete the two commands** and make the two `act` scopes dead.
//!   Rejected: the receipt is the point. A member's audit history would stop
//!   recording that every password in the vault was opened in order to score
//!   it, which is the single largest reveal Locker performs.
//! - **(b) keep the derivation on the gateway and hand it `K` for the
//!   duration.** Rejected outright: that is the key door with a smaller
//!   doorway.
//! - **(c) seat-side derivation, gateway-side receipt.** Adopted. The scopes
//!   keep their meaning (*may derive*), the plaintext never leaves the seat,
//!   and the fold below is pure, so the same corpus gives the same numbers on
//!   every seat.
//!
//! ## The derivation is v0's, score for score
//!
//! [`strength_score`] is `packages/vault/src/commands/locker.ts`'s five-point
//! scale and **weak is `score <= 2`** — not a rewrite, because the number a
//! member has been looking at must not change meaning when the code moves
//! hosts. Three of v0's rules are load-bearing and easy to lose:
//!
//! 1. **Only a `login` is scored.** `wifi` and `password` items have their
//!    passwords unsealed (they are in the row set) and are reported
//!    `weak: false, reused: false` — see [`SCORED_TYPE`]. Whether a wifi
//!    passphrase shared with a login *should* count as reuse is a real
//!    question and it is in the receipt as one, not silently answered here.
//! 2. **Reuse is counted over logins only**, and a password on two logins is
//!    reused on **both** — naming only the newer one would tell a member to
//!    rotate one of two copies of the same secret.
//! 3. **The row set includes archived items** (`deleted_at IS NULL`), because
//!    an archived login's password is still a password somebody reused, and
//!    excludes a `wifi`/`password` item with no password at all.
//!
//! ## Equality over a digest, never over a table of passwords
//!
//! The reuse pass groups by a **digest** of the password, so the intermediate
//! map this fold builds is not a table of every password in the vault. The
//! digest function is passed in rather than chosen here: a hash in an app crate
//! is a hash whose collision behaviour nobody owns, and `crates/seat::locker`
//! passes the one the custody plane already uses.

use std::collections::BTreeMap;

use crate::queries::Decorated;

/// The only item type Watchtower scores. v0's `r.type === "login"`, twice.
pub const SCORED_TYPE: &str = "login";

/// The types whose `password` the derivation unseals — the row set's own
/// condition: `type IN ('login','card') OR (type IN ('wifi','password') AND
/// password IS NOT NULL)`.
pub const UNSEALED_TYPES: [&str; 4] = ["login", "card", "wifi", "password"];

/// `strengthScore(pw) <= WEAK_AT` is weak.
pub const WEAK_AT: u8 = 2;

/// The derived facts about one item. Every field is an ANSWER, which is why
/// this type only ever appears inside an `Option`: its absence is *the
/// derivation did not run*, and there is no value of it that means that.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WatchEntry {
    pub weak: bool,
    pub reused: bool,
    /// The last four digits of a card number, and nothing else a card holds.
    pub last4: Option<String>,
}

/// The review summary. Built only from a shelf whose derivation **ran**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub compromised: usize,
    pub weak: usize,
    pub reused: usize,
    /// The rows that need attention, in the shelf's own order.
    pub items: Vec<Decorated>,
}

/// The summary, or `None` when the derivation did not run.
///
/// **This signature is the whole of the rule.** A caller cannot accidentally
/// build a zeroed summary, because the only constructor refuses to build one
/// without being told the derivation happened — there is no
/// `Summary::default()`.
#[must_use]
pub fn summarise(items: &[Decorated], derived: bool) -> Option<Summary> {
    if !derived {
        return None;
    }
    Some(Summary {
        compromised: items.iter().filter(|item| item.compromised).count(),
        weak: items
            .iter()
            .filter(|item| item.weak().unwrap_or(false))
            .count(),
        reused: items
            .iter()
            .filter(|item| item.reused().unwrap_or(false))
            .count(),
        items: items
            .iter()
            .filter(|item| item.needs_attention())
            .cloned()
            .collect(),
    })
}

/// One item's revealed secrets, as the seat hands them to the fold.
///
/// The seat builds these **inside its reveal window** and drops them when the
/// window closes. Deliberately neither `Clone` nor `Debug`, for the reason
/// [`crate::Revealed`] is neither: a cloned secret is a copy nothing clears
/// and a `Debug` secret is a secret in a log line.
pub struct RevealedSecrets {
    pub item_id: String,
    pub item_type: String,
    /// The password, when the item has one. A wifi passphrase reuses this
    /// column.
    pub password: Option<String>,
    /// The card number, for `last4` and for nothing else.
    pub card_number: Option<String>,
}

/// v0's five-point scale, rule for rule (`locker.ts`'s `strengthScore`).
///
/// *0..5; weak at ≤2 (mirrors the app meter).* The two length rules are
/// cumulative, and the case rule needs **both** cases — which is why
/// `aaaaaaaaaaaaaa` scores 2 and is weak while `Aaaaaaaaaaaaaa` scores 3 and is
/// not. Reproduced rather than improved: the number a member has been looking
/// at must not change meaning when the code changes hosts.
#[must_use]
pub fn strength_score(password: &str) -> u8 {
    if password.is_empty() {
        return 0;
    }
    let length = password.chars().count();
    let mut score = 0_u8;
    if length >= 8 {
        score += 1;
    }
    if length >= 14 {
        score += 1;
    }
    // v0's `/[A-Z]/u` and `/[a-z]/u` — ASCII case classes, not Unicode ones.
    if password.chars().any(|c| c.is_ascii_uppercase())
        && password.chars().any(|c| c.is_ascii_lowercase())
    {
        score += 1;
    }
    if password.chars().any(|c| c.is_ascii_digit()) {
        score += 1;
    }
    if password.chars().any(|c| !c.is_ascii_alphanumeric()) {
        score += 1;
    }
    score
}

/// Is this password weak? v0's `strengthScore(pw) <= 2`.
#[must_use]
pub fn is_weak(password: &str) -> bool {
    strength_score(password) <= WEAK_AT
}

/// The last four digits of a card number, ignoring the spacing a member typed.
///
/// v0 strips whitespace and takes the last four **of whatever is left**, so a
/// three-digit draft answers nothing rather than a short string: `••••` with
/// two digits on a list row would be a worse answer than "Card".
#[must_use]
pub fn last4(card_number: &str) -> Option<String> {
    let digits: String = card_number.chars().filter(|c| !c.is_whitespace()).collect();
    if digits.chars().count() < 4 {
        return None;
    }
    Some(digits.chars().skip(digits.chars().count() - 4).collect())
}

/// Is this item in the derivation's row set at all?
#[must_use]
pub fn is_unsealed_type(item_type: &str, has_password: bool) -> bool {
    match item_type {
        "login" | "card" => true,
        "wifi" | "password" => has_password,
        _ => false,
    }
}

/// THE DERIVATION. Pure, over digests rather than plaintext.
pub fn derive(
    secrets: &[RevealedSecrets],
    digest: impl Fn(&str) -> String,
) -> BTreeMap<String, WatchEntry> {
    // Reuse is counted over LOGINS ONLY — v0's `if (r.type !== "login")
    // continue`.
    let mut login_counts: BTreeMap<String, usize> = BTreeMap::new();
    for secret in secrets {
        if secret.item_type != SCORED_TYPE {
            continue;
        }
        if let Some(password) = secret.password.as_deref().filter(|value| !value.is_empty()) {
            *login_counts.entry(digest(password)).or_default() += 1;
        }
    }
    secrets
        .iter()
        .map(|secret| {
            if secret.item_type == "card" {
                return (
                    secret.item_id.clone(),
                    WatchEntry {
                        weak: false,
                        reused: false,
                        last4: secret.card_number.as_deref().and_then(last4),
                    },
                );
            }
            let scored = secret.item_type == SCORED_TYPE;
            let password = secret.password.as_deref().filter(|value| !value.is_empty());
            (
                secret.item_id.clone(),
                WatchEntry {
                    weak: scored && password.is_some_and(is_weak),
                    reused: scored
                        && password
                            .map(&digest)
                            .and_then(|key| login_counts.get(&key).copied())
                            .is_some_and(|count| count >= 2),
                    last4: None,
                },
            )
        })
        .collect()
}

/// What the `watchtower` query answers: the summary, plus whether the shelf it
/// summarised was itself complete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Watchtower {
    pub summary: Option<Summary>,
    /// The 2,000-row review window filled, so there are items it did not see.
    ///
    /// **This is the R-1020-35 half of the shelf** (`watchtower.ts`'s own
    /// comment: *"Watchtower audited a quarter of the vault and reported it as
    /// all of it"*). A summary over a short window with no flag is a security
    /// screen lying by omission, so the flag rides the answer.
    pub truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queries::{Decorations, ItemRow, decorate};

    fn digest(value: &str) -> String {
        // A deliberately terrible test digest: the fold's behaviour must
        // depend on the hash's EQUALITY and on nothing else about it.
        format!("len{}:{}", value.len(), value.chars().next().unwrap_or(' '))
    }

    fn login(item_id: &str, password: &str) -> RevealedSecrets {
        RevealedSecrets {
            item_id: item_id.to_owned(),
            item_type: "login".to_owned(),
            password: Some(password.to_owned()),
            card_number: None,
        }
    }

    /// v0's five points, each one's boundary.
    #[test]
    fn the_strength_score_is_v0s_five_points() {
        assert_eq!(strength_score(""), 0);
        assert_eq!(strength_score("abcdefg"), 0);
        assert_eq!(strength_score("abcdefgh"), 1);
        assert_eq!(strength_score("abcdefghijklm"), 1);
        assert_eq!(strength_score("abcdefghijklmn"), 2);
        assert_eq!(strength_score("Abcdefghijklmn"), 3);
        assert_eq!(strength_score("Abcdefghijklm1"), 4);
        assert_eq!(strength_score("Abcdefghijkl1!"), 5);
        // Weak is ≤ 2, so fourteen lowercase letters are weak and one capital
        // is the difference.
        assert!(is_weak("abcdefghijklmn"));
        assert!(!is_weak("Abcdefghijklmn"));
        assert!(is_weak("aaaaaaaaaaaaaa"));
    }

    /// ONLY A LOGIN IS SCORED — the rule a port loses first.
    #[test]
    fn a_wifi_passphrase_is_unsealed_and_not_scored() {
        let secrets = vec![
            login("i1", "password"),
            RevealedSecrets {
                item_id: "i2".to_owned(),
                item_type: "wifi".to_owned(),
                password: Some("password".to_owned()),
                card_number: None,
            },
        ];
        let derived = derive(&secrets, digest);
        assert!(derived["i1"].weak, "the login is weak");
        assert!(!derived["i2"].weak, "v0 does not score a wifi item");
        // …and a wifi passphrase shared with a login is NOT reuse in v0. The
        // question of whether it should be is in the receipt, not answered
        // here.
        assert!(!derived["i1"].reused);
        assert!(!derived["i2"].reused);
    }

    /// A password used on two logins is reused on BOTH rows.
    #[test]
    fn reuse_names_every_copy_and_not_only_the_newer_one() {
        let derived = derive(
            &[
                login("i1", "Abcdefghijkl1!"),
                login("i2", "Abcdefghijkl1!"),
                login("i3", "Zyxwvutsrqp9?"),
            ],
            digest,
        );
        assert!(derived["i1"].reused);
        assert!(derived["i2"].reused);
        assert!(!derived["i3"].reused);
        assert!(!derived["i1"].weak);
    }

    #[test]
    fn last4_ignores_spacing_and_refuses_a_partial_number() {
        assert_eq!(last4("4242 4242 4242 4242").as_deref(), Some("4242"));
        assert_eq!(last4("4111111111111234").as_deref(), Some("1234"));
        assert_eq!(last4("123"), None);
        assert_eq!(last4(""), None);
    }

    /// `last4` is a CARD's derivation, and a card is never weak or reused.
    #[test]
    fn a_card_carries_last4_and_no_score() {
        let derived = derive(
            &[RevealedSecrets {
                item_id: "i1".to_owned(),
                item_type: "card".to_owned(),
                password: None,
                card_number: Some("4242 4242 4242 4242".to_owned()),
            }],
            digest,
        );
        assert_eq!(derived["i1"].last4.as_deref(), Some("4242"));
        assert!(!derived["i1"].weak);
        assert!(!derived["i1"].reused);
    }

    /// "No password" and "a weak password" are two answers; folding them
    /// together would put every secure note on the review shelf.
    #[test]
    fn an_item_with_no_password_is_not_weak() {
        let derived = derive(
            &[RevealedSecrets {
                item_id: "i1".to_owned(),
                item_type: "note".to_owned(),
                password: None,
                card_number: None,
            }],
            digest,
        );
        assert!(!derived["i1"].weak);
        assert!(!derived["i1"].reused);
        assert_eq!(derived["i1"].last4, None);
    }

    #[test]
    fn the_row_set_is_v0s_row_set() {
        assert!(is_unsealed_type("login", false));
        assert!(is_unsealed_type("card", false));
        assert!(is_unsealed_type("wifi", true));
        assert!(!is_unsealed_type("wifi", false));
        assert!(is_unsealed_type("password", true));
        assert!(!is_unsealed_type("password", false));
        assert!(!is_unsealed_type("note", true));
        for item_type in UNSEALED_TYPES {
            assert!(is_unsealed_type(item_type, true), "{item_type}");
        }
    }

    /// THE ZEROED SUMMARY IS UNREACHABLE. This is the assertion that makes
    /// D-1020-L6's "absent, not false" a fact about the type.
    #[test]
    fn a_summary_cannot_be_built_without_the_derivation() {
        let rows = vec![ItemRow {
            item_id: "i1".to_owned(),
            item_type: "login".to_owned(),
            compromised: true,
            ..ItemRow::default()
        }];
        let items = decorate(&rows, &Decorations::default());
        assert_eq!(summarise(&items, false), None);
        let summary = summarise(&items, true).expect("the derivation ran");
        assert_eq!(summary.compromised, 1);
        assert_eq!(summary.weak, 0);
        assert_eq!(summary.items.len(), 1);
    }
}
