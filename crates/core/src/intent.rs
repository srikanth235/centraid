//! THE INTENT SINK, ON THE GATEWAY (#1025 S2).
//!
//! A write on a seat is an intent until the gateway says otherwise. This module
//! is the "otherwise": it takes an `Intent` off a `submit` stream, runs it on
//! the vault under the principal the connection's enrolled device resolves to,
//! and answers with an `Outcome` carrying **the commit position the effect
//! landed in**.
//!
//! That number is the whole point and it is why `ShutSink` had to go. The seat
//! does not clear an overlay when it is told `executed` — it parks at
//! `awaiting-change` and waits for its own cursor to reach the commit, so the
//! paint and the rows replace one another inside one transaction
//! (`centraid_seat::settlement`). A sink that reported itself shut left every
//! write queued forever; a sink that answered `executed` with no commit
//! position would park an intent nothing could ever settle, which is the
//! liveness bug `crates/sim` found on its first run.
//!
//! ## IDENTITY IS `(vault_id, intent_id, payload_hash)` AND NEVER THE DEVICE
//!
//! A seat file outlives its enrolment: a restored phone re-enrols under a new
//! endpoint id and replays intents this vault already executed
//! (`intent.proto`). So the idempotency key is the intent, and the device is
//! recorded beside it rather than folded into it — which is also what lets a
//! replay be answered from the ledger instead of re-executed.
//!
//! ## THE ORDER OF THE GATES IS THE CONTRACT
//!
//! 1. **The payload hash**, before anything is read. The bytes the seat hashed
//!    must be the bytes this gateway rehashes, compared in constant time.
//! 2. **A terminal outcome short-circuits the rest.** A replay of an intent
//!    this vault already finished is answered from the ledger — by
//!    `Vault::execute` itself, which owns `replica_intent_outcome` — and the
//!    two gates below are skipped, because a write that already happened
//!    cannot be refused for a base version that moved afterwards.
//! 3. **The predecessors**. An intent whose chain has not executed is `PARKED`
//!    waiting on the intent that has not, which is the only name a seat can
//!    match against its own outbox.
//! 4. **The declared read-set**. A version that moved is a `CONFLICT` carrying
//!    what the file actually holds; zero means the row is gone, which is a
//!    different remedy and so a different seat verdict.
//! 5. **The handler**, through `Command::with_intent`. Only now, and its own
//!    authority, validation and precondition gates run inside it.
//!
//! Gate 4 before gate 5 is not an optimisation: a handler that ran and then
//! discovered a stale base would have written rows for a decision the member
//! made against a screen that no longer exists.
//!
//! ## THE LEDGER IS THE VAULT'S, AND THIS MODULE DOES NOT WRITE IT
//!
//! `Vault::execute` already records `replica_intent_outcome`, refuses a reused
//! id with `assert_identity`, expires an outcome past its window and answers a
//! terminal one from the ledger without running the handler. It does that
//! under ITS OWN spelling of the payload — `(owner_schema, command name)` with
//! no base versions — so a row written here under the seat's spelling would
//! collide with the vault's on the very next retry and be refused as an id
//! reuse. Gates 3 and 4 therefore answer WITHOUT writing a ledger row: a parked
//! or conflicted intent is a live intent the seat will resubmit, and there is
//! nothing terminal to record.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::Vault;
use centraid_vault::commands::{Command, Registry};
use centraid_vault::intents::IntentPayload;

use crate::error::{CoreError, Result};

