//! Shared by the suites that run against a real vault (`--features vault-door`).

#![allow(dead_code)]

use std::collections::BTreeMap;

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::page::{Page, PageCursor, PageRequest};
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::{Cell, Row};
use centraid_apps_kit::statement::{PageBindValue, PageQuery};
use centraid_apps_money::commands::{Commands, Invocation, Outcome};
use centraid_apps_money::door::VaultDoor;
use centraid_vault::access::Principal;
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::page::KeysetPage;
use centraid_vault::{Value, Vault};
use serde_json::json;

pub struct Scratch {
    pub dir: std::path::PathBuf,
    pub vault: Vault,
    pub registry: Registry,
}

impl Scratch {
    pub fn founded(seed: &str) -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let vault = Vault::create_with(
            dir.join("vault.db"),
            Box::new(std::sync::Arc::new(FixedClock::frozen())),
            Box::new(SeededIds::new(seed)),
        )
        .expect("a vault is created");
        vault.found("Test", "Priya").expect("it is founded");
        let registry = Registry::with_system_commands().expect("the registry builds");
        registry.install(&vault).expect("the record installs");
        Self {
            dir,
            vault,
            registry,
        }
    }

    pub fn door(&self) -> VaultDoor<'_> {
        VaultDoor::new(&self.vault, &self.registry, Principal::owner("phone"))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn invocation(command: &'static str, input: serde_json::Value, key: &str) -> Invocation {
    Invocation {
        command,
        input: input
            .as_object()
            .expect("an object")
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect::<BTreeMap<_, _>>(),
        invoke_key: key.to_owned(),
        optional: false,
    }
}

/// Runs a command and returns its output, panicking with the refusal's
/// sentence if it does not execute.
pub fn execute(
    door: &dyn Commands,
    command: &'static str,
    input: serde_json::Value,
) -> serde_json::Value {
    let outcome = door
        .invoke(&invocation(command, input, command))
        .expect("the door is there");
    match outcome {
        Outcome::Executed { output } => output,
        other => panic!("{command}: {other:?}"),
    }
}

pub fn add_account(door: &dyn Commands, id: &str, name: &str, kind: &str, currency: &str) {
    execute(
        door,
        "money.add_account",
        json!({ "account_id": id, "name": name, "kind": kind, "currency": currency }),
    );
}

/// The vault's own paged door (`Vault::keyset_page`): keyset assembler TWO.
pub struct KeysetDoor<'v>(pub &'v Vault);

impl PageDoor for KeysetDoor<'_> {
    fn page(&self, query: &PageQuery, request: &PageRequest) -> KitResult<Page<Row>> {
        centraid_apps_kit::grammar::parse(query)?;
        let answer = self
            .0
            .keyset_page(&KeysetPage {
                name: query.name.clone(),
                select: query
                    .select
                    .split(',')
                    .map(str::trim)
                    .filter(|c| !c.is_empty())
                    .map(str::to_owned)
                    .collect(),
                from: query.from.clone(),
                predicate: query.r#where.clone(),
                binds: query
                    .bind
                    .iter()
                    .map(|bind| match bind {
                        PageBindValue::Text(t) => Value::Text(t.clone()),
                        PageBindValue::Integer(n) => Value::Integer(*n),
                        PageBindValue::Real(n) => Value::Real(*n),
                        PageBindValue::Null => Value::Null,
                    })
                    .collect(),
                sort_column: query.order.sort_column.clone(),
                pk_column: query.order.pk_column.clone(),
                descending: query.order.descending,
                limit: i64::try_from(request.limit).unwrap_or(i64::MAX),
                after: request
                    .after
                    .as_ref()
                    .map(|c| (c.sort_key.clone(), c.pk.clone())),
                held_thumbnail: false,
                document_size: false,
            })
            .map_err(|e| KitError::Door(e.to_string()))?;
        Ok(Page {
            rows: answer
                .rows
                .into_iter()
                .map(|image| {
                    image
                        .into_iter()
                        .map(|(column, value)| {
                            (
                                column,
                                match value {
                                    Value::Null => Cell::Null,
                                    Value::Integer(n) => Cell::Integer(n),
                                    Value::Real(n) => Cell::Real(n),
                                    Value::Text(t) => Cell::Text(t),
                                    Value::Blob(b) => Cell::Blob(b),
                                },
                            )
                        })
                        .collect()
                })
                .collect(),
            next: answer
                .next
                .map(|(sort_key, pk)| PageCursor { sort_key, pk }),
        })
    }
}
