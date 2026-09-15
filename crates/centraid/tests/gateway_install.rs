//! `centraid gateway install --dry-run` WRITES NOTHING (#1020, D-1020-G1).
//!
//! The unit-level tests in `cmd::gateway_install` cover the plan; this one
//! covers the side effects, because "writes nothing" is a claim about the
//! filesystem and not about a function's return value. v0 proved the same
//! property the same way (`service-admin.test.ts:93`–`:120`), and the reason
//! is the one the VPS smoke depends on: a dry run is what an operator uses to
//! READ a unit before trusting it, so a dry run that installed the service
//! would mean the release smoke mutates the host it is measuring (census §G
//! seam G11).

use std::path::Path;
use std::process::Command;

fn binary() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_centraid"))
}

/// Every file under `dir`, sorted — the before/after set the assertion is over.
fn tree(dir: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&next) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                found.push(path.to_string_lossy().to_string());
            }
        }
    }
    found.sort();
    found
}

#[test]
fn a_dry_run_prints_the_unit_and_leaves_the_home_directory_untouched() {
    let home = tempfile::tempdir().expect("a temporary HOME");
    let before = tree(home.path());
    assert!(before.is_empty());

    let output = Command::new(binary())
        .args([
            "gateway",
            "install",
            "--dry-run",
            "--data-dir",
            "/srv/centraid",
        ])
        .env("HOME", home.path())
        .env_remove("XDG_DATA_HOME")
        .output()
        .expect("run centraid gateway install --dry-run");

    assert!(output.status.success(), "{output:?}");
    let unit = String::from_utf8_lossy(&output.stdout);
    let facts = String::from_utf8_lossy(&output.stderr);

    // The unit goes to stdout so `… --dry-run > centraid-gateway.service` is a
    // usable gesture, and nothing else does.
    #[cfg(target_os = "macos")]
    assert!(unit.starts_with("<?xml version=\"1.0\""), "{unit}");
    #[cfg(not(target_os = "macos"))]
    {
        assert!(unit.starts_with("[Unit]\n"), "{unit}");
        assert!(unit.contains("ExecStart="), "{unit}");
        assert!(unit.contains("--data-dir /srv/centraid"), "{unit}");
        // The secret is never in the unit.
        assert!(unit.contains("LoadCredentialEncrypted="), "{unit}");
    }

    // The dry run SAYS it wrote nothing, and names the command that would.
    assert!(facts.contains("NOTHING was written"), "{facts}");
    assert!(
        facts.contains("enable the service yourself"),
        "installing is not enabling: {facts}"
    );

    assert_eq!(
        tree(home.path()),
        before,
        "--dry-run wrote into HOME; the files above appeared"
    );
}

/// The real install writes exactly one file, under the per-user path, and still
/// does not enable anything.
#[test]
fn an_install_writes_the_unit_and_nothing_else() {
    if cfg!(target_os = "macos") {
        // The LaunchAgent path is the same shape; the assertion below is written
        // for the systemd user unit and this container is Linux.
        return;
    }
    let home = tempfile::tempdir().expect("a temporary HOME");
    let output = Command::new(binary())
        .args(["gateway", "install", "--data-dir", "/srv/centraid"])
        .env("HOME", home.path())
        .output()
        .expect("run centraid gateway install");
    assert!(output.status.success(), "{output:?}");

    let written = tree(home.path());
    assert_eq!(written.len(), 1, "{written:?}");
    assert!(
        written[0].ends_with(".config/systemd/user/centraid-gateway.service"),
        "{written:?}"
    );
    let unit = std::fs::read_to_string(&written[0]).expect("read the unit");
    assert!(unit.contains("Restart=on-failure"), "{unit}");
    assert!(unit.contains("RestartSec=5"), "{unit}");
    assert!(unit.contains("WantedBy=default.target"), "{unit}");
}

/// A malformed `--instance` is refused before anything is written, because it
/// becomes a `%i` and a directory name under `/var/lib/centraid`.
#[test]
fn a_system_install_with_a_bad_instance_name_refuses() {
    let output = Command::new(binary())
        .args([
            "gateway",
            "install",
            "--system",
            "--dry-run",
            "--instance",
            "../etc",
        ])
        .output()
        .expect("run centraid gateway install --system");
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("--instance"),
        "{output:?}"
    );
}