/// Run one submitted intent and answer with the gateway's fact about it.
///
/// `device_id` is the ENROLLED DEVICE the connection was admitted as, resolved
/// at the accept boundary and passed in. It is never read off the request: a
/// request field naming a device would let one seat submit as another.
pub fn submit(
    vault: &Vault,
    registry: &Registry,
    device_id: &str,
    intent: &wire::Intent,
) -> Result<wire::Outcome> {
    if intent.intent_id.is_empty() {
        return Err(CoreError::InvalidRequest {
            detail: "an intent carries no intent id; it is half the idempotency key".to_owned(),
        });
    }
    let claim = payload_of(intent)?;
    let expected = claim.hash().map_err(CoreError::Vault)?;
    if !constant_time_eq(&expected, &intent.payload_hash) {
        // THE BYTES THE SEAT HASHED ARE NOT THE BYTES THIS GATEWAY HAS. Not a
        // conflict and not a denial: the request is unusable, and running it
        // would execute something nobody signed for.
        return Err(CoreError::InvalidRequest {
            detail: format!(
                "intent `{}` claims a payload hash its payload does not produce",
                intent.intent_id
            ),
        });
    }

    // GATE 2 — is this a replay of something already finished? If so the two
    // gates below are skipped and `Vault::execute` answers from the ledger.
    let finished = vault
        .read(|connection| centraid_vault::intents::read_outcome(connection, &intent.intent_id))?
        .is_some_and(|existing| existing.is_terminal());

    if !finished {
        // GATE 3 — the chain. `depends_on` is in outbox order and every
        // predecessor must have EXECUTED; anything else parks, naming the
        // predecessor. A gateway that ran a successor first would apply a
        // member's edits in an order they never performed them in.
        if let Some(waiting) = unmet_predecessor(vault, &claim.depends_on)? {
            return Ok(wire::Outcome {
                intent_id: intent.intent_id.clone(),
                status: wire::IntentStatus::Parked as i32,
                waiting_on: vec![wire::WaitingOn {
                    seat: wire::WaitingOnSeat::Intent as i32,
                    // THE PREDECESSOR'S INTENT ID, which is the only name a
                    // seat can match against its own outbox (`intent.proto`).
                    label: waiting,
                }],
                ..Default::default()
            });
        }

        // GATE 4 — the declared read-set.
        let conflicts = stale_bases(vault, &claim.base_versions)?;
        if !conflicts.is_empty() {
            return Ok(wire::Outcome {
                intent_id: intent.intent_id.clone(),
                status: wire::IntentStatus::Conflict as i32,
                conflicts,
                ..Default::default()
            });
        }
    }

    // GATE 5 — the handler, under the ENROLLED DEVICE's principal and carrying
    // the intent id, which is what puts the ledger in charge of replay.
    let principal = centraid_vault::Principal::owner(device_id.to_owned());
    let command = Command::new(command_name(&claim), claim.input.clone())
        .with_intent(intent.intent_id.clone(), device_id.to_owned());
    let outcome = vault.execute(registry, &principal, &command)?;
    let commit_seq = outcome.commit_seq;
    Ok(wire::Outcome {
        intent_id: intent.intent_id.clone(),
        status: match outcome.status {
            centraid_vault::commands::CommandStatus::Executed => wire::IntentStatus::Executed,
            centraid_vault::commands::CommandStatus::Failed => wire::IntentStatus::Failed,
        } as i32,
        // THE NUMBER THE OVERLAY SETTLES AGAINST. `None` is an honest absence —
        // a handler that wrote nothing a session saw produced no commit — and
        // the seat's version-set path takes over. What must never happen is an
        // `EXECUTED` carrying neither, which `centraid_seat::settlement`
        // refuses loudly rather than parking an overlay forever; the
        // `answered_versions` below are what makes the fallback reachable.
        commit_seq: commit_seq.map(i64::unsigned_abs),
        answered_versions: claim
            .base_versions
            .iter()
            .map(|version| wire::BaseVersion {
                entity: version.entity.clone(),
                row_id: version.row_id.clone(),
                shape_id: version.shape_id.clone(),
                version: u64::try_from(version.version).unwrap_or(0),
            })
            .collect(),
        // THE AUTHOR'S SENTENCE, never the raw predicate. The predicate reaches
        // the audit trail and never a member.
        reason: outcome.reason.unwrap_or_default(),
        ..Default::default()
    })
}

/// The registered command an intent names.
///
/// `<app>.<action>` — the registry's own spelling (`core.add_party`) — unless
/// the action already carries its app, which is what a seat built from a
/// catalogue entry sends. Joining an already-joined name would ask for
/// `core.core.add_party` and be refused as unregistered.
pub fn command_name(claim: &IntentPayload) -> String {
    if claim.action.contains('.') {
        claim.action.clone()
    } else {
        format!("{}.{}", claim.app_id, claim.action)
    }
}

