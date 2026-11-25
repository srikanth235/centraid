//! THE SPATIAL INDEX (#1214, A16, H3): one point per photo that has a `lat`/`lon` and per place that
//! has coordinates, kept by the same queue as the search rows, so the photo and place commands
//! write nothing of it themselves. Proved with raw rows, as those commands will write them: the
//! modules are not plugged yet.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use common::index::{assert_equals_a_rebuild, drain};
use serde_json::json;

fn mint(vault: &Vault) -> String {
    vault.ids().next()
}

fn photo(vault: &Vault, title: &str, at: Option<(f64, f64)>) -> String {
    let id = mint(vault);
    let (now, hash) = (
        vault.clock().now_text(),
        format!(
            "{:064x}",
            u128::from(id.len() as u64)
                + id.as_bytes().iter().map(|b| u128::from(*b)).sum::<u128>() * 7919
        ),
    );
    vault
        .commit(|tx| {
            tx.insert_entity(&id, Kind::Photo, title, &now)?;
            let c = tx.connection();
            c.execute("INSERT INTO blob (hash, size) VALUES (?1, 10)", [&hash])?;
            c.execute(
                "INSERT INTO photo (id, blob, media_type, form, lat, lon)
                 VALUES (?1, ?2, 'image/jpeg', 'photo', ?3, ?4)",
                rusqlite::params![id, hash, at.map(|p| p.0), at.map(|p| p.1)],
            )?;
            Ok(())
        })
        .expect("a photo");
    id
}

fn place(vault: &Vault, title: &str, at: Option<(f64, f64)>) -> String {
    let id = mint(vault);
    let now = vault.clock().now_text();
    vault
        .commit(|tx| {
            tx.insert_entity(&id, Kind::Place, title, &now)?;
            tx.connection().execute(
                "INSERT INTO place (id, lat, lon, address) VALUES (?1, ?2, ?3, 'a street')",
                rusqlite::params![id, at.map(|p| p.0), at.map(|p| p.1)],
            )?;
            Ok(())
        })
        .expect("a place");
    id
}

fn set(vault: &Vault, table: &str, id: &str, at: Option<(f64, f64)>) {
    vault
        .commit(|tx| {
            tx.connection().execute(
                &format!("UPDATE {table} SET lat = ?2, lon = ?3 WHERE id = ?1"),
                rusqlite::params![id, at.map(|p| p.0), at.map(|p| p.1)],
            )?;
            Ok(())
        })
        .expect("moves");
}

/// The ids in a box (west, east, south, north), sorted.
fn inside(vault: &Vault, w: f64, e: f64, s: f64, n: f64) -> Vec<String> {
    let mut ids: Vec<String> = vault
        .read(|c| centraid_vault::index::viewport(c, w, e, s, n, 100))
        .expect("reads")
        .into_iter()
        .map(|p| p.id)
        .collect();
    ids.sort();
    ids
}

fn sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();
    ids
}

#[test]
fn a_viewport_is_the_photos_and_places_in_the_box_and_a_point_follows_its_row() {
    let scratch = common::Scratch::founded("geo").expect("a vault");
    let vault = &scratch.vault;
    let paris = photo(vault, "Louvre", Some((48.86, 2.34)));
    let rome = place(vault, "Colosseum", Some((41.89, 12.49)));
    let nowhere = photo(vault, "No fix", None);
    let sydney = photo(vault, "Opera House", Some((-33.86, 151.21)));
    let unplaced = place(vault, "Somewhere", None);
    // Written by the commit's own pass: nothing is owed and nothing else wrote it.
    assert!(!vault.index_owed().expect("asks"));
    let europe = |v: &Vault| inside(v, -10.0, 30.0, 35.0, 60.0);
    assert_eq!(europe(vault), sorted(vec![paris.clone(), rome.clone()]));
    assert_eq!(
        inside(vault, 100.0, 180.0, -60.0, 0.0),
        vec![sydney.clone()]
    );
    assert!(inside(vault, -10.0, 30.0, -60.0, -30.0).is_empty());
    let points = vault
        .read(|c| centraid_vault::index::viewport(c, -10.0, 30.0, 35.0, 60.0, 1))
        .expect("reads");
    assert_eq!(points.len(), 1, "the limit bounds the answer");
    let rows: i64 = vault
        .read(|c| Ok(c.query_row("SELECT count(*) FROM geo", [], |r| r.get(0))?))
        .expect("counts");
    assert_eq!(
        rows, 3,
        "one point each for what has coordinates, none for {nowhere} or {unplaced}"
    );
    assert_equals_a_rebuild(scratch.dir(), "with three points");

    // A move moves the point; losing the coordinates removes it; getting them adds it.
    set(vault, "photo", &paris, Some((43.30, 5.37)));
    assert_eq!(europe(vault), sorted(vec![paris.clone(), rome.clone()]));
    assert_eq!(inside(vault, 5.0, 6.0, 43.0, 44.0), vec![paris.clone()]);
    assert!(
        inside(vault, 2.0, 3.0, 48.0, 49.0).is_empty(),
        "the old point is gone"
    );
    set(vault, "photo", &paris, None);
    assert_eq!(europe(vault), vec![rome.clone()]);
    set(vault, "place", &unplaced, Some((50.0, 8.0)));
    assert_eq!(europe(vault), sorted(vec![rome.clone(), unplaced.clone()]));
    assert_equals_a_rebuild(scratch.dir(), "after moves");

    // The trash takes a point out of the map; a restore brings it back; a purge ends it.
    let registry = Registry::with_system_commands().expect("a registry");
    let run = |name: &str, id: &str| {
        let out = vault
            .execute(
                &registry,
                &Principal::owner("phone"),
                &Command::new(name, json!({"id": id})),
            )
            .expect("runs");
        assert_eq!(
            out.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            out.reason
        );
    };
    run("entity.trash", &rome);
    assert_eq!(europe(vault), vec![unplaced.clone()]);
    drain(vault);
    assert_equals_a_rebuild(scratch.dir(), "with a place in the trash");
    run("entity.restore", &rome);
    assert_eq!(europe(vault), sorted(vec![rome.clone(), unplaced.clone()]));
    run("entity.trash", &sydney);
    run("entity.purge", &sydney);
    assert!(inside(vault, 100.0, 180.0, -60.0, 0.0).is_empty());
    let n: i64 = vault
        .read(|c| Ok(c.query_row("SELECT count(*) FROM geo", [], |r| r.get(0))?))
        .expect("counts");
    assert_eq!(n, 2, "the purged photo's point is gone");
    assert_equals_a_rebuild(scratch.dir(), "after a purge");
}
