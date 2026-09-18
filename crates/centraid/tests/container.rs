//! THE IMAGE RUNS A VERB THIS BINARY STILL HAS (#1029 §3; W4b hand-off 3).
//!
//! `deploy/docker/Dockerfile`'s `CMD ["gateway", "--data-dir", "/data"]` had
//! not worked since W2 reduced the `gateway` verb to `gateway install`: the
//! image built, CI was green, and `docker run` exited on a usage error. Nothing
//! read the file, so nothing said so.
//!
//! That is the failure this file exists to make loud, and it is the same claim
//! `crates/gateway-server/tests/container.rs` makes about the serving image —
//! stated here for the other one rather than assumed to carry across.
//!
//! **What it cannot prove is that the image builds.** There is no Docker daemon
//! in the environments this runs in (W4b found the same), so this reads the
//! Dockerfile as text and checks the couplings a build would not have caught
//! anyway: a build succeeds with a `CMD` that names a deleted subcommand. The
//! build itself is the release workflow's.

use std::path::{Path, PathBuf};

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the repository root")
}

fn dockerfile() -> String {
    std::fs::read_to_string(repository_root().join("deploy/docker/Dockerfile"))
        .expect("the operator image's Dockerfile")
}

fn cli_source() -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"))
        .expect("the binary's source")
}

/// EVERY VERB AND FLAG THE IMAGE RUNS IS ONE THE CLI STILL ACCEPTS.
///
/// The default command is one-shot on purpose — this image carries operator
/// verbs, not a server — so the check is that the verb exists, not that it
/// keeps running.
#[test]
fn every_command_the_image_runs_is_one_the_binary_still_has() {
    let text = dockerfile();
    let cli = cli_source();

    assert!(
        text.contains(r#"ENTRYPOINT ["/usr/local/bin/centraid"]"#),
        "the entrypoint is not this binary"
    );
    assert!(
        text.contains(r#"CMD ["doctor", "--data-dir", "/data"]"#),
        "the default command is not `doctor --data-dir /data`; if it changed, \
         change this line too — and check the new verb against the CLI below"
    );

    // clap derives the long flag from the field name, so checking `data_dir:`
    // is checking `--data-dir`, and it is the thing that actually disappears
    // when somebody renames an argument.
    assert!(
        cli.contains("data_dir:"),
        "the image passes `--data-dir`, which the CLI no longer accepts"
    );
    assert!(
        cli.contains("    Doctor {"),
        "the image runs `doctor`, which the CLI no longer has"
    );
}

/// THE VERB THAT BROKE IS NOT BACK.
///
/// `centraid gateway` on its own is not a command: `gateway` takes a
/// subcommand, and the only one is `install`, which writes a unit file onto a
/// host. Neither belongs in a container's default command, and a future edit
/// that put one back would reintroduce exactly the defect this file records.
#[test]
fn the_image_does_not_default_to_a_verb_that_needs_a_host_or_a_subcommand() {
    // Instructions only. The header comment quotes the broken `CMD` this file
    // exists to record, and a scan that read comments would find its own
    // history and fail.
    let text: String = dockerfile()
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    for wrong in [
        r#"CMD ["gateway""#,
        r#"CMD ["serve""#,
        r#"CMD ["recover""#,
    ] {
        assert!(
            !text.contains(wrong),
            "`{wrong}` is not something this binary can do as a container's \
             default command. The serving gateway is \
             `deploy/gateway-server/Dockerfile`"
        );
    }
}

/// THE IMAGE BUILDS THE BINARY IT THEN RUNS.
///
/// A build stage that names a different package or profile than the copy below
/// it fails after the whole compile has run, which is the most expensive place
/// to find a typo.
#[test]
fn the_build_stage_and_the_copy_name_the_same_binary() {
    let text = dockerfile();
    assert!(
        text.contains("--bin centraid"),
        "the build stage does not name this binary"
    );
    assert!(text.contains("--profile dist"));
    assert!(
        text.contains("target/dist/centraid"),
        "the copy does not read the profile the build stage writes"
    );
}

/// A CONTAINER WHOSE PROCESS EXITS MUST NOT CARRY A HEALTH CHECK.
///
/// Docker would run one against a stopped container and report `unhealthy`
/// forever. The previous `HEALTHCHECK` here made sense beside a `CMD` that
/// served; beside a one-shot verb it is a false alarm, and an operator who
/// learns to ignore one alarm has learned to ignore the next.
#[test]
fn a_one_shot_image_declares_no_health_check() {
    let text = dockerfile();
    let declared = text
        .lines()
        .any(|line| line.trim_start().starts_with("HEALTHCHECK"));
    assert!(
        !declared,
        "this image's default command exits, so a HEALTHCHECK can only ever \
         report `unhealthy`. The serving image is where one belongs"
    );
}
