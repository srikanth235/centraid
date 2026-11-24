//! WHAT THE BACKUP SCREEN READS OF EACH GATEWAY, AGAINST REAL GATEWAYS (#1209 wave 3b,
//! `contracts/backup/spec.md` §6.2 step 1 and §6.6).
//!
//! | Case | What it proves |
//! |---|---|
//! | [`a_gateway_whose_head_went_backwards_reads_as_rolled_back_until_a_new_head_is_confirmed`] | F1: a gateway restored from an older data directory is flagged on its row; the next confirmed head clears it |
//! | [`a_full_gateway_is_named_while_the_other_is_fed`] | F3: a refusal is named by its reason at the gateway that gave it, and the other still receives the pass |
//! | [`a_refusal_is_read_as_the_reason_the_gateway_gave`] | a size limit is named as its own reason, not as a full disk |
//!
//! Assertions are on counts and rows, never on how long anything took.

mod common;

use std::path::Path;

use centraid_api_proto::core_v1 as wire;
use serde_json::json;

use common::*;

fn row<'a>(status: &'a wire::BackupStatusResponse, id: &str) -> &'a wire::Destination {
    status
        .destinations
        .iter()
        .find(|row| row.gateway_id == id)
        .unwrap_or_else(|| panic!("no row for {id} in {status:?}"))
}

fn id_of(phone: &centraid_core::Handle, gateway: &Gateway) -> String {
    pair(phone, gateway)
        .destination
        .expect("a destination")
        .gateway_id
}

fn photo(phone: &centraid_core::Handle, label: &str, size: usize) {
    let bytes = bytes_of(label, size);
    let staged = stage(phone, owned("image/heic", &bytes), &bytes);
    add_asset(phone, &staged, "photo");
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("a directory");
    for entry in std::fs::read_dir(from).expect("lists") {
        let entry = entry.expect("an entry");
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).expect("copies");
        }
    }
}

/// The gateway's data directory put back as it was when `older` was copied, served at the
/// address it had: a machine restored from yesterday's backup.
fn roll_back(gateway: Gateway, older: &Path) -> Gateway {
    let Gateway {
        runtime: asleep,
        dir,
        spawned,
    } = gateway;
    let addr = spawned.addr;
    asleep.block_on(spawned.shutdown());
    drop(asleep);
    for entry in std::fs::read_dir(dir.path()).expect("lists") {
        let path = entry.expect("an entry").path();
        if path.is_dir() {
            std::fs::remove_dir_all(path).expect("removes");
        } else {
            std::fs::remove_file(path).expect("removes");
        }
    }
    copy_dir(older, dir.path());
    let runtime = runtime();
    let spawned = runtime
        .block_on(centraid_gateway::server::harness::spawn_on(
            dir.path(),
            addr,
        ))
        .expect("the older gateway starts where it was");
    Gateway {
        runtime,
        dir,
        spawned,
    }
}

#[test]
fn a_gateway_whose_head_went_backwards_reads_as_rolled_back_until_a_new_head_is_confirmed() {
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let (steady, shaky) = (gateway(), gateway());
    let (steady_id, shaky_id) = (id_of(&phone, &steady), id_of(&phone, &shaky));
    photo(&phone, "a photograph before yesterday", 40_000);
    drain(&phone, at_home());

    // YESTERDAY'S DATA DIRECTORY, copied while the gateway sat idle.
    let shaky = shaky.restart();
    let yesterday = tempfile::tempdir().expect("a directory");
    copy_dir(shaky.dir.path(), yesterday.path());

    // TODAY the phone moves both heads on.
    command(
        &phone,
        "note.create",
        &json!({ "title": "Tides", "body": "high at six", "format": "plain" }),
        "note:tides",
    );
    let today = drain(&phone, at_home());
    assert_eq!(today.stopped, wire::DrainStop::Empty as i32, "{today:?}");
    let path = phone.path().to_owned();
    assert!(
        !row(&status(&phone), &shaky_id).rolled_back,
        "a gateway that kept up is not rolled back"
    );

    // THE MACHINE IS RESTORED FROM YESTERDAY, and is full, so the pass that finds its head gone
    // backwards cannot mend it. Nothing is claimed before a pass reads the head.
    let shaky = roll_back(shaky, yesterday.path());
    assert!(!row(&status(&phone), &shaky_id).rolled_back);
    shaky.spawned.fill_disk(true);
    let found = drain(&phone, at_home());
    assert_eq!(found.stopped, wire::DrainStop::Refused as i32, "{found:?}");
    let backwards = status(&phone);
    assert!(row(&backwards, &shaky_id).rolled_back, "{backwards:?}");
    assert!(
        !row(&backwards, &steady_id).rolled_back,
        "only the gateway that went backwards"
    );
    assert!(
        state(&path)
            .gateway(&shaky_id)
            .expect("reads")
            .expect("paired")
            .regressed
    );

    // A NEW HEAD CONFIRMED THERE CLEARS IT.
    shaky.spawned.fill_disk(false);
    let mended = drain(&phone, quietly());
    assert_eq!(mended.stopped, wire::DrainStop::Empty as i32, "{mended:?}");
    let after = status(&phone);
    assert!(!row(&after, &shaky_id).rolled_back, "{after:?}");
    assert_eq!(
        row(&after, &shaky_id).reach_state,
        wire::DestinationReach::Ok as i32
    );
    assert!(
        conf_of(&path, &shaky_id).is_some(),
        "a head is confirmed again"
    );
}

