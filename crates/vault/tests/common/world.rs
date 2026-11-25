//! A founded vault with the registry, and entities of any kind made the way the commit guard
//! takes them (the entity row in its home, no kind row): the graph tests join entities, and a join
//! reads only the entity row and its kind's lookup attributes (#1214, K5).

use centraid_vault::commands::Registry;
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandOutcome, CommandStatus, CommitTx, Principal, Vault};

pub const AT: &str = "2026-03-01T09:00:00.000Z";

pub struct World {
    pub scratch: super::Scratch,
    pub registry: Registry,
}

impl World {
    pub fn new(seed: &str) -> Self {
        Self {
            scratch: super::Scratch::founded(seed).expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    pub fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    /// Run a command; the clock moves a second first, so a stamp changes exactly when a command
    /// touched the entity.
    pub fn run(&self, name: &str, input: serde_json::Value) -> CommandOutcome {
        self.scratch.clock.advance_ms(1_000);
        self.vault()
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"))
    }

    pub fn ok(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    pub fn refused(&self, name: &str, input: serde_json::Value) -> String {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "{name} was not refused"
        );
        outcome.reason.expect("a sentence")
    }

    pub fn commit(&self, body: impl FnOnce(&CommitTx<'_>) -> centraid_vault::Result<()>) {
        self.vault()
            .commit(|tx| body(tx))
            .expect("the commit lands");
    }

    pub fn one<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> T {
        self.vault()
            .read(|connection| {
                Ok(connection
                    .query_row(sql, rusqlite::params_from_iter(params), |row| row.get(0))?)
            })
            .unwrap_or_else(|error| panic!("{sql}: {error}"))
    }

    pub fn strings(&self, sql: &str, params: &[&str]) -> Vec<String> {
        self.vault()
            .read(|connection| {
                let mut statement = connection.prepare(sql)?;
                Ok(statement
                    .query_map(rusqlite::params_from_iter(params), |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()?)
            })
            .unwrap_or_else(|error| panic!("{sql}: {error}"))
    }

    pub fn stamp(&self, id: &str) -> String {
        self.one::<String>("SELECT updated_at FROM entity WHERE id = ?1", &[id])
    }

    pub fn mint(&self) -> String {
        self.vault().ids().next()
    }

    /// An entity of `kind` in `parent`, with no kind row.
    pub fn bare(&self, kind: Kind, title: &str, parent: Option<&str>) -> String {
        let id = self.mint();
        self.commit(|tx| tx.insert_entity_in(&id, kind, title, parent, AT));
        id
    }

    /// An entity of `kind` named `title`, in the first home its kind may sit in when its kind needs
    /// one (the home is made first, the same way): the lookups say what a kind needs, not this file.
    pub fn made(&self, kind: Kind, title: &str) -> String {
        let (needs_home, named): (bool, bool) = self
            .vault()
            .read(|c| {
                Ok(c.query_row(
                    "SELECT may_be_top = 0, may_be_named FROM entity_kind WHERE code = ?1",
                    [kind.as_str()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?)
            })
            .expect("a kind row");
        let home = needs_home.then(|| {
            let holder: String = self.one(
                "SELECT home_kind FROM home_shape WHERE kind = ?1 ORDER BY home_kind LIMIT 1",
                &[kind.as_str()],
            );
            self.made(Kind::parse(&holder).expect("a kind"), "Holder")
        });
        self.bare(kind, if named { title } else { "" }, home.as_deref())
    }

    pub fn person(&self, name: &str) -> String {
        let id = self.mint();
        self.commit(|tx| super::add_person(tx, &id, name, AT));
        id
    }

    pub fn note(&self, title: &str) -> String {
        let id = self.mint();
        self.commit(|tx| {
            tx.insert_entity_in(&id, Kind::Note, title, None, AT)?;
            tx.connection()
                .execute("INSERT INTO note (id, body) VALUES (?1, '')", [&id])?;
            Ok(())
        });
        id
    }

    pub fn container(&self, kind: &str, title: &str) -> String {
        self.ok(
            "container.create",
            serde_json::json!({"kind": kind, "title": title}),
        )["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    /// The kinds whose lookup row says `linkable = want`.
    pub fn kinds_linkable(&self, want: bool) -> Vec<Kind> {
        self.strings(
            "SELECT code FROM entity_kind WHERE linkable = ?1 ORDER BY code",
            &[if want { "1" } else { "0" }],
        )
        .iter()
        .map(|code| Kind::parse(code).expect("a kind the model knows"))
        .collect()
    }
}
