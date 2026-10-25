//! A Driver's scratch vault goes with it (#1135): every test run used to leave one
//! `centraid-scratch-*` directory under the system's temporary directory, and thousands of
//! them filled the disk the shared target directory lives on.

use centraid_screens::testing::Driver;

/// This process's scratch directories, by name.
fn ours() -> Vec<String> {
    let prefix = format!("centraid-scratch-{}-", std::process::id());
    std::fs::read_dir(std::env::temp_dir())
        .expect("the temporary directory lists")
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.starts_with(&prefix))
        .collect()
}

#[test]
fn a_driver_removes_the_scratch_vault_it_made_when_it_drops() {
    let before = ours();
    let mut driver = Driver::with_runtime(centraid_screens::imports::runtime());
    driver.start();
    assert_eq!(ours().len(), before.len() + 1, "the driver made one vault");
    drop(driver);
    assert_eq!(ours(), before, "and it went with the driver");
}
