//! The core's typed refusals, and their wire codes.
//!
//! Every variant maps to exactly one [`ErrorCode`], because a shell branches on
//! the code and a code that could mean two things is a branch that guesses.
//! The mapping is a function rather than a `#[repr]` so a new variant has to
//! choose, and so the choice is visible in one place.

use centraid_api_proto::core_v1::ErrorCode;

/// What the core refuses.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// The handle is closed. Every call after [`crate::Handle::close`] is this,
    /// and not a hang and not a panic.
    #[error("this core is closed")]
    Closed,

    /// The handle was poisoned by a caught panic. The shell restarts the core
    /// **deliberately** rather than carrying on over state nobody can vouch
    /// for. Carries the diagnostic id so a crash report and a log line name
    /// the same event.
    #[error("this core is poisoned by a caught panic ({diagnostic_id}); restart it")]
    Poisoned { diagnostic_id: String },

    /// THERE IS NO VAULT AT THIS PATH YET (#1025 S1, restated by #1029 §1).
    ///
    /// A state and not a fault: it is where a phone sits between installing
    /// the app and founding or restoring its first vault. The remedy is the
    /// one `ErrorCode::REBOOTSTRAP_REQUIRED` already names — get a copy — which
    /// is why it carries that code rather than a new one nothing on any shell
    /// would branch on differently.
    #[error("there is no vault at this path yet; create one, or restore one")]
    Unpaired,

    /// THIS FILE ALREADY HOLDS A VAULT, AND FOUNDING WOULD LAY A SECOND OVER IT
    /// (#1025 S7-9, re-homed by #1029 W5).
    ///
    /// It guarded `Handle::pair`, which bootstrapped a first copy into the file
    /// this core was open on. There is no pairing plane and no copy to take
    /// (#1029 §1), and the hazard moved intact to the door that replaced it:
    /// `crate::api::found` writes `core_vault`, and `Vault::found` mints a
    /// fresh id and inserts unconditionally — so a second found leaves TWO
    /// vault rows in one file, and `Vault::vault_id`'s `ORDER BY vault_id LIMIT
    /// 1` answers whichever of them sorted first. The member's own vault would
    /// start answering to a different id after a double tap.
    ///
    /// Refused BEFORE anything is written, and the vault that is here is left
    /// exactly as it was. The remedy is a fresh file, which a shell always has:
    /// `Shelf.freshVaultFile` names one no vault in the directory is using.
    #[error("this file already holds vault {vault_id}; found into a fresh file")]
    VaultAlreadyHeld { vault_id: String },

    /// THE ENDPOINT THIS DEVICE SPAWNED IS NOT THE ONE ITS GATEWAY ENROLLED
    /// (#1025 S7-13).
    ///
    /// The enrolment record the shell handed back names the public key the
    /// gateway put in its allowlist when this device paired — the gateway's own
    /// statement, derived from the connection iroh's TLS proved. If the
    /// endpoint that came up at open has a different key, the secret half is
    /// gone: a lost Keychain item, a store whose write silently failed, a
    /// record settled under one vault and a key under another.
    ///
    /// **Refused at open, and the network is NOT attached.** Dialling with an
    /// unenrolled identity is not a smaller failure — it is the SAME failure
    /// one round trip later, reported by the gateway as "an unenrolled peer"
    /// and rendered on the phone as a version-window sentence, which sends a
    /// member to update an app that is not the problem. Both keys are in
    /// `detail` for the log; the member reads a sentence about re-pairing.
    #[error("this device's endpoint is {found}, and its gateway enrolled {enrolled}")]
    IdentityMismatch { enrolled: String, found: String },

    /// A thin seat could not reach its gateway.
    #[error("the gateway is unreachable: {reason}")]
    Unavailable { reason: String },

    /// The request itself is wrong: a zero limit, a cursor with a non-decimal
    /// seq, a page query with no order column. Not the state.
    #[error("invalid request: {detail}")]
    InvalidRequest { detail: String },

    /// A message type or body this build does not carry.
    #[error("unsupported message: {type_url}")]
    Unsupported { type_url: String },

    /// Not built yet. **Never a silent stub** — a caller gets this and can say
    /// so, rather than getting an empty answer that looks like "no data".
    #[error("`{what}` is not yet available: {lands_in}")]
    NotYetAvailable {
        what: &'static str,
        lands_in: &'static str,
    },

    /// The action refuses to run without a gateway.
    #[error("`{app_id}.{action}` needs the gateway and this seat has none")]
    OnlineOnly { app_id: String, action: String },

    /// The request was cancelled by a `Cancel`.
    #[error("request {request_id} was cancelled")]
    Cancelled { request_id: u64 },

    /// A bounded read was asked to be cancelled. Bounded reads are bounded
    /// instead: cancelling one leaves a SQLite read transaction to be rolled
    /// back by a dropped future, which is how v0's four-statements-in-one-read
    /// rule gets broken (census seam 4).
    #[error("request {request_id} is a bounded read and is not cancellable")]
    NotCancellable { request_id: u64 },

    #[error(transparent)]
    Vault(#[from] centraid_vault::VaultError),

    #[error(transparent)]
    Protocol(#[from] centraid_protocol::ProtocolError),

    #[error(transparent)]
    Decode(#[from] prost::DecodeError),

    /// THE STALE-ARTIFACT REFUSAL, at `open` (#1020 Artifacts, D-1020-G2).
    ///
    /// The shell passed an `expectedIdentity` its own build recorded and this
    /// core's digest is a different one. Refused before the handle exists, so
    /// nothing answers a single call from the wrong schema.
    #[error(
        "stale core refused: the shell expects digest {expected} and this core is {found};          rebuild or re-download the prebuilt core for this commit"
    )]
    StaleCore { expected: String, found: String },

    #[error("core invariant: {context}")]
    Invariant { context: String },
}

