//! Every number the protocol states, declared once for both ends (#1080).
//!
//! A number an adapter restated would be a number that drifts: a client that
//! splits a batch at 1,000 names against a server that refuses at 999 fails
//! for a reason nobody can read in a log. The server and the client import
//! these; neither has its own.

/// The protocol version `GET /v3/info` answers. Protocol 3 moved every route
/// from `/v2/` to `/v3/`; a gateway serves one protocol and no other (#1191,
/// E13).
pub const PROTOCOL: u32 = 3;

/// The lowest protocol a phone will talk to. A gateway below it is told to
/// update, never spoken to in its own older dialect.
pub const REQUIRED_PROTOCOL: u32 = 3;

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

/// THE MOST A SIGNED RECORD'S GENERATION MAY JUMP past the standing one: 256.
/// Gaps come only from signed requests whose answers were lost; the bound
/// keeps one forged-looking value from locking the real phone out (E3).
pub const MAX_GENERATION_JUMP: u64 = 256;

/// HOW LONG A NONCE IS GOOD FOR: five minutes, and one use (E5).
pub const NONCE_TTL_MS: i64 = 300_000;

/// The most live nonces a gateway keeps; the next issue is `BUSY` (E5).
pub const MAX_LIVE_NONCES: u64 = 4_096;

/// What `BUSY` tells the phone to wait before it asks for a nonce again.
pub const BUSY_RETRY_MS: u64 = 60_000;

/// HOW LONG A REVOKED TOKEN STILL HEARS "MOVED": 365 days (E5).
pub const REVOKED_TOKEN_KEEP_MS: i64 = 365 * DAY_MS;

/// The most revoked-token tombstones a vault keeps; the oldest go first (E5).
pub const MAX_REVOKED_PER_VAULT: u64 = 64;

/// The purge sweep's interval: an hour.
pub const PURGE_INTERVAL_MS: i64 = 3_600_000;

/// A gap since the last purge sweep of more than this many intervals is time
/// the gateway was not watching — a clock step, a night asleep, a spoofed
/// time — and every hold is moved later by the whole gap before anything is
/// purged, so a hold counts only watched time (#1191, R1). Three.
pub const PURGE_GAP_INTERVALS: i64 = 3;

/// The most unused, unexpired pairing secrets at once; minting one more drops
/// the oldest (E14).
pub const MAX_LIVE_SECRETS: u64 = 64;

/// How long a spent or expired pairing secret is kept before the sweep
/// prunes it: seven days (E14).
pub const SECRET_KEEP_MS: i64 = 7 * DAY_MS;

/// A head whose `taken_at_ms` is further ahead than this of the gateway's
/// clock is refused `CLOCK_AHEAD` (E14).
pub const MAX_CLOCK_AHEAD_MS: i64 = 300_000;

/// A file in `objects/` with no row is an orphan only once it is this old, so
/// a bundle in flight is never taken for one: an hour (E14).
pub const ORPHAN_MIN_AGE_MS: i64 = 3_600_000;
