//! Every number the protocol states, declared once for both ends (#1080).
//!
//! A number an adapter restated would be a number that drifts: a client that
//! splits a batch at 1,000 names against a server that refuses at 999 fails
//! for a reason nobody can read in a log. The server and the client import
//! these; neither has its own.

/// The protocol version `GET /v2/info` answers.
pub const PROTOCOL: u32 = 2;

/// One day, in milliseconds.
pub const DAY_MS: i64 = 86_400_000;

/// THE LARGEST OBJECT A `PUT` OR A BUNDLE FRAME MAY CARRY: 80 MiB.
///
/// A file is uploaded as parts of at most 64 MiB of plaintext; sealing adds a
/// header and a nonce, a length and a tag per 4 MiB chunk. 80 MiB is that
/// part with room to spare, and anything above it is refused `TOO_LARGE`.
pub const MAX_OBJECT_BYTES: u64 = 80 * 1024 * 1024;

/// THE LARGEST BUNDLE, either way: 256 MiB of framing and bytes.
///
/// It bounds a `POST bundle` body and a `POST fetch` answer alike, so the
/// derivatives a restore pulls in bulk come back in pieces a phone can hold.
pub const MAX_BUNDLE_BYTES: u64 = 256 * 1024 * 1024;

/// The most names one `exists`, `fetch` or `delete` may carry.
pub const MAX_NAMES: usize = 1_000;

/// The most objects one page of `GET objects` answers.
pub const LIST_LIMIT: usize = 1_000;

/// THE GRACE BEFORE A TOMBSTONE'S BYTES GO: seven days.
///
/// A tombstoned object is still served by name until the purge sweep finds it
/// past this, so a phone that deleted the wrong thing — or a stolen one that
/// deleted everything — has a week before anything is unrecoverable.
pub const GRACE_MS: i64 = 7 * DAY_MS;

/// HOW LONG A PAIRING SECRET IS GOOD FOR: 24 hours, and one use.
pub const SECRET_TTL_MS: i64 = DAY_MS;

/// The longest device label a pairing may carry, in bytes.
pub const MAX_LABEL_BYTES: usize = 128;

/// The largest JSON request body any route accepts: 1 MiB, declared rather
/// than inherited from a framework. The biggest legitimate one is 1,000 names.
pub const MAX_JSON_BYTES: usize = 1024 * 1024;
