//! LOCKER'S IMPORT AND EXPORT, ON THE PHONE (#1047 T2).
//!
//! The two session steps that move many secrets at once. Both need an open
//! session — `K` is in it — and both keep the order every reveal keeps: **the
//! receipt before the value exists**.
//!
//! - **Export** is the handoff's plaintext file: "every title, username,
//!   address, note and password … Anything that reads the file reads your
//!   secrets." `locker.export` writes the one receipt a mass reveal owes (an
//!   unseal of every sealed cell, `derivation: export`) BEFORE any cell is
//!   opened; then every live and archived item's sealed cells and sealed
//!   custom fields are opened under `K` and the file is rendered by
//!   `centraid_apps_locker::transfer` — 1Password's CSV or Centraid's JSON.
//!   The bytes are answered once, to the shell, which hands them to the OS
//!   save sheet; nothing here writes a file and nothing logs one. A passkey's
//!   key is never opened for it (L-passkey), and the trash is not exported.
//!   The shell asks the phone's owner check afresh before it sends the ask
//!   (R-1047-T2-4); the core cannot see that prompt (D-7) and does not claim
//!   to.
//! - **Import** reads a picked file (a password-manager CSV or Centraid's
//!   JSON), plans each row against the vault — new, fills the empty fields
//!   only, or held because the vault already holds it — and, when asked to
//!   publish, writes the new and fill rows through the ordinary commands,
//!   each secret sealed by [`super::phone::seal_command`] on the way in. The
//!   plan writes nothing; a failed row is counted and the rest go on.

use centraid_api_proto::core_v1 as wire;
use centraid_apps_locker::phone as loaders;
use centraid_apps_locker::transfer::{self, Entry, Existing, Planned, ReadRefusal, Verdict};
use centraid_vault::commands::Registry;
use centraid_vault::commands::locker::SEALED_PLACEHOLDER;
use centraid_vault::custody::decrypt_under_locker_key;
use centraid_vault::{Principal, Vault};

use super::phone::{Cell, open_key, run, seal_command, state_of};
use crate::app_query::VaultDoor;
use crate::error::{CoreError, Result};

fn refused(
    cell: &Cell,
    now_ms: i64,
    refusal: wire::LockerRevealRefusal,
) -> wire::LockerSessionResponse {
    let mut answer = state_of(cell, now_ms);
    answer.refusal = refusal as i32;
    answer
}

fn loaded<T>(result: centraid_apps_kit::error::KitResult<T>) -> Result<T> {
    result.map_err(|error| CoreError::Invariant {
        context: format!("Locker's rows would not read: {error}"),
    })
}

