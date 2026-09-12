//! **The webhook ingress, without a listening socket** (#1020, D-1020-AU5).
//!
//! ## The problem, stated plainly
//!
//! A webhook trigger needs inbound HTTP. v0 mounts a route handler at
//! `/_centraid-hook` ahead of the gateway's own bearer check
//! (`scaffold/webhook.ts:1`–`:6`). v1 has **no listener**: the invariant is
//! *no crate opens a listening TCP socket unless `blob-door` is on*
//! (#1020 Invariants), and `no-listening-socket` is a gate rule, not a
//! preference. So the delivery has to arrive some other way, or the trigger
//! kind has to go.
//!
//! ## The ruling, and the two options it was chosen over
//!
//! - **(a) A feature-gated listener**, beside the HTTPS blob door. Honest and
//!   familiar, and it re-introduces exactly the surface the invariant exists to
//!   keep off a member's machine — for a trigger kind no bundled recipe uses.
//! - **(b) Poll a relay or inbox the OAuth worker holds.** The right long-term
//!   answer for connectors, and connectors are on the back burner (owner,
//!   2026-09-12), so it would be a rail with nothing at either end.
//! - **(c) ADOPTED. A delivery arrives through a SEAT.** On the desktop or CLI
//!   seat that is `centraid automations deliver <id>` reading the payload from
//!   stdin; from a paired phone it is the gateway's own iroh endpoint, which is
//!   a *dialled* connection and not a listener. A member whose provider can
//!   only POST to a URL forwards it from a device they already trust.
//!
//! (a) is recorded as the future option **under the same feature flag as the
//! HTTPS blob door**, so if it ever lands it lands where the invariant already
//! makes an exception, and `no-listening-socket` keeps refusing it everywhere
//! else. Nothing in this module opens, binds or listens.
//!
//! ## What is kept from v0, verbatim
//!
//! The pending/minted states ([`crate::manifest::WebhookState`]), the **hash
//! only** rule — `automation.json` is member-visible, so only the SHA-256 of a
//! secret shown once is stored — the constant-time comparison, the 64 KiB body
//! cap, the 60-per-minute limiter, and a **durable ingress row written after
//! auth and before the fire**, so a restarted gateway can never drop a
//! delivery.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// 64 KiB, v0's.
pub const MAX_BODY_BYTES: usize = 64 * 1024;

/// v0's limiter: 60 deliveries per webhook per minute.
pub const RATE_LIMIT_MAX: u32 = 60;
pub const RATE_LIMIT_WINDOW_MS: i64 = 60_000;

/// How long an ingress row survives before the retention pass may drop it.
/// Long enough that a gateway down for a working day still delivers.
pub const INGRESS_TTL_MS: i64 = 24 * 60 * 60 * 1_000;

/// What the manifest persists: the SHA-256 of a secret, lowercase hex.
#[must_use]
pub fn hash_secret(secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    hex::encode(hasher.finalize())
}

/// Compare a presented secret against a stored hash, in constant time.
///
/// Constant time over the HASHES rather than the secrets, which is v0's shape
/// and the right one: the lengths are then fixed, so the comparison leaks
/// nothing about the secret's own length either.
#[must_use]
pub fn verify_secret(provided: &str, expected_hash: &str) -> bool {
    let Ok(expected) = hex::decode(expected_hash) else {
        return false;
    };
    let Ok(actual) = hex::decode(hash_secret(provided)) else {
        return false;
    };
    if expected.len() != actual.len() || expected.is_empty() {
        return false;
    }
    actual.ct_eq(&expected).into()
}

/// Where a route slug and a secret come from.
///
/// A trait, because this crate must not hold a CSPRNG: a webhook secret is
/// key material, and the one source of key material in the product is the
/// host's (`crates/vault::custody`). A builder harness cannot mint these at
/// all, which is why [`crate::manifest::WebhookState::Pending`] exists.
pub trait Mint {
    /// A route slug. Unique across the vault, because the ingress lookup is by
    /// slug alone.
    fn webhook_id(&self) -> String;
    /// A secret, shown to the member **once**.
    fn secret(&self) -> String;
}

