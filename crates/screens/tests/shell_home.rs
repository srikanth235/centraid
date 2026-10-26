//! Home, the springboard, through the door a shell uses: eight tiles read through
//! their apps' own queries, graded as a whole, with the vaults the shell tells it
//! about. Ports the cases of the KMP `HomeMachineSpec`, `SpringboardPolicySpec`,
//! `HomeReadsSpec` and the tile specs over a real vault; every sentence is Rust's.

use centraid_api_proto::core_v1 as wire;
use centraid_screens::shell;
use centraid_screens::testing::Driver;
use wire::home_event::Kind as H;
use wire::screen_event::Kind as E;

fn started() -> (Driver, u64) {
    let mut d = Driver::with_runtime(shell::runtime());
    d.start();
    let root = d.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
    (d, root)
}

fn state(d: &Driver, i: u64) -> wire::HomeState {
    match &d.view(i).kind {
        Some(wire::view_state::Kind::Home(state)) => (**state).clone(),
        other => panic!("not Home: {other:?}"),
    }
}

fn data(d: &Driver, i: u64) -> wire::HomeData {
    match state(d, i).content {
        Some(wire::home_state::Content::Data(data)) => *data,
        other => panic!("not data: {other:?}"),
    }
}

fn tell(d: &mut Driver, i: u64, event: H) -> wire::ScreenUpdate {
    d.send(i, E::Home(wire::HomeEvent { kind: Some(event) }))
}

fn vault(id: &str, name: &str) -> wire::ShellVault {
    wire::ShellVault {
        vault_id: id.to_owned(),
        name: name.to_owned(),
        state: wire::HomeVaultState::Online as i32,
        ..Default::default()
    }
}

fn told(front: &wire::ShellVault, all: &[wire::ShellVault]) -> H {
    H::VaultsTold(wire::home_event::VaultsTold {
        vault: Some(front.clone()),
        vaults: all.to_vec(),
        none: false,
    })
}

fn tile<'a>(data: &'a wire::HomeData, app: &str) -> &'a wire::HomeTile {
    data.tiles
        .iter()
        .find(|tile| tile.app_id == app)
        .unwrap_or_else(|| panic!("no {app} tile"))
}

#[test]
fn home_is_the_root_of_the_home_tab_and_reads_every_app_in_the_grid_order() {
    let (d, i) = started();
    let nav = d.navigation.as_ref().unwrap();
    assert_eq!(nav.selected_tab, "home");
    assert_eq!(nav.tabs.len(), 1);
    let data = data(&d, i);
    let order: Vec<&str> = data.tiles.iter().map(|t| t.app_id.as_str()).collect();
    assert_eq!(
        order,
        [
            "photos", "docs", "agenda", "notes", "money", "health", "people", "locker"
        ]
    );
    // Every tile names its app, says how to open it and carries where a tap goes.
    for tile in &data.tiles {
        assert!(!tile.name.is_empty(), "{} has no name", tile.app_id);
        assert_eq!(tile.open_label, format!("Open {}", tile.name));
        assert!(tile.accessibility_label.starts_with(&tile.open_label));
        let route = tile.route.as_ref().expect("a tile opens its app");
        assert!(
            route.screen.starts_with(&format!("{}.", tile.app_id)),
            "{} opens {}",
            tile.app_id,
            route.screen
        );
    }
    // The rows follow the policy: a wide tile alone, small ones in twos.
    let rows: Vec<Vec<&str>> = data
        .grid_rows
        .iter()
        .map(|row| row.app_ids.iter().map(String::as_str).collect())
        .collect();
    assert_eq!(
        rows,
        vec![
            vec!["photos"],
            vec!["docs", "notes"],
            vec!["agenda"],
            vec!["money", "health"],
            vec!["people", "locker"],
        ]
    );
    assert!(!data.every_tile_unreadable);
}

