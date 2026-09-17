//! THE IMAGE, CHECKED WITHOUT A DAEMON (#1029 §3).
//!
//! `docker build` is the real check and it is not available in every place this
//! suite runs — this container has no Docker daemon at all, and CI's is a
//! separate lane. A Dockerfile that only CI ever reads is a Dockerfile that
//! rots between releases, and the way it rots is quiet: a renamed binary, a
//! flag the CLI stopped accepting, a `CMD` that has not been correct since
//! somebody deleted a subcommand.
//!
//! So this asserts the things that can be asserted from the file itself and
//! from the binary it claims to run — **every one of them a coupling between
//! the image and the code**, which is the class of breakage a rebuild would
//! catch and a reader would not:
//!
//! - the binary name, the package and the profile the build stage names are the
//!   ones this crate actually produces;
//! - every verb in `CMD`, `ENTRYPOINT` and `HEALTHCHECK` is a verb the CLI
//!   still has, and every flag is a flag it still accepts;
//! - the environment variable the image sets is the one the CLI reads;
//! - the runtime stage does not run as root, and the state directory it
//!   declares is the one the command writes to.
//!
//! It does not claim to replace a build. It claims that when a build does run,
//! it will not fail on something a string comparison could have caught.

use std::path::{Path, PathBuf};

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the workspace root resolves")
}

fn dockerfile() -> String {
    std::fs::read_to_string(repository_root().join("deploy/gateway-server/Dockerfile"))
        .expect("the gateway image's Dockerfile")
}

fn cli_source() -> String {
    std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/bin/centraid-gateway.rs"),
    )
    .expect("the binary's source")
}

/// The image builds the binary this crate actually produces.
#[test]
fn the_build_stage_names_this_crate_and_this_binary() {
    let text = dockerfile();
    assert!(
        text.contains("-p centraid-gateway-server"),
        "the build stage does not name this package"
    );
    assert!(
        text.contains("--bin centraid-gateway"),
        "the build stage does not name this binary"
    );
    // `[[bin]] name` is what the build stage copies out of `target/`.
    let manifest =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
            .expect("the manifest");
    assert!(
        manifest.contains("name = \"centraid-gateway\""),
        "the manifest no longer produces the binary the image copies"
    );
    // `--profile dist` and `target/dist/` have to agree, or the copy fails
    // after the whole build has run.
    assert!(text.contains("--profile dist"));
    assert!(text.contains("target/dist/centraid-gateway"));
}

/// EVERY VERB AND FLAG THE IMAGE RUNS STILL EXISTS.
///
/// This is the coupling that actually breaks: a `CMD` naming a subcommand
/// somebody deleted builds fine and fails at `docker run`, which is the worst
/// place to find out.
#[test]
fn every_command_the_image_runs_is_one_the_binary_still_has() {
    let text = dockerfile();
    let cli = cli_source();

    assert!(
        text.contains(
            r#"CMD ["serve", "--data-dir", "/var/lib/centraid", "--bind", "0.0.0.0:8443"]"#
        )
    );
    assert!(text.contains(r#"ENTRYPOINT ["/usr/local/bin/centraid-gateway"]"#));

    // clap derives a long flag from the field name, so `--data-dir` is the
    // field `data_dir`. Checking the field is checking the flag, and it is the
    // thing that actually disappears when somebody renames an argument.
    for (flag, field) in [
        ("--data-dir", "data_dir:"),
        ("--bind", "bind:"),
        ("--url", "url:"),
    ] {
        assert!(
            cli.contains(field),
            "the image passes `{flag}`, which the CLI no longer accepts"
        );
    }
    for verb in ["Serve", "Health"] {
        assert!(
            cli.contains(&format!("    {verb} {{")),
            "the image runs a verb the CLI no longer has: {verb}"
        );
    }
    assert!(
        text.contains("centraid-gateway\", \"health\""),
        "the health check no longer runs the health verb"
    );
}

/// The environment variable the image sets is the one the CLI reads. An image
/// that exported a name nothing reads would silently start every household's
/// gateway with an empty origin.
#[test]
fn the_origin_environment_variable_is_the_one_the_cli_reads() {
    assert!(dockerfile().contains("CENTRAID_GATEWAY_ORIGIN"));
    assert!(
        cli_source().contains(r#"env = "CENTRAID_GATEWAY_ORIGIN""#),
        "the CLI does not read the variable the image sets"
    );
}

/// THE RUNTIME STAGE IS NOT ROOT, and the directory it declares is the one the
/// command writes to. Either of those being wrong is a container that runs and
/// then loses the household's backup index on the first `docker rm`.
#[test]
fn the_runtime_stage_is_unprivileged_and_declares_the_state_it_keeps() {
    let text = dockerfile();
    assert!(
        text.contains("USER centraid"),
        "the runtime stage runs as root"
    );
    assert!(
        text.contains("WORKDIR /var/lib/centraid"),
        "the working directory is not the state directory"
    );
    assert!(
        text.contains("--data-dir\", \"/var/lib/centraid"),
        "the command writes somewhere other than the declared state directory"
    );
    // A published port, because this gateway listens — unlike `centraid`,
    // whose image deliberately has none.
    assert!(text.contains("EXPOSE 8443"));
}

/// Both `FROM` lines are digest-pinned, matching the posture of the sibling
/// image and of `.github/workflows/**`.
#[test]
fn every_base_image_is_digest_pinned() {
    for line in dockerfile()
        .lines()
        .filter(|line| line.starts_with("FROM "))
    {
        assert!(
            line.contains("@sha256:"),
            "a base image is not digest-pinned: {line}"
        );
    }
}

/// The self-hosting notes and the image agree about what to type. A README
/// whose commands do not run is worse than no README.
#[test]
fn the_self_hosting_notes_name_the_file_they_describe() {
    let notes = std::fs::read_to_string(repository_root().join("deploy/gateway-server/README.md"))
        .expect("the self-hosting notes");
    assert!(notes.contains("deploy/gateway-server/Dockerfile"));
    assert!(notes.contains("CENTRAID_GATEWAY_ORIGIN"));
    // The three reachability shapes the brief names, so none of them is
    // quietly dropped.
    for shape in ["cloudflared", "tailscale funnel", "reverse_proxy"] {
        assert!(notes.contains(shape), "the notes no longer cover {shape}");
    }
    // AND THE Q24 DEFAULT, DOCUMENTED CLEARLY. An owner who turns append-only
    // on is choosing a backup their phones can never prune.
    assert!(
        notes.contains("Append-only is off by default"),
        "the append-only default is not documented"
    );
}
