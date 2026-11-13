//! Home and the shelf (#1135, lane H2): what the Rust shelf tells Home, and what
//! Home asks of it. Ports the shelf's side of `HomeSwitchSpec`, `HomeNoVaultSpec`
//! and `HomeNoticeSpec` over the standard runtime and real vaults; Home's own
//! behaviour is `shell_home.rs`.

mod vault_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::vaults::Vaults;
use vault_support::*;
use wire::home_event::Kind as H;
use wire::screen_event::Kind as E;

fn home_of(phone: &Phone) -> u64 {
    phone
        .driver
        .navigation
        .as_ref()
        .expect("navigation")
        .tabs
        .iter()
        .find(|stack| stack.tab == "home")
        .and_then(|stack| stack.entries.first())
        .map(|entry| entry.instance)
        .expect("Home's root")
}

fn state(phone: &Phone) -> wire::HomeState {
    match &phone.driver.view(home_of(phone)).kind {
        Some(wire::view_state::Kind::Home(state)) => (**state).clone(),
        other => panic!("not Home: {other:?}"),
    }
}

fn press(phone: &mut Phone, event: H) -> wire::ScreenUpdate {
    let home = home_of(phone);
    phone
        .driver
        .send(home, E::Home(wire::HomeEvent { kind: Some(event) }))
}

/// Launch the standard runtime and let the shelf tell Home what it holds.
fn launched(phone: &mut Phone) {
    phone.launch();
    phone.driver.pump(Duration::from_millis(800));
}

fn vault_name(phone: &Phone) -> String {
    state(phone)
        .bar
        .and_then(|bar| bar.vault)
        .map(|vault| vault.name)
        .unwrap_or_default()
}

#[test]
fn home_is_told_the_vault_in_front_and_the_roster_by_the_shelf() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "Alpha");
    let _b = lay_down(&dir, "b", "Bravo");
    let mut phone = Phone::standard(&dir);
    launched(&mut phone);
    assert_eq!(vault_name(&phone), "Alpha");
    press(&mut phone, H::Vault(wire::home_event::VaultPressed {}));
    let sheet = state(&phone).sheet.expect("the switcher is open");
    assert_eq!(sheet.active_vault_id, a);
    assert_eq!(
        sheet
            .vaults
            .iter()
            .map(|v| v.name.as_str())
            .collect::<Vec<_>>(),
        ["Alpha", "Bravo"]
    );
}

/// Home's page is the failed state (no vault to read).
fn failed(phone: &Phone) -> bool {
    matches!(
        state(phone).page.and_then(|page| page.state),
        Some(wire::page_state::State::Failed(_))
    )
}

#[test]
fn a_phone_with_no_vault_settles_on_the_failed_branch_not_loading() {
    let dir = scratch();
    let mut phone = Phone::standard(&dir);
    // Not read yet: Home is not told a thing it does not know.
    phone.driver.start();
    assert!(!failed(&phone), "the shelf has not read its directory yet");
    phone.driver.serve(&mut phone.shell);
    phone.driver.pump(Duration::from_millis(800));
    assert!(failed(&phone), "{:?}", state(&phone).page);
    // No vault is a final failure: the first-launch gate is the way on, so there is no Retry.
    let Some(wire::page_state::State::Failed(failure)) =
        state(&phone).page.and_then(|page| page.state)
    else {
        unreachable!("checked above");
    };
    assert!(failure.permanent);
}

