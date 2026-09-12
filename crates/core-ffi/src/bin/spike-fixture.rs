//! Write the vault and the request bytes the out-of-process spike harnesses
//! need (#1020, D-1020-D2-7).
//!
//! The C harness and the JNA harness both take a vault path and a file of
//! encoded request bytes, so neither has to link protobuf or know how to found
//! a vault. This binary makes both. `tests/spike.rs` does the same work inline
//! for the C harness; this exists because the JNA harness runs under Gradle,
//! outside cargo, and needs the fixture on disk first.
//!
//!   cargo run -p centraid-core-ffi --bin spike-fixture -- <dir>

use centraid_api_proto::core_v1 as wire;
use prost::Message as _;

fn main() {
    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "/tmp/centraid-spike".to_owned());
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("the directory is made");
    let vault_path = dir.join("spike-vault.db");
    // A fresh file every time: a spike measuring a vault a previous run left
    // behind is measuring whatever that run happened to write.
    let _ = std::fs::remove_file(&vault_path);
    let _ = std::fs::remove_file(dir.join("spike-vault.db-wal"));
    let _ = std::fs::remove_file(dir.join("spike-vault.db-shm"));

    let handle = centraid_core::Core::open(centraid_core::CoreConfig::gateway(&vault_path))
        .expect("a core opens");
    handle
        .with_vault(|vault| {
            vault.found("Spike", "Owner")?;
            for index in 0..200 {
                vault.commit(|tx| {
                    tx.set_producer("spike.seed");
                    tx.connection().execute(
                        "INSERT INTO core_party
                           (party_id, kind, display_name, created_at, updated_at)
                         VALUES (?1, 'person', ?2, ?3, ?3)",
                        rusqlite::params![
                            format!("p-{index:05}"),
                            format!("Party {index}"),
                            "2026-01-01T00:00:00.000Z"
                        ],
                    )?;
                    Ok(())
                })?;
            }
            Ok(())
        })
        .expect("the rows seed");
    handle.close();

    let request = wire::Envelope {
        request_id: 0,
        body: Some(wire::envelope::Body::Request(wire::Request {
            kind: Some(wire::request::Kind::Page(wire::PageRequest {
                query: Some(wire::PageQuery {
                    name: "spike".to_owned(),
                    select: vec!["party_id".to_owned(), "created_at".to_owned()],
                    from: "core_party".to_owned(),
                    r#where: None,
                    bind: Vec::new(),
                    order: Some(wire::PageOrder {
                        sort_column: "created_at".to_owned(),
                        pk_column: "party_id".to_owned(),
                        descending: false,
                    }),
                }),
                limit: 100,
                after: None,
            })),
        })),
    }
    .encode_to_vec();
    let request_path = dir.join("request.bin");
    std::fs::write(&request_path, &request).expect("the request writes");

    println!("CENTRAID_VAULT={}", vault_path.display());
    println!("CENTRAID_REQUEST={}", request_path.display());
}