impl CoreError {
    /// The one code a shell branches on.
    #[must_use]
    pub fn code(&self) -> ErrorCode {
        match self {
            // A closed or poisoned handle is INTERNAL from the shell's side:
            // the remedy is the same, which is to restart the core.
            Self::Closed | Self::Poisoned { .. } | Self::Invariant { .. } => ErrorCode::Internal,
            // THE VERSION WINDOW, not `Internal`. "This app and that core are
            // not the same build" is the same remedy as "these two are too far
            // apart to talk" — update the one the diagnostics screen names —
            // and a shell that branched on `Internal` would offer a restart,
            // which cannot fix it (#1020 wave 3).
            Self::StaleCore { .. } => ErrorCode::VersionWindow,
            Self::Unavailable { .. } => ErrorCode::PeerUnreachable,
            Self::Unpaired => ErrorCode::RebootstrapRequired,
            Self::VaultAlreadyHeld { .. } => ErrorCode::VaultAlreadyHeld,
            Self::IdentityMismatch { .. } => ErrorCode::IdentityMismatch,
            Self::InvalidRequest { .. } | Self::NotCancellable { .. } | Self::Decode(_) => {
                ErrorCode::InvalidRequest
            }
            Self::Unsupported { .. } => ErrorCode::UnsupportedMessage,
            Self::NotYetAvailable { .. } => ErrorCode::NotYetAvailable,
            Self::OnlineOnly { .. } => ErrorCode::OnlineOnly,
            Self::Cancelled { .. } => ErrorCode::Cancelled,
            Self::Vault(vault) => vault_code(vault),
            Self::Protocol(_) => ErrorCode::MalformedFrame,
        }
    }

    /// The diagnostic id, when this error has one.
    #[must_use]
    pub fn diagnostic_id(&self) -> Option<&str> {
        match self {
            Self::Poisoned { diagnostic_id } => Some(diagnostic_id),
            _ => None,
        }
    }