#[test]
fn picking_another_vault_switches_the_tabs_and_home_reads_it() {
    let dir = scratch();
    let _a = lay_down(&dir, "a", "Alpha");
    let b = lay_down(&dir, "b", "Bravo");
    let mut phone = Phone::standard(&dir);
    launched(&mut phone);
    let old = home_of(&phone);
    press(&mut phone, H::Vault(wire::home_event::VaultPressed {}));
    let update = press(
        &mut phone,
        H::VaultPicked(wire::home_event::VaultPicked {
            vault_id: b.clone(),
        }),
    );
    // The shell sees an ordinary update, and no `VaultCommand` ever reaches it.
    assert!(update.closed.contains(&old), "the old Home is closed");
    assert!(
        phone.driver.effects.iter().all(|e| !matches!(
            e.effect.as_ref().and_then(|e| e.kind.as_ref()),
            Some(wire::effect::Kind::VaultCommand(_))
        )),
        "the shelf's commands are Rust's"
    );
    assert_ne!(home_of(&phone), old);
    phone.driver.pump(Duration::from_millis(500));
    assert_eq!(phone.holdings().foreground, b);
    assert_eq!(vault_name(&phone), "Bravo");
}

#[test]
fn forgetting_a_vault_from_the_sheet_deletes_it_and_the_next_comes_forward() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "Alpha");
    let b = lay_down(&dir, "b", "Bravo");
    let mut phone = Phone::standard(&dir);
    phone.keep_seed();
    phone.record_index(&a, 0);
    launched(&mut phone);
    press(&mut phone, H::Vault(wire::home_event::VaultPressed {}));
    press(
        &mut phone,
        H::ForgetAsked(wire::home_event::ForgetAsked {
            vault_id: a.clone(),
        }),
    );
    press(
        &mut phone,
        H::AskConfirmed(wire::home_event::AskConfirmed {}),
    );
    // The index goes with the vault: the writes are the shell's to perform.
    phone.driver.serve(&mut phone.shell);
    phone.driver.pump(Duration::from_millis(800));
    assert!(!dir.join("a").exists());
    assert_eq!(phone.ids(), [b]);
    assert_eq!(vault_name(&phone), "Bravo");
    assert!(!phone.shell.device.contains_key(&format!("vault-index.{a}")));
}

#[test]
fn renaming_a_vault_from_the_sheet_writes_its_name_and_home_draws_it() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "Alpha");
    let mut phone = Phone::standard(&dir);
    launched(&mut phone);
    press(&mut phone, H::Vault(wire::home_event::VaultPressed {}));
    press(
        &mut phone,
        H::RenameAsked(wire::home_event::RenameAsked {
            vault_id: a.clone(),
        }),
    );
    press(
        &mut phone,
        H::RenameTyped(wire::home_event::RenameTyped {
            name: "House".to_owned(),
        }),
    );
    press(
        &mut phone,
        H::AskConfirmed(wire::home_event::AskConfirmed {}),
    );
    phone.driver.pump(Duration::from_millis(800));
    assert_eq!(vault_name(&phone), "House");
    assert_eq!(phone.held(&a).name, "House");
}

#[test]
fn making_and_restoring_open_the_words_pages() {
    let dir = scratch();
    let mut phone = Phone::standard(&dir);
    launched(&mut phone);
    for (event, screen) in [
        (H::Make(wire::home_event::MakePressed {}), "words.make"),
        (
            H::Restore(wire::home_event::RestorePressed {}),
            "words.enter",
        ),
    ] {
        phone.driver.effects.clear();
        press(&mut phone, event);
        let opened = phone
            .driver
            .effects
            .iter()
            .find_map(|e| match e.effect.as_ref().and_then(|e| e.kind.as_ref()) {
                Some(wire::effect::Kind::OpenRoute(open)) => open.route.clone(),
                _ => None,
            })
            .expect("a page to push");
        assert_eq!(opened.screen, screen);
    }
}

#[test]
fn the_backup_key_selects_the_backup_tab_the_runtime_registers() {
    let dir = scratch();
    let mut phone = Phone::standard(&dir);
    launched(&mut phone);
    press(&mut phone, H::Backup(wire::home_event::BackupPressed {}));
    assert_eq!(
        phone
            .driver
            .navigation
            .as_ref()
            .expect("navigation")
            .selected_tab,
        "backup"
    );
}

