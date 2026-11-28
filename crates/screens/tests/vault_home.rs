//! Home and the shelf (#1135, lane H2): what the Rust shelf tells Home, and what
//! Home asks of it. Ports the shelf's side of `HomeSwitchSpec`, `HomeNoVaultSpec`
//! and `HomeNoticeSpec` over the standard runtime and real vaults; Home's own
//! behaviour is `shell_home.rs`.

mod vault_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use vault_support::*;

/// Launch the standard runtime and let the shelf tell Home what it holds.
fn launched(phone: &mut Phone) {
    phone.launch();
    phone.driver.pump(Duration::from_millis(800));
}

#[test]
fn a_launch_asks_for_the_first_pass_on_the_vaults_it_opened_and_a_restore_for_its_first_snapshot() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "Alpha");
    let mut phone = Phone::standard(&dir);
    phone.keep_seed();
    launched(&mut phone);
    let drained = |phone: &Phone| {
        phone
            .secrets
            .conductor()
            .take_issued()
            .into_iter()
            .filter(|(_, request)| matches!(request.kind, Some(wire::request::Kind::Drain(_))))
            .count()
    };
    // The pass service ran the pass the shelf asked for, on the vault it opened.
    assert!(
        drained(&phone) >= 1,
        "no pass was asked for after the launch"
    );
    let _ = a;

    // A restore laid a vault down: its first snapshot, now.
    let restored = lay_down(&dir, "restored", "Restored");
    let path = dir.join("restored").join("vault.db");
    let adopted = phone.adopt_restored(&[centraid_screens::vault::Restored {
        path: path.to_string_lossy().into_owned(),
        index: 0,
        own: None,
    }]);
    assert_eq!(adopted.value, 1);
    phone.driver.pump(Duration::from_millis(800));
    assert!(
        drained(&phone) >= 1,
        "no pass was asked for after the restore"
    );
    let _ = restored;
}
