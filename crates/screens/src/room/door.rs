//! WHAT A ROOM MAY ASK OF THE CORE: run one catalogue action, take it back, and the time. A room
//! never opens the vault itself; the core hands the runtime this door.

use super::selector::Act;

/// An action that ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Done {
    /// The status line's sentence ("Note moved to trash").
    pub sentence: String,
    /// Whether the status line offers Undo.
    pub undo: bool,
}

/// An action the core refused, in the core's own sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub String);

/// A floating room date/time resolved using the open vault's time zone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedRoomMoment {
    /// Canonical UTC instant spelling used by vault commands.
    pub instant: String,
    /// True when the local wall clock occurs twice; the earlier instant is selected.
    pub overlap: bool,
}

pub trait Door {
    /// Run `act` as one commit.
    ///
    /// # Errors
    /// The core's sentence for a refusal.
    fn act(&self, act: &Act) -> Result<Done, Refused>;

    /// Run a read-only catalogue command and return its typed JSON output.
    ///
    /// # Errors
    /// The core's sentence for a refusal.
    fn command_result(
        &self,
        command: &str,
        input: &serde_json::Value,
    ) -> Result<serde_json::Value, Refused> {
        let _ = (command, input);
        Err(Refused("this door cannot return command output".to_owned()))
    }

    /// Stage export bytes in the core-owned vault staging area for the OS save sheet.
    ///
    /// # Errors
    /// The core's refusal.
    fn stage_export(&self, bytes: &[u8]) -> Result<String, Refused> {
        let _ = bytes;
        Err(Refused("this door cannot stage an export".to_owned()))
    }

    fn stage_archive(&self) -> Result<String, Refused> {
        Err(Refused("this door cannot stage an archive".to_owned()))
    }

    fn held_bytes(&self, hash: &str, max_bytes: u64) -> Result<Vec<u8>, Refused> {
        let _ = (hash, max_bytes);
        Err(Refused("held content is unavailable".to_owned()))
    }

    /// Remove an export file after the save sheet closes.
    fn remove_export(&self, path: &str) {
        let _ = path;
    }

    fn locker_unlocked(&self) -> bool {
        false
    }
    fn locker_unlock(&self) -> Result<(u32, Option<String>), Refused> {
        Err(Refused("Locker is unavailable.".to_owned()))
    }
    fn locker_unlock_failed(&self) -> Result<u32, Refused> {
        Err(Refused("Locker is unavailable.".to_owned()))
    }
    fn locker_failed_unlocks(&self) -> Result<(u32, Option<String>), Refused> {
        Err(Refused("Locker is unavailable.".to_owned()))
    }
    fn locker_lock(&self) -> Result<(), Refused> {
        Err(Refused("Locker is unavailable.".to_owned()))
    }
    fn locker_reveal_field(
        &self,
        item_id: &str,
        field_id: &str,
    ) -> Result<zeroize::Zeroizing<String>, Refused> {
        let _ = (item_id, field_id);
        Err(Refused("Locker is unavailable.".to_owned()))
    }
    fn locker_seal_field(
        &self,
        field_id: &str,
        plaintext: &str,
    ) -> Result<(String, String), Refused> {
        let _ = (field_id, plaintext);
        Err(Refused("Locker is unavailable.".to_owned()))
    }

    /// Take back the last action the status line offered Undo for.
    ///
    /// # Errors
    /// The core's sentence, when the record changed again.
    fn undo(&self) -> Result<Done, Refused>;

    fn now_ms(&self) -> i64;

    fn time_zone(&self) -> Option<centraid_vault::time::FireZone> {
        None
    }

    fn today(&self) -> String {
        let zone = self
            .time_zone()
            .or_else(|| centraid_vault::time::FireZone::named("UTC").ok());
        let now = centraid_vault::clock::format_iso_ms(self.now_ms());
        zone.and_then(|zone| centraid_domain::civil::today(&zone, &now))
            .unwrap_or_else(|| now.chars().take(10).collect())
    }

    fn now_local(&self) -> String {
        let zone = self
            .time_zone()
            .or_else(|| centraid_vault::time::FireZone::named("UTC").ok());
        let now = centraid_vault::clock::format_iso_ms(self.now_ms());
        zone.and_then(|zone| centraid_domain::civil::now_local(&zone, &now))
            .unwrap_or_else(|| now.chars().take(16).collect())
    }

    /// Render a canonical instant as the open vault's local `YYYY-MM-DDTHH:mm` value.
    fn wall_time(&self, instant: &str) -> Option<String> {
        let millis = centraid_vault::time::recurrence::parse_instant_ms(instant)?;
        let zone = self
            .time_zone()
            .or_else(|| centraid_vault::time::FireZone::named("Etc/UTC").ok())?;
        Some(centraid_domain::civil::civil_minute(
            zone.zoned_parts(millis),
        ))
    }

    /// Resolve a floating local wall time. A skipped clock time is rejected for
    /// one-off edits; an overlapping time selects the earlier instant and marks
    /// the result so the room can explain that choice.
    fn resolve_wall_time(&self, wall: &str) -> Result<ResolvedRoomMoment, Refused> {
        let invalid = || Refused("Enter a valid local date and time.".to_owned());
        if centraid_vault::time::has_zone_designator(wall) {
            return Err(invalid());
        }
        let wall = centraid_vault::time::zone::parse_wall_iso(wall).ok_or_else(invalid)?;
        let zone = self
            .time_zone()
            .or_else(|| centraid_vault::time::FireZone::named("Etc/UTC").ok())
            .ok_or_else(invalid)?;
        let resolved = zone.resolve_wall_time(wall).ok_or_else(|| {
            Refused("That local time does not exist because the clocks change.".to_owned())
        })?;
        Ok(ResolvedRoomMoment {
            instant: resolved.instant,
            overlap: resolved.overlap,
        })
    }