#[test]
fn a_vault_made_says_so_on_homes_sheet_once() {
    let dir = scratch();
    let mut phone = Phone::standard(&dir);
    launched(&mut phone);
    let found = phone.shelf.found(None, "Family");
    assert!(matches!(
        found.value,
        centraid_screens::vault::Found::Made(_)
    ));
    phone.driver.pump(Duration::from_millis(800));
    press(&mut phone, H::Vault(wire::home_event::VaultPressed {}));
    let line = state(&phone).sheet.expect("the sheet").status_line;
    assert!(line.starts_with("Family is on this phone"), "{line}");
}

#[test]
fn the_backup_line_under_the_vault_is_the_backup_lanes_reading_of_it() {
    let dir = scratch();
    lay_down(&dir, "a", "Alpha");
    let mut phone = Phone::standard(&dir);
    launched(&mut phone);
    // No gateway is paired, and the line says so in the backup lane's words.
    let line = state(&phone)
        .bar
        .and_then(|bar| bar.backup)
        .expect("a line under the vault");
    assert_eq!(line.status, "Not backed up. Pair a backup device.");
    assert_eq!(
        line.route.expect("the line leads to pairing").screen,
        "pair.laptop"
    );
    // PRESSING IT LEADS TO PAIRING, not to the Backup place (decided in #1173),
    // and its spoken label is the line itself, which is the action.
    let bar = state(&phone).bar.expect("a bar");
    assert_eq!(
        bar.backup_open_label,
        "Not backed up. Pair a backup device."
    );
    phone.driver.effects.clear();
    press(&mut phone, H::Backup(wire::home_event::BackupPressed {}));
    let opened = phone
        .driver
        .effects
        .iter()
        .find_map(|e| match e.effect.as_ref().and_then(|e| e.kind.as_ref()) {
            Some(wire::effect::Kind::OpenRoute(open)) => open.route.clone(),
            _ => None,
        })
        .expect("a page to push");
    assert_eq!(opened.screen, "pair.laptop");
    // A moved vault says so itself and Home draws no backup line over it.
    let a = phone.holdings().foreground;
    phone.shelf.freeze(&a, "2026-03-14T09:31:00Z", 3);
    phone.driver.pump(Duration::from_millis(800));
    let bar = state(&phone).bar.expect("a bar");
    assert!(bar.backup.is_none());
    assert_eq!(
        bar.vault.expect("the vault").state,
        wire::HomeVaultState::Frozen as i32
    );
}

/// A gateway in the phone's ledger, as a pairing leaves it, and the announcement the core
/// makes after a door that moves the ledger (a forget of nobody still announces).
fn pair_in_the_ledger(phone: &mut Phone, vault: &str, acked_at_ms: Option<u64>) {
    use centraid_vault::backup::state::Gateway;
    let core = phone
        .shelf
        .core_of(vault)
        .expect("the vault's core is open");
    let ledger = core.plane().state().expect("the device state opens");
    let now = u64::try_from(centraid_core::example::now_ms()).expect("a clock");
    let mut row = Gateway::paired(
        "gw-zq".to_owned(),
        vec!["127.0.0.1:8443".to_owned()],
        vec![1, 2, 3],
        "Studio".to_owned(),
        1,
        now,
    );
    row.head_ms = acked_at_ms;
    ledger.put_gateway(&row).expect("the gateway is recorded");
    // What a pass records beside the row: the gateway answered, and acknowledged a head. The
    // pairing's row never carries either (a pairing again keeps what the ledger already knows).
    ledger
        .touch_seen("gw-zq", now)
        .expect("the gateway answered");
    if let Some(at) = acked_at_ms {
        ledger
            .touch_ack("gw-zq", at)
            .expect("the head was acknowledged");
    }
    let _ = core.call(&wire::Request {
        kind: Some(wire::request::Kind::ForgetDestination(
            wire::ForgetDestinationRequest {
                gateway_id: "gw-nobody".to_owned(),
            },
        )),
    });
    phone.driver.pump(Duration::from_millis(800));
}

