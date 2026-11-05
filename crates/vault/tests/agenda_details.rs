//! Older vaults retain their tasks and events while Agenda metadata is added.
mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::json;

fn run(vault: &Vault, name: &str, input: serde_json::Value) -> serde_json::Value {
    let result = vault
        .execute(
            &Registry::with_system_commands().unwrap(),
            &Principal::owner("phone"),
            &Command::new(name, input),
        )
        .unwrap();
    assert_eq!(
        result.status,
        CommandStatus::Executed,
        "{name}: {:?}",
        result.reason
    );
    result.output
}

#[test]
fn metadata_migration_keeps_existing_tasks_and_validates_travel_time() {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("vault.db");
    let old = common::earlier_schema(&file, 2);
    old.execute_batch("INSERT INTO entity(id,kind,title,created_at,updated_at) VALUES ('legacy-task','task','Keep me','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
        INSERT INTO task(id,due) VALUES ('legacy-task','2099-01-01');").unwrap();
    let task_id = "legacy-task".to_owned();
    drop(old);
    let vault = Vault::open(&file).unwrap();
    run(
        &vault,
        "task.edit",
        json!({"id":task_id,"url":"https://example.com/receipt"}),
    );
    let fields = vault
        .read(|db| {
            Ok(db.query_row(
                "SELECT e.title,t.due,t.url FROM entity e JOIN task t ON t.id=e.id WHERE e.id=?1",
                [&task_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )?)
        })
        .unwrap();
    assert_eq!(
        fields,
        (
            "Keep me".into(),
            "2099-01-01".into(),
            "https://example.com/receipt".into()
        )
    );
    let event = run(
        &vault,
        "event.propose",
        json!({"title":"Train", "starts":"2099-01-01T10:00:00Z", "ends":"2099-01-01T11:00:00Z", "zone":"UTC", "travel_minutes":30, "busy":false}),
    );
    let id = event["id"].as_str().unwrap();
    assert_eq!(
        vault
            .read(|db| Ok(db.query_row(
                "SELECT travel_minutes,busy FROM event WHERE id=?1",
                [id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            )?))
            .unwrap(),
        (30, 0)
    );
    let refused = vault
        .execute(
            &Registry::with_system_commands().unwrap(),
            &Principal::owner("phone"),
            &Command::new("event.edit", json!({"id":id,"travel_minutes":-1})),
        )
        .unwrap();
    assert_eq!(refused.status, CommandStatus::Failed);
    let snapshot = dir.join("snapshot.db");
    let backup = dir.join("backup");
    let artifact = centraid_vault::snapshot::build_snapshot(&vault, &backup).unwrap();
    let mut gzip =
        flate2::read::GzDecoder::new(std::fs::File::open(backup.join(artifact.name)).unwrap());
    std::io::copy(&mut gzip, &mut std::fs::File::create(&snapshot).unwrap()).unwrap();
    let restored = Vault::open(&snapshot).unwrap();
    assert_eq!(
        restored
            .read(|db| Ok(
                db.query_row("SELECT url FROM task WHERE id=?1", [&task_id], |row| row
                    .get::<_, String>(
                    0
                ))?
            ))
            .unwrap(),
        "https://example.com/receipt"
    );
}

#[test]
fn clearing_completed_reaches_beyond_the_logbook_window_and_keeps_open_children() {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let vault = Vault::create(dir.join("vault.db")).unwrap();
    vault.found("Home", "Owner").unwrap();
    let parent = run(&vault, "task.add", json!({"title":"Parent"}));
    let parent_id = parent["id"].as_str().unwrap();
    let child = run(
        &vault,
        "task.add",
        json!({"title":"Unfinished child","parent_id":parent_id}),
    );
    let child_id = child["id"].as_str().unwrap();
    run(&vault, "task.complete", json!({"id":parent_id}));
    for n in 0..55 {
        let task = run(&vault, "task.add", json!({"title":format!("Done {n}")}));
        run(&vault, "task.complete", json!({"id":task["id"]}));
    }
    let result = run(
        &vault,
        "task.clear_completed",
        json!({"view":"all","day":"2099-01-01","zone":"UTC"}),
    );
    assert_eq!(result["count"], 56);
    let (status,parent,deleted): (String,Option<String>,Option<String>) = vault.read(|db| Ok(db.query_row("SELECT t.status,t.parent_id,e.deleted_at FROM task t JOIN entity e ON e.id=t.id WHERE t.id=?1", [child_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?)).unwrap();
    assert_eq!(status, "open");
    assert!(parent.is_none());
    assert!(deleted.is_none());
    assert_eq!(
        run(
            &vault,
            "task.clear_completed",
            json!({"view":"all","day":"2099-01-01","zone":"UTC"})
        )["count"],
        0
    );
}

#[test]
fn clearing_tagged_completed_work_follows_the_visible_family_and_keeps_other_tags() {
    let scratch = common::Scratch::founded("clear-tags").unwrap();
    let vault = &scratch.vault;
    let parent = run(vault, "task.add", json!({"title":"Travel","tags":["Trip"]}));
    let child = run(
        vault,
        "task.add",
        json!({"title":"Pack","parent_id":parent["id"]}),
    );
    let other = run(vault, "task.add", json!({"title":"Garden","tags":["Home"]}));
    let untagged = run(vault, "task.add", json!({"title":"Read"}));
    let tagged = run(vault, "tag.add", json!({"id":parent["id"],"label":"Trip"}));
    for task in [&child, &parent, &other, &untagged] {
        run(vault, "task.complete", json!({"id":task["id"]}));
    }
    assert_eq!(
        run(
            vault,
            "task.clear_completed",
            json!({"view":"tags","tag_id":tagged["tag"],"day":"2099-01-01","zone":"UTC"})
        )["count"],
        2
    );
    assert_eq!(
        run(
            vault,
            "task.clear_completed",
            json!({"view":"tags","day":"2099-01-01","zone":"UTC"})
        )["count"],
        1
    );
    let left: i64 = vault.read(|db| Ok(db.query_row("SELECT count(*) FROM task t JOIN entity e ON e.id=t.id WHERE t.status='done' AND e.deleted_at IS NULL", [], |row| row.get(0))?)).unwrap();
    assert_eq!(left, 1);
    let missing_list = vault
        .execute(
            &Registry::with_system_commands().unwrap(),
            &Principal::owner("phone"),
            &Command::new(
                "task.clear_completed",
                json!({"view":"project","day":"2099-01-01","zone":"UTC"}),
            ),
        )
        .unwrap_err();
    assert!(matches!(
        missing_list,
        centraid_vault::VaultError::InvalidInput { name, .. } if name == "project_id"
    ));
    let still_present: bool = vault
        .read(|db| {
            Ok(db.query_row(
                "SELECT deleted_at IS NULL FROM entity WHERE id=?1",
                [untagged["id"].as_str().unwrap()],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert!(
        still_present,
        "a missing list selector must never mean Inbox"
    );
}
