//! THE BACKUP'S STANDING, AS THE SHELL ASKS IT (#1135, lane H2): the
//! `backup-status` query behind the Backup screen and Home's line, offered by
//! [`super::shell_reads`].
//!
//! The reading is the phone's own ledger (`phone::backup_status`) and the
//! content counts from the vault: it dials nobody, so drawing a line never
//! waits on somebody else's network. It is not a vault table, so what lets a
//! screen re-read it is a change event for [`TABLE`]: `Handle::call` announces
//! one after every door that moves the ledger ([`moves_the_ledger`]). The
//! `blob` table is the other reason: it is what the content counts are made of,
//! so a photograph or a video arriving moves "1,203 of 1,240".

use centraid_api_proto::core_v1 as wire;

use crate::error::Result;
use crate::handle::HandleState;

/// The query's name in `manifest.json`.
pub(crate) const STATUS: &str = "backup-status";

/// The pseudo-table a change event names when the backup ledger moved.
pub(crate) const TABLE: &str = "backup";

/// Whether answering `request` can have moved the backup ledger: a pass, a
/// pairing, a forget, an address refresh, the operating system's report of an
/// upload, a reconcile, a handoff, or the library items the platform deleted.
#[must_use]
pub(crate) fn moves_the_ledger(request: &wire::Request) -> bool {
    use wire::request::Kind as K;
    matches!(
        request.kind,
        Some(
            K::Drain(_)
                | K::PairPhone(_)
                | K::Restore(_)
                | K::ForgetDestination(_)
                | K::RefreshDestination(_)
                | K::Handoff(_)
                | K::Settle(_)
                | K::Reconcile(_)
                | K::Released(_)
        )
    )
}

/// Run `backup-status`.
///
/// # Errors
/// The ledger's or the spool's refusal, or a vault that will not read.
pub(crate) fn status(handle: &HandleState) -> Result<wire::LoadResponse> {
    let standing = handle.backup_standing()?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|since| i64::try_from(since.as_millis()).ok())
        .unwrap_or_default();
    Ok(wire::LoadResponse {
        answer: Some(wire::AppQueryResponse {
            answer: Some(wire::app_query_response::Answer::ShellBackupStatus(
                wire::ShellBackupStatus {
                    status: Some(standing),
                    now_ms,
                },
            )),
        }),
        tables: vec![TABLE.to_owned(), "blob".to_owned()],
    })
}
