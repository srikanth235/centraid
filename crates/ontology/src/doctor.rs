//! Is this file still sound?
//!
//! Two engine-level questions, and deliberately only two:
//! `PRAGMA integrity_check` for the pages, `PRAGMA foreign_key_check` for the
//! keys. v0's `packages/vault/src/doctor.ts` asks a third — blob custody, the
//! pointers no foreign key covers — and this crate does NOT, because v1 has no
//! content-addressed store yet. Custody arrives with `crates/vault`'s CAS and
//! this report gains a third section then; until it does, a clean report here
//! is a claim about pages and keys and nothing more.

use crate::error::Result;
use crate::vault::Vault;

#[derive(Debug, Clone)]
pub struct DoctorReport {
    pub ok: bool,
    /// What `PRAGMA integrity_check` said; `ok` when the pages are sound.
    pub integrity: String,
    /// One line per violated foreign key, empty when the keys hold.
    pub foreign_key_violations: Vec<String>,
}

/// Run the checks. A report is data; deciding what to do about it is the
/// caller's.
pub fn vault_doctor(vault: &Vault) -> Result<DoctorReport> {
    let db = vault.connection();
    let integrity: String = db.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;

    let mut statement = db.prepare("PRAGMA foreign_key_check")?;
    let mut rows = statement.query([])?;
    let mut violations = Vec::new();
    while let Some(row) = rows.next()? {
        let child: String = row.get(0)?;
        let rowid: Option<i64> = row.get(1)?;
        let parent: String = row.get(2)?;
        let key_index: i64 = row.get(3)?;
        violations.push(format!(
            "{child} rowid {} references {parent} through key #{key_index} and the parent row is missing",
            rowid.map_or_else(|| "(none)".to_owned(), |id| id.to_string())
        ));
    }

    Ok(DoctorReport {
        ok: integrity == "ok" && violations.is_empty(),
        integrity,
        foreign_key_violations: violations,
    })
}

/// The report as the one line a gate prints.
#[must_use]
pub fn format_doctor_report(report: &DoctorReport) -> String {
    if report.ok {
        return "vault doctor: clean (pages sound, foreign keys hold)".to_owned();
    }
    let mut lines = Vec::new();
    if report.integrity != "ok" {
        lines.push(format!("integrity_check: {}", report.integrity));
    }
    lines.extend(report.foreign_key_violations.iter().cloned());
    format!(
        "vault doctor: {} finding(s)\n{}",
        lines.len(),
        lines.join("\n")
    )
}
