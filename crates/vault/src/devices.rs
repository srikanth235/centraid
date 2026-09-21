//! The device allowlist, durable (D-1020-D1-9).
//!
//! Lane C owns the `AllowlistStore` trait; at this lane's rebase
//! `crates/net` was not yet on the umbrella branch, so this is the method set
//! rather than an `impl Trait` — `enrol`, `revoke`, `is_enrolled`,
//! `live_devices` — and lane C's trait is implemented over it in one small
//! block when the crate lands. The method set, not the trait, is what had to
//! be agreed, and it is here in the receipt.
//!
//! ## Unknown and revoked are the same refusal
//!
//! Revoking DELETES the private sibling row, so there is no "revoked" state to
//! check for and no way to forget to check for it. That is why the split is
//! `access_device` (replicated: the member's device list) and
//! `access_device_secret` (private: the public key and the sync cursor), with
//! the PRIVATE sibling referencing the REPLICATED parent. A seat's copy holds
//! the list and never the keys, and satisfies its own constraints with
//! `foreign_keys = OFF`.
//!
//! Revoking also wipes the device's protocol state — parked payloads, intent
//! outcomes — in the same transaction that forgets the device, because a sealed
//! request whose owner is gone is a request nothing will ever delete.

use crate::error::Result;
use crate::file::Vault;

/// One enrolled device, as the member's list shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub device_id: String,
    pub owner_party_id: String,
    pub name: String,
    pub platform: String,
    pub enrolled_at: String,
    /// The position this device says it has reached, if it has said.
    pub sync_cursor: Option<i64>,
}

impl Vault {
    /// Enrol a device: the replicated row and its private sibling, in one
    /// commit, so a device can never exist without its key or the other way.
    pub fn enrol_device(
        &self,
        device_id: &str,
        owner_party_id: &str,
        name: &str,
        platform: &str,
        public_key: &str,
    ) -> Result<()> {
        let now = self.clock().now_text();
        self.commit(|tx| {
            tx.set_producer("devices.enrol");
            tx.connection().execute(
                "INSERT INTO access_device
                   (device_id, owner_party_id, name, platform, enrolled_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (device_id) DO UPDATE SET
                   name = excluded.name, platform = excluded.platform",
                rusqlite::params![device_id, owner_party_id, name, platform, now],
            )?;
            tx.connection().execute(
                "INSERT INTO access_device_secret (device_id, public_key)
                 VALUES (?1, ?2)
                 ON CONFLICT (device_id) DO UPDATE SET public_key = excluded.public_key",
                rusqlite::params![device_id, public_key],
            )?;
            Ok(())
        })?;
        Ok(())
    }

    /// Revoke a device. Returns whether it was enrolled.
    ///
    /// It used to sweep the device's rows out of the replay-outcome ledger
    /// first, "while the ownership rows still exist". That ledger is
    /// `replica_intent_outcome`, dropped with the replica plane (#1029, rung
    /// five), so revoking is now the one DELETE it always was underneath.
    pub fn revoke_device(&self, device_id: &str) -> Result<bool> {
        let outcome = self.commit(|tx| {
            tx.set_producer("devices.revoke");
            let removed = tx.connection().execute(
                "DELETE FROM access_device_secret WHERE device_id = ?1",
                [device_id],
            )?;
            Ok(removed > 0)
        })?;
        Ok(outcome.value)
    }

    /// Is this device enrolled? **Unknown and revoked are one answer.**
    pub fn is_device_enrolled(&self, device_id: &str, public_key: &str) -> Result<bool> {
        self.read(|connection| {
            let found: Option<String> = connection
                .query_row(
                    "SELECT public_key FROM access_device_secret WHERE device_id = ?1",
                    [device_id],
                    |row| row.get(0),
                )
                .ok();
            // Key EQUALITY, which is v0's authentication too: real request
            // signatures change only this comparison.
            Ok(found.as_deref() == Some(public_key))
        })
    }

    /// THE LIVE DEVICE THIS PUBLIC KEY IS, or `None` (#1025 S7, D-1025-S7-80).
    ///
    /// The gateway's admission question, and the reason the durable allowlist
    /// needs nothing new in the schema: `access_device_secret.public_key` is
    /// `UNIQUE`, so it is already the index a proved iroh EndpointId is looked
    /// up by. The JOIN is what makes "live" mean live — revoking deletes the
    /// private sibling, so a revoked device has a replicated row and no key and
    /// is not found here, which is the same refusal an unknown key gets.
    ///
    /// **Unknown and revoked are ONE answer** and that is the whole design
    /// (see this module's header): there is no "revoked" state to remember to
    /// check for, so there is no way to forget to check for it.
    pub fn device_by_public_key(&self, public_key: &str) -> Result<Option<Device>> {
        self.read(|connection| {
            let found = connection
                .query_row(
                    "SELECT d.device_id, d.owner_party_id, d.name, d.platform, d.enrolled_at,
                            CAST(s.sync_cursor AS INTEGER)
                       FROM access_device d
                       JOIN access_device_secret s ON s.device_id = d.device_id
                      WHERE s.public_key = ?1",
                    [public_key],
                    |row| {
                        Ok(Device {
                            device_id: row.get(0)?,
                            owner_party_id: row.get(1)?,
                            name: row.get(2)?,
                            platform: row.get(3)?,
                            enrolled_at: row.get(4)?,
                            sync_cursor: row.get(5)?,
                        })
                    },
                )
                .ok();
            Ok(found)
        })
    }

    /// Every live device WITH THE PUBLIC KEY IT IS KNOWN BY (#1025 S7,
    /// D-1025-S7-8x).
    ///
    /// The gateway's durable allowlist needs both halves: the member-facing
    /// device and the key a dialling peer proves. [`Self::live_devices`] is the
    /// member's list and deliberately does not carry the key — a device list on
    /// a screen has no business holding credentials — so the gateway asks for
    /// it by a different name rather than widening the row every screen reads.
    pub fn live_devices_with_keys(&self) -> Result<Vec<(Device, String)>> {
        self.read(|connection| {
            let mut statement = connection.prepare(
                "SELECT d.device_id, d.owner_party_id, d.name, d.platform, d.enrolled_at,
                        CAST(s.sync_cursor AS INTEGER), s.public_key
                   FROM access_device d
                   JOIN access_device_secret s ON s.device_id = d.device_id
                  ORDER BY d.enrolled_at, d.device_id",
            )?;
            let devices = statement
                .query_map([], |row| {
                    Ok((
                        Device {
                            device_id: row.get(0)?,
                            owner_party_id: row.get(1)?,
                            name: row.get(2)?,
                            platform: row.get(3)?,
                            enrolled_at: row.get(4)?,
                            sync_cursor: row.get(5)?,
                        },
                        row.get(6)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(devices)
        })
    }

    /// Every live device, newest enrolment last.
    pub fn live_devices(&self) -> Result<Vec<Device>> {
        self.read(|connection| {
            let mut statement = connection.prepare(
                "SELECT d.device_id, d.owner_party_id, d.name, d.platform, d.enrolled_at,
                        CAST(s.sync_cursor AS INTEGER)
                   FROM access_device d
                   JOIN access_device_secret s ON s.device_id = d.device_id
                  ORDER BY d.enrolled_at, d.device_id",
            )?;
            let devices = statement
                .query_map([], |row| {
                    Ok(Device {
                        device_id: row.get(0)?,
                        owner_party_id: row.get(1)?,
                        name: row.get(2)?,
                        platform: row.get(3)?,
                        enrolled_at: row.get(4)?,
                        sync_cursor: row.get(5)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(devices)
        })
    }
}
