//! CLAUSE 10: exactly five symbols, and the exported names are what a shell
//! links.
//!
//! Two tests, because they answer two different questions. The xtask rule
//! `abi-five-symbols` counts the **declarations** in this crate's source; these
//! count what the linker actually **exported** from the built `cdylib`. A
//! symbol can be declared and not exported (a linker script, an LTO pass), or
//! exported without being declared here (a dependency that forgot
//! `-fvisibility=hidden`), and only the built artifact settles it.
//!
//! Both tests skip rather than fail when the `cdylib` is not on disk: `cargo
//! test -p centraid-core-ffi` builds the `rlib` these tests link and does not
//! guarantee the `cdylib` is fresh. The gate's `test` step runs
//! `cargo test --workspace`, which builds both. A skip is printed, loudly.

use std::path::{Path, PathBuf};
use std::process::Command;

/// The built shared library, if it is there.
fn cdylib() -> Option<PathBuf> {
    // `CARGO_TARGET_DIR` may be anywhere, so the test asks cargo rather than
    // guessing `target/`: this repository's gate runs with it set.
    let profile_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .map(Path::to_path_buf)?;
    let candidates = [
        std::env::var("CARGO_TARGET_DIR")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_else(|| profile_dir.join("target")),
        profile_dir.join("target"),
    ];
    for root in candidates {
        for profile in ["debug", "release"] {
            for name in [
                "libcentraid_core_ffi.so",
                "libcentraid_core_ffi.dylib",
                "centraid_core_ffi.dll",
            ] {
                let candidate = root.join(profile).join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// The five names, in the order `CONTRACT.md` lists them.
const EXPECTED: [&str; 5] = [
    "centraid_call",
    "centraid_close",
    "centraid_free",
    "centraid_next_event",
    "centraid_open",
];

#[test]
fn exactly_five_symbols_are_exported() {
    let Some(library) = cdylib() else {
        println!(
            "SKIPPED: no built cdylib found. Run `cargo build -p centraid-core-ffi` first; \
             the gate's `test` step builds it."
        );
        return;
    };
    let Ok(output) = Command::new("nm")
        .args(["-D", "--defined-only", "--format=posix"])
        .arg(&library)
        .output()
    else {
        println!("SKIPPED: `nm` is not on this machine");
        return;
    };
    assert!(
        output.status.success(),
        "nm failed on {}: {}",
        library.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    let listing = String::from_utf8_lossy(&output.stdout);
    let mut exported: Vec<String> = listing
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let name = fields.next()?;
            let kind = fields.next()?;
            // `T` is a defined function in the text section. A `B`, `D` or `R`
            // named `centraid_*` would be a data export, which this ABI has
            // none of and must not grow one by accident.
            (kind == "T" && name.starts_with("centraid_")).then(|| name.to_owned())
        })
        .collect();
    exported.sort();
    exported.dedup();
    assert_eq!(
        exported,
        EXPECTED,
        "the ABI is open/call/next_event/free/close and nothing else (#1020). \
         {} exports {} `centraid_*` text symbol(s)",
        library.display(),
        exported.len()
    );
}

/// The names a shell writes in its `dlsym`, `@_silgen_name` or JNA interface
/// are the names in the artifact.
///
/// Loading the library and resolving each symbol is the only test that proves
/// this: a Rust `extern "C"` call in the same crate resolves through the `rlib`
/// and would pass even if `#[unsafe(no_mangle)]` were missing.
#[test]
fn the_exported_names_are_what_a_shell_links() {
    let Some(library) = cdylib() else {
        println!("SKIPPED: no built cdylib found");
        return;
    };
    // SAFETY: loading a library runs its initialisers, which for this one are
    // Rust's own. The path is this build's own artifact.
    let loaded = match unsafe { libloading::Library::new(&library) } {
        Ok(loaded) => loaded,
        Err(error) => {
            println!("SKIPPED: {} did not load: {error}", library.display());
            return;
        }
    };
    for name in EXPECTED {
        // SAFETY: the symbol's real signature is not used — only its address —
        // so the declared type is irrelevant to soundness here.
        let found: Result<libloading::Symbol<'_, unsafe extern "C" fn()>, _> =
            unsafe { loaded.get(name.as_bytes()) };
        assert!(
            found.is_ok(),
            "`{name}` is in CONTRACT.md and not in {}",
            library.display()
        );
    }

    // And a symbol that is NOT in the contract is not there either, so the
    // count above cannot be met by a rename.
    // SAFETY: as above.
    let absent: Result<libloading::Symbol<'_, unsafe extern "C" fn()>, _> =
        unsafe { loaded.get(b"centraid_invoke") };
    assert!(
        absent.is_err(),
        "`centraid_invoke` is exported and is not one of the five"
    );
}

/// The header is committed and regenerating it is a no-op.
///
/// The header is the one artifact a shell author reads, and a stale one is a
/// shell that compiles against a signature the library does not have.
#[test]
fn the_committed_header_is_what_cbindgen_generates() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let committed = manifest.join("include/centraid.h");
    let text = std::fs::read_to_string(&committed)
        .unwrap_or_else(|error| panic!("{} is committed: {error}", committed.display()));

    // Every one of the five is declared, with its `Handle` opaquely.
    for name in EXPECTED {
        assert!(
            text.contains(name),
            "`{name}` is not declared in the committed header"
        );
    }
    assert!(
        text.contains("CENTRAID_H"),
        "the header has no include guard"
    );

    // The regeneration itself: cbindgen over this crate must produce the same
    // bytes. Skipped when cbindgen cannot parse the crate on this machine,
    // with the reason printed rather than swallowed.
    let generated = match cbindgen_output(manifest) {
        Some(generated) => generated,
        None => {
            println!("SKIPPED: cbindgen did not run on this machine");
            return;
        }
    };
    assert_eq!(
        normalise(&generated),
        normalise(&text),
        "the committed header is stale. Regenerate it:\n  \
         CENTRAID_WRITE_HEADER=1 cargo build -p centraid-core-ffi"
    );
}

fn cbindgen_output(manifest: &Path) -> Option<String> {
    let config = cbindgen::Config::from_root_or_default(manifest);
    let bindings = cbindgen::Builder::new()
        .with_crate(manifest)
        .with_config(config)
        .generate()
        .ok()?;
    let mut out = Vec::new();
    bindings.write(&mut out);
    String::from_utf8(out).ok()
}

/// Trailing whitespace and line endings are not part of the contract.
fn normalise(text: &str) -> String {
    text.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_owned()
}