fn backup_line(phone: &Phone) -> wire::HomeBackupLine {
    state(phone)
        .bar
        .and_then(|bar| bar.backup)
        .expect("a line under the vault")
}

/// HOME'S LINE IS THE BACKUP LANE'S READING, NOT A VALUE TOLD ONCE: it was told when Home
/// opened and when the shelf or a pass woke the service, so a pairing (which wakes neither)
/// left "Not backed up. Pair a backup device." under a vault that Settings and the Backup page
/// already called paired. A move of the ledger is a move of the line.
#[test]
fn the_backup_line_follows_the_ledger_after_a_pairing_and_after_an_acknowledgement() {
    let dir = scratch();
    lay_down(&dir, "a", "Alpha");
    let mut phone = Phone::standard(&dir);
    launched(&mut phone);
    let a = phone.holdings().foreground;
    assert_eq!(
        backup_line(&phone).status,
        "Not backed up. Pair a backup device."
    );

    pair_in_the_ledger(&mut phone, &a, None);
    let line = backup_line(&phone);
    assert_eq!(line.status, "Not backed up yet");
    assert!(
        line.route.is_none(),
        "a paired vault no longer leads to pairing"
    );

    let now = u64::try_from(centraid_core::example::now_ms()).expect("a clock");
    pair_in_the_ledger(&mut phone, &a, Some(now));
    assert!(
        backup_line(&phone).status.starts_with("Backed up")
            || backup_line(&phone).status.starts_with("Backing up"),
        "{:?}",
        backup_line(&phone).status
    );
}

#[test]
fn a_launch_asks_for_the_first_pass_on_the_vaults_it_opened_and_a_restore_for_its_first_snapshot() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "Alpha");
    let mut phone = Phone::standard(&dir);
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
    let adopted = phone
        .shelf
        .adopt_restored(&[centraid_screens::vault::Restored {
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

/// A RESTORE OF A VAULT THAT FOLLOWED STORES OFFERS THE RECONNECT PAGE (#1185), and a vault that
/// followed nothing is not shown an empty one. The offer is a page pushed, never a connect.
#[test]
fn a_restore_offers_the_reconnect_page_only_when_the_vault_followed_stores() {
    use centraid_screens::catalog::act;
    use centraid_screens::field::Keyed;
    let offered = |phone: &Phone| {
        phone.driver.effects.iter().any(|request| {
            matches!(
                request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                Some(wire::effect::Kind::OpenRoute(open))
                    if open.route.as_ref().is_some_and(|r| r.screen == "follow.reconnect")
            )
        })
    };
    let dir = scratch();
    lay_down(&dir, "a", "Alpha");
    let mut phone = Phone::standard(&dir);
    launched(&mut phone);
    let restore = |phone: &mut Phone, name: &str| {
        lay_down(&dir, name, name);
        let path = dir.join(name).join("vault.db");
        phone.driver.effects.clear();
        let adopted = phone
            .shelf
            .adopt_restored(&[centraid_screens::vault::Restored {
                path: path.to_string_lossy().into_owned(),
                index: 0,
                own: None,
            }]);
        assert_eq!(adopted.value, 1);
        phone.driver.pump(Duration::from_millis(800));
    };
    restore(&mut phone, "first");
    assert!(
        !offered(&phone),
        "a vault that followed nothing is not offered the page"
    );
    let told = phone.driver.act(
        act::people::FollowContacts {
            origin: serde_json::json!({"ref": "container:icloud", "label": "iCloud"}).to_string(),
            records: "[]".to_owned(),
            complete: Some(false),
            since: None,
            ..Default::default()
        }
        .request()
        .keyed("arrange:contacts"),
    );
    assert_eq!(
        told.status,
        wire::ActStatus::Executed as i32,
        "{}",
        told.reason
    );
    restore(&mut phone, "second");
    assert!(
        offered(&phone),
        "a vault that followed stores is offered the page"
    );
}