#[test]
fn the_seeded_vault_fills_the_tiles_and_a_count_agrees_with_its_noun() {
    let (d, i) = started();
    let data = data(&d, i);
    assert_eq!(
        data.springboard,
        wire::HomeSpringboard::Content as i32,
        "{:?}",
        data.tiles
            .iter()
            .map(|t| (t.app_id.clone(), t.status))
            .collect::<Vec<_>>()
    );
    let mut content = 0;
    for tile in &data.tiles {
        if tile.status == wire::HomeTileStatus::Content as i32 {
            content += 1;
            assert!(
                tile.body.is_some(),
                "{} is content with no body",
                tile.app_id
            );
        }
        // A tile that reports a count words it, plural at zero and at many.
        if let Some(count) = tile.count {
            let said = format!("{} {}", count.value, tile.count_label);
            if tile.status == wire::HomeTileStatus::Content as i32 && !count.capped {
                assert!(
                    tile.accessibility_label.ends_with(&said),
                    "{:?} vs {said}",
                    tile.accessibility_label
                );
            }
        }
    }
    assert!(
        content >= 4,
        "the example scenario fills several apps: {content}"
    );
    // Notes' tile names its newest note, and a count is the notes the library holds.
    let notes = tile(&data, "notes");
    let Some(wire::home_tile_body::Kind::Notes(body)) =
        notes.body.as_ref().and_then(|b| b.kind.as_ref())
    else {
        panic!("the notes tile has no notes body: {notes:?}");
    };
    assert!(!body.title.is_empty());
    // Locker is empty in the example (no Locker), and says what to do.
    let locker = tile(&data, "locker");
    assert_eq!(locker.status, wire::HomeTileStatus::Empty as i32);
    assert_eq!(locker.empty_copy, "Unlock to see your items");
    assert_eq!(locker.count.map(|c| c.value), Some(0));
    assert_eq!(locker.count_label, "items");
}

#[test]
fn a_phone_with_no_vault_is_a_failed_home_with_no_empty_tiles() {
    let (mut d, i) = started();
    tell(
        &mut d,
        i,
        H::VaultsTold(wire::home_event::VaultsTold {
            none: true,
            ..Default::default()
        }),
    );
    let home = state(&d, i);
    let Some(wire::home_state::Content::Failure(failure)) = home.content else {
        panic!("expected a failure: {home:?}");
    };
    assert_eq!(failure.sentence, "No vault is open.");
    // The lockup still says which vault failed: none.
    assert_eq!(home.bar.unwrap().vault.unwrap().name, "No vault yet");
}

#[test]
fn a_phone_with_no_vault_opens_onto_the_first_launch_gate_and_its_doors_make_and_restore() {
    let (mut d, i) = started();
    assert!(state(&d, i).first_launch.is_none());
    tell(
        &mut d,
        i,
        H::VaultsTold(wire::home_event::VaultsTold {
            none: true,
            ..Default::default()
        }),
    );
    let gate = state(&d, i).first_launch.expect("the gate is drawn");
    assert_eq!(
        gate.body,
        "Apps and an assistant on this phone, backed up to your own devices."
    );
    assert_eq!(
        (gate.make_label.as_str(), gate.restore_label.as_str()),
        ("Get started", "Restore backup")
    );
    // THE HOUSE IS HOME'S ROSTER: every tile's app, in Home's order.
    assert_eq!(
        gate.apps,
        shell::policy::ORDER
            .iter()
            .map(|a| (*a).to_owned())
            .collect::<Vec<_>>()
    );
    assert_eq!(gate.slides.len(), 3);
    assert!(!gate.next_label.is_empty() && !gate.skip_label.is_empty());
    for (event, wanted) in [
        (
            H::Make(wire::home_event::MakePressed {}),
            wire::vault_command::Kind::Make(true),
        ),
        (
            H::Restore(wire::home_event::RestorePressed {}),
            wire::vault_command::Kind::Restore(true),
        ),
    ] {
        d.effects.clear();
        tell(&mut d, i, event);
        let asked = d
            .effects
            .last()
            .and_then(|e| e.effect.as_ref())
            .and_then(|e| e.kind.as_ref());
        assert_eq!(
            asked,
            Some(&wire::effect::Kind::VaultCommand(wire::VaultCommand {
                kind: Some(wanted)
            }))
        );
    }
    // A vault made: the gate goes.
    let founded = vault("v1", "Personal");
    tell(&mut d, i, told(&founded, std::slice::from_ref(&founded)));
    assert!(state(&d, i).first_launch.is_none());
}

