//! WHICH BACKGROUND WINDOWS THE SHELL IS ASKED TO KEEP SCHEDULED, AND UNDER
//! WHAT CONSTRAINTS (#1080: "periodic WorkManager under constraints derived
//! from the rule").
//!
//! Platform-free: the shell maps a [`wire::Window`] onto WorkManager's
//! `NetworkType` and `setRequiresCharging`, or onto a BGTask request (a window
//! that requires charging is a processing request, the others app-refresh).
//!
//! **The core still decides every item.** A window's constraint is a floor that
//! saves waking the phone for nothing, never the rule itself: a window that
//! ran on cellular under Wi-Fi only would move thumbnails and leave originals
//! and the snapshot to the core's own refusal.

use centraid_api_proto::core_v1 as wire;

use super::rule::TransferRule;

/// v0's unique name for the periodic work, kept: a rename would orphan what a
/// shipped build scheduled, and the shell replaces the request in place.
pub const PERIODIC: &str = "centraid-sync-pass";
pub const NIGHT: &str = "centraid-night-shift";
pub const NUDGE: &str = "centraid-nudge";
/// WorkManager's periodic floor.
pub const PERIOD_MINUTES: u32 = 15;
pub const NIGHT_PERIOD_MINUTES: u32 = 60;

/// The periodic window. **UNMETERED unless the rule lets photographs cross
/// cellular**: under Wi-Fi only and manual the originals and the snapshot wait
/// for Wi-Fi, so a cellular window would wake the phone to move thumbnails a
/// foreground pass moves anyway.
#[must_use]
pub fn periodic(rule: TransferRule) -> wire::Window {
    wire::Window {
        name: PERIODIC.to_owned(),
        link: if rule == TransferRule::WifiAndCellularPhotos {
            wire::WindowLink::Connected
        } else {
            wire::WindowLink::Unmetered
        } as i32,
        requires_charging: false,
        period_minutes: PERIOD_MINUTES,
    }
}

/// THE NIGHT SHIFT: charging and unmetered, where a camera roll's first backup
/// and every video's original actually move. Hourly: the periodic window
/// already runs on a charger, so this one only buys the long idle windows a
/// charging phone is granted.
#[must_use]
pub fn night_shift() -> wire::Window {
    wire::Window {
        name: NIGHT.to_owned(),
        link: wire::WindowLink::Unmetered as i32,
        requires_charging: true,
        period_minutes: NIGHT_PERIOD_MINUTES,
    }
}

/// After a capture or an import: as soon as the rule's own floor allows.
#[must_use]
pub fn nudge(rule: TransferRule) -> wire::Window {
    wire::Window {
        name: NUDGE.to_owned(),
        period_minutes: 0,
        ..periodic(rule)
    }
}

/// Every window kept scheduled under `rule`. The one-off nudge is not among
/// them: it is asked for once, by an import.
#[must_use]
pub fn standing(rule: TransferRule) -> Vec<wire::Window> {
    vec![periodic(rule), night_shift()]
}

/// The effect that keeps [`standing`] scheduled.
#[must_use]
pub fn schedule(rule: TransferRule) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::ScheduleWindows(wire::ScheduleWindows {
            windows: standing(rule),
        })),
    }
}

/// The effect that asks for one more window soon.
#[must_use]
pub fn schedule_nudge(rule: TransferRule) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::ScheduleWindows(wire::ScheduleWindows {
            windows: vec![nudge(rule)],
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_periodic_window_waits_for_wifi_unless_the_rule_lets_photographs_cross_cellular() {
        let link = |rule| periodic(rule).link;
        assert_eq!(
            link(TransferRule::WifiOnly),
            wire::WindowLink::Unmetered as i32
        );
        assert_eq!(
            link(TransferRule::Manual),
            wire::WindowLink::Unmetered as i32
        );
        assert_eq!(
            link(TransferRule::WifiAndCellularPhotos),
            wire::WindowLink::Connected as i32
        );
        for rule in TransferRule::ALL {
            assert!(!periodic(rule).requires_charging);
            assert_eq!(nudge(rule).link, periodic(rule).link);
            assert_eq!(nudge(rule).period_minutes, 0);
        }
    }

    #[test]
    fn the_night_shift_needs_the_charger_and_wifi() {
        assert!(night_shift().requires_charging);
        assert_eq!(night_shift().link, wire::WindowLink::Unmetered as i32);
    }

    #[test]
    fn the_periodic_name_is_kept_and_every_window_has_its_own() {
        assert_eq!(PERIODIC, "centraid-sync-pass");
        let names = [
            periodic(TransferRule::WifiOnly).name,
            night_shift().name,
            nudge(TransferRule::WifiOnly).name,
        ];
        let distinct: std::collections::BTreeSet<_> = names.iter().collect();
        assert_eq!(distinct.len(), names.len());
        assert_eq!(periodic(TransferRule::WifiOnly).period_minutes, 15);
    }
}
