//! A clock far from the vault's last commit deletes nothing (#1191, V19). Each test moves the
//! injected clock for real and looks at the rows: the trash and the action keys are all still
//! there after a launch pass under a clock years ahead (or days behind), and a pass whose clock
//! is within the bound still purges and still prunes.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::action_key::KeyMark;
use centraid_vault::clock::{CLOCK_BOUND_DAYS, Clock as _};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Vault};
use serde_json::json;

fn count(vault: &Vault, sql: &str) -> i64 {
    vault
        .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
        .expect("counts")
}

fn owner() -> Principal {
    Principal::owner("phone")
}

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new(seed: &str) -> Self {
        Self {
            scratch: common::Scratch::founded(seed).expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        let outcome = self
            .scratch
            .vault
            .execute(&self.registry, &owner(), &Command::new(name, input))
            .expect("runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn keyed(&self, key: &'static str, title: &str) {
        let mark = KeyMark {
            key,
            asked: "digest",
        };
        let outcome = self
            .scratch
            .vault
            .execute_keyed(
                &self.registry,
                &owner(),
                &Command::new(
                    "container.create",
                    json!({"kind": "folder", "title": title}),
                ),
                Some(&mark),
            )
            .expect("runs");
        assert_eq!(outcome.status, CommandStatus::Executed);
    }

    /// A note in the trash, ready to be overdue 30 days on.
    fn trashed_note(&self, title: &str) -> String {
        let id = self.run("note.create", json!({"title": title, "body": "words"}))["id"]
            .as_str()
            .expect("an id")
            .to_owned();
        self.run("entity.trash", json!({"id": id}));
        id
    }

    fn pass(&self) -> usize {
        let mut purged = 0;
        loop {
            let step = self
                .scratch
                .vault
                .empty_overdue_trash_step(&self.registry, 50, false)
                .expect("the pass runs");
            purged += step.purged;
            if !step.more {
                return purged;
            }
        }
    }

    fn trashed(&self) -> i64 {
        count(
            &self.scratch.vault,
            "SELECT COUNT(*) FROM entity WHERE deleted_at IS NOT NULL",
        )
    }
}

#[test]
fn a_clock_years_ahead_purges_nothing_and_a_normal_gap_still_purges() {
    let w = World::new("bound-ahead");
    w.trashed_note("one");
    w.trashed_note("two");
    w.keyed("k1", "A");
    w.keyed("k2", "B");
    assert_eq!(w.trashed(), 2);

    // THREE YEARS AHEAD: every trashed row reads as long overdue. Nothing is purged and nothing is
    // written.
    w.scratch.clock.advance_days(3 * 365);
    let writes = count(&w.scratch.vault, "SELECT writes FROM vault");
    assert_eq!(w.pass(), 0, "a clock years ahead purges nothing");
    assert_eq!(w.trashed(), 2, "every trashed row is still there");
    assert_eq!(count(&w.scratch.vault, "SELECT writes FROM vault"), writes);

    // A NORMAL GAP: back to the day the member last wrote; the trash lapses 29 days on, they
    // write that day, and two days later the launch pass purges what has lapsed.
    let w = World::new("bound-normal");
    w.trashed_note("one");
    w.scratch.clock.advance_days(29);
    w.run("note.create", json!({"title": "later", "body": "x"}));
    w.scratch.clock.advance_days(2);
    assert_eq!(w.pass(), 1, "within the bound, the lapsed row is purged");
    assert_eq!(w.trashed(), 0);
}

#[test]
fn a_clock_years_ahead_prunes_no_action_key_and_a_normal_one_does() {
    let w = World::new("bound-keys");
    w.keyed("old", "A");
    w.keyed("older", "B");
    w.scratch.clock.advance_days(3 * 365);
    w.keyed("new", "C");
    assert_eq!(
        count(&w.scratch.vault, "SELECT COUNT(*) FROM action_key"),
        3,
        "no key was forgotten under a clock years ahead"
    );

    let w = World::new("bound-keys-normal");
    w.keyed("old", "A");
    w.scratch.clock.advance_days(29);
    w.keyed("recent", "B");
    w.scratch.clock.advance_days(2);
    w.keyed("new", "C");
    assert_eq!(
        count(&w.scratch.vault, "SELECT COUNT(*) FROM action_key"),
        2,
        "within the bound the key past thirty days is forgotten"
    );
}

#[test]
fn a_clock_behind_the_last_commit_purges_nothing_either() {
    let w = World::new("bound-behind");
    w.trashed_note("one");
    w.scratch.clock.advance_days(60);
    w.run("note.create", json!({"title": "later", "body": "x"}));
    // The phone's clock slips back 15 days: the row reads as lapsed (day 45 > 30) but the clock
    // cannot be believed.
    w.scratch
        .clock
        .set_ms(w.scratch.clock.now_ms() - 15 * 86_400_000);
    assert_eq!(w.pass(), 0);
    assert_eq!(w.trashed(), 1);
    // Back within the bound of the last commit, it purges.
    w.scratch.clock.advance_days(16);
    assert_eq!(w.pass(), 1);
    assert_eq!(w.trashed(), 0);
}

/// The exact edge of the bound, read straight off `is_credible`: seven days from the vault's last
/// write is believed, seven days and a millisecond is not, in either direction.
#[test]
fn the_bound_is_seven_days_to_the_millisecond_in_both_directions() {
    let w = World::new("bound-edge");
    w.run("note.create", json!({"title": "n", "body": "x"}));
    let written = w
        .scratch
        .vault
        .read(|connection| {
            let text: String =
                connection.query_row("SELECT written_at FROM vault", [], |row| row.get(0))?;
            Ok(text)
        })
        .expect("reads written_at");
    let written_ms =
        centraid_vault::time::recurrence::parse_instant_ms(&written).expect("an instant");
    let credible = |now: i64| {
        w.scratch
            .vault
            .read(|connection| centraid_vault::clock::is_credible(connection, now))
            .expect("asks")
    };
    let bound = CLOCK_BOUND_DAYS * 86_400_000;
    assert!(credible(written_ms), "the moment of the write");
    assert!(credible(written_ms + bound), "seven days on");
    assert!(
        !credible(written_ms + bound + 1),
        "seven days and a millisecond on"
    );
    assert!(credible(written_ms - bound), "seven days behind");
    assert!(
        !credible(written_ms - bound - 1),
        "seven days and a millisecond behind"
    );
}

/// A phone idle for 8 days: the first pass after it purges nothing (the clock is more than the
/// bound from the last write), the member writes once, and the next pass purges the rows that are
/// due. Counted, not timed.
#[test]
fn a_phone_idle_eight_days_purges_after_its_first_write() {
    let w = World::new("bound-idle");
    w.trashed_note("one");
    // The trash lapses at 30 days; the phone is then idle a further stretch past the 7-day bound.
    w.scratch.clock.advance_days(31);
    assert_eq!(
        w.pass(),
        0,
        "idle more than the bound: the first pass purges nothing"
    );
    assert_eq!(w.trashed(), 1);
    // The member opens the app and writes once: that write re-bases the bound on today's clock.
    w.run("note.create", json!({"title": "back", "body": "x"}));
    assert_eq!(
        w.pass(),
        1,
        "after one write, the next pass purges what is due"
    );
    assert_eq!(w.trashed(), 0);
}