#[test]
fn the_lockup_is_worded_from_the_vault_the_shell_names() {
    let (mut d, i) = started();
    let personal = vault("v1", "Personal");
    tell(
        &mut d,
        i,
        told(&personal, &[personal.clone(), vault("v2", "House")]),
    );
    let bar = state(&d, i).bar.unwrap();
    let front = bar.vault.unwrap();
    assert_eq!(
        (front.name.as_str(), front.initial.as_str()),
        ("Personal", "P")
    );
    assert_eq!(front.state_line, "On this phone");
    assert_eq!(bar.search_label, "Search everything");
    assert_eq!(bar.search_route, Some(shell::routes::search()));
    assert_eq!(bar.switch_spoken, "Switch vault");
    // The backup line is shown as given, for a vault that has not moved.
    tell(
        &mut d,
        i,
        H::BackupTold(wire::home_event::BackupLineTold {
            line: Some(wire::HomeBackupLine {
                status: "Backed up".to_owned(),
                ..Default::default()
            }),
        }),
    );
    assert_eq!(
        state(&d, i).bar.unwrap().backup.unwrap().status,
        "Backed up"
    );
    // A vault that moved says so itself, and the backup line steps aside.
    let moved = wire::ShellVault {
        state: wire::HomeVaultState::Frozen as i32,
        ..personal.clone()
    };
    tell(&mut d, i, told(&moved, std::slice::from_ref(&moved)));
    let bar = state(&d, i).bar.unwrap();
    assert!(bar.backup.is_none());
    assert_eq!(bar.vault.unwrap().state_line, "Moved to your other phone");
}

#[test]
fn the_switcher_lists_the_roster_as_told_and_picking_another_vault_asks_the_shelf() {
    let (mut d, i) = started();
    let (a, b) = (vault("v1", "Personal"), vault("v2", "House"));
    tell(&mut d, i, told(&a, &[a.clone(), b.clone()]));
    assert!(state(&d, i).sheet.is_none());
    tell(&mut d, i, H::Vault(wire::home_event::VaultPressed {}));
    let sheet = state(&d, i).sheet.expect("the sheet opens");
    assert_eq!(sheet.title, "Vaults");
    assert_eq!(sheet.active_vault_id, "v1");
    assert_eq!(
        sheet
            .vaults
            .iter()
            .map(|v| v.name.as_str())
            .collect::<Vec<_>>(),
        ["Personal", "House"]
    );
    assert!(sheet.one_line.is_empty());
    // Choosing the open vault is a dismissal and nothing else.
    d.effects.clear();
    tell(
        &mut d,
        i,
        H::VaultPicked(wire::home_event::VaultPicked {
            vault_id: "v1".into(),
        }),
    );
    assert!(state(&d, i).sheet.is_none());
    assert!(d.effects.is_empty());
    // Choosing another asks the shelf to switch, and shuts the sheet at once.
    tell(&mut d, i, H::Vault(wire::home_event::VaultPressed {}));
    tell(
        &mut d,
        i,
        H::VaultPicked(wire::home_event::VaultPicked {
            vault_id: "v2".into(),
        }),
    );
    assert!(state(&d, i).sheet.is_none());
    let effect = d
        .effects
        .last()
        .and_then(|e| e.effect.as_ref())
        .and_then(|e| e.kind.as_ref());
    assert!(
        matches!(effect, Some(wire::effect::Kind::VaultCommand(wire::VaultCommand { kind: Some(wire::vault_command::Kind::SwitchTo(id)) })) if id == "v2"),
        "{effect:?}"
    );
}