/// What provisioning a pending webhook produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Provisioned {
    pub automation_ref: String,
    pub webhook_id: String,
    /// **Never written to disk.** The caller shows it once and forgets it.
    pub secret: String,
    /// What replaces the pending trigger in the manifest.
    pub secret_hash: String,
}

/// Provision a pending webhook trigger.
///
/// Returns `None` when the automation carries no pending trigger — a
/// provisioned one needs a ROTATION, not a first mint, and rotating silently
/// here would invalidate a caller's configured URL.
#[must_use]
pub fn provision(
    automation_ref: &str,
    triggers: &[crate::manifest::Trigger],
    mint: &dyn Mint,
) -> Option<Provisioned> {
    if !triggers.iter().any(|trigger| {
        matches!(
            trigger,
            crate::manifest::Trigger::Webhook(crate::manifest::WebhookState::Pending)
        )
    }) {
        return None;
    }
    let secret = mint.secret();
    Some(Provisioned {
        automation_ref: automation_ref.to_owned(),
        webhook_id: mint.webhook_id(),
        secret_hash: hash_secret(&secret),
        secret,
    })
}

/// Rotate a provisioned webhook's secret.
///
/// **The route id is KEPT**, so a configured caller keeps working; only the
/// hash changes. An owner who missed the one-time reveal is left with an
/// uncallable automation, which is the honest cost of never storing the
/// plaintext.
#[must_use]
pub fn rotate(
    automation_ref: &str,
    triggers: &[crate::manifest::Trigger],
    mint: &dyn Mint,
) -> Option<Provisioned> {
    let webhook_id = triggers.iter().find_map(|trigger| match trigger {
        crate::manifest::Trigger::Webhook(crate::manifest::WebhookState::Minted { id, .. }) => {
            Some(id.clone())
        }
        _ => None,
    })?;
    let secret = mint.secret();
    Some(Provisioned {
        automation_ref: automation_ref.to_owned(),
        webhook_id,
        secret_hash: hash_secret(&secret),
        secret,
    })
}

/// One inbound delivery, as a seat hands it over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Delivery {
    pub webhook_id: String,
    /// Per-delivery BY CONTRACT. v0 reads `x-centraid-delivery-id` or
    /// `x-github-delivery` and never `x-request-id`, *"which is reused by some
    /// proxies, which would collapse two deliveries into one"*. A seat passes
    /// the header through, or mints one.
    pub delivery_id: String,
    pub received_at: i64,
    /// The body, as text. Parsed as JSON when it parses, and passed through as
    /// a string when it does not — a provider that posts form data is still a
    /// delivery.
    pub body: String,
}

impl Delivery {
    /// The payload the ingress row stores.
    #[must_use]
    pub fn payload(&self) -> serde_json::Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|_| serde_json::Value::String(self.body.clone()))
    }
}

/// What accepting a delivery decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Accepted {
    /// Stored durably, and the trigger may now be nudged.
    Stored,
    /// The same `(source, source_key, delivery_id)` is already stored. **Not
    /// an error**: a provider that retries because our 202 was lost must get
    /// the same answer, and the fire happens once.
    Duplicate,
    /// The automation exists and is switched off. Answered 200-with-skipped in
    /// v0, and a value here — a member who disabled an automation did not ask
    /// for an error either.
    Disabled,
    /// A SENTENCE. Every refusal below names a different failure, and none of
    /// them says which part of the secret was wrong.
    Refused(String),
}

/// Where an ingress row lives: `trigger_ingress`, whose store code is
/// `centraid_vault::ledger::automation_ingress`'s. A trait, because this crate
/// holds no SQL.
pub trait IngressStore {
    /// Store one delivery, answering `false` when the
    /// `(source, source_key, delivery_id)` triple is already there — the
    /// table's own UNIQUE constraint, surfaced as a value.
    fn store(&self, row: &IngressRow) -> bool;
}

