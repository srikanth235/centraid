//! The restore drill's helpers: back up, lose everything, restore, and prove it is the vault that
//! was lost (spec §7). The drill itself is `crates/vault/tests/restore_drill.rs`, which runs the
//! real engine against [`super::store::MemoryStore`]; this module holds what that test and the
//! command-line drill share.

use std::collections::BTreeMap;

use crate::file::Vault;

use super::Result;

/// Every row of every table a member has rows in, as text, sorted: two vaults with the same
/// dump hold the same records.
///
/// # Errors
/// The vault's refusal.
pub fn dump(vault: &Vault) -> Result<BTreeMap<String, Vec<String>>> {
    Ok(vault.read(|connection| {
        let census = crate::pagesource::census_of(connection)?;
        let mut out = BTreeMap::new();
        for table in census.keys() {
            // The index's own queue is derived, not a record: a restored vault founds its index file
            // again and owes it every entity (#1214, A15), which a live one does not.
            if crate::log::guard::is_index(table) {
                continue;
            }
            let quoted = table.replace('"', "\"\"");
            let mut statement = connection.prepare(&format!("SELECT * FROM \"{quoted}\""))?;
            let columns = statement.column_count();
            let mut rows: Vec<String> = statement
                .query_map([], |row| {
                    let values: Vec<rusqlite::types::Value> = (0..columns)
                        .map(|index| row.get(index))
                        .collect::<rusqlite::Result<_>>()?;
                    Ok(format!("{values:?}"))
                })?
                .collect::<rusqlite::Result<_>>()?;
            rows.sort();
            out.insert(table.clone(), rows);
        }
        Ok(out)
    })?)
}
