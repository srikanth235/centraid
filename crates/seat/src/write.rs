//! THE SEAT'S WRITE DOOR: a member's edit becomes a queued intent (#1025 S5).
//!
//! ## The hole this closes
//!
//! Everything downstream of `seat_outbox` existed and was tested —
//! [`crate::IntentRecord`], the table, [`crate::outbox::pinned_blobs`], the
//! live `IntentSink`, [`crate::Outbox::overlaid`]'s paint,
//! [`crate::settlement::settle_at_commit_seq`] — and **nothing anywhere wrote
//! the row they all operate on**. `Request::Intent` is the only write verb on
//! the five-symbol ABI and the core refused it on exactly the role that needs
//! it, so a member who edited a note with the gateway away watched "Saving"
//! forever over an outbox with zero rows in it. S3's receipt half-said it:
//! "`needs_blobs` is written by whoever builds the `IntentRecord`, and today
//! that is a test or a shell." There was no shell that could.
//!
//! ## THE CORE COMPUTES THE HASH, AND A DECLARED ONE IS AN ERROR
//!
//! `(vault_id, intent_id, payload_hash)` is the identity and the gateway
//! rehashes the canonical payload, so the hash is computed HERE, by
//! [`crate::payload::PayloadHash`], which delegates to `centraid_vault`'s own
//! canonicalisation — the same code the gateway rehashes with, so the two
//! cannot drift. The input the shell sent is carried through untouched and
//! never rebuilt from something else.
//!
//! **A non-empty declared hash is REFUSED** rather than trusted or ignored
//! (D-1025-S4-6). It is lowercase-hex BLAKE3, and neither `CryptoKit` nor
//! `MessageDigest` nor `crypto.subtle` offers BLAKE3 — so a shell that filled
//! that field filled it with a different function's value under the vault's
//! name, which is the exact defect S4 closed by deleting
//! `MediaLibrary.Asset.sha256`. Ignoring it would let a shell believe it had
//! authenticated something; accepting it when it matches is a check that can
//! never fire, because a shell that could produce the right value would not
//! have needed the rule. "The shell declares no digest" is only a rule if
//! declaring one is an error.
//!
//! The GATEWAY path is untouched: an intent arriving over the wire from another
//! seat carries a hash its own seat computed, and
//! `centraid_core::intent::submit` still checks it against the bytes in
//! constant time.
//!
//! ## WHAT IT DOES NOT DO
//!
//! It does not paint. [`crate::IntentRecord::optimistic`] is the seat's
//! optimistic image and it is supplied by whoever builds the record; the wire
//! `Intent` has no field for one, so a write queued through this door is
//! `overlaid()` with **no image**, and the seat's own `read_page` shows the
//! mirrored row unchanged until the commit arrives. That is stated rather than
//! quietly wired: a shell drawing "Saved" over a read that still shows the old
//! value needs to know which half it is getting, and inventing an image here —
//! guessing what the handler will write — is how a screen ends up showing a
//! value the gateway never agreed to.

use rusqlite::Connection;

use crate::error::{Result, SeatError};
use crate::intent::{IntentRecord, IntentState};
use crate::outbox::Outbox;
use crate::payload::PayloadHash;

/// One write, as a shell hands it over.
///
/// Deliberately not the wire type: `crates/seat` does not depend on
/// `centraid-api-proto` and should not — the queue is a fact about this
/// replica, and the crate that speaks protobuf converts.
#[derive(Debug, Clone)]
pub struct Queueing {
    /// Half the idempotency key, and the shell's to mint: an intent replayed
    /// after a restore must carry the id the gateway already answered.
    pub intent_id: String,
    pub app_id: String,
    pub action: String,
    /// The input, EXACTLY as the shell sent it. Hashed, stored and later put on
    /// the wire unchanged.
    pub input: serde_json::Value,
    pub base_versions: Vec<centraid_vault::intents::BaseVersion>,
    pub depends_on: Vec<String>,
    /// The bytes this write cannot execute without (#1025 S3). IN the payload
    /// hash, which is what stops a gateway being told to fetch bytes the member
    /// never signed for.
    pub needs_blobs: Vec<centraid_vault::intents::NeededBytes>,
    /// THE HASH A CALLER DECLARED, WHICH MUST BE EMPTY (D-1025-S4-6).
    ///
    /// Carried so the door can refuse a non-empty one by name rather than
    /// silently dropping it. A shell has no BLAKE3, so a value here is a
    /// different function's digest wearing the vault's name.
    pub declared_hash: String,
    /// A write that must never reach the durable queue — a Locker reveal, an
    /// export. [`Outbox::enqueue`] refuses one, at the point of QUEUING rather
    /// than the point of sending.
    pub online_only: bool,
}