/// One `trigger_ingress` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngressRow {
    /// `webhook` or `poll`, the table's CHECK.
    pub source: &'static str,
    /// The route slug for a webhook.
    pub source_key: String,
    pub delivery_id: String,
    pub received_at: i64,
    pub payload_json: String,
    pub expires_at: i64,
}

/// The per-slug limiter. Pure, and given its own clock.
#[derive(Debug, Clone, Default)]
pub struct RateLimiter {
    windows: std::collections::BTreeMap<String, (i64, u32)>,
}

impl RateLimiter {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Count one delivery. `true` means over the limit.
    pub fn over_limit(&mut self, webhook_id: &str, now: i64) -> bool {
        let window = self
            .windows
            .entry(webhook_id.to_owned())
            .or_insert((now, 0));
        if now - window.0 >= RATE_LIMIT_WINDOW_MS {
            *window = (now, 1);
            return false;
        }
        window.1 += 1;
        window.1 > RATE_LIMIT_MAX
    }
}

/// The automation a delivery is for, as the caller resolved it.
#[derive(Debug, Clone)]
pub struct Target<'a> {
    pub automation_ref: &'a str,
    pub secret_hash: &'a str,
    pub enabled: bool,
}

/// Accept one delivery: verify, then store durably, then let the caller nudge.
///
/// **The order is the property.** The ingress row is written after auth and
/// **before** the fire, so a gateway that dies between the two re-delivers from
/// the row rather than losing the event; and it is written after auth so an
/// unauthenticated caller cannot fill the table.
pub fn accept(
    delivery: &Delivery,
    target: Option<&Target<'_>>,
    presented_secret: Option<&str>,
    store: &dyn IngressStore,
    limiter: &mut RateLimiter,
) -> Accepted {
    if delivery.body.len() > MAX_BODY_BYTES {
        return Accepted::Refused(format!(
            "this delivery is {} bytes and the ceiling is {MAX_BODY_BYTES}",
            delivery.body.len()
        ));
    }
    if !is_valid_slug(&delivery.webhook_id) {
        return Accepted::Refused("unknown webhook".to_owned());
    }
    if limiter.over_limit(&delivery.webhook_id, delivery.received_at) {
        return Accepted::Refused("rate limit exceeded".to_owned());
    }
    // AN UNKNOWN SLUG AND A WRONG SECRET GET THE SAME SHAPE OF ANSWER, so a
    // caller cannot enumerate which routes exist.
    let Some(target) = target else {
        return Accepted::Refused("unknown webhook".to_owned());
    };
    let Some(secret) = presented_secret else {
        return Accepted::Refused("invalid or missing webhook secret".to_owned());
    };
    if !verify_secret(secret, target.secret_hash) {
        return Accepted::Refused("invalid or missing webhook secret".to_owned());
    }
    if !target.enabled {
        return Accepted::Disabled;
    }
    let row = IngressRow {
        source: "webhook",
        source_key: delivery.webhook_id.clone(),
        delivery_id: delivery.delivery_id.clone(),
        received_at: delivery.received_at,
        payload_json: delivery.payload().to_string(),
        expires_at: delivery.received_at + INGRESS_TTL_MS,
    };
    if store.store(&row) {
        Accepted::Stored
    } else {
        Accepted::Duplicate
    }
}