/// Every secret, in a file.
///
/// # Errors
/// A read that failed, or a receipt that did not land — in which case no
/// cell was opened.
pub(super) fn export(
    vault: &Vault,
    registry: &Registry,
    owner: &Principal,
    cell: &Cell,
    now_ms: i64,
    asked: &wire::LockerExportAsk,
    changes: &crate::events::ChangeFeed,
) -> Result<wire::LockerSessionResponse> {
    let Some((live_id, live_key)) = open_key(cell, now_ms) else {
        return Ok(refused(cell, now_ms, wire::LockerRevealRefusal::Locked));
    };
    let json = asked.format() == wire::LockerExportFormat::Json;
    let day = crate::app_query::zone_of(vault, &asked.tz)
        .ok()
        .and_then(|zone| centraid_apps_agenda::local::today(&zone, &vault.clock().now_text()))
        .unwrap_or_default();
    let door = VaultDoor::new(vault);
    let mut sources = loaded(loaders::load_export(&door))?;
    // THE RECEIPT FIRST (D-1020-L3, L-export): one mass reveal, confirmed and
    // receipted by the command plane, before any cell is opened. A receipt
    // that did not land is an error and nothing is opened.
    let receipt = run(
        vault,
        registry,
        owner,
        "locker.export",
        serde_json::json!({ "confirm": true }),
        changes,
    )?;
    let open = |generation: Option<String>, bound: &str, ciphertext: &str| {
        let generation = generation.unwrap_or_else(|| live_id.clone());
        decrypt_under_locker_key(&live_key, &generation, bound, ciphertext).ok()
    };
    let mut unopened = 0_u32;
    for source in &mut sources {
        for column in &source.sealed_cells {
            let opened = vault
                .locker_sealed_item_cell(&source.item_id, column)?
                .and_then(|sealed| {
                    let ciphertext = sealed.ciphertext?;
                    open(sealed.key_id, &source.item_id, &ciphertext)
                });
            match opened {
                Some(value) => {
                    source.entry.columns.insert((*column).to_owned(), value);
                }
                None => unopened += 1,
            }
        }
        for (field_id, index) in &source.sealed_fields {
            let opened = vault
                .locker_sealed_field_cell(&source.item_id, field_id)?
                .and_then(|sealed| {
                    let ciphertext = sealed.ciphertext?;
                    open(sealed.key_id, field_id, &ciphertext)
                });
            match (opened, source.entry.fields.get_mut(*index)) {
                (Some(value), Some(field)) => field.value = value,
                _ => unopened += 1,
            }
        }
    }
    let entries: Vec<Entry> = sources.into_iter().map(|source| source.entry).collect();
    let content = if json {
        transfer::json(&entries, &vault.clock().now_text())
    } else {
        transfer::csv(&entries)
    };
    let (file_name, media_type) = transfer::file_of(&day, json);
    let mut answer = state_of(cell, now_ms);
    answer.exported = Some(Box::new(wire::LockerExported {
        content: content.into_bytes(),
        file_name,
        media_type: media_type.to_owned(),
        item_count: u32::try_from(entries.len()).unwrap_or(u32::MAX),
        receipt_id: receipt["receipt_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        unopened,
    }));
    Ok(answer)
}

/// A picked file: its plan, or — published — what was written.
///
/// # Errors
/// A read that failed, or a file too large to plan (a sentence that quotes
/// nothing of it).
pub(super) fn import(
    vault: &Vault,
    registry: &Registry,
    owner: &Principal,
    cell: &Cell,
    now_ms: i64,
    asked: &wire::LockerImportAsk,
    changes: &crate::events::ChangeFeed,
) -> Result<wire::LockerSessionResponse> {
    if open_key(cell, now_ms).is_none() {
        return Ok(refused(cell, now_ms, wire::LockerRevealRefusal::Locked));
    }
    let file = match transfer::read(&asked.content) {
        Ok(file) => file,
        Err(ReadRefusal::NotReadable) => {
            return Ok(refused(
                cell,
                now_ms,
                wire::LockerRevealRefusal::NotReadable,
            ));
        }
        Err(refusal @ ReadRefusal::TooLarge) => {
            return Err(CoreError::InvalidRequest {
                detail: refusal.to_string(),
            });
        }
    };
    let door = VaultDoor::new(vault);
    let existing = loaded(loaders::load_import_targets(&door))?;
    let planned = transfer::plan(&file.entries, &existing);
    let mut plan = wire::LockerImportPlan {
        format: file.format.as_str().to_owned(),
        ..wire::LockerImportPlan::default()
    };
    for (entry, one) in file.entries.iter().zip(&planned) {
        let verdict = match one.verdict {
            Verdict::New => {
                plan.new_count += 1;
                wire::LockerImportVerdict::New
            }
            Verdict::Fill => {
                plan.fill_count += 1;
                wire::LockerImportVerdict::Fill
            }
            Verdict::Held => {
                plan.held_count += 1;
                wire::LockerImportVerdict::Held
            }
            Verdict::Skipped => {
                plan.skipped_count += 1;
                wire::LockerImportVerdict::Skipped
            }
        };
        let host = transfer::host_of(entry.column("url")).unwrap_or_default();
        plan.rows.push(wire::LockerImportRow {
            title: entry.title.clone(),
            r#type: entry.item_type.clone(),
            subtitle: [entry.column("username"), host.as_str()]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" · "),
            verdict: verdict as i32,
            matched_item_id: one.matched.clone().unwrap_or_default(),
            carries_secret: entry.carries_secret(),
        });
    }
    if asked.publish {
        let writer = Writer {
            vault,
            registry,
            owner,
            cell,
            changes,
        };
        for (entry, one) in file.entries.iter().zip(&planned) {
            let written = match one.verdict {
                Verdict::New => writer.create(entry).map(|()| &mut plan.created),
                Verdict::Fill => writer
                    .fill(entry, one, &existing)
                    .map(|()| &mut plan.filled),
                Verdict::Held | Verdict::Skipped => continue,
            };
            match written {
                Ok(count) => *count += 1,
                Err(_) => plan.failed += 1,
            }
        }
        plan.published = true;
    }
    let mut answer = state_of(cell, now_ms);
    answer.import_plan = Some(Box::new(plan));
    Ok(answer)
}

