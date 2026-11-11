//! THE RECONNECT PAGE (#1185): after a restore the vault holds the stores another phone
//! followed, this phone follows none of them, and the page offers each one, never connecting
//! by itself. The shell's part is played here: it answers the keychain habits, the folder
//! listing and the reads.

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::field::Keyed;
use centraid_screens::testing::Driver;
use centraid_screens::{Registry, Runtime, follow, imports};
use wire::effect::Kind as F;
use wire::effect_result::Outcome as O;

const SEEDED_AT: i64 = 1_760_000_000_000;

fn rig(with_follower: bool) -> Driver {
    let secrets = centraid_screens::custody::secrets::VaultSecrets::new();
    let registry = Registry::default()
        .merge(imports::registry(&secrets))
        .merge(follow::registry());
    // The folder follower is a service beside the page: the page tells it which folder was picked.
    let mut tabs = vec![("reconnect".to_owned(), follow::reconnect::route())];
    if with_follower {
        tabs.extend(imports::roots());
    }
    let runtime = Runtime::new(registry, tabs);
    Driver::with_runtime_at(runtime, SEEDED_AT)
}

fn arrange(d: &Driver, request: impl Into<wire::ActRequest>, key: &str) {
    let told = d.act(request.into().keyed(format!("arrange:{key}")));
    assert_eq!(
        told.status,
        wire::ActStatus::Executed as i32,
        "{}",
        told.reason
    );
}

/// A vault another phone followed: an address book account and a folder.
fn restored(with_follower: bool) -> Driver {
    let mut d = rig(with_follower);
    arrange(
        &d,
        act::people::FollowContacts {
            origin: serde_json::json!({"ref": "container:icloud", "label": "iCloud"}).to_string(),
            records: "[]".to_owned(),
            complete: Some(false),
            since: None,
        },
        "contacts",
    );
    let made = d.act(
        act::docs::CreateFolder {
            title: "Taxes".to_owned(),
            ..Default::default()
        }
        .request()
        .keyed("arrange:docs-folder".to_owned()),
    );
    assert_eq!(
        made.status,
        wire::ActStatus::Executed as i32,
        "{}",
        made.reason
    );
    let folder = serde_json::from_slice::<serde_json::Value>(&made.output).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    arrange(
        &d,
        act::shell::FollowFiles {
            origin: serde_json::json!({"ref": "folder:abc", "label": "Taxes", "fills": folder})
                .to_string(),
            records: "[]".to_owned(),
            complete: Some(false),
        },
        "files",
    );
    d.start();
    d
}

fn page(d: &Driver) -> wire::TransferView {
    let root = d.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
    match &d.view(root).kind {
        Some(wire::view_state::Kind::Transfer(view)) => view.clone(),
        other => panic!("not the transfer view: {other:?}"),
    }
}

fn root(d: &Driver) -> u64 {
    d.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance
}

fn answer(d: &mut Driver, outcome: impl FnOnce(&F) -> O) {
    let request = d.effects.remove(0);
    let outcome = outcome(
        request
            .effect
            .as_ref()
            .and_then(|e| e.kind.as_ref())
            .unwrap(),
    );
    d.send(
        request.instance,
        wire::screen_event::Kind::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(outcome),
        }),
    );
}

fn no_habit(effect: &F) -> O {
    match effect {
        F::Keychain(_) => O::Keychain(wire::KeychainValue {
            found: false,
            value: Vec::new(),
        }),
        F::FoldersRead(_) => O::FoldersListing(wire::FoldersListing {
            complete: true,
            device_id: "new-phone".to_owned(),
            folders: Vec::new(),
        }),
        // The camera roll service opens beside the folder follower and asks its own question.
        F::LibraryPermission(_) => O::Done(wire::EffectDone {}),
        other => panic!("not a check: {other:?}"),
    }
}

/// The checks the page asks on opening, answered as a phone that follows nothing would.
fn opened_on_a_new_phone() -> Driver {
    opened(false)
}

fn opened(with_follower: bool) -> Driver {
    let mut d = restored(with_follower);
    while !d.effects.is_empty() {
        answer(&mut d, no_habit);
    }
    d
}

fn keys(view: &wire::TransferView) -> Vec<String> {
    view.rows.iter().map(|row| row.key.clone()).collect()
}

#[test]
fn the_page_offers_each_store_the_vault_followed_and_connects_none() {
    let d = opened_on_a_new_phone();
    let view = page(&d);
    assert!(!view.busy);
    assert_eq!(view.rows.len(), 2, "{:?}", keys(&view));
    assert!(
        view.rows
            .iter()
            .all(|row| row.tappable && row.value == "Connect")
    );
    let labels: Vec<&str> = view.rows.iter().map(|row| row.label.as_str()).collect();
    assert_eq!(labels, ["Phone contacts", "Taxes folder"]);
    // Nothing was read and no permission asked: the page only looked.
    assert!(d.effects.is_empty());
}

