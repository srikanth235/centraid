//! THE ONE WRITE, as a screen uses it: `act` answers at once (the phone is the
//! vault), so a screen submits, reads the verdict and loads again. There is no
//! in-flight overlay and no "pending" row: what committed is in the next load,
//! and what was refused is a sentence.

use centraid_api_proto::core_v1 as wire;

use crate::field::Keyed;
use crate::screen::Ctx;
use crate::strings::shared;

/// What one `act` came to.
#[derive(Clone, Debug)]
pub struct Settled {
    pub committed: bool,
    /// The core's sentence for a refusal, or ours when it gave none. Empty when
    /// committed.
    pub refusal: String,
    /// The action's output (JSON), e.g. the id a create minted.
    pub output: Vec<u8>,
    /// What undoes it, when the core knows.
    pub inverse: Option<wire::ActInverse>,
    /// The tables the commit wrote, sorted. Empty when nothing committed.
    pub tables: Vec<String>,
    /// The check that refused, when one did (the vault's predicate id, `stale_revision`, or the
    /// core's own such as `input_schema`). Empty when committed and when the core named none.
    pub check: String,
}

/// Why a save naming `expected_rev` was refused: the record is not as the screen read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stale {
    /// The record changed since the screen read it (`stale_revision`).
    Changed,
    /// The record was moved to the trash since (`stale_trashed`).
    Trashed,
}

/// The predicate a save is refused with when the record changed since it was read.
pub const STALE_REVISION: &str = "stale_revision";

/// The predicate a save is refused with when the record is in the trash.
pub const STALE_TRASHED: &str = "stale_trashed";

impl Settled {
    /// Whether the save was refused because the record is not as the screen read it.
    #[must_use]
    pub fn stale(&self) -> Option<Stale> {
        match self.check.as_str() {
            STALE_REVISION => Some(Stale::Changed),
            STALE_TRASHED => Some(Stale::Trashed),
            _ => None,
        }
    }

    /// The record's revision a guarded save answered (`rev`), when it did.
    #[must_use]
    pub fn rev(&self) -> Option<i64> {
        serde_json::from_slice::<serde_json::Value>(&self.output)
            .ok()?
            .get("rev")?
            .as_i64()
    }

    /// One field of the output, as a flag.
    #[must_use]
    pub fn output_flag(&self, field: &str) -> Option<bool> {
        serde_json::from_slice::<serde_json::Value>(&self.output)
            .ok()?
            .get(field)?
            .as_bool()
    }

    /// One field of the output, as text.
    #[must_use]
    pub fn output_text(&self, field: &str) -> Option<String> {
        let value: serde_json::Value = serde_json::from_slice(&self.output).ok()?;
        value.get(field)?.as_str().map(str::to_owned)
    }
}

/// A number no earlier gesture used, on this phone, ever: microseconds since
/// the epoch when the process first asked, plus a count. The core remembers an
/// `invoke_key` in the vault for thirty days and answers a second delivery
/// "replayed" without running it, so a counter a screen restarts at one every
/// time it opens would turn a later tap into a silent no-op. Screens take their
/// [`key`] sequence from here.
#[must_use]
pub fn fresh() -> u64 {
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicU64, Ordering};
    static BASE: OnceLock<u64> = OnceLock::new();
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let base = *BASE.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| u64::try_from(since.as_micros()).unwrap_or(0))
    });
    base + COUNT.fetch_add(1, Ordering::Relaxed)
}

/// A key that tells this gesture from the next: the parts joined by `:`, then
/// a sequence number the screen counts. The core runs one key once.
#[must_use]
pub fn key(parts: &[&str], seq: u64) -> String {
    format!("{}:n={seq}", parts.join(":"))
}

/// Submit `request` under `invoke_key`.
pub fn act(ctx: &Ctx, request: impl Into<wire::ActRequest>, invoke_key: &str) -> Settled {
    let request = request.into().keyed(invoke_key);
    match ctx.act(&request) {
        Ok(response) if response.status == wire::ActStatus::Executed as i32 => Settled {
            committed: true,
            refusal: String::new(),
            output: response.output,
            inverse: response.inverse,
            tables: response.tables,
            check: String::new(),
        },
        Ok(response) => Settled {
            committed: false,
            refusal: if response.reason.trim().is_empty() {
                shared::write_refused(ctx.locale())
            } else {
                response.reason
            },
            output: Vec::new(),
            inverse: None,
            tables: Vec::new(),
            check: response
                .refusal
                .map(|refusal| refusal.check)
                .unwrap_or_default(),
        },
        Err(_) => Settled {
            committed: false,
            refusal: shared::write_refused(ctx.locale()),
            output: Vec::new(),
            inverse: None,
            tables: Vec::new(),
            check: String::new(),
        },
    }
}