#[test]
fn a_single_vault_keeps_its_sentence_and_a_delete_is_confirmed_in_words() {
    let (mut d, i) = started();
    let only = vault("v1", "Personal");
    tell(&mut d, i, told(&only, std::slice::from_ref(&only)));
    tell(&mut d, i, H::Vault(wire::home_event::VaultPressed {}));
    assert_eq!(
        state(&d, i).sheet.unwrap().one_line,
        "This phone has one vault."
    );
    tell(
        &mut d,
        i,
        H::ForgetAsked(wire::home_event::ForgetAsked {
            vault_id: "v1".into(),
        }),
    );
    let ask = state(&d, i).sheet.unwrap().ask.expect("a question");
    let Some(wire::home_vault_ask::Kind::Forget(forget)) = ask.kind else {
        panic!("not a delete");
    };
    assert_eq!(forget.title, "Delete Personal?");
    assert_eq!(forget.confirm_label, "Delete");
    assert_eq!(forget.cancel_label, "Cancel");
    // Dismissing asks nothing of the shelf.
    d.effects.clear();
    tell(
        &mut d,
        i,
        H::AskDismissed(wire::home_event::AskDismissed {}),
    );
    assert!(state(&d, i).sheet.unwrap().ask.is_none());
    assert!(d.effects.is_empty());
    // Confirming does, and shuts the sheet.
    tell(
        &mut d,
        i,
        H::ForgetAsked(wire::home_event::ForgetAsked {
            vault_id: "v1".into(),
        }),
    );
    tell(
        &mut d,
        i,
        H::AskConfirmed(wire::home_event::AskConfirmed {}),
    );
    assert!(state(&d, i).sheet.is_none());
    assert!(matches!(
        d.effects.last().and_then(|e| e.effect.as_ref()).and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::VaultCommand(wire::VaultCommand { kind: Some(wire::vault_command::Kind::Forget(id)) })) if id == "v1"
    ));
}

#[test]
fn a_rename_needs_a_name_and_a_refusal_is_worded() {
    let (mut d, i) = started();
    let only = vault("v1", "Personal");
    tell(&mut d, i, told(&only, std::slice::from_ref(&only)));
    tell(&mut d, i, H::Vault(wire::home_event::VaultPressed {}));
    tell(
        &mut d,
        i,
        H::RenameAsked(wire::home_event::RenameAsked {
            vault_id: "v1".into(),
        }),
    );
    let rename = |d: &Driver| match state(d, i).sheet.unwrap().ask.unwrap().kind.unwrap() {
        wire::home_vault_ask::Kind::Rename(rename) => rename,
        other => panic!("{other:?}"),
    };
    assert_eq!(rename(&d).title, "Rename vault");
    assert_eq!(rename(&d).name, "Personal");
    // Cleared, it cannot be saved and confirming sends nothing.
    tell(
        &mut d,
        i,
        H::RenameTyped(wire::home_event::RenameTyped { name: "  ".into() }),
    );
    assert!(!rename(&d).can_save);
    d.effects.clear();
    tell(
        &mut d,
        i,
        H::AskConfirmed(wire::home_event::AskConfirmed {}),
    );
    assert!(d.effects.is_empty());
    assert!(state(&d, i).sheet.unwrap().ask.is_some());
    // Typed, it saves the trimmed name.
    tell(
        &mut d,
        i,
        H::RenameTyped(wire::home_event::RenameTyped {
            name: " House ".into(),
        }),
    );
    tell(
        &mut d,
        i,
        H::AskConfirmed(wire::home_event::AskConfirmed {}),
    );
    assert!(matches!(
        d.effects.last().and_then(|e| e.effect.as_ref()).and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::VaultCommand(wire::VaultCommand { kind: Some(wire::vault_command::Kind::Rename(r)) })) if r.name == "House" && r.vault_id == "v1"
    ));
}

#[test]
fn a_different_vault_in_front_reads_the_tiles_again_and_the_first_lockup_does_not() {
    let (mut d, i) = started();
    let a = vault("v1", "Personal");
    // The first lockup is not a switch: the tiles that landed stay.
    let before = state(&d, i);
    tell(&mut d, i, told(&a, std::slice::from_ref(&a)));
    assert_eq!(state(&d, i).content, before.content);
    // The same vault again (a gateway changed) moves only the lockup.
    tell(&mut d, i, told(&a, std::slice::from_ref(&a)));
    assert_eq!(state(&d, i).content, before.content);
    // Another vault in front re-reads, with the sheet shut.
    tell(&mut d, i, H::Vault(wire::home_event::VaultPressed {}));
    let b = vault("v2", "House");
    tell(&mut d, i, told(&b, &[a, b.clone()]));
    let after = state(&d, i);
    assert!(after.sheet.is_none());
    assert!(matches!(
        after.content,
        Some(wire::home_state::Content::Data(_))
    ));
}

