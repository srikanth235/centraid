//! The binding spike, host half: build `spike/spike.c` with `cc` and run it.
//!
//! A test rather than a script, so it runs in the gate and rots visibly rather
//! than silently (#1020, D-1020-D2-7).
//!
//! **These are `ci-linux-x64-4c` numbers.** The spike's purpose is to fix the
//! ABI's *shape* before three shells are written against it: a shape that needed
//! a sixth symbol, or a per-call allocation a shell could not free, would show
//! here. The *numbers* are a floor — a phone's are wave 3 lane E's, and the
//! device half (cinterop on iOS, JNA on Android, the Swift wrapper) is an owner
//! hand-off.
//!
//! Run it on its own, printing the JSON:
//!
//! ```text
//! cargo test -p centraid-core-ffi --test spike -- --nocapture
//! ```

use std::path::{Path, PathBuf};
use std::process::Command;

use centraid_api_proto::core_v1 as wire;
use prost::Message as _;

/// The directory the `cdylib` is in.
fn library_dir() -> Option<PathBuf> {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2)?;
    let roots = [
        std::env::var("CARGO_TARGET_DIR")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_else(|| repo.join("target")),
        repo.join("target"),
    ];
    for root in roots {
        for profile in ["debug", "release"] {
            let candidate = root.join(profile);
            if candidate.join("libcentraid_core_ffi.so").is_file()
                || candidate.join("libcentraid_core_ffi.dylib").is_file()
            {
                return Some(candidate);
            }
        }
    }
    None
}

#[test]
fn the_c_harness_crosses_the_abi_ten_thousand_times() {
    let Some(library_dir) = library_dir() else {
        println!(
            "SKIPPED: no built cdylib. Run `cargo build -p centraid-core-ffi` first; \
             the gate's `test` step builds it."
        );
        return;
    };
    if Command::new("cc").arg("--version").output().is_err() {
        println!("SKIPPED: no `cc` on this machine");
        return;
    }

    let scratch = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&scratch).expect("the directory is made");

    // The request bytes are written HERE and read by the harness, so the C
    // side needs no protobuf library. A spike that made the shell author link
    // protobuf in C would be testing a binding nobody ships.
    let request = wire::Envelope {
        request_id: 0,
        body: Some(wire::envelope::Body::Request(wire::Request {
            kind: Some(wire::request::Kind::Page(wire::PageRequest {
                query: Some(wire::PageQuery {
                    name: "spike".to_owned(),
                    select: vec!["party_id".to_owned(), "created_at".to_owned()],
                    from: "core_party".to_owned(),
                    r#where: None,
                    bind: Vec::new(),
                    order: Some(wire::PageOrder {
                        sort_column: "created_at".to_owned(),
                        pk_column: "party_id".to_owned(),
                        descending: false,
                    }),
                }),
                limit: 100,
                after: None,
            })),
        })),
    }
    .encode_to_vec();
    let request_path = scratch.join("request.bin");
    std::fs::write(&request_path, &request).expect("the request writes");

    // A vault with rows in it, so the page is a real page. Founded through the
    // Rust surface: founding is not part of the ABI and the spike measures the
    // ABI.
    let vault_path = scratch.join("spike-vault.db");
    {
        let handle = centraid_core::Core::open(centraid_core::CoreConfig::gateway(&vault_path))
            .expect("a core opens");
        handle
            .with_vault(|vault| {
                vault.found("Spike", "Owner")?;
                // Through the real command plane; `sql-confinement` refuses SQL
                // in this crate, and the rows are better for it.
                let registry = centraid_vault::commands::Registry::with_system_commands()?;
                let principal = centraid_vault::Principal::owner("spike-device");
                for index in 0..200 {
                    vault.execute(
                        &registry,
                        &principal,
                        &centraid_vault::commands::Command::new(
                            "core.add_party",
                            serde_json::json!({
                                "display_name": format!("Party {index}"),
                                "kind": "person"
                            }),
                        ),
                    )?;
                }
                Ok(())
            })
            .expect("the rows seed");
        handle.close();
    }

    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("spike/spike.c");
    let binary = scratch.join("spike");
    let compile = Command::new("cc")
        .arg("-O2")
        .arg("-Wall")
        .arg("-Wextra")
        .arg(&source)
        .arg(format!("-L{}", library_dir.display()))
        .arg("-lcentraid_core_ffi")
        .arg("-o")
        .arg(&binary)
        .output()
        .expect("cc runs");
    assert!(
        compile.status.success(),
        "the C harness did not compile — which is itself a finding about the ABI's shape:\n{}",
        String::from_utf8_lossy(&compile.stderr)
    );
    // `-Wall -Wextra` clean, because a warning on a five-line declaration set is
    // a warning every shell author will see.
    let warnings = String::from_utf8_lossy(&compile.stderr);
    assert!(
        !warnings.contains("warning:"),
        "the C harness compiles with warnings:\n{warnings}"
    );

    let run = Command::new(&binary)
        .arg(&vault_path)
        .arg(&request_path)
        .env("LD_LIBRARY_PATH", &library_dir)
        .output()
        .expect("the harness runs");
    let out = String::from_utf8_lossy(&run.stdout);
    let err = String::from_utf8_lossy(&run.stderr);
    assert!(
        run.status.success(),
        "the C harness failed:\nstdout: {out}\nstderr: {err}"
    );
    println!("binding spike — C harness (ci-linux-x64-4c):\n{out}");

    let measured: serde_json::Value =
        serde_json::from_str(out.trim()).expect("the harness prints JSON");
    assert_eq!(measured["calls"], 10_000);
    assert!(
        measured["callsPerSecond"].as_f64().unwrap_or(0.0) > 0.0,
        "no throughput was measured"
    );
    // A bounded read across the ABI answers real bytes, so a spike that
    // measured an empty answer cannot pass.
    assert!(
        measured["answerBytesMean"].as_f64().unwrap_or(0.0) > 100.0,
        "the answers were suspiciously small; the page may have been empty"
    );

    let _ = std::fs::remove_dir_all(&scratch);
}