#[test]
fn a_full_gateway_is_named_while_the_other_is_fed() {
    let (first, second) = (gateway(), gateway());
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let (one, two) = (id_of(&phone, &first), id_of(&phone, &second));
    photo(&phone, "a photograph for a full disk", 60_000);

    second.spawned.fill_disk(true);
    let drained = drain(&phone, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Refused as i32,
        "{drained:?}"
    );
    assert!(!first.held(&vault_id()).is_empty(), "the first is fed");
    assert!(
        second.held(&vault_id()).is_empty(),
        "the full one took nothing"
    );
    assert!(
        conf_of(phone.path(), &one).is_some(),
        "records are confirmed at the first"
    );
    let behind = status(&phone);
    assert_eq!(
        row(&behind, &two).reach,
        wire::WaitReason::Refused as i32,
        "{behind:?}"
    );
    assert_eq!(
        row(&behind, &two).reach_state,
        wire::DestinationReach::Refused as i32
    );
    assert_eq!(
        row(&behind, &one).reach,
        wire::WaitReason::Unspecified as i32,
        "the other is not named"
    );
    assert_eq!(
        row(&behind, &one).reach_state,
        wire::DestinationReach::Ok as i32
    );
    assert!(
        waiting(&behind, wire::WaitReason::Refused) > 0,
        "{:?}",
        behind.waiting
    );

    // ROOM MADE, the next pass feeds it and the name goes.
    second.spawned.fill_disk(false);
    let moved = drain(&phone, quietly());
    assert_eq!(moved.stopped, wire::DrainStop::Empty as i32, "{moved:?}");
    let backed = status(&phone);
    assert_eq!(backed.content_confirmed, backed.content_total, "{backed:?}");
    assert_eq!(
        row(&backed, &two).reach,
        wire::WaitReason::Unspecified as i32,
        "{backed:?}"
    );
}

#[test]
fn a_refusal_is_read_as_the_reason_the_gateway_gave() {
    let (first, second) = (gateway(), gateway());
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let (one, two) = (id_of(&phone, &first), id_of(&phone, &second));
    photo(&phone, "a photograph for a size limit", 60_000);

    second.spawned.refuse_as_too_large(true);
    let drained = drain(&phone, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Refused as i32,
        "{drained:?}"
    );
    let refused = status(&phone);
    assert_eq!(
        row(&refused, &two).reach,
        wire::WaitReason::TooLarge as i32,
        "a size limit is its own reason, not a full disk: {refused:?}"
    );
    assert_eq!(
        row(&refused, &one).reach,
        wire::WaitReason::Unspecified as i32
    );
    assert!(
        waiting(&refused, wire::WaitReason::TooLarge) > 0,
        "{:?}",
        refused.waiting
    );
    assert_eq!(waiting(&refused, wire::WaitReason::Refused), 0);
}

#[test]
fn a_paired_gateway_with_no_snapshot_is_not_backed_up() {
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let gw = gateway();
    let id = id_of(&phone, &gw);

    let before = status(&phone);
    let dest = row(&before, &id);
    assert!(
        dest.classes.iter().all(|c| !c.backed_up),
        "no class may be backed_up before a snapshot is confirmed: {:?}",
        dest.classes
    );
    assert!(
        before.classes.iter().all(|c| !c.backed_up),
        "aggregate classes must not be backed_up before a snapshot is confirmed: {:?}",
        before.classes
    );
}

#[test]
fn read_back_damage_drives_repairing_until_repaired() {
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let gw = gateway();
    let id = id_of(&phone, &gw);
    photo(&phone, "a photograph for read-back damage", 40_000);
    let first = drain(&phone, at_home());
    assert_eq!(first.stopped, wire::DrainStop::Empty as i32, "{first:?}");
    assert_eq!(
        row(&status(&phone), &id).reach_state,
        wire::DestinationReach::Ok as i32
    );

    // Corrupt every object held on the gateway so the next read-back is guaranteed to find damage.
    let vault = vault_id();
    for name in gw.held(&vault) {
        gw.spawned
            .corrupt(
                &vault,
                &centraid_gateway::rules::ids::Name::from_bytes(*name.as_bytes()),
            )
            .expect("a bit flips");
    }
    let found = drain(&phone, quietly());
    assert_eq!(found.stopped, wire::DrainStop::Empty as i32, "{found:?}");
    let after_damage = status(&phone);
    assert_eq!(
        row(&after_damage, &id).reach_state,
        wire::DestinationReach::Repairing as i32,
        "read-back damage must drive DestinationReach::Repairing: {after_damage:?}"
    );
    assert!(
        !row(&after_damage, &id).rolled_back,
        "damage is not rolled_back"
    );

    // The next pass repairs the damaged objects and clears Repairing back to Ok.
    let repaired = drain(&phone, quietly());
    assert_eq!(
        repaired.stopped,
        wire::DrainStop::Empty as i32,
        "{repaired:?}"
    );
    let after_repair = status(&phone);
    assert_eq!(
        row(&after_repair, &id).reach_state,
        wire::DestinationReach::Ok as i32,
        "clean repair must clear DestinationReach::Repairing: {after_repair:?}"
    );
}