#[test]
fn a_store_this_phone_already_follows_or_paused_is_not_offered() {
    let mut d = restored(false);
    // The contacts habit exists (followed or paused: the phone's own word); the folder is reachable.
    answer(&mut d, |_| {
        O::Keychain(wire::KeychainValue {
            found: true,
            value: b"paused".to_vec(),
        })
    });
    answer(&mut d, |_| {
        O::FoldersListing(wire::FoldersListing {
            complete: true,
            device_id: "this".to_owned(),
            folders: vec![wire::FolderListed {
                origin: "folder:abc".to_owned(),
                label: "Taxes".to_owned(),
                files: Vec::new(),
            }],
        })
    });
    let view = page(&d);
    assert!(view.rows.is_empty());
    assert_eq!(view.headline, "Nothing to reconnect");
}

#[test]
fn a_vault_that_followed_nothing_has_nothing_to_reconnect() {
    let mut d = rig(false);
    d.start();
    assert!(d.effects.is_empty());
    let view = page(&d);
    assert!(view.rows.is_empty());
    assert_eq!(view.headline, "Nothing to reconnect");
    assert!(!d.with_ctx(follow::reconnect::vault_followed_stores));
}

#[test]
fn connecting_contacts_is_the_import_that_asks_the_phone_and_then_the_row_goes() {
    let mut d = opened_on_a_new_phone();
    let instance = root(&d);
    d.send(
        instance,
        wire::screen_event::Kind::Transfer(wire::TransferEvent {
            key: "contacts".to_owned(),
        }),
    );
    // The existing import: the read that may ask the OS for its permission.
    let asked = d.effects.remove(0);
    let Some(F::ContactsRead(read)) = asked.effect.and_then(|e| e.kind) else {
        panic!("the contacts import reads the address book");
    };
    assert!(read.ask_permission);
    d.send(
        asked.instance,
        wire::screen_event::Kind::EffectResult(wire::EffectResult {
            effect_id: asked.effect_id,
            outcome: Some(O::Contacts(wire::ContactsSnapshot {
                complete: true,
                device_id: "new-phone".to_owned(),
                containers: vec![wire::PhoneContactContainer {
                    key: "icloud".to_owned(),
                    name: "iCloud".to_owned(),
                }],
                contacts: Vec::new(),
            })),
        }),
    );
    // The habit that says this phone follows is written, and the row is gone.
    assert!(
        d.effects
            .iter()
            .any(|request| matches!(request.effect.as_ref().and_then(|e| e.kind.as_ref()), Some(F::Keychain(op)) if op.op == wire::keychain_op::Op::Set as i32))
    );
    assert_eq!(keys(&page(&d)).len(), 1);
}

#[test]
fn connecting_a_folder_opens_the_picker_and_retires_the_old_origin_of_that_folder() {
    let mut d = opened(true);
    let docs_folders = |d: &Driver| {
        d.with_ctx(|ctx| {
            match centraid_screens::kit::read::read(
                ctx,
                centraid_screens::catalog::load::shell::FilesFollowed::default(),
                |answer| match answer {
                    wire::app_query_response::Answer::ImportsFilesHeld(held) => Some(held.folders),
                    _ => None,
                },
            ) {
                centraid_screens::kit::read::Reading::Data(folders) => folders,
                other => panic!("unreadable: {other:?}"),
            }
        })
    };
    let earlier = docs_folders(&d);
    assert_eq!(earlier.len(), 1);
    assert!(!earlier[0].docs_folder.is_empty());
    let instance = root(&d);
    let folder_key = keys(&page(&d))
        .into_iter()
        .find(|key| key.starts_with("folder:"))
        .expect("a folder row");
    d.send(
        instance,
        wire::screen_event::Kind::Transfer(wire::TransferEvent { key: folder_key }),
    );
    let asked = d.effects.remove(0);
    assert!(matches!(
        asked.effect.as_ref().and_then(|e| e.kind.as_ref()),
        Some(F::FollowFolder(_))
    ));
    d.send(
        asked.instance,
        wire::screen_event::Kind::EffectResult(wire::EffectResult {
            effect_id: asked.effect_id,
            outcome: Some(O::FolderFollowed(wire::FolderFollowed {
                origin: "folder:new".to_owned(),
                name: "Taxes".to_owned(),
            })),
        }),
    );
    assert_eq!(keys(&page(&d)), ["contacts"]);
    // The old origin is retired: the vault no longer lists `folder:abc`.
    let listed = d.with_ctx(|ctx| {
        match centraid_screens::kit::read::read(
            ctx,
            centraid_screens::catalog::load::shell::FollowedStores::default(),
            |answer| match answer {
                wire::app_query_response::Answer::FollowedStores(held) => Some(held.stores),
                _ => None,
            },
        ) {
            centraid_screens::kit::read::Reading::Data(stores) => stores,
            other => panic!("unreadable: {other:?}"),
        }
    });
    assert!(listed.iter().all(|store| store.origin_ref != "folder:abc"));
    // The new origin fills the Docs folder the old one filled: no second folder is made.
    let now = docs_folders(&d);
    assert_eq!(now.len(), 1);
    assert_eq!(now[0].origin_ref, "folder:new");
    assert_eq!(now[0].docs_folder, earlier[0].docs_folder);
}
