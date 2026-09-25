//! A TRASHED EVENT IS NOT ON THE AGENDA ([#1046](https://github.com/srikanth235/centraid/issues/1046)).
//!
//! `schedule.delete_event` moves an event to the trash: `deleted_at` and
//! `purge_at` are set and the row stays for its restore window. The question
//! this file answers is whether `upcoming` shows it anyway, and it answers it
//! against a REAL vault — founded, written through the registered commands, and
//! read through the ported statements — because the parity corpus cannot: it is
//! v0's own answer, and v0 shows the trashed row (`tests/parity.rs`,
//! `TRASHED_IN_V0`).
//!
//! Two shapes, because the two discovering reads are two statements: a one-off
//! is found by the range window, and a series by the anchor read, which reaches
//! back past any range and would otherwise bring a deleted series back one
//! occurrence a week.

use centraid_apps_agenda::queries::load_upcoming;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::Vault;
use centraid_vault::access::Principal;
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::time::zone::FireZone;
use serde_json::{Value, json};

const FROM: &str = "2099-06-01T00:00:00.000Z";
const TO: &str = "2099-06-22T00:00:00.000Z";
const NOW: &str = "2099-06-01T09:00:00.000Z";

/// The events here are floating (no `start_tz`), so the zone only reads the
/// lower bound; UTC keeps `FROM` and the wall clocks on one axis.
fn utc() -> FireZone {
    FireZone::named("Etc/UTC").expect("UTC is in the bundled database")
}

struct Scratch {
    dir: std::path::PathBuf,
    vault: Vault,
    registry: Registry,
}

