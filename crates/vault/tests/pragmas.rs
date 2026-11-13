//! The durability pragmas (#1191, V18). The list is a function over a target flag, so any machine
//! can assert what an Apple build sets; the real read is gated to the target it is about.

mod common;

use centraid_vault::durability_pragmas;

#[test]
fn apple_targets_set_fullfsync() {
    let apple = durability_pragmas(true);
    for (name, value) in [("fullfsync", "ON"), ("checkpoint_fullfsync", "ON")] {
        assert!(
            apple.contains(&(name, value)),
            "an Apple build sets {name} = {value}: {apple:?}"
        );
    }
    let other = durability_pragmas(false);
    assert!(
        other.iter().all(|(name, _)| !name.contains("fullfsync")),
        "no other target does: {other:?}"
    );
    // Every target keeps the rest of the set.
    for list in [&apple, &other] {
        for pair in [
            ("journal_mode", "wal"),
            ("synchronous", "FULL"),
            ("secure_delete", "ON"),
        ] {
            assert!(list.contains(&pair), "{pair:?} is in {list:?}");
        }
    }
}

/// On an Apple target a founded vault really reads both as 1.
#[cfg(target_vendor = "apple")]
#[test]
fn a_vault_on_an_apple_target_reads_fullfsync_on() {
    let scratch = common::Scratch::founded("pragmas").expect("a vault");
    for pragma in ["fullfsync", "checkpoint_fullfsync"] {
        let value: i64 = scratch
            .vault
            .read(|connection| {
                Ok(connection.query_row(&format!("PRAGMA {pragma}"), [], |r| r.get(0))?)
            })
            .expect("reads");
        assert_eq!(value, 1, "{pragma}");
    }
}

/// On every target the real vault reads the cross-platform set.
#[test]
fn a_founded_vault_reads_the_pragmas_the_list_names() {
    let scratch = common::Scratch::founded("pragmas-real").expect("a vault");
    let sync: i64 = scratch
        .vault
        .read(|connection| Ok(connection.query_row("PRAGMA synchronous", [], |r| r.get(0))?))
        .expect("reads");
    let secure: i64 = scratch
        .vault
        .read(|connection| Ok(connection.query_row("PRAGMA secure_delete", [], |r| r.get(0))?))
        .expect("reads");
    assert_eq!(sync, 2, "synchronous = FULL");
    assert_eq!(secure, 1, "secure_delete = ON");
}