fn payload_of(intent: &wire::Intent) -> Result<IntentPayload> {
    let input: serde_json::Value = if intent.input.is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_slice(&intent.input).map_err(|error| CoreError::InvalidRequest {
            detail: format!("an intent's input is canonical JSON in bytes: {error}"),
        })?
    };
    Ok(IntentPayload {
        app_id: intent.app_id.clone(),
        action: intent.action.clone(),
        input,
        base_versions: intent
            .base_versions
            .iter()
            .map(|version| centraid_vault::intents::BaseVersion {
                entity: version.entity.clone(),
                row_id: version.row_id.clone(),
                shape_id: version.shape_id.clone(),
                version: i64::try_from(version.version).unwrap_or(i64::MAX),
            })
            .collect(),
        depends_on: intent.depends_on.clone(),
        // THE DECLARED BYTES (#1025 S3). Carried into the claim because they
        // are IN the payload hash: a gateway that dropped them here would
        // rehash a different preimage and refuse every intent that names a
        // photograph.
        needs: intent
            .needs
            .iter()
            .map(|need| centraid_vault::intents::NeededBytes {
                hash: need.hash.clone(),
                byte_size: i64::try_from(need.byte_size).unwrap_or(i64::MAX),
                media_type: need.media_type.clone(),
            })
            .collect(),
    })
}

/// THE BYTES THIS INTENT CANNOT RUN WITHOUT, once the payload hash has been
/// checked (#1025 S3).
///
/// The gateway's seat lane calls this BEFORE it submits, pulls what the answer
/// names over the connection the seat opened, and only then executes. The
/// payload-hash gate runs here and not at the call site for one reason: the
/// declaration is inside the hash, so a caller that read `intent.needs` without
/// verifying the hash would be fetching bytes off an unverified request — and
/// the answer would then be whatever a proxy wanted the gateway to go and get.
///
/// `submit` re-runs the same gate. That is deliberate and cheap: `submit` has
/// to be correct on its own, because it is also reachable from a caller that
/// holds no bytes at all.
pub fn needed_bytes(intent: &wire::Intent) -> Result<Vec<centraid_vault::intents::NeededBytes>> {
    let claim = payload_of(intent)?;
    let expected = claim.hash().map_err(CoreError::Vault)?;
    if !constant_time_eq(&expected, &intent.payload_hash) {
        return Err(CoreError::InvalidRequest {
            detail: format!(
                "intent `{}` claims a payload hash its payload does not produce",
                intent.intent_id
            ),
        });
    }
    Ok(claim.needs)
}

/// The first predecessor that has not executed, if any.
fn unmet_predecessor(vault: &Vault, depends_on: &[String]) -> Result<Option<String>> {
    for predecessor in depends_on {
        let outcome = vault
            .read(|connection| centraid_vault::intents::read_outcome(connection, predecessor))?;
        match outcome {
            Some(outcome) if outcome.status == "executed" => {}
            // UNKNOWN AND UNFINISHED ARE ONE ANSWER. A predecessor this gateway
            // has never seen is one the seat has not managed to submit yet, and
            // the successor waits for it exactly as it waits for one still in
            // flight.
            _ => return Ok(Some(predecessor.clone())),
        }
    }
    Ok(None)
}

/// Every declared base version that no longer matches the file.
///
/// An entity this build's ontology does not name, and a table with no
/// `row_version`, are BOTH "nothing was checked" rather than "it held". The
/// fifty-one unversioned tables are a recorded gap (`centraid_seat::occ`), and
/// pretending otherwise would claim a guarantee for exactly the tables that
/// register names.
fn stale_bases(
    vault: &Vault,
    declared: &[centraid_vault::intents::BaseVersion],
) -> Result<Vec<wire::Conflict>> {
    if declared.is_empty() {
        return Ok(Vec::new());
    }
    vault
        .read(|connection| {
            let mut conflicts = Vec::new();
            for version in declared {
                let Some(table) = table_of(&version.entity) else {
                    continue;
                };
                let Some(primary_key) = centraid_ontology::snapshot::primary_key_of(
                    connection, table,
                )
                .map_err(|error| centraid_vault::VaultError::Invariant {
                    context: format!("a base version's table has no readable key: {error}"),
                })?
                else {
                    continue;
                };
                let verdict = centraid_seat::occ_check(
                    connection,
                    table,
                    &primary_key,
                    &version.entity,
                    &version.row_id,
                    version.shape_id.as_deref(),
                    version.version,
                )
                .map_err(|error| centraid_vault::VaultError::Invariant {
                    context: format!("a base version could not be checked: {error}"),
                })?;
                if let centraid_seat::occ::OccVerdict::Moved(conflict) = verdict {
                    conflicts.push(wire::Conflict {
                        entity: conflict.entity,
                        row_id: conflict.row_id,
                        shape_id: conflict.shape_id,
                        expected_version: u64::try_from(conflict.expected_version).unwrap_or(0),
                        // ZERO MEANS THE ROW IS GONE, and `occ_check` already
                        // encodes it that way. `row_version` starts at 1, so the
                        // sentinel cannot collide.
                        actual_version: u64::try_from(conflict.actual_version).unwrap_or(0),
                    });
                }
            }
            Ok(conflicts)
        })
        .map_err(CoreError::from)
}

