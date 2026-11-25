//! A day's totals from a health store (#1214, K9): `follow::write_day_totals` is the one writer of
//! `measurement.origin_id`. The column is a plain foreign key (amendment 7), so that the origin is
//! a health store is the writer's rule, read from `source_shape` (an origin whose system yields
//! readings), and the table's own keys refuse the rest.

mod common;

use centraid_vault::commands::follow::write_day_totals;
use common::follow::Follow;
use serde_json::json;

const DAY: &str = "2026-03-02";

fn origin(f: &Follow, system: &str, reference: &str) -> String {
    f.ok(
        "follow.advance_cursor",
        json!({ "system": system, "ref": reference, "device_id": "phone-1", "cursor": "c" }),
    );
    f.one(
        "SELECT id FROM origin WHERE system = ?1 AND ref = ?2",
        &[system, reference],
    )
}

fn write(f: &Follow, origin: &str, totals: &[(&str, f64)]) -> Result<usize, String> {
    let person: String = f.one("SELECT self_id FROM vault", &[]);
    f.vault()
        .commit(|tx| write_day_totals(tx.connection(), origin, &person, DAY, totals))
        .map(|done| done.value)
        .map_err(|error| error.to_string())
}

fn steps(f: &Follow) -> (f64, String) {
    (
        f.one("SELECT value FROM measurement WHERE metric = 'steps'", &[]),
        f.one(
            "SELECT origin_id FROM measurement WHERE metric = 'steps'",
            &[],
        ),
    )
}

#[test]
fn a_health_store_writes_a_days_totals_and_a_correction_overwrites_the_figure() {
    let f = Follow::new("totals_write");
    let health = origin(&f, "health", "Health");
    assert_eq!(
        write(&f, &health, &[("steps", 4000.0), ("sleep_min", 410.0)]),
        Ok(2)
    );
    assert_eq!(steps(&f), (4000.0, health.clone()));
    // The phone corrects the day: the figure is overwritten, not added beside.
    assert_eq!(write(&f, &health, &[("steps", 5200.0)]), Ok(1));
    assert_eq!(steps(&f), (5200.0, health.clone()));
    assert_eq!(f.count("SELECT COUNT(*) FROM measurement", &[]), 2);
    // Another health store's day for the same person and metric takes the figure and the name.
    let other = origin(&f, "health", "Watch");
    assert_eq!(write(&f, &other, &[("steps", 5300.0)]), Ok(1));
    assert_eq!(steps(&f), (5300.0, other));
}

#[test]
fn only_a_followed_health_store_writes_totals_and_the_table_refuses_the_rest() {
    let f = Follow::new("totals_refuse");
    let health = origin(&f, "health", "Health");
    // A store whose system yields no readings is not a health store: a sentence, nothing written.
    let roll = origin(&f, "camera_roll", "Camera roll");
    let sentence = write(&f, &roll, &[("steps", 1.0)]).expect_err("refused");
    assert!(sentence.contains("not a health store"), "{sentence}");
    let sentence = write(&f, "no-such-origin", &[("steps", 1.0)]).expect_err("refused");
    assert!(sentence.contains("no store"), "{sentence}");
    // A store the member stopped is not followed now.
    f.ok(
        "follow.stop",
        json!({ "system": "health", "ref": "Health" }),
    );
    let sentence = write(&f, &health, &[("steps", 1.0)]).expect_err("refused");
    assert!(sentence.contains("not followed"), "{sentence}");
    assert_eq!(f.count("SELECT COUNT(*) FROM measurement", &[]), 0);

    // What only the table can say is the table's: a reading's metric is not a daily total, a
    // figure is never negative, and one bad figure undoes the whole day.
    let watch = origin(&f, "health", "Watch");
    assert!(write(&f, &watch, &[("steps", 1.0), ("weight_kg", 70.0)]).is_err());
    assert!(write(&f, &watch, &[("steps", -1.0)]).is_err());
    assert_eq!(f.count("SELECT COUNT(*) FROM measurement", &[]), 0);

    // The foreign key itself is plain: it names an origin and nothing more (amendment 7), which is
    // why the writer above is the one rule that a health store wrote it.
    let person: String = f.one("SELECT self_id FROM vault", &[]);
    f.raw(&format!(
        "INSERT INTO measurement (person_id, day, metric, value, origin_id)
         VALUES ('{person}', '{DAY}', 'steps', 1, '{roll}')"
    ));
}