fn is_valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::BTreeSet;

    use super::*;
    use crate::manifest::{Trigger, WebhookState};

    struct Fixed(&'static str, &'static str);

    impl Mint for Fixed {
        fn webhook_id(&self) -> String {
            self.0.to_owned()
        }

        fn secret(&self) -> String {
            self.1.to_owned()
        }
    }

    #[derive(Default)]
    struct MemoryIngress(RefCell<BTreeSet<(String, String)>>);

    impl IngressStore for MemoryIngress {
        fn store(&self, row: &IngressRow) -> bool {
            self.0
                .borrow_mut()
                .insert((row.source_key.clone(), row.delivery_id.clone()))
        }
    }

    fn delivery(id: &str, body: &str, at: i64) -> Delivery {
        Delivery {
            webhook_id: "hook1".to_owned(),
            delivery_id: id.to_owned(),
            received_at: at,
            body: body.to_owned(),
        }
    }

    #[test]
    fn the_hash_is_what_persists_and_the_comparison_is_constant_time() {
        let hash = hash_secret("s3cret");
        assert_eq!(hash.len(), 64);
        assert!(verify_secret("s3cret", &hash));
        assert!(!verify_secret("s3cre", &hash));
        assert!(!verify_secret("", &hash));
        assert!(!verify_secret("s3cret", "not hex"));
        assert!(!verify_secret("s3cret", ""));
        // A hash is not a secret: the plaintext cannot be recovered, which is
        // the whole reason the manifest may be member-visible.
        assert_ne!(hash, "s3cret");
    }

    #[test]
    fn a_pending_trigger_is_provisioned_once_and_a_minted_one_is_rotated() {
        let pending = [Trigger::Webhook(WebhookState::Pending)];
        let minted = provision("hooks/hooks", &pending, &Fixed("hook1", "s3cret"))
            .expect("a pending trigger");
        assert_eq!(minted.webhook_id, "hook1");
        assert_eq!(minted.secret, "s3cret");
        assert_eq!(minted.secret_hash, hash_secret("s3cret"));
        // A provisioned trigger is NOT re-provisioned: that would mint a new
        // route id and break a configured caller.
        let provisioned = [Trigger::Webhook(WebhookState::Minted {
            id: "hook1".to_owned(),
            secret_hash: minted.secret_hash.clone(),
        })];
        assert_eq!(
            provision("hooks/hooks", &provisioned, &Fixed("hook2", "x")),
            None
        );
        // A ROTATION KEEPS THE ROUTE ID.
        let rotated = rotate("hooks/hooks", &provisioned, &Fixed("hook2", "fresh"))
            .expect("a provisioned trigger");
        assert_eq!(rotated.webhook_id, "hook1", "the caller's URL survives");
        assert_eq!(rotated.secret_hash, hash_secret("fresh"));
        assert_ne!(rotated.secret_hash, minted.secret_hash);
        // A pending trigger needs a first mint, not a rotation.
        assert_eq!(rotate("hooks/hooks", &pending, &Fixed("hook2", "x")), None);
    }

    #[test]
    fn a_verified_delivery_is_stored_durably_before_any_fire() {
        let store = MemoryIngress::default();
        let mut limiter = RateLimiter::new();
        let hash = hash_secret("s3cret");
        let target = Target {
            automation_ref: "hooks/hooks",
            secret_hash: &hash,
            enabled: true,
        };
        let accepted = accept(
            &delivery("d1", r#"{"action":"opened"}"#, 1_000),
            Some(&target),
            Some("s3cret"),
            &store,
            &mut limiter,
        );
        assert_eq!(accepted, Accepted::Stored);
        // A RETRY IS A DUPLICATE, not an error and not a second fire.
        let again = accept(
            &delivery("d1", r#"{"action":"opened"}"#, 1_001),
            Some(&target),
            Some("s3cret"),
            &store,
            &mut limiter,
        );
        assert_eq!(again, Accepted::Duplicate);
        // A different delivery id is a different delivery.
        let next = accept(
            &delivery("d2", r#"{"action":"closed"}"#, 1_002),
            Some(&target),
            Some("s3cret"),
            &store,
            &mut limiter,
        );
        assert_eq!(next, Accepted::Stored);
    }

    #[test]
    fn an_unverified_delivery_stores_nothing() {
        let store = MemoryIngress::default();
        let mut limiter = RateLimiter::new();
        let hash = hash_secret("s3cret");
        let target = Target {
            automation_ref: "hooks/hooks",
            secret_hash: &hash,
            enabled: true,
        };
        for presented in [None, Some("wrong")] {
            let refused = accept(
                &delivery("d1", "{}", 1_000),
                Some(&target),
                presented,
                &store,
                &mut limiter,
            );
            assert_eq!(
                refused,
                Accepted::Refused("invalid or missing webhook secret".to_owned())
            );
        }
        assert!(
            store.0.borrow().is_empty(),
            "an unauthenticated caller must not be able to fill the ingress table"
        );
    }

    /// An unknown slug and a wrong secret answer the same shape, so a caller
    /// cannot enumerate routes.
    #[test]
    fn an_unknown_webhook_says_only_that() {
        let store = MemoryIngress::default();
        let mut limiter = RateLimiter::new();
        assert_eq!(
            accept(
                &delivery("d1", "{}", 1_000),
                None,
                Some("s3cret"),
                &store,
                &mut limiter
            ),
            Accepted::Refused("unknown webhook".to_owned())
        );
        let mut bad = delivery("d1", "{}", 1_000);
        bad.webhook_id = "../etc/passwd".to_owned();
        assert_eq!(
            accept(&bad, None, Some("s"), &store, &mut limiter),
            Accepted::Refused("unknown webhook".to_owned())
        );
    }

    #[test]
    fn a_disabled_automation_is_a_value_not_an_error() {
        let store = MemoryIngress::default();
        let mut limiter = RateLimiter::new();
        let hash = hash_secret("s3cret");
        let target = Target {
            automation_ref: "hooks/hooks",
            secret_hash: &hash,
            enabled: false,
        };
        assert_eq!(
            accept(
                &delivery("d1", "{}", 1_000),
                Some(&target),
                Some("s3cret"),
                &store,
                &mut limiter
            ),
            Accepted::Disabled
        );
        assert!(store.0.borrow().is_empty());
    }

    #[test]
    fn the_body_ceiling_and_the_limiter_are_v0s() {
        let store = MemoryIngress::default();
        let mut limiter = RateLimiter::new();
        let hash = hash_secret("s");
        let target = Target {
            automation_ref: "hooks/hooks",
            secret_hash: &hash,
            enabled: true,
        };
        let big = delivery("d1", &"x".repeat(MAX_BODY_BYTES + 1), 1_000);
        match accept(&big, Some(&target), Some("s"), &store, &mut limiter) {
            Accepted::Refused(reason) => assert!(reason.contains("ceiling"), "{reason}"),
            other => panic!("{other:?}"),
        }
        // 60 in a window is fine; the 61st is not.
        let mut limiter = RateLimiter::new();
        for index in 0..RATE_LIMIT_MAX {
            assert!(
                !limiter.over_limit("hook1", 1_000 + i64::from(index)),
                "{index}"
            );
        }
        assert!(limiter.over_limit("hook1", 1_050));
        // A new window resets it.
        assert!(!limiter.over_limit("hook1", 1_000 + RATE_LIMIT_WINDOW_MS));
        // And the limiter is per slug.
        assert!(!limiter.over_limit("hook2", 1_050));
    }

    #[test]
    fn a_body_that_is_not_json_is_still_a_delivery() {
        let form = delivery("d1", "a=1&b=2", 1_000);
        assert_eq!(form.payload(), serde_json::json!("a=1&b=2"));
        let json = delivery("d1", r#"{"a":1}"#, 1_000);
        assert_eq!(json.payload(), serde_json::json!({"a":1}));
        let empty = delivery("d1", "", 1_000);
        assert_eq!(empty.payload(), serde_json::json!(""));
    }

    #[test]
    fn an_ingress_row_expires_and_names_its_source() {
        let store = MemoryIngress::default();
        let mut limiter = RateLimiter::new();
        let hash = hash_secret("s");
        let target = Target {
            automation_ref: "hooks/hooks",
            secret_hash: &hash,
            enabled: true,
        };
        accept(
            &delivery("d1", "{}", 1_000),
            Some(&target),
            Some("s"),
            &store,
            &mut limiter,
        );
        let row = IngressRow {
            source: "webhook",
            source_key: "hook1".to_owned(),
            delivery_id: "d1".to_owned(),
            received_at: 1_000,
            payload_json: "{}".to_owned(),
            expires_at: 1_000 + INGRESS_TTL_MS,
        };
        // `source` is one of the table's two CHECK values.
        assert!(["webhook", "poll"].contains(&row.source));
        assert!(row.expires_at > row.received_at);
    }
}