#[test]
fn the_appearance_key_follows_the_phone_then_holds_the_other_scheme_in_the_keychain() {
    let (mut d, i) = started();
    // Opening asks the Keychain for what was chosen.
    let ask = d
        .effects
        .last()
        .and_then(|e| e.effect.as_ref())
        .and_then(|e| e.kind.as_ref());
    assert!(
        matches!(ask, Some(wire::effect::Kind::Keychain(op)) if op.key == "appearance" && op.op == wire::keychain_op::Op::Get as i32)
    );
    tell(
        &mut d,
        i,
        H::PhoneSchemeTold(wire::home_event::PhoneSchemeTold { dark: false }),
    );
    let bar = state(&d, i).bar.unwrap();
    assert_eq!(
        (bar.appearance_icon.as_str(), bar.appearance_label.as_str()),
        ("Moon", "Switch to dark")
    );
    assert_eq!(state(&d, i).scheme, wire::HomeScheme::System as i32);
    d.effects.clear();
    tell(
        &mut d,
        i,
        H::Appearance(wire::home_event::AppearancePressed {}),
    );
    let home = state(&d, i);
    assert_eq!(home.scheme, wire::HomeScheme::Dark as i32);
    assert_eq!(home.bar.unwrap().appearance_icon, "Sun");
    assert!(matches!(
        d.effects.last().and_then(|e| e.effect.as_ref()).and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::Keychain(op)) if op.value == b"dark".to_vec() && op.op == wire::keychain_op::Op::Set as i32
    ));
    // The stored choice comes back from the Keychain as an effect result.
    let id = d.effects.last().unwrap().effect_id;
    let _ = id;
    d.answer_effect(wire::effect_result::Outcome::Keychain(
        wire::KeychainValue {
            found: true,
            value: b"light".to_vec(),
        },
    ));
    assert_eq!(state(&d, i).scheme, wire::HomeScheme::Light as i32);
}

#[test]
fn the_backup_door_selects_the_backup_tab_when_it_exists_and_does_nothing_when_it_does_not() {
    // Without a backup tab nothing moves.
    let (mut d, i) = started();
    let before = d.navigation.as_ref().unwrap().revision;
    tell(&mut d, i, H::Backup(wire::home_event::BackupPressed {}));
    assert_eq!(d.navigation.as_ref().unwrap().revision, before);
    // With one, the runtime selects it and the shell hears a new navigation.
    let registry = shell::registry(&centraid_screens::custody::secrets::VaultSecrets::new()).with(
        centraid_screens::proof::NAME,
        centraid_screens::proof::build,
    );
    let runtime = centraid_screens::Runtime::new(
        registry,
        vec![
            ("home".to_owned(), shell::routes::home()),
            ("backup".to_owned(), centraid_screens::proof::route()),
        ],
    )
    .with_band(shell::band::view);
    let mut d = Driver::with_runtime(runtime);
    d.start();
    let i = d.navigation.as_ref().unwrap().tabs[0].entries[0].instance;
    assert_eq!(d.navigation.as_ref().unwrap().selected_tab, "home");
    tell(&mut d, i, H::Backup(wire::home_event::BackupPressed {}));
    let nav = d.navigation.as_ref().unwrap();
    assert_eq!(nav.selected_tab, "backup");
    let band = nav.band.as_ref().expect("a band");
    assert_eq!(
        band.tabs
            .iter()
            .map(|t| (t.tab.as_str(), t.selected))
            .collect::<Vec<_>>(),
        [("home", false), ("backup", true)]
    );
    assert!(d.effects.iter().all(|e| !matches!(
        e.effect.as_ref().and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::SelectTab(_))
    )));
}

