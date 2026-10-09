//! THE SAMPLE VAULT'S LOCKER: a few obviously fake items, sealed under the
//! member's own keys.
//!
//! The sample is a vault like any other the phone holds, so a member who opens
//! its Locker should see what Locker is for. That takes items, and an item's
//! secrets are sealed under the vault's `K` — the seed's `locker'` leaf at the
//! vault's own derivation index (D-6, Q-1047-11). So the sample is founded
//! KEYED, at an index of its own that the shell spent for it, and this module
//! seeds Locker through the door the shell uses and no other:
//!
//! 1. a Locker **unlock** with the vault's keys (`locker::phone::answer`, which
//!    receipts it as `locker.auth` and opens the session);
//! 2. each item as `locker.add_item`, its secrets sealed by
//!    `locker::phone::seal_command` — the same function `Handle::call` runs for
//!    a member's typed secret — before the vault sees the command;
//! 3. a **relock**, always, so nothing about the finished vault depends on a
//!    session.
//!
//! There is no second sealing path here, no key of this module's own and no
//! phrase: the keys are the ones the open core derived from the member's seed,
//! passed in as [`Sealing`]. A core opened with no seed has none, and the
//! caller passes none — the sample then has no Locker rather than a Locker
//! sealed under something that is not the member's.
//!
//! **Every secret below is a made-up test value** (the card is Stripe's
//! published test number), so a sample item that is copied, shown or shared
//! reveals nothing real. The sample never pairs, drains or backs up, so the
//! sealed rows never leave the phone either.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::commands::Registry;
use centraid_vault::{Principal, Vault};
use serde_json::{Value, json};

use super::Seeder;
use crate::events::ChangeFeed;
use crate::locker::phone as session;
use crate::phone::Keyring;

/// WHAT SEALS THE SAMPLE'S LOCKER: the open core's own keys and Locker session,
/// borrowed for the length of the found. Nothing here is copied or kept.
pub struct Sealing<'a> {
    /// The vault's keys, derived at open from the member's seed and this
    /// vault's index.
    pub keys: &'a Keyring,
    /// The core's Locker session cell, which holds `K` only while unlocked.
    pub cell: &'a session::Cell,
    /// The change feed the core's other commands report through.
    pub changes: &'a ChangeFeed,
}

/// The sample's Locker commands, in order: one of each thing a member walks,
/// every secret a test value.
fn items() -> Vec<(&'static str, Value)> {
    vec![
        (
            "locker.add_item",
            json!({
                "item_id": "sample-locker-wifi", "type": "wifi", "title": "Cabin Wi-Fi",
                "network": "Tahoe Cabin", "password": "tahoe-cabin-guest"
            }),
        ),
        (
            "locker.add_item",
            json!({
                "item_id": "sample-locker-card", "type": "card", "title": "Sample Visa",
                "cardholder": "Sample Owner", "card_number": "4242424242424242",
                "expiry": "12/34", "cvv": "123", "brand": "Visa"
            }),
        ),
        (
            "locker.add_item",
            json!({
                "item_id": "sample-locker-stream", "type": "login", "title": "Streaming",
                "username": "maya@example.com", "password": "sample-stream-login-1",
                "url": "https://watch.example.com"
            }),
        ),
        (
            "locker.add_item",
            json!({
                "item_id": "sample-locker-door", "type": "note", "title": "Cabin door code",
                "content": "Keypad 0000#. A sample code that opens nothing."
            }),
        ),
        (
            "locker.add_item",
            json!({
                "item_id": "sample-locker-note", "type": "note", "title": "Secure note",
                "content": "Notes here are sealed like passwords. This one is sample text."
            }),
        ),
        (
            "locker.star_item",
            json!({ "item_id": "sample-locker-wifi" }),
        ),
    ]
}

/// Seed the sample's Locker. Answers the refusals, in the report's words; an
/// empty answer is a whole Locker.
pub(super) fn seed(
    vault: &Vault,
    registry: &Registry,
    principal: &Principal,
    sealing: &Sealing<'_>,
) -> Vec<String> {
    let unlock = session::answer(
        vault,
        registry,
        principal,
        Some(sealing.keys),
        sealing.cell,
        &wire::LockerSessionRequest {
            step: Some(wire::locker_session_request::Step::Unlock(
                wire::LockerUnlock {},
            )),
        },
        sealing.changes,
    );
    if let Err(error) = unlock {
        tracing::warn!(%error, "the sample's Locker would not unlock");
        return vec![format!("locker.unlock: {error}")];
    }
    let mut seeder = Seeder {
        vault,
        registry,
        principal,
        report: super::Report::default(),
    };
    for (position, (name, input)) in items().into_iter().enumerate() {
        let typed = wire::Command {
            name: name.to_owned(),
            input: serde_json::to_vec(&input).unwrap_or_default(),
            invoke_key: format!("sample-locker-{position}"),
            ..wire::Command::default()
        };
        // THE CORE'S OWN SEAL, as `Handle::call` runs it for a typed secret:
        // `Some` is the input with each secret as ciphertext under `K`, `None`
        // is a command that carries none (the star).
        let body = match session::seal_command(vault, sealing.cell, &typed) {
            Ok(Some(sealed)) => serde_json::from_slice(&sealed).ok(),
            Ok(None) => Some(input),
            Err(error) => {
                seeder.report.refused.push(format!("{name}: {error}"));
                None
            }
        };
        if let Some(body) = body {
            seeder.run(name, body);
        }
    }
    session::relock(sealing.cell);
    let mut refused = seeder.report.refused;
    refused.extend(
        seeder
            .report
            .gaps
            .into_iter()
            .map(|gap| format!("{gap}: no body")),
    );
    refused
}
