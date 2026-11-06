//! Label colors survive the additive upgrade and a restored snapshot. A color
//! belongs to the tag, so every labelled entity keeps the same choice.
mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::json;

fn run(vault: &Vault, name: &str, input: serde_json::Value) -> serde_json::Value {
    let registry = Registry::with_system_commands().unwrap();
    let outcome = vault
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new(name, input),
        )
        .unwrap();
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
    outcome.output
}

#[test]
fn existing_labels_upgrade_without_losing_links_and_the_color_restores() {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("vault.db");
    let old = common::earlier_schema(&file, 1);
    old.execute_batch("INSERT INTO entity(id,kind,title,created_at,updated_at) VALUES ('legacy-note','note','Travel','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'), ('legacy-tag','tag','Travel','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
        INSERT INTO note(id,body) VALUES ('legacy-note','Tickets');
        INSERT INTO concept(id,kind,key) VALUES ('legacy-tag','tag','travel');
        INSERT INTO edge(from_id,rel,to_id,created_at) VALUES ('legacy-note','tagged','legacy-tag','2026-01-01T00:00:00Z');").unwrap();
    let id = "legacy-note";
    let tag = "legacy-tag";
    drop(old);
    let vault = Vault::open(&file).unwrap();
    run(
        &vault,
        "tag.color",
        json!({"id": tag, "color":"listViolet"}),
    );
    assert_eq!(
        vault
            .read(|db| Ok(db.query_row(
                "SELECT COUNT(*) FROM edge WHERE from_id=?1 AND to_id=?2 AND rel='tagged'",
                [id, tag],
                |row| row.get::<_, i64>(0)
            )?))
            .unwrap(),
        1
    );
    let snapshot = dir.join("restored.db");
    let backup = dir.join("backup");
    let artifact = centraid_vault::snapshot::build_snapshot(&vault, &backup).unwrap();
    let mut gzip =
        flate2::read::GzDecoder::new(std::fs::File::open(backup.join(artifact.name)).unwrap());
    std::io::copy(&mut gzip, &mut std::fs::File::create(&snapshot).unwrap()).unwrap();
    let restored = Vault::open(&snapshot).unwrap();
    assert_eq!(
        restored
            .read(|db| Ok(
                db.query_row("SELECT color FROM concept WHERE id=?1", [tag], |row| row
                    .get::<_, String>(
                    0
                ))?
            ))
            .unwrap(),
        "listViolet"
    );
    let registry = Registry::with_system_commands().unwrap();
    for invalid in [
        json!({"id":tag,"color":"danger"}),
        json!({"id":id,"color":"listBlue"}),
    ] {
        let result = restored
            .execute(
                &registry,
                &Principal::owner("phone"),
                &Command::new("tag.color", invalid),
            )
            .unwrap();
        assert_eq!(result.status, CommandStatus::Failed);
    }
    restored.finish().unwrap();
    vault.finish().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}
