//! Entity ids for unit tests: a canonical lowercase UUIDv7, the only id grammar the database
//! takes besides a seeded slug (#1214, A17), numbered so a fixture stays readable.

/// The `n`th test id.
#[must_use]
pub(crate) fn uuid(n: u64) -> String {
    format!(
        "{:08x}-0000-7000-8000-{n:012x}",
        0x0190_0000_u64 + (n >> 32)
    )
}