/// The physical table an entity name refers to.
///
/// Both spellings are accepted — `core.party` and `core_party` — because the
/// logical name is what an app declares and the physical one is what the log
/// carries, and a seat may have taken its base version from either.
fn table_of(entity: &str) -> Option<&'static str> {
    let registries = centraid_ontology::registries::v0_registries();
    registries
        .entities
        .iter()
        .find(|known| known.logical == entity || known.table == entity)
        .map(|known| known.table.as_str())
}

/// Compare two hex digests without an early exit.
///
/// The gateway compares the payload hash in constant time (v0:
/// `replica-intent-route.ts:257-260`). The value is not a secret on its own,
/// but an early-exit comparison over an attacker-chosen id is a byte-at-a-time
/// oracle for a digest that gates execution, and the cost of not having one is
/// this function.
fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0u8, |differing, (a, b)| differing | (a ^ b))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_digest_comparison_has_no_early_exit_and_still_answers_correctly() {
        assert!(constant_time_eq("abcd", "abcd"));
        assert!(!constant_time_eq("abcd", "abce"));
        assert!(!constant_time_eq("abcd", "abc"));
        assert!(constant_time_eq("", ""));
    }

    /// The registry spells a command `<app>.<action>`, and an action that
    /// already carries its app is not joined twice.
    #[test]
    fn a_command_name_is_joined_once_and_only_once() {
        let mut claim = IntentPayload {
            app_id: "core".to_owned(),
            action: "add_party".to_owned(),
            input: serde_json::Value::Null,
            base_versions: Vec::new(),
            depends_on: Vec::new(),
            needs: Vec::new(),
        };
        assert_eq!(command_name(&claim), "core.add_party");
        claim.action = "core.add_party".to_owned();
        assert_eq!(command_name(&claim), "core.add_party");
    }

    /// THE DECLARED BYTES ARE ONLY READABLE THROUGH THE HASH GATE (#1025 S3).
    ///
    /// An intent whose payload hash does not match is not a source of anything,
    /// least of all a list of blobs a gateway is about to go and fetch over a
    /// member's connection.
    #[test]
    fn needed_bytes_refuses_an_intent_whose_payload_hash_does_not_match() {
        let need = wire::NeededBytes {
            hash: "aa".repeat(32),
            byte_size: 7,
            media_type: "image/jpeg".to_owned(),
        };
        let mut intent = wire::Intent {
            intent_id: "i-1".to_owned(),
            app_id: "media".to_owned(),
            action: "add_asset".to_owned(),
            input: br#"{"staged_sha":"x"}"#.to_vec(),
            payload_hash: "0".repeat(64),
            needs: vec![need.clone()],
            ..Default::default()
        };
        assert!(needed_bytes(&intent).is_err(), "a wrong hash names nothing");

        // With the honest hash it answers the declaration, whole.
        intent.payload_hash = payload_of(&intent)
            .expect("a payload")
            .hash()
            .expect("hashes");
        let answered = needed_bytes(&intent).expect("the gate passes");
        assert_eq!(answered.len(), 1);
        assert_eq!(answered[0].hash, need.hash);
        assert_eq!(answered[0].byte_size, 7);
        assert_eq!(answered[0].media_type, "image/jpeg");

        // AND THE DECLARATION IS IN THE HASH: dropping it invalidates it.
        let mut stripped = intent.clone();
        stripped.needs.clear();
        assert!(
            needed_bytes(&stripped).is_err(),
            "a declaration outside the hash could be edited in flight"
        );
    }

    /// Both spellings of an entity resolve, and an entity this ontology does
    /// not name resolves to nothing rather than to a guess.
    #[test]
    fn an_entity_resolves_from_either_spelling() {
        assert_eq!(table_of("core.party"), Some("core_party"));
        assert_eq!(table_of("core_party"), Some("core_party"));
        assert_eq!(table_of("not.an.entity"), None);
    }
}