/// The event path's throughput, through the C entry point.
///
/// Neither out-of-process harness can measure this: nothing in them produces an
/// event, so both report `events: 0` — which is a real measurement of the
/// timeout path (CONTRACT.md clause 6, and both harnesses would crash if a
/// timeout allocated) and not a measurement of a drain. The producer has to be
/// on this side of the boundary, so the drain is measured here, still through
/// `centraid_next_event` rather than through the core's Rust surface.
#[test]
fn the_event_path_drains_through_the_abi() {
    use centraid_core_ffi::{CENTRAID_OK, centraid_free, centraid_next_event, centraid_open};

    let scratch = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&scratch).expect("the directory is made");
    let config = format!(
        r#"{{"path":{:?},"role":"gateway","create":true}}"#,
        scratch.join("vault.db").display().to_string()
    );
    let mut handle: *mut centraid_core::Handle = std::ptr::null_mut();
    // SAFETY: `config` lives for the call and `handle` is a live local.
    assert_eq!(
        unsafe { centraid_open(config.as_ptr(), config.len(), &raw mut handle) },
        CENTRAID_OK
    );

    // Fill the queue to its cap. One event per table, so nothing coalesces
    // away and the count is the count.
    // SAFETY: the handle is live.
    let queue = unsafe { &*handle }.events();
    let filled = centraid_core::EVENT_QUEUE_CAP;
    for index in 0..filled {
        assert!(queue.push(wire::Event {
            kind: Some(wire::event::Kind::Change(wire::ChangeEvent {
                table: format!("t{index}"),
                pk_set: vec![wire::RecordKey {
                    values: vec![wire::Value {
                        kind: Some(wire::value::Kind::Text(format!("k{index}"))),
                    }],
                }],
                commit_seq: index as u64,
            })),
        }));
    }

    let mut drained = 0_usize;
    let started = std::time::Instant::now();
    loop {
        let mut buf: *mut u8 = std::ptr::null_mut();
        let mut len: usize = 0;
        // SAFETY: live handle, live out-pointers.
        let code = unsafe { centraid_next_event(handle, 1, &raw mut buf, &raw mut len) };
        if code != CENTRAID_OK {
            break;
        }
        drained += 1;
        // SAFETY: `buf`/`len` are what the call reported; freed exactly once.
        unsafe { centraid_free(buf, len) };
        if drained > filled * 2 {
            break;
        }
    }
    let elapsed = started.elapsed();
    let per_second = if elapsed.as_secs_f64() > 0.0 {
        drained as f64 / elapsed.as_secs_f64()
    } else {
        0.0
    };
    println!(
        "binding spike — event path through the ABI (ci-linux-x64-4c): \
         {drained} event(s) in {:.1}ms · {per_second:.0} events/s",
        elapsed.as_secs_f64() * 1_000.0
    );
    assert!(
        drained >= filled,
        "every accepted event came out: {drained} of {filled}"
    );

    // SAFETY: the handle came from `centraid_open` and is closed once.
    unsafe { centraid_core_ffi::centraid_close(handle) };
    let _ = std::fs::remove_dir_all(&scratch);
}
