//! Generate the Rust types for both protobuf packages (#1020, D-1020-C5).
//!
//! `protox` parses the `.proto` tree in pure Rust and produces the
//! `FileDescriptorSet`; `prost-build` turns that into Rust. There is
//! deliberately no `protoc` on the path here — the common brief's registry
//! table records that this machine has none, and a build that shells out to a
//! binary nobody installed is a build that works on one laptop.
//!
//! `buf` is NOT in this path either. `buf.gen.yaml` at the repository root is
//! documentation of what the other languages generate; the Rust codegen is this
//! file, so a contributor without `buf` can still build the workspace while
//! `buf lint` / `buf breaking` stay gate steps rather than build steps.

use std::path::PathBuf;

/// Every file in the tree, named rather than globbed: a `.proto` that is not on
/// this list is a file nothing generates from, and a glob would hide that.
/// `tests/tree.rs` asserts the list and the directory agree.
const PROTOS: [&str; 16] = [
    "proto/centraid/core/v1/value.proto",
    "proto/centraid/core/v1/row.proto",
    "proto/centraid/core/v1/command.proto",
    "proto/centraid/core/v1/query.proto",
    "proto/centraid/core/v1/content.proto",
    "proto/centraid/core/v1/change.proto",
    "proto/centraid/core/v1/handshake.proto",
    "proto/centraid/core/v1/pair.proto",
    "proto/centraid/core/v1/admin.proto",
    "proto/centraid/core/v1/error.proto",
    "proto/centraid/core/v1/envelope.proto",
    // The gateway protocol (#1029 §3). It lives in `centraid.core.v1` rather
    // than in a package of its own because core.v1's promise IS this promise —
    // "a gateway's commitment to seats that update on their own schedule" — and
    // a third package would need its own `buf breaking` category in `buf.yaml`
    // to say the same thing twice.
    "proto/centraid/core/v1/gateway.proto",
    "proto/centraid/core/v1/backup.proto",
    "proto/centraid/core/v1/lease.proto",
    // Founding a vault over the ABI (#1029 W5, hand-off 1). Its own file rather
    // than an arm on `command.proto`, because founding is the act that writes
    // the rows the command plane's gate order reads.
    "proto/centraid/core/v1/vault.proto",
    "proto/centraid/screen/v1/screen.proto",
];

fn main() -> Result<(), Box<dyn std::error::Error>> {
    for proto in PROTOS {
        println!("cargo:rerun-if-changed={proto}");
    }
    // A new file in the tree changes the answer of `tests/tree.rs` even when no
    // listed file changed, so the directory is watched too.
    println!("cargo:rerun-if-changed=proto");

    let descriptors = protox::compile(PROTOS, ["proto"])?;

    let out: PathBuf = std::env::var("OUT_DIR")?.into();
    prost_build::Config::new()
        .out_dir(&out)
        .compile_fds(descriptors)?;
    Ok(())
}
