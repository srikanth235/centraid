//! Shared test harness: a seeded fixture world and a session over it.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use centraid_nativetools::{Flags, Session, dates, seed, vaultio};
use serde_json::{Value, json};

pub const FIXTURE: &str = include_str!("../fixtures/world.json");
/// A Sunday.
pub const TODAY: &str = "2026-09-27";

pub struct World {
    pub dir: tempfile::TempDir,
    pub path: PathBuf,
    pub keys: Value,
}

/// Seed the fixture world into a fresh directory.
#[must_use]
pub fn seeded() -> World {
    seeded_with(&serde_json::from_str(FIXTURE).expect("the fixture is JSON"))
}

#[must_use]
pub fn seeded_with(world: &Value) -> World {
    let dir = tempfile::tempdir().expect("a temp dir");
    let path = dir.path().join("vault.db");
    let keys = seed::seed(world, &path).expect("the world seeds");
    World { dir, path, keys }
}

impl World {
    #[must_use]
    pub fn session(&self) -> Session {
        self.session_with(TODAY, Flags::default())
    }

    /// A session with the asks and declines the model used to write left to it (`Flags::compose`
    /// off): the legacy replies (`ambiguous:`, `0 … called …`, `error: … was refused`) the
    /// older suites pin, as `--no-compose` runs them.
    #[must_use]
    pub fn session_uncomposed(&self) -> Session {
        self.session_with(
            TODAY,
            Flags {
                compose: false,
                ..Flags::default()
            },
        )
    }

    #[must_use]
    pub fn session_with(&self, today: &str, flags: Flags) -> Session {
        vaultio::open_session(
            &self.path,
            dates::parse_now(today).expect("a date"),
            "",
            flags,
        )
        .expect("the session opens")
    }

    /// The vault id of a fixture key.
    #[must_use]
    pub fn id(&self, key: &str) -> String {
        self.keys[key]["id"].as_str().expect("a key").to_owned()
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// One call, returning the whole response.
pub fn call(session: &mut Session, tool: &str, args: Value) -> Value {
    session.call(tool, &args)
}

/// The observation text of one call.
pub fn text(session: &mut Session, tool: &str, args: Value) -> String {
    call(session, tool, args)["text"]
        .as_str()
        .expect("a text")
        .to_owned()
}

/// Start a turn and return `#n` of the one row a find selects. Earlier
/// turns compact, so the number is good for this turn and any later one
/// whose calls reference it.
pub fn number(session: &mut Session, kind: &str, name: &str) -> String {
    numbers(session, &[(kind, name)]).remove(0)
}

/// Start a turn and find several rows in it.
pub fn numbers(session: &mut Session, wanted: &[(&str, &str)]) -> Vec<String> {
    session.user("");
    wanted
        .iter()
        .map(|(kind, name)| find_in_turn(session, kind, name))
        .collect()
}

/// `#n` of the one row a find selects, inside the current turn.
pub fn find_in_turn(session: &mut Session, kind: &str, name: &str) -> String {
    let response = call(session, "find", json!({"kind": kind, "name": name}));
    let rows = response["effect"]["rows"].as_array().expect("rows");
    assert_eq!(rows.len(), 1, "{kind} {name}: {}", response["text"]);
    format!("#{}", rows[0]["n"])
}

/// The `#n` a find over trashed rows selects.
pub fn trashed_number(session: &mut Session, kind: &str, name: &str) -> String {
    session.user("");
    let response = call(
        session,
        "find",
        json!({"kind": kind, "name": name, "trashed": true}),
    );
    let rows = response["effect"]["rows"].as_array().expect("rows");
    assert_eq!(rows.len(), 1, "{kind} {name}: {}", response["text"]);
    format!("#{}", rows[0]["n"])
}

/// Vault ids a response's effect answered or listed.
#[must_use]
pub fn ids(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row["id"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// The diff rows of a write's effect.
#[must_use]
pub fn diff_rows(response: &Value) -> Vec<Value> {
    response["effect"]["diff"]["rows"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}
