//! What a core is opened as.

use std::path::PathBuf;

/// Which of the three this core is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Role {
    /// The authority. D1's vault is the truth, the doors serve seats, and the
    /// endpoint (when configured) accepts them.
    Gateway,
    /// A mirror, thin or replicated.
    ///
    /// **NO GATEWAY ID (#1025 S1, D-1025-S1-1).** The role says what this core
    /// is; WHERE the vault is reached is a property of the pairing record and
    /// changes when the owner moves the vault to another machine. A role that
    /// carried an endpoint id would make "which gateway" part of what a core
    /// IS, and a restore would then be a different core over the same file.
    Seat { kind: SeatKind },
}

/// How much of the vault a seat holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeatKind {
    /// A full local mirror with its own file and its own outbox. Answers reads
    /// offline; queues writes.
    Replicated,
    /// No local rows. Every call is forwarded to the gateway **under the
    /// caller's principal**, and answered [`crate::CoreError::Unavailable`]
    /// when the gateway cannot be reached.
    ///
    /// Forwarding under the caller's principal and not the seat's is the whole
    /// security property: a thin seat is a pipe, not a deputy, and a gateway
    /// that trusted "the seat says so" would have no authority plane left.
    Thin,
}

/// How to open a core.
pub struct CoreConfig {
    /// The vault file. A gateway's authority; a replicated seat's mirror. A
    /// thin seat still has one, because `seat_state` and the outbox live in it
    /// even when no rows do.
    pub path: PathBuf,
    pub role: Role,
    /// The name the shell gave its UI thread, when it named one.
    ///
    /// A debug assertion in [`crate::Handle::call`] fires when the calling
    /// thread is this one. `None` means the shell did not say, and then no
    /// assertion is possible — which is honest, and better than asserting
    /// against a guess like "the main thread", since a gateway's main thread is
    /// exactly where `call` belongs.
    pub ui_thread_name: Option<String>,
    /// Create the file when it is not there. A gateway founding a new vault
    /// wants this; a seat installing a snapshot does not, because the file it
    /// expects is the artifact it just downloaded and a fresh empty one would
    /// be a silently empty product.
    pub create: bool,
    /// The clock this core's writes are stamped with. `None` is the system
    /// clock.
    ///
    /// Injectable because **a core on the real wall clock is not
    /// reproducible**, and `crates/sim` needs it to be: the deterministic
    /// simulation found this itself — two runs of one seed produced identical
    /// rows and different timestamps, and the receipt hashes over those
    /// timestamps then differed too. A seed that cannot be replayed byte for
    /// byte is a seed that cannot be recorded (#1020).
    pub clock: Option<std::sync::Arc<dyn centraid_vault::Clock>>,
    /// The id source. `None` is the build's default.
    pub ids: Option<std::sync::Arc<dyn centraid_vault::Ids>>,
    /// THE DIGEST THE SHELL WAS BUILT AGAINST (#1020 Artifacts, D-1020-G2).
    ///
    /// A shell that links a prebuilt core cannot tell by construction that the
    /// core it loaded is the one its own build expects, and a stale core is the
    /// worst failure shape in the design: it starts, it answers, and it answers
    /// from a schema the shell stopped speaking. So a shell passes the digest
    /// ITS build recorded and [`crate::Core::open`] refuses a mismatch with
    /// [`crate::CoreError::StaleCore`] — before the handle exists.
    ///
    /// `None` means the caller claimed no expectation, which is a developer
    /// running the binary by hand. **It is not treated as a match**: it is
    /// treated as "not checked", and `crate::identity::require_digest` is what
    /// says so out loud when a `dev` build is on either side.
    pub expected_digest: Option<String>,
    /// THE PAIRING THE SHELL KEPT, for a seat that has no file yet
    /// (#1025 S7, item 3).
    ///
    /// **Before the first bootstrap the pairing record lives only in the
    /// secure store.** It is written into the replica by the transaction that
    /// adopts the copy — which is the earliest moment there IS a replica to
    /// hold it — so a device that paired and whose first copy did not land had,
    /// until this, nothing to dial on its next launch. The ticket was burned;
    /// the member would have had to mint another.
    ///
    /// `None` is a shell that has nothing to hand back, which is every launch
    /// after the copy lands: the replica holds the record and is asked first.
    ///
    /// ## THE RECORD DECIDES THE RELAY MODE (#1025 S7-13, superseding D-1025-S7-7)
    ///
    /// There used to be a `relays: bool` here and the shell was told to set it.
    /// It never did — nothing on the mobile side ever passed `false` — and the
    /// flag was redundant the moment the record carried
    /// [`PairingRecord::relay_url`]: a ticket that names no relay IS a
    /// deployment that has none, and the shell had already written that fact
    /// down. A second spelling of one fact is a second thing to keep true.
    ///
    /// So: a SETTLED record (one with a `gateway_address`) whose `relay_url` is
    /// empty opens the endpoint in `RelayMode::Disabled`, and one that names a
    /// relay opens it in `RelayMode::Default`. No record, or a record whose
    /// `relay_url` is `None` — the transient one a device holds while redeeming
    /// a ticket — leaves relays ON: the deployment is not known until the
    /// ticket is read, and a device that turned relays off on a guess could not
    /// pair over the internet at all.
    pub pairing: Option<PairingRecord>,
}

