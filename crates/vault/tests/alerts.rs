//! THE ALERT INDEX (#1188, A5; #1214 D2): what a reminder fires next, kept by the index writer.
//!
//! The event, task, person and Locker command modules are other lanes', so the items here are raw-SQL
//! fixtures (committed through the guard, so the index sees them as it sees a command's); the
//! reminders are made by the reminder commands.

mod common;

use std::sync::Arc;

use centraid_vault::alerts::{self, Alert};
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::{Value, json};

const AT: &str = "2026-01-01T00:00:00.000Z";

fn id(n: u64) -> String {
    format!("01900000-0000-7000-8000-{n:012x}")
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

    /// Raw SQL in a commit (the index file is written after it, as for a command's commit).
    fn sql(&self, sql: &str) {
        self.scratch
            .vault
            .commit(|tx| {
                tx.connection().execute_batch(sql)?;
                Ok(())
            })
            .unwrap_or_else(|error| panic!("{sql}\n{error}"));
    }

    fn run(&self, name: &str, input: Value) -> Result<Value, String> {
        let outcome = self
            .scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .map_err(|error| error.to_string())?;
        if outcome.status == CommandStatus::Executed {
            Ok(outcome.output)
        } else {
            Err(outcome.reason.unwrap_or_default())
        }
    }

    fn ok(&self, name: &str, input: Value) -> Value {
        self.run(name, input)
            .unwrap_or_else(|why| panic!("`{name}`: {why}"))
    }

    fn event(
        &self,
        n: u64,
        starts: &str,
        timing: &str,
        zone: Option<&str>,
        rule: Option<&str>,
    ) -> String {
        let e = id(n);
        let zone = zone.map_or("NULL".to_owned(), |z| format!("'{z}'"));
        let rule = rule.map_or("NULL".to_owned(), |r| format!("'{r}'"));
        self.sql(&format!(
            "INSERT INTO entity (id, kind, title, parent_id, parent_kind, created_at, updated_at)
               VALUES ('{e}', 'event', 'Standup', 'calendar:default', 'calendar', '{AT}', '{AT}');
             INSERT INTO event (id, starts, timing, zone, rule)
               VALUES ('{e}', '{starts}', '{timing}', {zone}, {rule});"
        ));
        e
    }

    fn task(
        &self,
        n: u64,
        due: &str,
        timing: &str,
        zone: Option<&str>,
        rule: Option<&str>,
    ) -> String {
        let t = id(n);
        let zone = zone.map_or("NULL".to_owned(), |z| format!("'{z}'"));
        let rule = rule.map_or("NULL".to_owned(), |r| format!("'{r}'"));
        self.sql(&format!(
            "INSERT INTO entity (id, kind, title, created_at, updated_at)
               VALUES ('{t}', 'task', 'Call', '{AT}', '{AT}');
             INSERT INTO task (id, due, due_timing, zone, rule) VALUES ('{t}', '{due}', '{timing}', {zone}, {rule});"
        ));
        t
    }

    fn person(&self, n: u64, title: &str) -> String {
        let p = id(n);
        self.sql(&format!(
            "INSERT INTO entity (id, kind, title, created_at, updated_at)
               VALUES ('{p}', 'person', '{title}', '{AT}', '{AT}');
             INSERT INTO person (id) VALUES ('{p}');"
        ));
        p
    }

    fn date(&self, person: &str, n: u64, kind: &str, date: &str, label: Option<&str>) -> String {
        let d = id(n);
        let single = i32::from(kind == "birthday");
        let label = label.map_or("NULL".to_owned(), |l| format!("'{l}'"));
        self.sql(&format!(
            "INSERT INTO person_date (id, person_id, kind, single, label, date)
               VALUES ('{d}', '{person}', '{kind}', {single}, {label}, '{date}');"
        ));
        d
    }

    /// A Locker item "Bank" with a sealed card number, a text field and a date field "Expiry".
    fn item(&self, n: u64) -> (String, String, String, String) {
        let item = id(n);
        let (sealed, text, date) = (id(n + 1), id(n + 2), id(n + 3));
        self.sql(&format!(
            "INSERT INTO entity (id, kind, title, created_at, updated_at)
               VALUES ('{item}', 'locker_item', 'Bank', '{AT}', '{AT}');
             INSERT INTO locker_item (id, type) VALUES ('{item}', 'login');
             INSERT OR IGNORE INTO locker_key (id, key_id, created_at) VALUES (1, 'k1', '{AT}');
             INSERT INTO locker_item_field (id, item_id, label, kind, value_sealed, key_id, value_set_at, created_at, updated_at)
               VALUES ('{sealed}', '{item}', 'Card number', 'sealed', 'lk1:SECRETVALUE', 'k1', '{AT}', '{AT}', '{AT}');
             INSERT INTO locker_item_field (id, item_id, label, kind, value_text, created_at, updated_at)
               VALUES ('{text}', '{item}', 'Note', 'text', 'plain words', '{AT}', '{AT}');
             INSERT INTO locker_item_field (id, item_id, label, kind, value_text, created_at, updated_at)
               VALUES ('{date}', '{item}', 'Expiry', 'date', '2030-01-31', '{AT}', '{AT}');"
        ));
        (item, sealed, text, date)
    }

    fn add(
        &self,
        entity: &str,
        date: Option<&str>,
        field: Option<&str>,
        offset: i64,
    ) -> Result<String, String> {
        let mut input = json!({ "entity_id": entity, "offset_min": offset });
        if let Some(date) = date {
            input["date_id"] = json!(date);
        }
        if let Some(field) = field {
            input["field_id"] = json!(field);
        }
        self.run("reminder.add", input)
            .map(|out| out["id"].as_str().expect("an id").to_owned())
    }

    fn remind(&self, entity: &str, offset: i64) -> String {
        self.add(entity, None, None, offset).expect("a reminder")
    }

    fn key(&self, reminder: &str) -> Option<(String, String)> {
        self.scratch
            .vault
            .read(|c| {
                Ok(c.query_row(
                    "SELECT timing, fire_key FROM alert WHERE reminder_id = ?1",
                    [reminder],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok())
            })
            .expect("reads")
    }

    fn rows(&self) -> Vec<Alert> {
        self.scratch
            .vault
            .read(|c| alerts::next(c, "0000", "0000", 1000))
            .expect("rows")
    }

    fn dump(&self) -> Vec<String> {
        self.scratch
            .vault
            .read(|c| {
                let mut s = c.prepare(
                    "SELECT reminder_id || '|' || n || '|' || timing || '|' || fire_key || '|' || repeats
                       FROM alert ORDER BY reminder_id",
                )?;
                Ok(s.query_map([], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .expect("dump")
    }
}

fn is(key: Option<(String, String)>, timing: &str, fire: &str) {
    assert_eq!(key, Some((timing.to_owned(), fire.to_owned())));
}

// ---------------------------------------------------------------------------------------------
// 1. The commands: where a reminder may go
// ---------------------------------------------------------------------------------------------

#[test]
fn a_reminder_goes_on_an_event_a_task_a_persons_date_or_a_locker_date_and_nowhere_else() {
    let w = World::new("alerts_where");
    let event = w.event(1, "2030-03-01T10:00", "floating", None, None);
    let task = w.task(2, "2030-03-01T10:00", "floating", None, None);
    let person = w.person(3, "Ada");
    let birthday = w.date(&person, 4, "birthday", "1990-03-14", None);
    let wedding = w.date(&person, 5, "anniversary", "2015-06-01", Some("Wedding"));
    let (item, sealed, text, expiry) = w.item(10);
    let note = common::insert_note(&w.scratch.vault, "N").expect("a note");

    let on_event = w.remind(&event, 10);
    let on_task = w.remind(&task, 10);
    // The same lead on two dates of one person is two reminders.
    let on_birthday = w
        .add(&person, Some(&birthday), None, 1440)
        .expect("birthday");
    let on_wedding = w.add(&person, Some(&wedding), None, 1440).expect("wedding");
    assert_ne!(on_birthday, on_wedding);
    let on_expiry = w.add(&item, None, Some(&expiry), 0).expect("expiry");
    assert!(w.key(&on_expiry).is_some());

    for (who, expect) in [(&event, 1), (&task, 1), (&person, 2), (&item, 1)] {
        let rows = w
            .scratch
            .vault
            .read(|c| centraid_vault::commands::reminder::list(c, who))
            .expect("lists");
        assert_eq!(rows.len(), expect, "{who}");
    }

    // Everything else is refused with a sentence the member can read.
    let refused = |result: Result<String, String>, fragment: &str| {
        let why = result.expect_err("refused");
        assert!(why.contains(fragment), "`{why}` should say `{fragment}`");
    };
    refused(w.add(&note, None, None, 5), "no time to remind at");
    refused(w.add(&person, None, None, 5), "names one of their dates");
    refused(w.add(&person, None, Some(&text), 5), "not a Locker field");
    refused(w.add(&event, Some(&birthday), None, 5), "no date to name");
    refused(w.add(&task, None, Some(&expiry), 5), "no date to name");
    let other = w.person(30, "Bob");
    refused(w.add(&other, Some(&birthday), None, 5), "not one of");
    refused(w.add(&item, None, None, 5), "names one of its date fields");
    refused(w.add(&item, None, Some(&text), 5), "is not a date field");
    refused(w.add(&item, None, Some(&sealed), 5), "is not a date field");
    refused(
        w.add(&item, Some(&birthday), None, 5),
        "not a person's date",
    );
    refused(w.add(&event, None, None, 10), "already has a reminder");
    refused(w.add(&event, None, None, -1), "offset_min");
    refused(w.add(&id(999), None, None, 5), "nothing with the id");

    w.ok("reminder.remove", json!({ "id": on_event }));
    assert!(w.run("reminder.remove", json!({ "id": on_event })).is_err());
    assert!(w.key(&on_event).is_none() && w.key(&on_task).is_some());
}

// ---------------------------------------------------------------------------------------------
// 2. The next firing
// ---------------------------------------------------------------------------------------------

#[test]
fn the_next_firing_of_each_kind_of_moment_with_the_lead_counted_back() {
    // The clock is 2026-01-01T00:00Z, the vault has no zone: its wall clock is UTC's.
    let w = World::new("alerts_table");
    let zoned = w.event(1, "2026-03-01T10:00:00.000Z", "zoned", Some("UTC"), None);
    let floating = w.event(2, "2026-03-01T10:00", "floating", None, None);
    let all_day = w.event(3, "2026-03-10", "all-day", None, None);
    let person = w.person(4, "Ada");
    let yearless = w.date(&person, 5, "other", "--03-14", None);
    let born = w.date(&person, 6, "birthday", "1990-01-02", None);
    let (item, _, _, expiry) = w.item(10);

    let cases: Vec<(String, &str, &str)> = vec![
        (w.remind(&zoned, 30), "fixed", "2026-03-01T09:30:00.000Z"),
        (w.remind(&floating, 90), "floating", "2026-03-01T08:30"),
        // A day has no moment: 09:00 on the day, the lead counted back from 09:00.
        (w.remind(&all_day, 0), "floating", "2026-03-10T09:00"),
        (w.remind(&all_day, 60), "floating", "2026-03-10T08:00"),
        // A lead that crosses midnight.
        (w.remind(&all_day, 600), "floating", "2026-03-09T23:00"),
        // A yearless birthday a week before: it fires, every year.
        (
            w.add(&person, Some(&yearless), None, 10_080).unwrap(),
            "floating",
            "2026-03-07T09:00",
        ),
        (
            w.add(&person, Some(&yearless), None, 600).unwrap(),
            "floating",
            "2026-03-13T23:00",
        ),
        (
            w.add(&person, Some(&born), None, 0).unwrap(),
            "floating",
            "2026-01-02T09:00",
        ),
        (
            w.add(&person, Some(&born), None, 1440).unwrap(),
            "floating",
            "2026-01-01T09:00",
        ),
        // The lead has already passed this year: it is next year's.
        (
            w.add(&person, Some(&born), None, 2880).unwrap(),
            "floating",
            "2026-12-31T09:00",
        ),
        (
            w.add(&item, None, Some(&expiry), 1440).unwrap(),
            "floating",
            "2030-01-30T09:00",
        ),
        (
            w.add(&item, None, Some(&expiry), 0).unwrap(),
            "floating",
            "2030-01-31T09:00",
        ),
    ];
    for (reminder, timing, fire) in cases {
        is(w.key(&reminder), timing, fire);
    }
    // A person's date repeats; a Locker date and an event of one day do not.
    let repeats: Vec<(String, bool)> = w
        .rows()
        .into_iter()
        .map(|a| (a.reminder_id, a.repeats))
        .collect();
    assert_eq!(repeats.iter().filter(|(_, r)| *r).count(), 5);
}

#[test]
fn feb_29_falls_on_feb_28_in_a_year_with_no_leap_day_and_on_the_29th_in_one() {
    let w = World::new("alerts_leap");
    let person = w.person(1, "Leap");
    let date = w.date(&person, 2, "other", "--02-29", None);
    let r = w.add(&person, Some(&date), None, 0).unwrap();
    is(w.key(&r), "floating", "2026-02-28T09:00");
    // 2027-12-01: the next February is 2028's, a leap year.
    w.scratch.clock.set_ms(1_827_705_600_000);
    w.scratch.vault.rebuild_index().expect("rebuilds");
    is(w.key(&r), "floating", "2028-02-29T09:00");
}

// ---------------------------------------------------------------------------------------------
// 3. Repeats
// ---------------------------------------------------------------------------------------------

#[test]
fn a_repeating_event_holds_its_next_firing_and_advance_moves_it_on() {
    let w = World::new("alerts_repeat");
    let e = w.event(
        1,
        "2025-12-30T10:00:00.000Z",
        "zoned",
        Some("UTC"),
        Some("FREQ=DAILY"),
    );
    let r = w.remind(&e, 10);
    is(w.key(&r), "fixed", "2026-01-01T09:50:00.000Z");
    assert!(w.rows()[0].repeats);
    w.scratch.clock.advance_days(1);
    assert_eq!(w.scratch.vault.advance_alerts().expect("advance"), 1);
    is(w.key(&r), "fixed", "2026-01-02T09:50:00.000Z");
    assert_eq!(w.scratch.vault.advance_alerts().expect("again"), 0);
}

#[test]
fn a_cancelled_day_and_a_one_day_override_are_honoured() {
    let w = World::new("alerts_override");
    let e = w.event(
        1,
        "2025-12-30T10:00:00.000Z",
        "zoned",
        Some("UTC"),
        Some("FREQ=DAILY"),
    );
    let r = w.remind(&e, 10);
    // A day moved LATER: today's occurrence is no longer at 10:00, it is at 20:00.
    w.sql(&format!(
        "INSERT INTO occurrence (series_id, series_timing, original_start, starts)
           VALUES ('{e}', 'zoned', '2026-01-01T10:00:00.000Z', '2026-01-01T20:00:00.000Z')"
    ));
    is(w.key(&r), "fixed", "2026-01-01T19:50:00.000Z");
    // Cancelled: the next is tomorrow's.
    w.sql(&format!(
        "UPDATE occurrence SET cancelled = 1, starts = NULL WHERE series_id = '{e}'"
    ));
    is(w.key(&r), "fixed", "2026-01-02T09:50:00.000Z");
    // Tomorrow moved EARLIER than today would be: the override wins over the rule.
    w.sql(&format!(
        "INSERT INTO occurrence (series_id, series_timing, original_start, starts)
           VALUES ('{e}', 'zoned', '2026-01-02T10:00:00.000Z', '2026-01-02T06:00:00.000Z')"
    ));
    is(w.key(&r), "fixed", "2026-01-02T05:50:00.000Z");
    // The override removed: the rule again.
    w.sql(&format!("DELETE FROM occurrence WHERE series_id = '{e}'"));
    is(w.key(&r), "fixed", "2026-01-01T09:50:00.000Z");

    // An all-day series: each day at 09:00, a cancelled day passed over.
    let d = w.event(2, "2026-01-01", "all-day", None, Some("FREQ=DAILY"));
    let rd = w.remind(&d, 0);
    is(w.key(&rd), "floating", "2026-01-01T09:00");
    w.sql(&format!(
        "INSERT INTO occurrence (series_id, series_timing, original_start, cancelled)
           VALUES ('{d}', 'all-day', '2026-01-01', 1)"
    ));
    is(w.key(&rd), "floating", "2026-01-02T09:00");
}

#[test]
fn a_repeating_task_holds_its_next_firing_and_a_snooze_is_its_one_alert() {
    let w = World::new("alerts_task");
    let t = w.task(1, "2025-12-30T08:00", "floating", None, Some("FREQ=DAILY"));
    let early = w.remind(&t, 15);
    let at = w.remind(&t, 0);
    is(w.key(&at), "floating", "2026-01-01T08:00");
    is(w.key(&early), "floating", "2026-01-01T07:45");
    w.scratch.clock.advance_days(1);
    assert_eq!(w.scratch.vault.advance_alerts().expect("advance"), 1);
    is(w.key(&at), "floating", "2026-01-02T08:00");

    // A snooze: the task's one alert, on its smallest lead; the due stays.
    let s = w.task(2, "2026-03-01T09:00:00.000Z", "zoned", Some("UTC"), None);
    let (a, b) = (w.remind(&s, 15), w.remind(&s, 0));
    is(w.key(&a), "fixed", "2026-03-01T08:45:00.000Z");
    w.sql(&format!(
        "UPDATE task SET snoozed_until = '2026-03-01T10:00:00.000Z' WHERE id = '{s}'"
    ));
    is(w.key(&b), "fixed", "2026-03-01T10:00:00.000Z");
    assert!(w.key(&a).is_none(), "a snooze leaves the task one alert");
    let due: String = w
        .scratch
        .vault
        .read(|c| Ok(c.query_row("SELECT due FROM task WHERE id = ?1", [&s], |r| r.get(0))?))
        .expect("due");
    assert_eq!(due, "2026-03-01T09:00:00.000Z");
    w.sql(&format!(
        "UPDATE task SET snoozed_until = NULL WHERE id = '{s}'"
    ));
    is(w.key(&a), "fixed", "2026-03-01T08:45:00.000Z");
    is(w.key(&b), "fixed", "2026-03-01T09:00:00.000Z");
    // Done: no alert.
    w.sql(&format!(
        "UPDATE task SET status = 'done', done_at = '{AT}' WHERE id = '{s}'"
    ));
    assert!(w.key(&a).is_none() && w.key(&b).is_none());
    // A date-only due: 09:00 that day, the lead counted back.
    let day = w.task(3, "2026-03-02", "all-day", None, None);
    let r = w.remind(&day, 60);
    is(w.key(&r), "floating", "2026-03-02T08:00");
}

// ---------------------------------------------------------------------------------------------
// 4. After the commit
// ---------------------------------------------------------------------------------------------

#[test]
fn alerts_are_queued_in_the_commit_and_written_after_it() {
    let w = World::new("alerts_after");
    let e = w.event(1, "2030-03-01T10:00", "floating", None, None);
    // Inside a commit the index file is not written: the body sees no alert yet.
    w.scratch
        .vault
        .commit(|tx| {
            tx.connection().execute(
                "INSERT INTO reminder (id, entity_id, entity_kind, offset_min) VALUES (?1, ?2, 'event', 5)",
                [id(50), e.clone()],
            )?;
            let inside: i64 =
                tx.connection()
                    .query_row("SELECT count(*) FROM alert", [], |r| r.get(0))?;
            assert_eq!(inside, 0, "the commit's body never writes the index file");
            Ok(())
        })
        .expect("commits");
    is(w.key(&id(50)), "floating", "2030-03-01T09:55");
    assert!(
        !w.scratch.vault.index_owed().expect("asks"),
        "the queue is cleared"
    );
    // A rolled-back commit leaves no alert behind and nothing owed.
    let _ = w.scratch.vault.commit(|tx| {
        tx.connection().execute(
            "INSERT INTO reminder (id, entity_id, entity_kind, offset_min) VALUES (?1, ?2, 'event', 7)",
            [id(51), e.clone()],
        )?;
        Err::<(), _>(centraid_vault::VaultError::Invariant { context: "no".into() })
    });
    assert!(w.key(&id(51)).is_none());
    assert!(!w.scratch.vault.index_owed().expect("asks"));
}

const STAGE: &str = "CENTRAID_ALERT_STAGE";
const DIR: &str = "CENTRAID_ALERT_DIR";

fn pause(stage: centraid_vault::stage::Stage) -> std::io::Result<()> {
    use centraid_vault::stage::Stage;
    let wanted = match stage {
        Stage::Committed => "committed",
        Stage::IndexWritten => "index-written",
        _ => return Ok(()),
    };
    if std::env::var(STAGE).as_deref() == Ok(wanted) {
        println!("STAGE {wanted}");
        loop {
            std::thread::park();
        }
    }
    Ok(())
}

#[test]
fn child_commits_a_reminder_and_stops() {
    let (Some(_), Some(dir)) = (
        std::env::var_os(STAGE),
        std::env::var_os(DIR).map(std::path::PathBuf::from),
    ) else {
        return;
    };
    let vault = Vault::open(dir.join("vault.db")).expect("opens");
    centraid_vault::stage::set_hook(Some(pause));
    vault
        .commit(|tx| {
            tx.connection().execute_batch(&format!(
                "INSERT INTO entity (id, kind, title, parent_id, parent_kind, created_at, updated_at)
                   VALUES ('{e}', 'event', 'Far', 'calendar:default', 'calendar', '{AT}', '{AT}');
                 INSERT INTO event (id, starts, timing) VALUES ('{e}', '2099-03-01T10:00', 'floating');
                 INSERT INTO reminder (id, entity_id, entity_kind, offset_min) VALUES ('{r}', '{e}', 'event', 5);",
                e = id(1),
                r = id(2)
            ))?;
            Ok(())
        })
        .expect("commits");
}

fn killed_at(stage: &str) -> std::path::PathBuf {
    use std::io::{BufRead as _, BufReader};
    let dir = centraid_ontology::scratch::scratch_dir().join(format!("alert-kill-{stage}"));
    std::fs::create_dir_all(&dir).expect("a directory");
    let vault = Vault::create(dir.join("vault.db")).expect("founds");
    vault.found("Home", "Ada").expect("founds");
    vault.finish().expect("closes");
    let mut child = std::process::Command::new(std::env::current_exe().expect("the test binary"))
        .args([
            "--exact",
            "child_commits_a_reminder_and_stops",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(STAGE, stage)
        .env(DIR, &dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("the child starts");
    let marker = format!("STAGE {stage}");
    let reached = BufReader::new(child.stdout.take().expect("a pipe"))
        .lines()
        .map_while(Result::ok)
        .any(|line| line.contains(&marker));
    assert!(reached, "the child never reached `{stage}`");
    child.kill().expect("SIGKILL");
    child.wait().expect("reaped");
    dir
}

fn alerts_of(vault: &Vault) -> i64 {
    vault
        .read(|c| Ok(c.query_row("SELECT count(*) FROM alert", [], |r| r.get(0))?))
        .expect("counts")
}

#[test]
fn a_kill_between_the_commit_and_the_index_loses_no_alert() {
    // Killed after COMMIT, before the index file is written: the reminder is there, the alert is
    // owed, and the idle pass writes it.
    let dir = killed_at("committed");
    let vault = Vault::open(dir.join("vault.db")).expect("opens");
    let reminders: i64 = vault
        .read(|c| Ok(c.query_row("SELECT count(*) FROM reminder", [], |r| r.get(0))?))
        .expect("counts");
    assert_eq!(reminders, 1, "the commit is whole");
    assert_eq!(alerts_of(&vault), 0, "the alert was not written yet");
    assert!(vault.index_owed().expect("asks"), "and it is owed");
    while vault.reindex_owed().expect("a batch") > 0 {}
    assert_eq!(alerts_of(&vault), 1);
    vault.finish().expect("closes");
    let _ = std::fs::remove_dir_all(&dir);

    // Killed after the index file is written, before the queue is cleared: it is written again to
    // the same result.
    let dir = killed_at("index-written");
    let vault = Vault::open(dir.join("vault.db")).expect("opens");
    assert_eq!(alerts_of(&vault), 1);
    assert!(vault.index_owed().expect("asks"));
    let before = vault
        .read(|c| Ok(c.query_row("SELECT fire_key FROM alert", [], |r| r.get::<_, String>(0))?))
        .expect("key");
    while vault.reindex_owed().expect("a batch") > 0 {}
    let after = vault
        .read(|c| Ok(c.query_row("SELECT fire_key FROM alert", [], |r| r.get::<_, String>(0))?))
        .expect("key");
    assert_eq!((alerts_of(&vault), before), (1, after));
    assert_eq!(after_key(&vault), "2099-03-01T09:55");
    vault.finish().expect("closes");
    let _ = std::fs::remove_dir_all(&dir);
}

fn after_key(vault: &Vault) -> String {
    vault
        .read(|c| Ok(c.query_row("SELECT fire_key FROM alert", [], |r| r.get(0))?))
        .expect("key")
}

#[test]
fn the_alerts_equal_a_rebuild_from_the_rows() {
    let w = World::new("alerts_equal");
    let e = w.event(
        1,
        "2025-12-30T10:00:00.000Z",
        "zoned",
        Some("UTC"),
        Some("FREQ=DAILY"),
    );
    w.remind(&e, 10);
    w.sql(&format!(
        "INSERT INTO occurrence (series_id, series_timing, original_start, cancelled)
           VALUES ('{e}', 'zoned', '2026-01-01T10:00:00.000Z', 1)"
    ));
    let t = w.task(2, "2026-03-01T09:00", "floating", None, None);
    w.remind(&t, 5);
    let person = w.person(3, "Ada");
    let d = w.date(&person, 4, "birthday", "--03-14", None);
    w.add(&person, Some(&d), None, 1440).unwrap();
    let (item, _, _, expiry) = w.item(10);
    w.add(&item, None, Some(&expiry), 0).unwrap();
    let gone = w.event(20, "2030-01-01T10:00", "floating", None, None);
    let gone_reminder = w.remind(&gone, 5);
    w.ok("entity.trash", json!({ "id": gone }));
    w.ok("entity.purge", json!({ "id": gone }));
    assert!(w.key(&gone_reminder).is_none());

    let incremental = w.dump();
    assert_eq!(incremental.len(), 4);
    // The same vault, rebuilt.
    w.scratch.vault.rebuild_index().expect("rebuilds");
    assert_eq!(incremental, w.dump(), "incremental differs from a rebuild");
    // A copy of the rows alone, opened with the same clock, founds its index again and owes it everything.
    let work = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&work).expect("a directory");
    let copy = work.join("vault.db");
    rusqlite::Connection::open_with_flags(
        w.scratch.dir().join("vault.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("opens the live vault")
    .execute("VACUUM INTO ?1", [copy.to_string_lossy().as_ref()])
    .expect("copies the rows");
    let reference = Vault::open_with(
        &copy,
        Box::new(Arc::new(FixedClock::frozen())),
        Box::new(SeededIds::new("copy")),
    )
    .expect("opens");
    while reference.reindex_owed().expect("a batch") > 0 {}
    let rows: Vec<String> = reference
        .read(|c| {
            let mut s = c.prepare(
                "SELECT reminder_id || '|' || n || '|' || timing || '|' || fire_key || '|' || repeats
                   FROM alert ORDER BY reminder_id",
            )?;
            Ok(s.query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .expect("rows");
    assert_eq!(
        incremental, rows,
        "incremental differs from a rebuild of the rows alone"
    );
    reference.finish().expect("closes");
    let _ = std::fs::remove_dir_all(&work);
}

// ---------------------------------------------------------------------------------------------
// 5. The read
// ---------------------------------------------------------------------------------------------

#[test]
fn the_next_few_are_one_seek_on_alert_by_fire_whatever_the_vault_holds() {
    let w = World::new("alerts_read");
    for n in 1..=60u64 {
        let e = w.event(
            n,
            &format!("2026-02-{:02}T10:00", (n % 27) + 1),
            "floating",
            None,
            None,
        );
        w.remind(&e, 5);
    }
    let next = w
        .scratch
        .vault
        .read(|c| alerts::next(c, "2026-02-10", "2026-02-10", 5))
        .expect("rows");
    assert_eq!(next.len(), 5);
    assert!(
        next.windows(2)
            .all(|pair| pair[0].fire_key <= pair[1].fire_key)
    );
    let plan = w
        .scratch
        .vault
        .explain_query_plan(alerts::NEXT_SQL, &[])
        .expect("plans");
    let plan = plan.join("\n");
    assert!(plan.contains("alert_by_fire"), "{plan}");
    assert!(!plan.contains("TEMP B-TREE"), "{plan}");
    assert!(
        !plan
            .lines()
            .any(|l| l.starts_with("SCAN") && !l.contains("INDEX")),
        "{plan}"
    );
}

// ---------------------------------------------------------------------------------------------
// 6. What a notification says
// ---------------------------------------------------------------------------------------------

#[test]
fn a_notification_says_the_title_and_time_and_never_a_sealed_value() {
    let w = World::new("alerts_notice");
    let e = w.event(1, "2026-03-01T10:00:00.000Z", "zoned", Some("UTC"), None);
    let re = w.remind(&e, 30);
    let all_day = w.event(2, "2026-03-10", "all-day", None, None);
    let rd = w.remind(&all_day, 60);
    let t = w.task(3, "2026-03-01T09:00", "floating", None, None);
    let rt = w.remind(&t, 15);
    let person = w.person(4, "Ada");
    let birthday = w.date(&person, 5, "birthday", "1990-03-14", None);
    let wedding = w.date(&person, 6, "anniversary", "2015-06-01", Some("Wedding"));
    let rb = w.add(&person, Some(&birthday), None, 1440).unwrap();
    let rw = w.add(&person, Some(&wedding), None, 0).unwrap();
    let (item, _, _, expiry) = w.item(10);
    let rl = w.add(&item, None, Some(&expiry), 0).unwrap();

    let notice = |r: &str| {
        w.scratch
            .vault
            .read(|c| alerts::notice(c, r))
            .expect("reads")
            .expect("a notice")
    };
    let n = notice(&re);
    assert_eq!((n.kind.as_str(), n.title.as_str()), ("event", "Standup"));
    assert_eq!(n.at.as_deref(), Some("2026-03-01T10:00:00.000Z"));
    assert_eq!(n.timing, "zoned");
    let n = notice(&rd);
    assert_eq!(
        (n.at.as_deref(), n.timing.as_str()),
        (Some("2026-03-10"), "all-day")
    );
    let n = notice(&rt);
    assert_eq!(
        (n.kind.as_str(), n.title.as_str(), n.at.as_deref()),
        ("task", "Call", Some("2026-03-01T09:00"))
    );
    let n = notice(&rb);
    assert_eq!(
        (n.title.as_str(), n.what.as_deref(), n.at.as_deref()),
        ("Ada", Some("birthday"), Some("2026-03-14"))
    );
    let n = notice(&rw);
    assert_eq!(
        n.what.as_deref(),
        Some("Wedding"),
        "a label the member gave wins"
    );
    let n = notice(&rl);
    assert_eq!(
        (n.kind.as_str(), n.title.as_str(), n.what.as_deref()),
        ("locker_item", "Bank", Some("Expiry"))
    );
    // Nothing sealed can be in it.
    let said = format!("{n:?}");
    for secret in [
        "lk1:",
        "SECRETVALUE",
        "Card number",
        "plain words",
        "2030-01-31T",
    ] {
        assert!(!said.contains(secret), "`{secret}` is in {said}");
    }
    // Nor in the index file's own rows.
    let all = w.dump().join("\n");
    assert!(!all.contains("lk1:") && !all.contains("SECRET"));
    assert!(
        w.scratch
            .vault
            .read(|c| alerts::notice(c, "no-such"))
            .expect("reads")
            .is_none()
    );
}

// ---------------------------------------------------------------------------------------------
// 7. Trash and purge
// ---------------------------------------------------------------------------------------------

#[test]
fn a_trashed_item_or_one_in_a_trashed_holder_has_no_alert_restore_brings_it_back_purge_removes_it()
{
    let w = World::new("alerts_trash");
    let person = w.person(1, "Ada");
    let d = w.date(&person, 2, "birthday", "--03-14", None);
    let r = w.add(&person, Some(&d), None, 0).unwrap();
    is(w.key(&r), "floating", "2026-03-14T09:00");
    w.ok("entity.trash", json!({ "id": person }));
    assert!(w.key(&r).is_none(), "trashed: no alert");
    w.ok("entity.restore", json!({ "id": person }));
    is(w.key(&r), "floating", "2026-03-14T09:00");
    w.ok("entity.trash", json!({ "id": person }));
    w.ok("entity.purge", json!({ "id": person }));
    assert!(w.key(&r).is_none(), "purged: gone");
    assert!(w.rows().is_empty());

    // An event in a holder (a calendar) that is trashed.
    let cal = id(40);
    w.sql(&format!(
        "INSERT INTO entity (id, kind, title, created_at, updated_at) VALUES ('{cal}', 'calendar', 'Work', '{AT}', '{AT}')"
    ));
    let e = id(41);
    w.sql(&format!(
        "INSERT INTO entity (id, kind, title, parent_id, parent_kind, created_at, updated_at)
           VALUES ('{e}', 'event', 'Review', '{cal}', 'calendar', '{AT}', '{AT}');
         INSERT INTO event (id, starts, timing) VALUES ('{e}', '2030-03-01T10:00', 'floating');"
    ));
    let re = w.remind(&e, 10);
    assert!(w.key(&re).is_some());
    w.ok("entity.trash", json!({ "id": cal }));
    assert!(w.key(&re).is_none(), "its holder is in the trash");
    w.ok("entity.restore", json!({ "id": cal }));
    assert!(w.key(&re).is_some());

    // A Locker item in the trash alerts nothing.
    let (item, _, _, expiry) = w.item(60);
    let rl = w.add(&item, None, Some(&expiry), 0).unwrap();
    assert!(w.key(&rl).is_some());
    w.ok("entity.trash", json!({ "id": item }));
    assert!(w.key(&rl).is_none());
}

// ---------------------------------------------------------------------------------------------
// One alert per real thing (#1188, NA2): what the phone's own app holds, the phone alerts
// ---------------------------------------------------------------------------------------------

impl World {
    fn origin(&self, name: &str, system: &str) -> String {
        let o = format!("origin-{name}");
        self.sql(&format!(
            "INSERT INTO origin (id, system, ref, label, created_at) VALUES ('{o}', '{system}', '{name}', '{name}', '{AT}')"
        ));
        o
    }

    fn source(
        &self,
        n: u64,
        origin: &str,
        system: &str,
        entity: &str,
        kind: &str,
        stated: &str,
    ) -> String {
        let s = format!("source-{n}");
        self.sql(&format!(
            "INSERT INTO source (id, origin_id, system, external_id, entity_id, entity_kind, stated, seen_at)
               VALUES ('{s}', '{origin}', '{system}', 'x{n}', '{entity}', '{kind}', '{stated}', '{AT}')"
        ));
        s
    }
}

#[test]
fn what_the_phone_holds_the_phone_alerts_until_the_member_changes_it_or_it_is_gone() {
    let w = World::new("alerts_na2");
    let e = w.event(1, "2026-03-02T09:00", "floating", None, None);
    let r10 = w.remind(&e, 10);
    assert!(w.key(&r10).is_some(), "no source: Centraid's own");
    let live = w.origin("work", "calendar");
    let stated = r#"{"starts":"2026-03-02T09:00","reminders":[10]}"#;
    let source = w.source(1, &live, "calendar", &e, "event", stated);
    assert!(w.key(&r10).is_none(), "the phone alerts for it");
    // The member adds a lead: the alert is Centraid's own now, all of it.
    let r60 = w.remind(&e, 60);
    assert!(w.key(&r10).is_some() && w.key(&r60).is_some());
    w.ok("reminder.remove", json!({ "id": r60 }));
    assert!(
        w.key(&r10).is_none(),
        "back to what the phone stated, silent again"
    );
    // A moved start is Centraid's.
    w.sql(&format!(
        "UPDATE event SET starts = '2026-03-02T10:00' WHERE id = '{e}'"
    ));
    assert!(w.key(&r10).is_some());
    w.sql(&format!(
        "UPDATE event SET starts = '2026-03-02T09:00' WHERE id = '{e}'"
    ));
    assert!(w.key(&r10).is_none());
    // STOPPING THE FOLLOW CHANGES NOTHING: the record stays in the phone's own app, which still
    // alerts it. A retired origin's items stay silent, and following it again keeps them so.
    w.sql(&format!(
        "UPDATE origin SET retired_at = '{AT}' WHERE id = '{live}'"
    ));
    assert!(
        w.key(&r10).is_none(),
        "a retired origin's untouched alert stays silent"
    );
    // The member's change still makes it Centraid's, retired or not.
    let r30 = w.remind(&e, 30);
    assert!(w.key(&r10).is_some() && w.key(&r30).is_some());
    w.ok("reminder.remove", json!({ "id": r30 }));
    assert!(w.key(&r10).is_none());
    w.sql(&format!(
        "UPDATE origin SET retired_at = NULL WHERE id = '{live}'"
    ));
    assert!(w.key(&r10).is_none());
    // A record the phone no longer has (gone) is not the phone's to alert.
    w.sql(&format!(
        "UPDATE source SET gone_at = '{AT}' WHERE id = '{source}'"
    ));
    assert!(w.key(&r10).is_some());
    w.sql(&format!(
        "UPDATE source SET gone_at = NULL WHERE id = '{source}'"
    ));
    assert!(w.key(&r10).is_none());

    // TWO SOURCES (a merged record keeps both): one that holds it is enough.
    let old = w.origin("old", "calendar");
    w.source(2, &old, "calendar", &e, "event", stated);
    w.sql(&format!(
        "UPDATE source SET gone_at = '{AT}' WHERE id = '{source}'"
    ));
    assert!(w.key(&r10).is_none(), "the second source still holds it");
    w.sql("UPDATE source SET gone_at = NULL WHERE id = 'source-2'");
    w.sql(&format!(
        "UPDATE source SET gone_at = '{AT}' WHERE id IN ('{source}', 'source-2')"
    ));
    assert!(w.key(&r10).is_some(), "both gone: Centraid's");
    w.sql("UPDATE source SET gone_at = NULL WHERE id = 'source-2'");
    assert!(w.key(&r10).is_none());

    // A phone reminder (a task), a day as a day and one `remind_before_min`.
    let list = w.origin("list", "phone_reminders");
    let t = w.task(5, "2026-03-02", "all-day", None, None);
    let rt = w.remind(&t, 10);
    w.source(
        3,
        &list,
        "phone_reminders",
        &t,
        "task",
        r#"{"due":"2026-03-02","remind_before_min":10}"#,
    );
    assert!(w.key(&rt).is_none());
    w.sql(&format!(
        "UPDATE origin SET retired_at = '{AT}' WHERE id = '{list}'"
    ));
    assert!(w.key(&rt).is_none(), "stopped following: still the phone's");
    w.sql(&format!(
        "UPDATE task SET due = '2026-03-03' WHERE id = '{t}'"
    ));
    assert!(w.key(&rt).is_some(), "a moved due is Centraid's");
    // The index equals a rebuild with all of this in place.
    let before = w.dump();
    w.scratch.vault.rebuild_index().expect("rebuilds");
    assert_eq!(before, w.dump());
}

// ---------------------------------------------------------------------------------------------
// A LONG EVENT KEEPS ITS BANNER: a one-off row outlives its firing by two days, and while the
// event is running; it goes when the event has ended.
// ---------------------------------------------------------------------------------------------

#[test]
fn an_event_that_is_still_running_keeps_its_row_past_the_keep_window() {
    let w = World::new("alerts_running");
    let ends = |n: u64, ends: &str| {
        let e = w.event(n, "2026-03-01T10:00", "floating", None, None);
        w.sql(&format!(
            "UPDATE event SET ends = '{ends}' WHERE id = '{e}'"
        ));
        w.remind(&e, 0)
    };
    let long = ends(1, "2026-03-10T10:00");
    let short = ends(2, "2026-03-01T11:00");
    let none = {
        let e = w.event(3, "2026-03-01T10:00", "floating", None, None);
        w.remind(&e, 0)
    };
    // Four days on, in the vault's own pass: the firing is past the keep window for all three.
    w.scratch.clock.set_ms(1_772_582_400_000); // 2026-03-04T00:00Z
    w.scratch.vault.advance_alerts().expect("advance");
    assert!(w.key(&long).is_some(), "the event is still running");
    assert!(
        w.key(&short).is_none() && w.key(&none).is_none(),
        "the others are over"
    );
    // A rebuild says the same.
    w.scratch.vault.rebuild_index().expect("rebuilds");
    assert!(w.key(&long).is_some() && w.key(&short).is_none() && w.key(&none).is_none());
    // The event ends: the next pass lets the row go.
    w.scratch.clock.set_ms(1_773_273_600_000 + 86_400_000 * 2); // 2026-03-14
    w.scratch.vault.advance_alerts().expect("advance");
    assert!(w.key(&long).is_none());
}

// ---------------------------------------------------------------------------------------------
// DST AND ZONES (#1202, S12): a zoned alert is an instant that follows its zone's offset; a
// floating or all-day one is a wall-clock key that no zone changes. No alert is skipped or doubled
// by a clock change, and no assertion is on a duration: only on keys and counts. The vault's own
// zone is set (America/New_York), because the floating reference reads it.
// ---------------------------------------------------------------------------------------------

impl World {
    fn at(&self, iso: &str) {
        let at: jiff::Timestamp = iso.parse().expect("an instant");
        self.scratch.clock.set_ms(at.as_millisecond());
    }

    fn zone(&self, zone: &str) {
        self.sql(&format!("UPDATE vault SET zone = '{zone}'"));
    }

    /// Every firing from the clock on, taken one at a time: the key, then advance past it.
    fn firings(&self, count: usize) -> Vec<String> {
        let mut keys = Vec::new();
        for _ in 0..count {
            let rows = self.rows();
            assert_eq!(rows.len(), 1, "one next firing, never two: {rows:?}");
            let key = rows[0].fire_key.clone();
            let instant: jiff::Timestamp = key.parse().expect("a fixed key");
            self.scratch.clock.set_ms(instant.as_millisecond() + 1_000);
            assert_eq!(self.scratch.vault.advance_alerts().expect("advance"), 1);
            keys.push(key);
        }
        keys
    }

    fn zoned_daily(&self, now: &str, zone: &str, starts_utc: &str) -> String {
        self.at(now);
        let e = self.event(1, starts_utc, "zoned", Some(zone), Some("FREQ=DAILY"));
        self.remind(&e, 0)
    }
}

#[test]
fn a_zoned_alert_follows_its_zones_offset_through_the_spring_forward() {
    let w = World::new("alerts_dst1");
    w.zone("America/New_York");
    // 09:00 EST on 5 March, daily.
    w.zoned_daily(
        "2026-03-06T15:00:00Z",
        "America/New_York",
        "2026-03-05T14:00:00.000Z",
    );
    assert_eq!(
        w.firings(4),
        [
            "2026-03-07T14:00:00.000Z",
            // The clocks sprang forward on the 8th: 09:00 is 13:00Z from then, one alert a day.
            "2026-03-08T13:00:00.000Z",
            "2026-03-09T13:00:00.000Z",
            "2026-03-10T13:00:00.000Z",
        ]
    );
}

#[test]
fn an_alert_in_the_spring_gap_moves_forward_once_and_the_next_day_is_back_on_its_clock() {
    let w = World::new("alerts_dst2");
    w.zone("America/New_York");
    // 02:30 EST on 5 March.
    w.zoned_daily(
        "2026-03-06T12:00:00Z",
        "America/New_York",
        "2026-03-05T07:30:00.000Z",
    );
    assert_eq!(
        w.firings(3),
        [
            "2026-03-07T07:30:00.000Z",
            // 02:30 does not exist on the 8th: it sounds at 03:30 EDT, once.
            "2026-03-08T07:30:00.000Z",
            "2026-03-09T06:30:00.000Z",
        ]
    );
}

#[test]
fn an_alert_in_the_fall_back_fold_sounds_once_at_the_earlier_instant() {
    let w = World::new("alerts_dst3");
    w.zone("America/New_York");
    // 01:30 EDT on 29 October.
    w.zoned_daily(
        "2026-10-30T12:00:00Z",
        "America/New_York",
        "2026-10-29T05:30:00.000Z",
    );
    assert_eq!(
        w.firings(3),
        [
            "2026-10-31T05:30:00.000Z",
            // 01:30 happens twice on 1 November: the earlier (EDT) only.
            "2026-11-01T05:30:00.000Z",
            "2026-11-02T06:30:00.000Z",
        ]
    );
}

#[test]
fn a_date_and_a_floating_alert_stay_on_their_wall_clock_through_both_changes() {
    let w = World::new("alerts_dst4");
    w.zone("America/New_York");
    w.at("2026-03-06T12:00:00Z");
    // A repeating all-day event: each day at 09:00, a key that names no zone.
    let d = w.event(1, "2026-03-06", "all-day", None, Some("FREQ=DAILY"));
    let rd = w.remind(&d, 0);
    // A repeating floating one at 02:30, a time the 8th does not have in New York: the key stays.
    let f = w.event(2, "2026-03-06T02:30", "floating", None, Some("FREQ=DAILY"));
    let rf = w.remind(&f, 0);
    let mut days = Vec::new();
    let mut floats = Vec::new();
    for _ in 0..4 {
        let rows = w.rows();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.timing == alerts::Timing::Floating));
        days.push(w.key(&rd).expect("row").1);
        floats.push(w.key(&rf).expect("row").1);
        w.scratch.clock.advance_days(1);
        assert_eq!(w.scratch.vault.advance_alerts().expect("advance"), 2);
    }
    assert_eq!(
        days,
        [
            "2026-03-06T09:00",
            "2026-03-07T09:00",
            "2026-03-08T09:00",
            "2026-03-09T09:00"
        ]
    );
    assert_eq!(
        floats,
        [
            "2026-03-07T02:30",
            "2026-03-08T02:30",
            "2026-03-09T02:30",
            "2026-03-10T02:30"
        ]
    );
    // A wall-clock task on the fold day keeps its key.
    let t = w.task(3, "2026-11-01T01:30", "floating", None, None);
    is(
        Some(w.key(&w.remind(&t, 0)).expect("row")),
        "floating",
        "2026-11-01T01:30",
    );
}

#[test]
fn the_nine_oclock_rule_and_a_lead_on_a_dst_day_are_wall_clock_arithmetic() {
    let w = World::new("alerts_dst5");
    w.zone("America/New_York");
    w.at("2026-03-07T12:00:00Z");
    let person = w.person(1, "Ada");
    let day = w.date(&person, 2, "other", "--03-08", None);
    let today = w.add(&person, Some(&day), None, 0).unwrap();
    is(w.key(&today), "floating", "2026-03-08T09:00");
    // A lead of 10 hours counts back from 09:00 on the wall clock: no hour is lost to the change
    // (23:00 the evening before, never 22:00 or 00:00).
    let eve = w.add(&person, Some(&day), None, 600).unwrap();
    is(w.key(&eve), "floating", "2026-03-07T23:00");
    // 06:00 EDT on the 8th: the 09:00 date is still ahead in the vault's own wall clock, though in
    // UTC's wall (10:00) it would have passed; the evening's lead has gone by, so it is next year's.
    w.at("2026-03-08T10:00:00Z");
    w.scratch.vault.rebuild_index().expect("rebuilds");
    is(w.key(&today), "floating", "2026-03-08T09:00");
    is(w.key(&eve), "floating", "2027-03-07T23:00");
    // The fold day, from a clock before it.
    w.at("2026-10-31T12:00:00Z");
    let fall = w.date(&person, 3, "other", "--11-01", None);
    let r = w.add(&person, Some(&fall), None, 0).unwrap();
    is(w.key(&r), "floating", "2026-11-01T09:00");
    // An all-day event on the change day, a lead of 600 minutes: the same arithmetic.
    let e = w.event(4, "2026-11-01", "all-day", None, None);
    let re = w.remind(&e, 600);
    is(w.key(&re), "floating", "2026-10-31T23:00");
}

#[test]
fn the_same_wall_time_is_a_different_instant_in_each_zone_and_travel_changes_nothing_stored() {
    let w = World::new("alerts_dst6");
    // 09:00 in New York (EDT) and in Kolkata, on 10 March.
    let ny = w.event(
        1,
        "2026-03-10T13:00:00.000Z",
        "zoned",
        Some("America/New_York"),
        None,
    );
    let kolkata = w.event(
        2,
        "2026-03-10T03:30:00.000Z",
        "zoned",
        Some("Asia/Kolkata"),
        None,
    );
    let (a, b) = (w.remind(&ny, 0), w.remind(&kolkata, 0));
    let before = (w.key(&a), w.key(&b));
    // The vault's zone (where the member is) changes nothing a zoned alert holds.
    w.zone("Asia/Tokyo");
    w.scratch.vault.rebuild_index().expect("rebuilds");
    assert_eq!((w.key(&a), w.key(&b)), before);
    is(w.key(&a), "fixed", "2026-03-10T13:00:00.000Z");
    is(w.key(&b), "fixed", "2026-03-10T03:30:00.000Z");
}
