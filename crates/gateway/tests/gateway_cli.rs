//! The installed gateway's operator commands must reach their work, not panic in argument parsing.
#![cfg(feature = "server")]

use std::process::Command;

use centraid_gateway::rules::payload::PairPayload;
use centraid_gateway::server::record_served;

fn gateway() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_centraid-gateway"));
    command.env_remove("CENTRAID_GATEWAY_DATA_DIR");
    command.env_remove("CENTRAID_GATEWAY_NAME");
    command.env_remove("CENTRAID_GATEWAY_ANNOUNCE");
    command
}

fn parse_printed_payload(stdout: &str) -> PairPayload {
    let json = stdout
        .lines()
        .find_map(|line| line.strip_prefix("pair      "))
        .expect("a `pair      <json>` line");
    PairPayload::parse(json).expect("printed payload parses")
}

#[test]
fn pairings_opens_an_empty_gateway_and_lists_it() {
    let directory = tempfile::tempdir().expect("a disposable gateway directory");
    let output = gateway()
        .args(["pairings", "--data-dir"])
        .arg(directory.path())
        .output()
        .expect("the actual gateway executable runs");
    assert!(output.status.success(), "{output:?}");
    assert!(directory.path().join("state.db").is_file());
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("secrets   0 waiting, 0 spent, 0 expired")
    );
    assert!(!String::from_utf8_lossy(&output.stderr).contains("panicked"));
}

#[test]
fn a_missing_data_directory_is_a_normal_usage_error() {
    let output = gateway()
        .arg("pairings")
        .output()
        .expect("the actual gateway executable runs");
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("--data-dir"), "{stderr}");
    assert!(!stderr.contains("panicked"), "{stderr}");
}

#[test]
fn revoke_help_works_with_the_documented_argument_order() {
    let output = gateway()
        .args(["pairings", "--data-dir", "test-gateway", "revoke", "--help"])
        .output()
        .expect("the actual gateway executable runs");
    assert!(output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("<ID>"));
}

#[test]
fn pair_carries_name_and_announce_and_inherits_persisted_serve_record() {
    let directory = tempfile::tempdir().expect("a disposable gateway directory");
    let explicit = gateway()
        .args(["pair", "--data-dir"])
        .arg(directory.path())
        .args([
            "--name",
            "Home NAS",
            "--announce",
            "100.101.102.103:8443",
            "--announce",
            "nas.tail1234.ts.net:8443",
        ])
        .output()
        .expect("pair runs");
    assert!(explicit.status.success(), "{explicit:?}");
    let payload = parse_printed_payload(&String::from_utf8_lossy(&explicit.stdout));
    assert_eq!(payload.label.as_deref(), Some("Home NAS"));
    assert!(payload.addrs.contains(&"100.101.102.103:8443".to_owned()));
    assert!(
        payload
            .addrs
            .contains(&"nas.tail1234.ts.net:8443".to_owned())
    );

    // When `serve` has persisted `(bind, name, announce)` in `serve.json`,
    // `centraid-gateway pair --data-dir ...` inherits them automatically.
    record_served(
        directory.path(),
        "0.0.0.0:9443".parse().expect("socket addr"),
        Some("Studio Mac"),
        &["studio.tail1234.ts.net:9443".to_owned()],
    )
    .expect("records serve.json");

    let inherited = gateway()
        .args(["pair", "--data-dir"])
        .arg(directory.path())
        .output()
        .expect("pair runs");
    assert!(inherited.status.success(), "{inherited:?}");
    let inherited_payload = parse_printed_payload(&String::from_utf8_lossy(&inherited.stdout));
    assert_eq!(inherited_payload.label.as_deref(), Some("Studio Mac"));
    assert!(
        inherited_payload
            .addrs
            .contains(&"studio.tail1234.ts.net:9443".to_owned()),
        "{inherited_payload:?}"
    );
}