/// Write the outbox row, and hand back the record that is now in it.
///
/// The record carries the `created_order` the queue assigned, because that
/// number is the member's own order and a caller that wants to say anything
/// about position needs it.
pub fn queue_write(
    connection: &Connection,
    queueing: &Queueing,
    now: &str,
) -> Result<IntentRecord> {
    if queueing.intent_id.is_empty() {
        return Err(SeatError::Invariant {
            context: "a write carries no intent id; it is half the idempotency key".to_owned(),
        });
    }
    // COMPUTED FROM WHAT THE SHELL SENT, by the vault's own canonicalisation —
    // the same code the gateway rehashes with.
    let hash = PayloadHash::of(
        &queueing.app_id,
        &queueing.action,
        &queueing.input,
        &queueing.base_versions,
        &queueing.depends_on,
        &queueing.needs_blobs,
    )?;
    if !queueing.declared_hash.is_empty() {
        // A DECLARED DIGEST IS AN ERROR ON THIS PATH (D-1025-S4-6). The value
        // cannot have been BLAKE3 — no shell toolkit has it — so it is another
        // function's digest under this vault's name, and the only two other
        // answers are worse: ignoring it lets a shell believe it authenticated
        // something, and accepting it when it matches is a check that can never
        // fire.
        return Err(SeatError::Invariant {
            context: format!(
                "write `{}` declares a payload hash; a seat computes its own",
                queueing.intent_id
            ),
        });
    }
    let record = IntentRecord {
        intent_id: queueing.intent_id.clone(),
        // ASSIGNED BY THE QUEUE, not by the caller. `Outbox::enqueue` takes
        // `MAX(created_order) + 1` and answers it; this is a placeholder until
        // it does, and the record handed back carries the real one.
        created_order: 0,
        app_id: queueing.app_id.clone(),
        action: queueing.action.clone(),
        input: queueing.input.clone(),
        payload_hash: hash.as_str().to_owned(),
        // QUEUED, which is the one state a write starts in: `sending` is what a
        // drain sets, and a row that began there would be an intent nothing
        // retries if the process died before it sent.
        state: IntentState::Queued,
        attempts: 0,
        depends_on: queueing.depends_on.clone(),
        base_versions: queueing.base_versions.clone(),
        // NO IMAGE. See the module header: the wire carries none and guessing
        // what the handler will write is how a screen shows a value the gateway
        // never agreed to.
        optimistic: None,
        commit_seq: None,
        waiting_on: Vec::new(),
        needs_blobs: queueing.needs_blobs.clone(),
        enqueued_at: now.to_owned(),
        updated_at: now.to_owned(),
        reason: None,
        conflicts: Vec::new(),
        online_only: queueing.online_only,
    };
    let order = Outbox::open(connection)?.enqueue(&record, now)?;
    Ok(IntentRecord {
        created_order: order,
        ..record
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-01-01T00:00:00.000Z";

    fn seat() -> Connection {
        let connection = Connection::open_in_memory().expect("opens");
        Outbox::open(&connection).expect("the queue");
        connection
    }

    fn queueing() -> Queueing {
        Queueing {
            intent_id: "i-1".to_owned(),
            app_id: "core".to_owned(),
            action: "add_party".to_owned(),
            input: serde_json::json!({ "display_name": "Offline", "kind": "person" }),
            base_versions: Vec::new(),
            depends_on: Vec::new(),
            needs_blobs: Vec::new(),
            declared_hash: String::new(),
            online_only: false,
        }
    }

    /// THE ROW EXISTS, which until this door nothing anywhere produced.
    #[test]
    fn a_write_lands_in_the_queue_as_queued_with_the_order_it_was_given() {
        let connection = seat();
        let queued = queue_write(&connection, &queueing(), NOW).expect("it queues");
        assert_eq!(queued.state, IntentState::Queued);
        assert_eq!(queued.created_order, 1, "the queue assigned no order");
        assert_eq!(queued.attempts, 0);

        let held = Outbox::open(&connection)
            .expect("the queue")
            .all()
            .expect("reads");
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].intent_id, "i-1");
        assert_eq!(held[0].payload_hash, queued.payload_hash);
        // A SECOND WRITE IS SECOND. The order is the member's own.
        let mut next = queueing();
        next.intent_id = "i-2".to_owned();
        assert_eq!(
            queue_write(&connection, &next, NOW)
                .expect("it queues")
                .created_order,
            2
        );
    }

    /// THE HASH IS THE GATEWAY'S. Computed over the payload the shell sent, so
    /// the number the gateway rehashes is the number in the row.
    #[test]
    fn the_hash_is_the_one_the_gateway_will_recompute() {
        let connection = seat();
        let queueing = queueing();
        let queued = queue_write(&connection, &queueing, NOW).expect("it queues");
        let expected = PayloadHash::of(
            &queueing.app_id,
            &queueing.action,
            &queueing.input,
            &queueing.base_versions,
            &queueing.depends_on,
            &queueing.needs_blobs,
        )
        .expect("hashes");
        assert_eq!(queued.payload_hash, expected.as_str());
        // 64 lowercase hex, which is what the gateway's `/^[a-f0-9]{64}$/`
        // requires and what a `to_uppercase` anywhere would have broken.
        assert_eq!(queued.payload_hash.len(), 64);
        assert!(
            queued
                .payload_hash
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        );
    }

    /// A DECLARED DIGEST IS AN ERROR, EVEN A CORRECT ONE (D-1025-S4-6).
    ///
    /// No shell toolkit has BLAKE3, so a value in that field is a different
    /// function's digest under this vault's name — the defect S4 closed by
    /// deleting `MediaLibrary.Asset.sha256`. Refusing only a WRONG one would be
    /// a check that never fires, because a caller able to produce the right
    /// value would not have needed the rule; so the correct value is refused
    /// too, and that is the assertion worth having.
    #[test]
    fn a_declared_payload_hash_is_refused_even_when_it_is_the_right_one() {
        let connection = seat();
        let mut lying = queueing();
        lying.declared_hash = "0".repeat(64);
        assert!(queue_write(&connection, &lying, NOW).is_err());
        assert!(
            Outbox::open(&connection)
                .expect("the queue")
                .all()
                .expect("reads")
                .is_empty(),
            "a refused write was stored anyway"
        );

        let mut correct = queueing();
        correct.declared_hash = PayloadHash::of(
            &correct.app_id,
            &correct.action,
            &correct.input,
            &correct.base_versions,
            &correct.depends_on,
            &correct.needs_blobs,
        )
        .expect("hashes")
        .as_str()
        .to_owned();
        assert!(
            queue_write(&connection, &correct, NOW).is_err(),
            "a declared digest was accepted because it happened to be right"
        );
    }

    /// AN `online_only` WRITE NEVER REACHES THE DURABLE QUEUE. The refusal is
    /// the outbox's and it is at the point of QUEUING: a Locker reveal that
    /// reached the store is a mass reveal waiting for the next drain.
    #[test]
    fn an_online_only_write_is_refused_and_leaves_nothing_behind() {
        let connection = seat();
        let mut reveal = queueing();
        reveal.online_only = true;
        reveal.app_id = "locker".to_owned();
        reveal.action = "reveal".to_owned();
        assert!(matches!(
            queue_write(&connection, &reveal, NOW),
            Err(SeatError::OnlineOnly { .. })
        ));
        assert!(
            Outbox::open(&connection)
                .expect("the queue")
                .all()
                .expect("reads")
                .is_empty()
        );
    }

    /// THE DECLARED BYTES SURVIVE THE ROUND TRIP (#1025 S3). They are in the
    /// hash, so a door that dropped them would queue a write the gateway
    /// refuses — and `pinned_blobs` would then not know to keep the only copy
    /// of the member's photograph.
    #[test]
    fn the_declared_bytes_are_stored_and_are_in_the_hash() {
        let connection = seat();
        let mut with_bytes = queueing();
        with_bytes.needs_blobs = vec![centraid_vault::intents::NeededBytes {
            hash: "a".repeat(64),
            byte_size: 1_024,
            media_type: "image/jpeg".to_owned(),
        }];
        let queued = queue_write(&connection, &with_bytes, NOW).expect("it queues");
        assert_eq!(queued.needs_blobs.len(), 1);
        let pinned = crate::outbox::pinned_blobs(&connection).expect("reads");
        assert_eq!(pinned, vec!["a".repeat(64)]);
        // AND THE HASH DIFFERS from the same write without them, which is the
        // property that stops a gateway being told to fetch bytes nobody
        // signed for.
        assert_ne!(
            queued.payload_hash,
            queue_write(
                &connection,
                &Queueing {
                    intent_id: "i-2".to_owned(),
                    ..queueing()
                },
                NOW
            )
            .expect("it queues")
            .payload_hash
        );
    }

    /// A WRITE WITH NO ID IS REFUSED. It is half the idempotency key, and a row
    /// without one is a write the gateway can never answer twice the same way.
    #[test]
    fn a_write_with_no_intent_id_is_refused() {
        let connection = seat();
        let mut nameless = queueing();
        nameless.intent_id = String::new();
        assert!(queue_write(&connection, &nameless, NOW).is_err());
    }
}
