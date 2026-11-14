//! The installed gateway's operator commands must reach their work, not panic in argument parsing.
#![cfg(feature = "server")]

use std::process::Command;

fn gateway() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_centraid-gateway"));
    command.env_remove("CENTRAID_GATEWAY_DATA_DIR");
    command
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