    /// THE OWNER-FACING SENTENCE, derived from [`Self::code`] and nothing else.
    ///
    /// Lane E's shell showed a member
    /// `entity id is already held by another kind: core_party (#916)` — a
    /// SQLite `RAISE(ABORT)` from a trigger, carried out through `detail`
    /// because that was the only string on the message (#1020 wave 3, lane E
    /// finding 2). `error.proto` already said that no free-text reason reaches
    /// a member; it just gave a shell nothing else to render.
    ///
    /// So this function reads the CODE, never `self`'s own `Display`. That is
    /// the whole mechanism: a database message, a file path, a SQL fragment or
    /// a panic payload cannot reach a member through a function that does not
    /// look at them. `to_wire` keeps the raw text in `detail` for the audit
    /// trail, which is where `command.proto`'s rule says a predicate belongs.
    #[must_use]
    pub fn sentence(&self) -> String {
        sentence_for_code(self.code()).to_owned()
    }

    /// The wire `Error`. `detail` is **for logs only** — a shell renders
    /// [`Self::sentence`], or its own words for the code, and never `detail`.
    #[must_use]
    pub fn to_wire(&self) -> centraid_api_proto::core_v1::Error {
        centraid_api_proto::core_v1::Error {
            code: self.code() as i32,
            detail: self.to_string(),
            diagnostic_id: self.diagnostic_id().unwrap_or_default().to_owned(),
            sentence: self.sentence(),
            // NONE, AND NOT BECAUSE IT IS UNIMPLEMENTED (#1029 W5). `moved`
            // carries `lease.proto`'s `VaultMoved` on an
            // `ERROR_CODE_VAULT_MOVED`, and that code is a GATEWAY's refusal:
            // it means "you held this vault and a higher epoch took it", which
            // is a statement about a lease this core neither holds nor hears
            // about. `CoreError` has no variant that maps to it, so there is no
            // arm here that could fill it in — and a core that invented an
            // epoch and a date would be the second mechanism F1 forbids.
            moved: None,
        }
    }
}