    fn shift_day(&self, day: &str, days: i64) -> String {
        centraid_domain::civil::shift_day(day, days).unwrap_or_else(|| day.to_owned())
    }

    fn day_start(&self, day: &str) -> String {
        let zone = self
            .time_zone()
            .or_else(|| centraid_vault::time::FireZone::named("UTC").ok());
        zone.and_then(|zone| centraid_domain::civil::day_start(&zone, day))
            .unwrap_or_else(|| format!("{day}T00:00:00.000Z"))
    }

    fn at_time(&self, day: &str, hour: u8, minute: u8) -> String {
        let zone = self
            .time_zone()
            .or_else(|| centraid_vault::time::FireZone::named("UTC").ok());
        zone.and_then(|zone| centraid_domain::civil::at_time(&zone, day, hour, minute))
            .unwrap_or_else(|| format!("{day}T{hour:02}:{minute:02}:00.000Z"))
    }

    /// One request of the core's own (the backup status, a drain).
    ///
    /// # Errors
    /// The core's sentence.
    fn call(
        &self,
        request: &centraid_api_proto::core_v1::Request,
    ) -> Result<centraid_api_proto::core_v1::Response, Refused> {
        let _ = request;
        Err(Refused("this door carries no core".to_owned()))
    }

    /// A device-store key's value.
    fn device_get(&self, key: &str) -> Option<String> {
        let _ = key;
        None
    }

    /// Write a device-store key, through the registry.
    ///
    /// # Errors
    /// The registry's or the store's sentence.
    fn device_put(&self, key: &str, value: &str) -> Result<(), Refused> {
        let _ = (key, value);
        Err(Refused("this door keeps no device store".to_owned()))
    }

    /// Remove a device-store key, through the registry.
    ///
    /// # Errors
    /// The registry's or the store's sentence.
    fn device_delete(&self, key: &str) -> Result<(), Refused> {
        let _ = key;
        Err(Refused("this door keeps no device store".to_owned()))
    }

    /// A read-only door onto the vault file, guarded by the SQLite authorizer.
    ///
    /// # Errors
    /// The core's sentence.
    fn reader(&self) -> Result<centraid_domain::read::Reader, Refused> {
        Err(Refused("this door carries no reader".to_owned()))
    }

    fn search(
        &self,
        request: &centraid_search::EachRequest,
    ) -> Result<Vec<centraid_search::Target>, Refused> {
        let _ = request;
        Err(Refused("search is unavailable".to_owned()))
    }

    fn search_page(
        &self,
        request: &centraid_search::SearchRequest,
    ) -> Result<centraid_search::Answer, Refused> {
        let _ = request;
        Err(Refused("search is unavailable".to_owned()))
    }

    fn search_correction(
        &self,
        kinds: &[String],
        query: &str,
        thin: bool,
    ) -> Result<Option<String>, Refused> {
        let _ = (kinds, query, thin);
        Err(Refused("search is unavailable".to_owned()))
    }

    /// Whether this phone has a Reminders store to import from (iOS does, Android has none).
    fn reminders_source(&self) -> bool {
        true
    }

    /// What a draft is kept under for the vault in front.
    fn vault_id(&self) -> String {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Clock;

    impl Door for Clock {
        fn act(&self, _: &Act) -> Result<Done, Refused> {
            unreachable!()
        }

        fn undo(&self) -> Result<Done, Refused> {
            unreachable!()
        }

        fn now_ms(&self) -> i64 {
            centraid_vault::time::recurrence::parse_instant_ms("2026-01-01T02:00:00.000Z")
                .expect("an instant")
        }

        fn time_zone(&self) -> Option<centraid_vault::time::FireZone> {
            centraid_vault::time::FireZone::named("America/New_York").ok()
        }
    }

    #[test]
    fn civil_clock_uses_the_supplied_zone_near_midnight() {
        assert_eq!(Clock.today(), "2025-12-31");
        assert_eq!(Clock.now_local(), "2025-12-31T21:00");
        assert_eq!(Clock.shift_day(&Clock.today(), 1), "2026-01-01");
        assert_eq!(Clock.day_start("2025-12-31"), "2025-12-31T05:00:00.000Z");
        assert_eq!(
            Clock.at_time("2025-12-31", 7, 0),
            "2025-12-31T12:00:00.000Z"
        );
    }

    #[test]
    fn room_moments_use_the_vault_zone_and_refuse_gaps() {
        assert_eq!(
            Clock.wall_time("2026-10-22T13:00:00.000Z").as_deref(),
            Some("2026-10-22T09:00")
        );
        let ordinary = Clock
            .resolve_wall_time("2026-10-22T09:00")
            .expect("ordinary local time");
        assert_eq!(ordinary.instant, "2026-10-22T13:00:00.000Z");
        assert!(!ordinary.overlap);

        let overlap = Clock
            .resolve_wall_time("2026-11-01T01:30")
            .expect("overlap chooses the earlier instant");
        assert_eq!(overlap.instant, "2026-11-01T05:30:00.000Z");
        assert!(overlap.overlap);

        let gap = Clock
            .resolve_wall_time("2026-03-08T02:30")
            .expect_err("one-off edits cannot normalize a nonexistent time");
        assert_eq!(
            gap.0,
            "That local time does not exist because the clocks change."
        );
    }
}