/// ONE ENROLMENT, AS THE SHELL KEPT IT (#1025 S7-13).
///
/// Everything this device needs to be, and to reach, ONE vault: the secret half
/// of the identity its gateway enrolled, the public half the gateway says it
/// enrolled, where the vault is reached, and what it is called.
///
/// **It was three secure-store entries and is now one.** A key filed under one
/// name and a record under another is a pair that can settle by halves, and it
/// did: a device came back with an identity for a vault whose address it had
/// lost, or an address for a vault whose identity it had never kept. One record
/// settles with one rename, or it does not settle at all.
///
/// Deliberately not `crate::link::PairedGateway`: this is what a shell READ off
/// a `PairOk` and wrote to its secure store, and it crosses the ABI as JSON.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PairingRecord {
    /// THIS DEVICE'S ENDPOINT SECRET FOR THIS VAULT — 32 raw bytes, out of the
    /// shell's secure store (#1025 S5, and folded in here by S7-13).
    ///
    /// **The shell keeps it, not the core.** A secret key belongs in the
    /// platform's own store — the iOS Keychain, the Android Keystore — and a
    /// core that invented a file on disk would have put the one unrecoverable
    /// secret on this device next to the vault it protects, in a place no shell
    /// asked for and no backup excludes.
    ///
    /// `None` mints a fresh keypair at open, which is a device its gateway has
    /// never enrolled. That is honest only BEFORE a pairing; afterwards
    /// [`Self::enrolled_public_key`] catches it and the open is refused.
    pub secret: Option<[u8; 32]>,
    /// The gateway's endpoint id, 64 lowercase hex. THE AUTHORITY for reaching
    /// the vault: iroh's TLS proves this and none of the hints here is proved
    /// by anything. Empty on the TRANSIENT record a device holds while it is
    /// redeeming a ticket and does not yet know what it paired with.
    pub gateway_address: String,
    pub vault_id: String,
    pub vault_name: String,
    /// A dialling hint, AND THE RELAY DECISION (#1025 S7-13) — with three
    /// states, because there genuinely are three.
    ///
    /// `Some(url)` is a deployment reached through that relay. `Some("")` is a
    /// LAN-only deployment that STATED it has none, and the endpoint comes up
    /// with relay mode disabled. `None` is a record that has not been told yet
    /// — the transient one a device holds while it is redeeming a ticket — and
    /// relays stay ON, because a device that guessed them off could not pair
    /// over the internet at all.
    ///
    /// Two states would have to collapse the last two, and both collapses are
    /// wrong: "empty means LAN-only" turns every pre-pairing endpoint into one
    /// that cannot reach a relay, and "empty means unknown" leaves a phone on a
    /// LAN-only gateway waiting on a relay probe before every dial.
    pub relay_url: Option<String>,
    /// `<ip>:<port>` hints with NO AUTHORITY.
    pub direct_addrs: Vec<String>,
    /// THE PUBLIC KEY THE GATEWAY SAYS IT ENROLLED, 64 lowercase hex.
    ///
    /// Off the `PairOk`, derived by the gateway from the connection it proved —
    /// never from a field the device sent. It is what makes
    /// [`crate::CoreError::IdentityMismatch`] possible: at open the endpoint
    /// that came up is compared with this, and a device whose secret is gone is
    /// told so instead of dialling as a stranger.
    ///
    /// Empty means this record predates its own pairing — the transient one —
    /// and there is nothing to check yet.
    pub enrolled_public_key: String,
}