/// THE OWNER-FACING SENTENCE for a code.
///
/// One table, reached by `CoreError::sentence` and by any path that produces a
/// code without a `CoreError` variant of its own. A shell may render it
/// verbatim or branch on the code and use its own words;
/// what it must not do is render `Error.detail`, which is where the raw
/// predicate lives (#1020 wave 3, lane E finding 2).
#[must_use]
pub fn sentence_for_code(code: ErrorCode) -> &'static str {
    use ErrorCode as C;
    match code {
        C::Unspecified => "Something went wrong and this build could not say what.",
        C::Unauthorized => {
            "This device is not enrolled on that vault, or its access was withdrawn."
        }
        C::VersionWindow => {
            "This app and that gateway are too far apart in version to talk. Update the one the \
             diagnostics screen names."
        }
        C::MalformedFrame => {
            "The connection carried something this build could not read, so it was closed."
        }
        C::UnsupportedMessage => "That is something this build does not know how to do.",
        C::NoRelayReachable => {
            "No route to the gateway was found. Check the network at either end."
        }
        C::PeerUnreachable => "The gateway did not answer.",
        C::Timeout => "That took too long and was given up on rather than left hanging.",
        C::Cancelled => "Cancelled.",
        C::RebootstrapRequired => {
            "This device has to take a fresh copy of the vault before it can catch up."
        }
        C::InvalidRequest => {
            "That request does not make sense to this build, and nothing was changed."
        }
        C::SnapshotUnavailable => "The gateway has nowhere to build a copy of the vault right now.",
        // THE VAULT ALREADY HERE IS THE ONE THIS PROTECTS, and the sentence
        // says so rather than naming a file: the member's vault is intact,
        // which is the fact they need. Mobile rarely renders it — `Shelf.found`
        // founds into a fresh file every time — so this is the sentence for the
        // caller that got there another way (#1025 S7-9, #1029 W5).
        C::VaultAlreadyHeld => {
            "There is already a vault in that file, so it was left alone. Make a new one."
        }
        // WHAT IS WRONG IS THE CREDENTIAL, AND THE REMEDY IS PAIRING AGAIN
        // (#1025 S7-13). It names neither key — they are 64 hex characters
        // apiece and mean nothing to a member — and it does not blame the
        // gateway, which is behaving correctly by not knowing this device.
        C::IdentityMismatch => {
            "This device's key for that vault is gone, so the gateway no longer recognises it. \
             Pair it again."
        }
        C::IntentHashMismatch => {
            "That request does not match what was submitted with it, so it was not run."
        }
        C::IntentIdReused => {
            "That request was already answered once, with different contents. Start it again."
        }
        C::IntentOutcomeExpired => {
            "The answer to that request is too old to reuse. Send it again as a new one."
        }
        C::ReadSetIncomplete => {
            "That change did not declare everything it reads, so it was refused rather than run \
             on a guess."
        }
        C::OnlineOnly => "That one needs the gateway, and this device cannot reach it.",
        C::Denied => "That is not allowed for this app.",
        // RETRYABLE, and the sentence says the device is still working rather
        // than that anything went wrong: the write is in the queue, its bytes
        // are on this phone, and the next window carries them (#1025 S3).
        C::BytesNotYetHeld => "That file has not finished sending yet.",
        C::DowngradeRefused => {
            "This vault was written by a newer version of Centraid. Update this one rather than \
             risk the file."
        }
        C::UpgradeRequired => "This vault needs an upgrade this version does not carry.",
        C::NotYetAvailable => "That part is not built yet.",
        C::Internal => {
            "Centraid hit a problem of its own and stopped rather than carry on. Restarting it is \
             safe."
        }

        // --- the gateway (#1029 §3) ---
        //
        // Every sentence here is written for somebody whose backup did not go
        // through, and none of them names a key, a hash or an object: those are
        // 64 hex characters and mean nothing to a member. Several say the
        // reassuring thing FIRST, because the true fact in most of these is
        // that nothing was lost.

        // THE ONE WITH A BEHAVIOUR ATTACHED. The phone freezes this vault
        // read-only and keeps its unacked spool, so the sentence has to make
        // the freeze make sense — and it has to say the changes are still
        // there, because they are and they are the only thing at stake.
        C::VaultMoved => {
            "This vault has moved to another phone. It is read-only here, and any changes made on \
             this phone since then are still on it."
        }
        C::GatewaySignatureInvalid => {
            "The backup service did not recognise this phone. Check it is set up for this vault."
        }
        // The remedy is automatic — the phone re-signs once with the server's
        // own time — so this reaches a member only when that failed too.
        C::GatewayClockSkew => {
            "This phone's clock is too far from the backup service's. Check the date and time."
        }
        C::GatewayChecksumMissing | C::GatewayChecksumMismatch => {
            "Some of the backup did not arrive intact, so it was not accepted. It will be sent \
             again."
        }
        C::GatewayAlreadyCommitted => "That part of the backup is already saved.",
        C::GatewayObjectUnknown => {
            "Part of the backup was missing when it was saved, so nothing was recorded. It will \
             be sent again."
        }
        C::GatewayObjectTooLarge => {
            "That file was sent in a piece larger than the backup service accepts."
        }
        // The compare-and-set fence (F7). The member's action is to look at the
        // other phone, which is the only thing that can explain it.
        C::GatewayHeadConflict => {
            "Another phone backed this vault up first. Nothing was overwritten; open Centraid on \
             the other phone to see what it holds."
        }
        C::GatewayLeaseStale | C::GatewayNotLeaseHolder => {
            "Another phone holds this vault now, so this one cannot back it up."
        }
        C::GatewayQuotaExceeded => {
            "This vault has used all its backup space. Free some up, or move to a larger plan."
        }
        // READ-ONLY, NOT DELETED, and the sentence leads with that: the whole
        // reason the rule exists is that a member who let a plan lapse finds
        // their backup where they left it (F13).
        C::GatewayPlanLapsed => {
            "This plan has lapsed. The backup is still there and can still be restored; nothing \
             new is being saved."
        }
        C::GatewayDeleteRefused => {
            "The backup service kept that rather than deleting it. Backups are held for a set \
             time so an older one can always be restored."
        }
        C::GatewayCapabilityScope => "That share is no longer available.",
        C::GatewayMailboxRefused => {
            "That could not be delivered right now. It will be tried again later."
        }
    }
}

