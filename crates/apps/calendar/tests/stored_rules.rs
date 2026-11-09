//! A STORED RULE THAT NOW FAILS TO PARSE STILL LOADS (#1173, owner decision):
//! Calendar's reads of an event whose stored rule this build cannot
//! read. The row is put in through `fixtures::store_unreadable_rule`, past
//! every write boundary (which refuses such a rule), the way an older build or
//! an import left it.
//!
//! - the event is on the agenda ONCE, at its anchor, with its stored rule (the
//!   editor opens it read-only as Custom) and no occurrences invented;
//! - its detail loads;
//!
//! The vault's half (completion, follow merge, edits) is
//! `crates/vault/tests/stored_rules.rs`; the screens' (the read-only Custom
//! editor, the detail) is in `crates/screens/tests/agenda_repeat.rs`.

use centraid_apps_calendar::{load_event, load_upcoming};
use centraid_apps_kit::fixtures::{RuleOwner, store_unreadable_rule};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::commands::Registry;
use centraid_vault::time::zone::FireZone;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::{Value, json};

const UNREADABLE: &str = "FREQ=DAILY;BYHOUR=9";

struct World {
    dir: std::path::PathBuf,
    vault: Vault,
    registry: Registry,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl World {
    fn new() -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let vault = Vault::create(dir.join("vault.db")).expect("a vault");
        vault.found("Home", "Owner").expect("founded");
        Self {
            dir,
            vault,
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn id(&self, name: &str, input: Value) -> String {
        let outcome = self
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .expect("runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output["id"].as_str().expect("an id").to_owned()
    }

    fn store(&self, owner: RuleOwner, id: &str) {
        self.vault
            .commit(|tx| {
                store_unreadable_rule(tx.connection(), owner, id, UNREADABLE).map_err(|error| {
                    centraid_vault::VaultError::Invariant {
                        context: error.to_string(),
                    }
                })
            })
            .expect("a write");
    }
}

#[test]
fn an_event_with_an_unreadable_rule_is_on_the_agenda_once_at_its_anchor_and_its_detail_loads() {
    let world = World::new();
    let event = world.id(
        "event.propose",
        json!({ "title": "Standup", "starts": "2026-03-02T09:00", "ends": "2026-03-02T09:15",
                "timing": "floating", "rule": "FREQ=DAILY" }),
    );
    world.store(RuleOwner::Event, &event);
    let zone = FireZone::named("Etc/UTC").expect("a zone");
    world
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let (upcoming, denial) = load_upcoming(
                &door,
                Some("2026-03-01T00:00:00.000Z"),
                Some("2026-04-01T00:00:00.000Z"),
                "2026-03-01T00:00:00.000Z",
                &zone,
            )
            .expect("reads");
            assert!(denial.is_none());
            assert_eq!(
                upcoming.events.len(),
                1,
                "the anchor, and no occurrence invented: {:?}",
                upcoming.events
            );
            let row = &upcoming.events[0];
            assert_eq!(row.event_id, event);
            assert_eq!(row.dtstart, "2026-03-02T09:00");
            assert_eq!(
                row.rrule.as_deref(),
                Some(UNREADABLE),
                "the stored rule, for the editor to open read-only as Custom"
            );
            assert!(!row.is_recurrence_instance);

            let (detail, denial) = load_event(&door, &event, None, None).expect("reads");
            assert!(denial.is_none());
            let shown = detail.event.expect("the detail loads");
            assert_eq!(shown.summary.as_deref(), Some("Standup"));
            assert_eq!(shown.rrule.as_deref(), Some(UNREADABLE));
            Ok(())
        })
        .expect("a read");
}