impl CoreConfig {
    /// A gateway over `path`.
    pub fn gateway(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            role: Role::Gateway,
            ui_thread_name: None,
            create: true,
            clock: None,
            ids: None,
            expected_digest: None,
            pairing: None,
        }
    }

    /// A replicated seat over `path`.
    pub fn replicated_seat(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            role: Role::Seat {
                kind: SeatKind::Replicated,
            },
            ui_thread_name: None,
            create: false,
            clock: None,
            ids: None,
            expected_digest: None,
            pairing: None,
        }
    }

    /// A thin seat over `path`.
    pub fn thin_seat(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            role: Role::Seat {
                kind: SeatKind::Thin,
            },
            ui_thread_name: None,
            create: false,
            clock: None,
            ids: None,
            expected_digest: None,
            pairing: None,
        }
    }

    /// Give this core the enrolment the shell kept for this vault.
    ///
    /// The identity, the address and the relay decision all ride on it, because
    /// all three are properties of ONE enrolment with ONE gateway. Without it
    /// the endpoint mints a fresh keypair and the seat is a device its gateway
    /// has not enrolled.
    #[must_use]
    pub fn with_pairing(mut self, record: PairingRecord) -> Self {
        self.pairing = Some(record);
        self
    }

    /// Just the endpoint identity, for a caller that has no record yet — a
    /// test, or a device in the middle of redeeming a ticket.
    #[must_use]
    pub fn with_endpoint_secret(mut self, secret: [u8; 32]) -> Self {
        let record = self.pairing.get_or_insert_with(PairingRecord::default);
        record.secret = Some(secret);
        self
    }

    /// Refuse to open unless this core's digest is `digest`.
    #[must_use]
    pub fn expecting_digest(mut self, digest: impl Into<String>) -> Self {
        self.expected_digest = Some(digest.into());
        self
    }

    /// Stamp this core's writes with a given clock and id source.
    ///
    /// What makes a run reproducible. A test, a simulation and a fixture
    /// freezer all want it; a shipped gateway wants the system clock and passes
    /// neither.
    ///
    /// `Arc` RATHER THAN `Box` SINCE #1025 S2, and the reason is the
    /// re-bootstrap: the core keeps this stamp and hands it to the file that
    /// REPLACES the replica, so a `FixedClock` a test advances is still the
    /// same object on the other side of the swap. A `Box` could only be given
    /// away once, and the second open silently took the build's default.
    #[must_use]
    pub fn with_clock(
        mut self,
        clock: std::sync::Arc<dyn centraid_vault::Clock>,
        ids: std::sync::Arc<dyn centraid_vault::Ids>,
    ) -> Self {
        self.clock = Some(clock);
        self.ids = Some(ids);
        self
    }

    /// Whether this role holds the authority.
    #[must_use]
    pub fn is_gateway(&self) -> bool {
        self.role == Role::Gateway
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gateway_creates_its_file_and_a_seat_does_not() {
        assert!(CoreConfig::gateway("/tmp/v.db").create);
        assert!(!CoreConfig::replicated_seat("/tmp/s.db").create);
        assert!(!CoreConfig::thin_seat("/tmp/s.db").create);
    }

    #[test]
    fn the_three_roles_are_distinguishable() {
        assert!(CoreConfig::gateway("/tmp/v.db").is_gateway());
        let thin = CoreConfig::thin_seat("/tmp/s.db");
        assert!(!thin.is_gateway());
        assert!(matches!(
            thin.role,
            Role::Seat {
                kind: SeatKind::Thin
            }
        ));
    }
}