fn vault_code(error: &centraid_vault::VaultError) -> ErrorCode {
    use centraid_vault::VaultError as V;
    if error.is_disk_full() {
        // No dedicated code: a full disk is the file refusing, and the shell's
        // remedy (tell the member to clear space) is the same as for any other
        // internal failure of the file. Named here rather than left implicit so
        // the choice is a choice.
        return ErrorCode::Internal;
    }
    match error {
        V::RebootstrapRequired { .. } => ErrorCode::RebootstrapRequired,
        V::DowngradeRefused { .. } => ErrorCode::DowngradeRefused,
        V::NotImplemented { .. } => ErrorCode::NotYetAvailable,
        V::InvalidInput { .. }
        | V::InvalidCursor { .. }
        | V::UnknownCommand { .. }
        | V::OntologyVersionMismatch { .. } => ErrorCode::InvalidRequest,
        V::IntentRefused { refusal, .. } => intent_refusal_code(*refusal),
        _ => ErrorCode::Internal,
    }
}

fn intent_refusal_code(refusal: centraid_vault::IntentRefusal) -> ErrorCode {
    use centraid_vault::IntentRefusal as R;
    match refusal {
        // The SAME code for both: `intent_already_terminal` is a reused id seen
        // from the other side — the ledger holds an answer and is being asked
        // for a different one. A shell's remedy is identical (mint a new id).
        R::IdReused | R::AlreadyTerminal => ErrorCode::IntentIdReused,
        R::OutcomeExpired => ErrorCode::IntentOutcomeExpired,
    }
}

