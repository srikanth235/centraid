//! Palette changes belong to the container and survive re-opening the vault.
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::json;

#[test]
fn container_appearance_is_saved_rejects_unknown_roles_and_leaves_unrelated_fields() {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let vault = Vault::create(dir.join("vault.db")).unwrap();
    vault.found("Home", "Owner").unwrap();
    let registry = Registry::with_system_commands().unwrap();
    let run = |name: &str, input| {
        vault
            .execute(
                &registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap()
    };
    for kind in ["calendar", "project"] {
        let made = run(
            "container.create",
            json!({"kind":kind,"title":"Weekend","color":"listPetrol","icon_key":"Heart"}),
        );
        assert_eq!(made.status, CommandStatus::Executed, "{:?}", made.reason);
        let id = made.output["id"].as_str().unwrap();
        let changed = run(
            "container.style",
            json!({"id":id,"color":"listOrchid","icon_key":"Book"}),
        );
        assert_eq!(
            changed.status,
            CommandStatus::Executed,
            "{:?}",
            changed.reason
        );
        let refused = run("container.style", json!({"id":id,"color":"net"}));
        assert_eq!(refused.status, CommandStatus::Failed);
        let (title,color,icon): (String,String,String) = vault.read(|db| Ok(db.query_row("SELECT e.title,c.color,c.icon_key FROM container c JOIN entity e ON e.id=c.id WHERE c.id=?1", [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?)).unwrap();
        assert_eq!(
            (title, color, icon),
            ("Weekend".into(), "listOrchid".into(), "Book".into())
        );
        run("container.style", json!({"id":id,"icon_key":null}));
        let color: String = vault
            .read(|db| {
                Ok(
                    db.query_row("SELECT color FROM container WHERE id=?1", [id], |row| {
                        row.get(0)
                    })?,
                )
            })
            .unwrap();
        assert_eq!(color, "listOrchid");
    }
}