/// The commands an import publishes through, each secret sealed on the way.
struct Writer<'a> {
    vault: &'a Vault,
    registry: &'a Registry,
    owner: &'a Principal,
    cell: &'a Cell,
    changes: &'a crate::events::ChangeFeed,
}

impl Writer<'_> {
    /// Seal what `input` carries (the core's one sealing door) and run it.
    fn write(&self, name: &str, input: serde_json::Value) -> Result<serde_json::Value> {
        let command = wire::Command {
            name: name.to_owned(),
            input: serde_json::to_vec(&input).map_err(|error| CoreError::Invariant {
                context: format!("an import's command is not JSON: {error}"),
            })?,
            ..wire::Command::default()
        };
        let input = match seal_command(self.vault, self.cell, &command)? {
            Some(sealed) => {
                serde_json::from_slice(&sealed).map_err(|error| CoreError::Invariant {
                    context: format!("a sealed input is not JSON: {error}"),
                })?
            }
            None => input,
        };
        run(
            self.vault,
            self.registry,
            self.owner,
            name,
            input,
            self.changes,
        )
    }

    /// A NEW ITEM, whole: the item with its cells, then its fields, extra
    /// addresses, memo, star and shelf — in that order, so a failure part way
    /// leaves an item that holds what it was given so far.
    fn create(&self, entry: &Entry) -> Result<()> {
        let item_id = self.vault.ids().next();
        let mut input = serde_json::json!({
            "item_id": item_id,
            "type": entry.item_type,
            "title": entry.title,
        });
        for column in transfer::type_columns(&entry.item_type) {
            let value = entry.column(column);
            if !value.is_empty() {
                input[*column] = serde_json::Value::String(value.to_owned());
            }
        }
        if !entry.tags.is_empty() {
            input["tags"] = serde_json::json!(entry.tags);
        }
        if entry.compromised {
            input["compromised"] = serde_json::Value::Bool(true);
        }
        self.write("locker.add_item", input)?;
        for (position, field) in entry.fields.iter().enumerate() {
            self.write(
                "locker.set_field",
                serde_json::json!({
                    "item_id": item_id,
                    "field_id": self.vault.ids().next(),
                    "section": field.section,
                    "label": field.label,
                    "kind": field.kind,
                    "value": field.value,
                    "position": position,
                }),
            )?;
        }
        if !entry.addresses.is_empty() {
            let addresses: Vec<serde_json::Value> = entry
                .addresses
                .iter()
                .map(|url| serde_json::json!({ "url": url }))
                .collect();
            self.write(
                "locker.set_addresses",
                serde_json::json!({ "item_id": item_id, "addresses": addresses }),
            )?;
        }
        if !entry.memo.is_empty() {
            self.write(
                "locker.set_memo",
                serde_json::json!({ "item_id": item_id, "note": entry.memo }),
            )?;
        }
        if entry.starred {
            self.write(
                "locker.star_item",
                serde_json::json!({ "item_id": item_id }),
            )?;
        }
        if entry.archived {
            self.write(
                "locker.archive_item",
                serde_json::json!({ "item_id": item_id }),
            )?;
        }
        Ok(())
    }

    /// FILL THE EMPTY FIELDS ONLY. `locker.edit_item` rewrites every column
    /// the type owns, so the input carries what the item already holds — a
    /// held secret as the placeholder, which leaves it alone — plus the
    /// columns this row fills, and nothing the item holds is replaced.
    fn fill(&self, entry: &Entry, planned: &Planned, existing: &[Existing]) -> Result<()> {
        let item_id = planned.matched.as_deref().unwrap_or_default();
        let item = existing
            .iter()
            .find(|item| item.item_id == item_id)
            .ok_or_else(|| CoreError::Invariant {
                context: "an import filled an item its plan did not name".to_owned(),
            })?;
        let mut input = serde_json::json!({ "item_id": item_id });
        for column in transfer::type_columns(&item.item_type) {
            let value = if planned.fills.contains(column) {
                entry.column(column).to_owned()
            } else if item.sealed.contains(*column) {
                SEALED_PLACEHOLDER.to_owned()
            } else {
                item.plain.get(*column).cloned().unwrap_or_default()
            };
            if !value.is_empty() {
                input[*column] = serde_json::Value::String(value);
            }
        }
        self.write("locker.edit_item", input).map(|_| ())
    }
}