pub type Result<T> = std::result::Result<T, CoreError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closed_handle_is_a_typed_error_and_not_a_hang() {
        let error = CoreError::Closed;
        assert_eq!(error.code(), ErrorCode::Internal);
        assert!(error.diagnostic_id().is_none());
    }

    #[test]
    fn a_poisoned_handle_carries_the_diagnostic_id_onto_the_wire() {
        let error = CoreError::Poisoned {
            diagnostic_id: "diag-1".to_owned(),
        };
        let wire = error.to_wire();
        assert_eq!(wire.diagnostic_id, "diag-1");
        assert_eq!(wire.code, ErrorCode::Internal as i32);
        // And the DETAIL is for logs. It is present, and a shell must not
        // render it; the test records the intent rather than enforcing it.
        assert!(!wire.detail.is_empty());
    }

    #[test]
    fn a_vault_that_must_be_replaced_carries_the_rebootstrap_code() {
        assert_eq!(CoreError::Unpaired.code(), ErrorCode::RebootstrapRequired);
        assert_eq!(
            CoreError::Vault(centraid_vault::VaultError::RebootstrapRequired {
                reason: centraid_vault::RebootstrapReason::EpochMismatch,
            })
            .code(),
            ErrorCode::RebootstrapRequired
        );
    }

    #[test]
    fn a_bounded_read_refusing_to_be_cancelled_is_an_invalid_request_not_an_internal_error() {
        // The peer asked for something the protocol does not offer. That is the
        // peer's mistake, not a failure of this core.
        assert_eq!(
            CoreError::NotCancellable { request_id: 7 }.code(),
            ErrorCode::InvalidRequest
        );
        assert_eq!(
            CoreError::Cancelled { request_id: 7 }.code(),
            ErrorCode::Cancelled
        );
    }

    #[test]
    fn a_not_yet_available_capability_names_where_it_lands() {
        let error = CoreError::NotYetAvailable {
            what: "content",
            lands_in: "wave 3",
        };
        assert_eq!(error.code(), ErrorCode::NotYetAvailable);
        assert!(error.to_string().contains("wave 3"));
    }

    /// **NO REFUSAL PAYLOAD SHIPS SQL.** The demonstrated red for lane E
    /// finding 2 (#1020 wave 3).
    ///
    /// The refusal a member actually saw was a SQLite `RAISE(ABORT)` from an
    /// entity-kind trigger, reaching the screen through `Error.detail` because
    /// that was the only string the message carried. The sentence is now built
    /// from the code, so the trigger's words cannot get into it — and `detail`
    /// still carries them, because the audit trail is what they are for.
    #[test]
    fn the_owner_facing_sentence_carries_no_database_text_and_the_detail_still_does() {
        // Verbatim, from `contracts/schema/vault-ddl.sql`'s trigger and from
        // lane E's Kotlin run through the real C ABI.
        let raised = "entity id is already held by another kind: core_party (#916)";
        let error = CoreError::Vault(centraid_vault::VaultError::Invariant {
            context: raised.to_owned(),
        });
        let wire = error.to_wire();

        assert!(
            wire.detail.contains(raised),
            "the audit trail keeps the predicate: {}",
            wire.detail
        );
        assert!(
            !wire.sentence.contains(raised),
            "and the owner-facing sentence does not: {}",
            wire.sentence
        );
        assert_eq!(wire.code, ErrorCode::Internal as i32);

        // And not by luck: nothing that looks like a schema object or a SQL
        // keyword appears in ANY code's sentence.
        for code in EVERY_CODE {
            let sentence = sentence_for_code(code);
            assert!(!sentence.is_empty(), "{code:?} has no sentence");
            let lowered = sentence.to_lowercase();
            // SQL-SHAPED, not merely English: `update` is a word an owner
            // reads ("update this one"), `update ... set` is a statement.
            for fragment in [
                "select ",
                "insert into",
                "delete from",
                " set ",
                "raise(",
                "sqlite",
                "pragma ",
                "constraint",
                "core_",
                "knowledge_",
                "media_",
                "_json",
                "#916",
                "(#",
            ] {
                assert!(
                    !lowered.contains(fragment),
                    "`{code:?}`'s sentence contains `{fragment}`: {sentence}"
                );
            }
        }
    }

    /// Every code the enum carries, so the sweep above cannot miss one: a new
    /// code with no sentence is a code whose refusal renders as nothing.
    const EVERY_CODE: [ErrorCode; 22] = [
        ErrorCode::Unspecified,
        ErrorCode::Unauthorized,
        ErrorCode::VersionWindow,
        ErrorCode::MalformedFrame,
        ErrorCode::UnsupportedMessage,
        ErrorCode::NoRelayReachable,
        ErrorCode::PeerUnreachable,
        ErrorCode::Timeout,
        ErrorCode::Cancelled,
        ErrorCode::RebootstrapRequired,
        ErrorCode::InvalidRequest,
        ErrorCode::SnapshotUnavailable,
        ErrorCode::IntentHashMismatch,
        ErrorCode::IntentIdReused,
        ErrorCode::IntentOutcomeExpired,
        ErrorCode::ReadSetIncomplete,
        ErrorCode::OnlineOnly,
        ErrorCode::Denied,
        ErrorCode::DowngradeRefused,
        ErrorCode::UpgradeRequired,
        ErrorCode::NotYetAvailable,
        ErrorCode::Internal,
    ];
}
