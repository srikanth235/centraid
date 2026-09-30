//! Generate `include/centraid.h` with cbindgen, and commit it.
//!
//! The header is **committed** rather than generated at build time by the
//! consumer, for one reason: a Swift or Kotlin build that generated it would
//! need cbindgen and a Rust toolchain on every developer's machine, and the
//! header is the one artifact a shell author reads. `tests/header.rs` asserts
//! that regenerating it is a no-op, which is what keeps the committed copy
//! honest.
//!
//! `CENTRAID_WRITE_HEADER=1 cargo build -p centraid-core-ffi` rewrites it.

fn main() {
    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=src/marshal.rs");
    println!("cargo:rerun-if-changed=cbindgen.toml");
    println!("cargo:rerun-if-env-changed=CENTRAID_WRITE_HEADER");
    if std::env::var("CENTRAID_WRITE_HEADER").as_deref() != Ok("1") {
        return;
    }
    let root = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets the manifest directory"),
    );
    match cbindgen::generate(&root) {
        Ok(bindings) => {
            bindings.write_to_file(root.join("include/centraid.h"));
        }
        Err(error) => {
            // A build that could not generate the header still builds: the
            // committed header is the artifact, and `tests/header.rs` is what
            // fails when it is stale.
            println!("cargo:warning=cbindgen did not run: {error}");
        }
    }
}
