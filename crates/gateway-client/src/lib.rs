#![forbid(unsafe_code)]
//! THE PHONE'S HALF OF THE GATEWAY PROTOCOL (#1029 §3, W5).
//!
//! `centraid-gateway-core` is the rules and `centraid-gateway-server` is one
//! deployment of them. This is the **client**: the thing in a member's pocket
//! that signs a request, reads a refusal, and knows which refusals it is
//! allowed to do something about.
//!
//! # WHY THIS IS RUST AND NOT `commonMain`
//!
//! W5 lane A stopped at exactly this seam and wrote down why: `commonMain` has
//! no Ed25519, so signing is either a platform seam — a Swift half and a Kotlin
//! half — or a door onto the rules. It is the door, for the reason
//! [`centraid_gateway_core::auth`]'s own header gives about the two *server*
//! adapters, which applies with more force to a client:
//!
//! > A phone that signs one shape and is verified against the other fails for a
//! > reason nobody can read in a log.
//!
//! Two shells signing their own preimages would be two shapes, drifting, with
//! the failure showing up as `SignatureInvalid` on somebody's restore. So
//! **nothing above this crate assembles a preimage**: [`signer`] calls
//! [`centraid_gateway_core::auth::preimage`], the same function the server
//! verifies with.
//!
//! # WHAT THIS CRATE DOES NOT DO: CARRY BYTES
//!
//! [`transport::Transport`] is a port, and the phone's implementation of it is
//! the platform's HTTP stack — a background `URLSession` on iOS, `OkHttp` under
//! a `CoroutineWorker` on Android. That is not a portability nicety: **iOS will
//! not let a process upload while it is suspended** unless the upload is an
//! `NSURLSession` background task owned by the system, so a Rust client that
//! held the socket itself could not do the one thing a phone client is for.
//!
//! [`signer::SignedHeaders`] is therefore the crate's most important public
//! type. It is four header values, and it is what a background task carries
//! when this crate is not running at all.
//!
//! ## The property that makes a *file-based* background upload signable
//!
//! A signature covers a **body digest** ([`centraid_gateway_core::auth`]), and
//! an uploader that had to read a 16 MiB file to compute one would defeat
//! `uploadTask(with:fromFile:)`, whose whole point is that the app never holds
//! the bytes. It does not have to: an object's name **is** the BLAKE3-256 of
//! its sealed bytes ([`centraid_gateway_core::ids::ObjectName`]), so for
//! `PUT /v1/objects/{vault}/{name}` the digest is already in the path.
//! [`signer::DeviceSigner::sign_object_put`] is that one line, named, with the
//! reason attached — and [`signer`]'s tests hold it against
//! `ObjectName::of(..)` so a change to either side is caught here.
//!
//! # THE THREE ANSWERS A PHONE IS ALLOWED TO ACT ON
//!
//! Everything else is shown and nothing more. These three are behaviour:
//!
//! | Refusal | What the client does |
//! |---|---|
//! | `GatewayClockSkew` | applies the server's time as an **offset** and re-signs **once**. Never twice: see [`client`] |
//! | `VersionWindow` with the server below us | latches [`outcome::ServerNeeds::Update`] and **writes nothing further to that server** |
//! | `VaultMoved` | surfaces [`outcome::ClientError::Moved`] with the epoch and the moment, which is `Error.moved`'s companion and the shell's freeze |
//!
//! # NO LISTENING SOCKET
//!
//! Egress only, like everything else a phone does (#1029 §6): HTTPS to the
//! gateway, and — through [`centraid_identity::discovery`] — HTTPS to the pkarr
//! resolver. `cargo xtask rules`' `no-listening-socket` scans this crate like
//! every other.

pub mod client;
pub mod directory;
pub mod outcome;
pub mod publish;
pub mod signer;
pub mod spool;
pub mod transport;

pub use client::{GatewayClient, Preflight};
pub use outcome::{ClientError, ServerNeeds};
pub use signer::{DeviceSigner, SignedHeaders};
pub use transport::{HttpRequest, HttpResponse, Transport, TransportError};

/// The protocol range this build of the phone speaks.
///
/// It is `gateway-core`'s, deliberately and not by accident of reuse: the
/// version comparison is one function precisely so that a phone and a server
/// cannot disagree about whose fault a mismatch is
/// ([`centraid_gateway_core::version`]). A client constant of its own would be
/// the disagreement the module exists to prevent.
pub const CLIENT_PROTOCOL_MIN: u32 = centraid_gateway_core::PROTOCOL_MIN;

/// See [`CLIENT_PROTOCOL_MIN`].
pub const CLIENT_PROTOCOL_MAX: u32 = centraid_gateway_core::PROTOCOL_MAX;
