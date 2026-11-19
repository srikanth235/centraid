//! A RESTORE LEAVES THE PHONE ABLE TO PAIR (#1202): after a restore onto a phone that was already
//! seeded, the Pair screen opens ready for a code (never "Enter your recovery key first"), for the
//! vault that was in front before, for the restored one brought to the front, and after a relaunch
//! with and without the demo seed. The pairing screen asks whether the vault in front is keyed.
mod vault_support;

use centraid_api_proto::core_v1 as wire;
use centraid_core::vaults::Vaults;
use centraid_screens::pairing;
use centraid_screens::shell;
use centraid_screens::vault::{Restored, files};
use vault_support::*;
use wire::pair_laptop_state::Phase;

/// The Pair screen opened over the vault in front, and the phase it opens in.
fn pairing_phase(phone: &mut Phone) -> Phase {
    let id = phone.driver.push(shell::TAB, pairing::routes::laptop());
    let phase = match &phone.driver.view(id).kind {
        Some(wire::view_state::Kind::PairLaptop(state)) => state.phase,
        other => panic!("not the pairing screen: {other:?}"),
    };
    phone.driver.pop(shell::TAB, id);
    Phase::try_from(phase).expect("a phase")
}

#[test]
fn a_restore_onto_a_seeded_phone_leaves_every_vault_pairable_without_a_reinstall() {
    let dir = scratch();
    let held = lay_down(&dir, "held", "Held");
    let mut phone = Phone::standard(&dir);
    phone.keep_seed();
    phone.record_index(&held, 0);
    phone.launch();
    phone.driver.pump(std::time::Duration::from_millis(800));
    assert_eq!(pairing_phase(&mut phone), Phase::Waiting, "seeded");

    // THE RESTORE LAYS ANOTHER VAULT DOWN, then asks to hold it.
    let restored = lay_down(&dir, "restored", "Restored");
    let path = dir
        .join("restored")
        .join(files::VAULT_FILE)
        .to_string_lossy()
        .into_owned();
    let adopted = phone.adopt_restored(&[Restored {
        path,
        index: 3,
        own: None,
    }]);
    assert_eq!(adopted.value, 1);
    phone.apply(&adopted.writes);
    phone.driver.pump(std::time::Duration::from_millis(800));
    assert_eq!(
        pairing_phase(&mut phone),
        Phase::Waiting,
        "the vault that was in front"
    );
    assert!(phone.shelf.bring_to_front(&restored));
    phone.driver.pump(std::time::Duration::from_millis(800));
    assert_eq!(
        pairing_phase(&mut phone),
        Phase::Waiting,
        "the restored vault"
    );

    // A RELAUNCH, with the demo seed handed again (the keys alone) and without it (the screen too).
    let mut seeded = Phone::on(&dir, Some(SEED));
    seeded.shell = phone.shell.clone();
    seeded.launch();
    assert!(seeded.held(&held).keyed && seeded.held(&restored).keyed);
    let mut again = Phone::standard(&dir);
    again.shell = phone.shell.clone();
    again.launch();
    again.driver.pump(std::time::Duration::from_millis(800));
    assert!(again.held(&held).keyed && again.held(&restored).keyed);
    assert_eq!(pairing_phase(&mut again), Phase::Waiting, "relaunched");
}