impl Scratch {
    fn founded(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "centraid-agenda-trash-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |since| since.as_nanos())
        ));
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let vault = Vault::create(dir.join("vault.db")).expect("a vault file");
        vault.found("Trash", "Owner").expect("founded");
        let registry = Registry::with_system_commands().expect("the system commands register");
        Self {
            dir,
            vault,
            registry,
        }
    }

    fn run(&self, name: &str, input: Value) -> Value {
        let outcome = self
            .vault
            .execute(
                &self.registry,
                &Principal::owner("agenda-trash-test"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("{name} refused: {error}"));
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    /// The summaries `upcoming` answers over the three-week window.
    fn upcoming(&self) -> Vec<String> {
        self.upcoming_starts()
            .into_iter()
            .map(|(summary, _)| summary)
            .collect()
    }

    /// `(summary, dtstart)` for every row `upcoming` answers.
    fn upcoming_starts(&self) -> Vec<(String, String)> {
        self.vault
            .read(|connection| {
                let door = TestDoor::new(connection);
                let (data, denial) = load_upcoming(&door, Some(FROM), Some(TO), NOW, &utc())
                    .expect("upcoming reads");
                assert!(denial.is_none(), "the owner is not refused");
                Ok(data
                    .events
                    .into_iter()
                    .filter_map(|event| Some((event.summary?, event.dtstart)))
                    .collect())
            })
            .expect("the read runs")
    }

    fn calendar_id(&self) -> String {
        self.vault
            .read(|connection| {
                let door = TestDoor::new(connection);
                let (data, _) = load_upcoming(&door, Some(FROM), Some(TO), NOW, &utc())
                    .expect("upcoming reads");
                Ok(data
                    .calendars
                    .first()
                    .map(|calendar| calendar.calendar_id.clone())
                    .expect("founding makes a calendar"))
            })
            .expect("the read runs")
    }

    fn propose(&self, summary: &str, dtstart: &str, dtend: &str, rrule: Option<&str>) -> String {
        let mut input = json!({
            "summary": summary,
            "dtstart": dtstart,
            "dtend": dtend,
            "calendar_id": self.calendar_id(),
        });
        if let Some(rule) = rrule {
            input["rrule"] = json!(rule);
        }
        self.run("schedule.propose_event", input)["event_id"]
            .as_str()
            .expect("an event id")
            .to_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// THE ONE-OFF: found by the range window. Before the fix this answered both
/// summaries, the deleted one included, for its whole restore window.
#[test]
fn a_one_off_moved_to_the_trash_leaves_the_agenda() {
    let scratch = Scratch::founded("one-off");
    let kept = scratch.propose(
        "Dentist",
        "2099-06-03T09:00:00.000Z",
        "2099-06-03T10:00:00.000Z",
        None,
    );
    let trashed = scratch.propose(
        "Book the cabin",
        "2099-06-04T09:00:00.000Z",
        "2099-06-04T10:00:00.000Z",
        None,
    );
    assert_ne!(kept, trashed);
    assert_eq!(scratch.upcoming(), vec!["Dentist", "Book the cabin"]);

    scratch.run("schedule.delete_event", json!({ "event_id": trashed }));
    assert_eq!(
        scratch.upcoming(),
        vec!["Dentist"],
        "a trashed event is not on the agenda"
    );

    // AND A RESTORE BRINGS IT BACK: the clause is the trash, not a tombstone.
    scratch.run("schedule.restore_event", json!({ "event_id": trashed }));
    assert_eq!(scratch.upcoming(), vec!["Dentist", "Book the cabin"]);
}

/// THE SERIES: found by the anchor read as well as the window. A clause on the
/// window alone would still expand a deleted series from its anchor.
#[test]
fn a_series_moved_to_the_trash_leaves_every_occurrence() {
    let scratch = Scratch::founded("series");
    let series = scratch.propose(
        "Morning run",
        "2099-05-04T07:00:00.000Z",
        "2099-05-04T08:00:00.000Z",
        Some("FREQ=WEEKLY"),
    );
    // Every row answered is in range — the reach-back's past occurrences are
    // bounded off (`tests/lower_bound.rs`) — so the count is the range's.
    let before = scratch.upcoming_starts();
    assert_eq!(
        before
            .iter()
            .filter(|(summary, _)| summary == "Morning run")
            .count(),
        3,
        "three weeks, three occurrences: {before:?}"
    );

    scratch.run("schedule.delete_event", json!({ "event_id": series }));
    assert!(
        scratch.upcoming().is_empty(),
        "no occurrence of a trashed series is on the agenda"
    );
}

/// SEARCH FROM A TERM, through the FTS door and back through the page door —
/// and the trash is out of it too. The index drops a trashed row by trigger;
/// `agenda.search.events` says so again, and this is the check that the two
/// together answer the live event in rank order with the index's own snippet.
#[test]
fn search_answers_the_live_event_with_its_snippet_and_not_the_trashed_one() {
    use centraid_apps_agenda::queries::load_search_term;
    use centraid_search::{Principal as SearchPrincipal, SqliteDoor};

    let scratch = Scratch::founded("search");
    let live = scratch.propose(
        "Cabin weekend",
        "2099-06-05T16:00:00.000Z",
        "2099-06-07T16:00:00.000Z",
        None,
    );
    let trashed = scratch.propose(
        "Book the cabin",
        "2099-06-04T09:00:00.000Z",
        "2099-06-04T10:00:00.000Z",
        None,
    );
    scratch.run("schedule.delete_event", json!({ "event_id": trashed }));

    let (data, denial) = scratch
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let search = SqliteDoor::open(connection).expect("the FTS door opens");
            Ok(
                load_search_term(&door, &search, &SearchPrincipal::Owner, "cabin", 20)
                    .expect("search reads"),
            )
        })
        .expect("the read runs");
    assert!(denial.is_none(), "the owner is not refused");
    let ids: Vec<&str> = data
        .events
        .iter()
        .map(|event| event.event_id.as_str())
        .collect();
    assert_eq!(ids, vec![live.as_str()], "the live event and only it");
    let hit = &data.events[0];
    assert!(
        hit.snippet
            .as_deref()
            .is_some_and(|snippet| snippet.contains("⟦")),
        "the index's own highlight rides the hit: {:?}",
        hit.snippet
    );
    assert_eq!(
        hit.instance_key, live,
        "a hit is the series, keyed by its id"
    );

    // A TERM OF PUNCTUATION IS NOTHING, NOT A REFUSAL.
    let (empty, denial) = scratch
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let search = SqliteDoor::open(connection).expect("the FTS door opens");
            Ok(
                load_search_term(&door, &search, &SearchPrincipal::Owner, "---", 20)
                    .expect("search reads"),
            )
        })
        .expect("the read runs");
    assert!(empty.events.is_empty());
    assert!(
        denial.is_none(),
        "a member who typed `---` was refused nothing"
    );
}
