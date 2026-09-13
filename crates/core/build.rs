//! THE IDENTITY STAMP (#1020 Artifacts, D-1020-G2).
//!
//! Every prebuilt artifact carries the git sha and the artifact digest it was
//! built from, so a shell can refuse one that is not the core this tree
//! produced. The values arrive as environment variables from the release
//! workflow (`CENTRAID_BUILD_GIT_SHA`, `CENTRAID_BUILD_DIGEST` — the digest is
//! `cargo xtask artifact-key`'s output) and are baked in here.
//!
//! **A local build is marked `dev`, loudly, and is not an error.** A developer
//! building on a laptop has no release digest, and a build script that failed
//! without one would make `cargo build` depend on a release pipeline. What must
//! never happen is the other direction: a `dev` artifact silently passing for a
//! released one. That is why the marker is the literal string `dev` rather than
//! an empty value or a plausible-looking hash — `centraid --version --json`
//! prints it, `deploy/vps/install.sh` compares it against the release's
//! `identity.json`, and a mismatch is an abort.
//!
//! This file is deliberately tiny and has no dependencies: a build script is
//! compiled before the crate and charged to every clean build.

fn main() {
    // Without these, a change to an environment variable would not rebuild the
    // crate and the stamp would be whatever the last build saw — the exact
    // class of staleness this mechanism exists to catch.
    println!("cargo:rerun-if-env-changed=CENTRAID_BUILD_GIT_SHA");
    println!("cargo:rerun-if-env-changed=CENTRAID_BUILD_DIGEST");

    for (variable, stamp) in [
        ("CENTRAID_BUILD_GIT_SHA", "CENTRAID_STAMP_GIT_SHA"),
        ("CENTRAID_BUILD_DIGEST", "CENTRAID_STAMP_DIGEST"),
    ] {
        let value = std::env::var(variable).unwrap_or_default();
        let value = value.trim();
        let value = if value.is_empty() { "dev" } else { value };
        println!("cargo:rustc-env={stamp}={value}");
    }
}