#[test]
fn a_stranded_write_ribbon_is_shown_and_its_door_goes_where_it_says() {
    let (mut d, i) = started();
    tell(
        &mut d,
        i,
        H::StatusTold(wire::home_event::StatusTold {
            status: Some(wire::HomeStatus {
                tone: wire::HomeTone::Attention as i32,
                copy: "Storage is low".into(),
                action: "Free up space".into(),
                destination: wire::home_status::Destination::Phone as i32,
                ..Default::default()
            }),
        }),
    );
    let ribbon = state(&d, i).status.unwrap();
    assert_eq!(ribbon.copy, "Storage is low");
    assert_eq!(ribbon.accessibility_label, "Storage is low. Free up space");
    tell(&mut d, i, H::Status(wire::home_event::StatusPressed {}));
    assert!(matches!(
        d.effects.last().and_then(|e| e.effect.as_ref()).and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::VaultCommand(wire::VaultCommand { kind: Some(wire::vault_command::Kind::Open(dest)) }))
            if *dest == wire::home_status::Destination::Phone as i32
    ));
}

#[test]
fn two_vaults_sharing_a_name_are_still_two_vaults_and_an_unnamed_lockup_compares_by_name() {
    let (mut d, i) = started();
    let first = vault("v1", "Personal");
    tell(&mut d, i, told(&first, std::slice::from_ref(&first)));
    // The sheet is open so a reload (which shuts it) is visible.
    tell(&mut d, i, H::Vault(wire::home_event::VaultPressed {}));
    let twin = vault("v2", "Personal");
    tell(&mut d, i, told(&twin, &[first.clone(), twin.clone()]));
    assert!(
        state(&d, i).sheet.is_none(),
        "another id is a switch even under the same name"
    );
    // With no ids a lockup is compared by name: the same name is the same vault...
    let (mut d, i) = started();
    let bare = vault("", "Personal");
    tell(&mut d, i, told(&bare, std::slice::from_ref(&bare)));
    tell(&mut d, i, H::Vault(wire::home_event::VaultPressed {}));
    tell(&mut d, i, told(&bare, std::slice::from_ref(&bare)));
    assert!(state(&d, i).sheet.is_some());
    // ...and another name is another vault.
    let other = vault("", "House");
    tell(&mut d, i, told(&other, std::slice::from_ref(&other)));
    assert!(state(&d, i).sheet.is_none());
}

#[test]
fn founding_a_vault_leaves_the_failed_home_and_reads_the_tiles() {
    let (mut d, i) = started();
    tell(
        &mut d,
        i,
        H::VaultsTold(wire::home_event::VaultsTold {
            none: true,
            ..Default::default()
        }),
    );
    assert!(matches!(
        state(&d, i).content,
        Some(wire::home_state::Content::Failure(_))
    ));
    // A pull or a foreground while there is no vault stays failed.
    d.send(i, E::Appeared(wire::Appeared {}));
    tell(&mut d, i, H::Shown(wire::home_event::Shown {}));
    assert!(matches!(
        state(&d, i).content,
        Some(wire::home_state::Content::Failure(_))
    ));
    let founded = vault("v1", "Personal");
    tell(&mut d, i, told(&founded, std::slice::from_ref(&founded)));
    let data = data(&d, i);
    assert_eq!(data.tiles.len(), 8);
}

#[test]
fn a_dismissal_carries_no_id_changes_no_vault_and_asks_the_shelf_nothing() {
    let (mut d, i) = started();
    let a = vault("v1", "Personal");
    tell(&mut d, i, told(&a, std::slice::from_ref(&a)));
    tell(&mut d, i, H::Vault(wire::home_event::VaultPressed {}));
    d.effects.clear();
    tell(
        &mut d,
        i,
        H::VaultPicked(wire::home_event::VaultPicked {
            vault_id: String::new(),
        }),
    );
    assert!(state(&d, i).sheet.is_none());
    assert!(d.effects.is_empty());
    // Pressing the lockup asks for nothing either.
    tell(&mut d, i, H::Vault(wire::home_event::VaultPressed {}));
    assert!(d.effects.is_empty());
}

#[test]
fn home_reads_again_when_a_table_a_tile_read_moves_with_no_pull_and_no_gesture() {
    use centraid_screens::catalog::act;
    use centraid_screens::field::Keyed;
    let (mut d, i) = started();
    let notes = |d: &Driver| tile(&data(d, i), "notes").count.expect("a count").value;
    let before = notes(&d);
    let response = d.act(
        wire::ActRequest::from(act::notes::CreateNote {
            title: "Added from another surface".to_owned(),
            body: "A note the Notes tile has not heard of".to_owned(),
            ..Default::default()
        })
        .keyed("home-reload-1"),
    );
    assert_eq!(
        response.status,
        wire::ActStatus::Executed as i32,
        "{}",
        response.reason
    );
    // The change event reaches Home through the tables its tiles recorded.
    d.pump(std::time::Duration::from_secs(2));
    assert_eq!(notes(&d), before + 1, "the Notes tile moved on its own");
}

/// THE SEAM THE HUE CORPUS CANNOT SEE (`crates/design/tests/corpus.rs` holds every
/// row of the wheel): both native Home views turn a face's hue key into a colour
/// role. A hue spelled in one shell and forgotten in the other draws nothing on
/// Compose and traps on SwiftUI, and neither failure looks like a missing token.
/// This reads the SOURCE, because the Swift half has no other enforcer on a
/// machine with no Xcode. (Ported from the shared module's `PartyHueWheelSpec`.)
#[test]
fn both_native_home_views_name_all_eight_hue_roles_and_the_solved_foreground() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let views = [
        "mobile/iosApp/Sources/HomeView.swift",
        "mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/HomeScreen.kt",
    ];
    for view in views {
        let source = std::fs::read_to_string(root.join(view)).expect("a native Home view");
        for key in centraid_design::IDENTITY_HUE_KEYS {
            let role = format!("c{}{}", key[..1].to_uppercase(), &key[1..]);
            assert!(source.contains(&role), "{view} never names {role}");
        }
        // And the solved foreground, without which a saturated disc keeps the ink
        // that failed contrast on it.
        assert!(source.contains("textInv"), "{view} never names textInv");
    }
}

#[test]
fn an_outside_entry_is_answered_with_the_route_and_the_shell_names_no_screen() {
    use wire::home_event::entry_asked::Entry;
    for (entry, screen) in [
        (Entry::LockerLock, "locker.lock"),
        (Entry::HealthConnect, "health.connect"),
    ] {
        let (mut d, i) = started();
        let before = d.effects.len();
        tell(
            &mut d,
            i,
            H::EntryAsked(wire::home_event::EntryAsked {
                entry: entry as i32,
            }),
        );
        let routes: Vec<_> = d.effects[before..]
            .iter()
            .filter_map(|e| match e.effect.as_ref()?.kind.as_ref()? {
                wire::effect::Kind::OpenRoute(open) => {
                    open.route.as_ref().map(|r| r.screen.clone())
                }
                _ => None,
            })
            .collect();
        assert_eq!(routes, [screen], "{entry:?}");
    }
}

#[test]
fn the_lockups_spoken_sentences_are_finished_by_rust() {
    let (mut d, i) = started();
    let front = vault("v1", "Personal");
    tell(&mut d, i, told(&front, std::slice::from_ref(&front)));
    // No backup line: the vault's own state line stands in the sentence.
    let bar = state(&d, i).bar.unwrap();
    let state_line = bar.vault.as_ref().unwrap().state_line.clone();
    assert_eq!(
        bar.switch_label,
        format!("Personal, {state_line}. {}", bar.switch_spoken)
    );
    assert_eq!(bar.backup_open_label, "");
    // A backup line replaces the state line, and is a door of its own.
    tell(
        &mut d,
        i,
        H::BackupTold(wire::home_event::BackupLineTold {
            line: Some(wire::HomeBackupLine {
                status: "Backed up today".into(),
                tone: wire::HomeTone::Quiet as i32,
                accessibility_label: "Backed up today".into(),
            }),
        }),
    );
    let bar = state(&d, i).bar.unwrap();
    assert_eq!(bar.switch_label, format!("Personal. {}", bar.switch_spoken));
    assert_eq!(
        bar.backup_open_label,
        format!("Backed up today. {}", bar.backup_open_spoken)
    );
}
