//! THE PHONE'S BACKUP PLANE, THROUGH THE CORE'S OWN DOORS, AGAINST A REAL GATEWAY
//! (#1080 "The phone core", #1209 `contracts/backup/spec.md` §6).
//!
//! Every case here drives `Handle::call` (the arms `centraid_call` reaches) against
//! `centraid_gateway::server::harness`: the gateway a member runs, TLS and SQLite and object
//! files included, on `127.0.0.1:0`. Nothing below the socket is faked, and nothing above the
//! core's doors is assumed. **Assertions are on counts** (objects committed, calls asked, bytes
//! sent), never on how long anything took (R8).
//!
//! | Case | What it proves |
//! |---|---|
//! | [`a_pass_backs_up_a_vault_to_two_gateways_and_they_hold_only_ciphertext`] | C2: one pass feeds two gateways the same objects, each committed once; an idle pass moves nothing; the gateways hold no plaintext, no plaintext hash and no key |
//! | [`a_cut_connection_mid_bundle_resends_at_most_the_cut_chunk`] | C2: a bundle cut inside a frame leaves every finished frame committed, and the next pass sends no more than what is missing |
//! | [`the_members_rule_decides_each_class_and_video_originals_never_cross_a_metered_link`] | the rule per class: records only on a tap, photos on cellular only when allowed, a video original never on a metered link |
//! | [`a_library_item_is_asked_for_streamed_through_the_stage_door_and_backed_up`] | C2/C3: nothing is sealed at import; `need_bytes` asks, the stage door seals into staging, the next pass confirms, staging is released |
//! | [`a_library_film_larger_than_staging_backs_up_a_window_at_a_time`] | staging is a budget: a film of three chunks through a staging area of one goes a window per round, and never stages more than its ceiling |
//! | [`os_bundle_files_are_uploaded_by_the_os_and_only_wake_a_pass`] | §6.5, R7: the pass names bundle files, the OS uploads them, and nothing is confirmed until a pass re-reads the head |
//! | [`a_gateway_older_than_this_build_is_told_to_be_updated`] | C1: protocol below the required one is `too_old`, `DRAIN_STOP_TOO_OLD` and `DESTINATION_REACH_GATEWAY_OLD` |
//! | [`held_whole_names_the_gateways_that_hold_an_original_and_says_none_before_the_pass`] | R4: the delete warning's read |
//! | [`a_gateway_that_moved_is_found_again_by_its_identity_and_only_by_it`] | `refresh_destination` (Q-1080-D3) |
//! | [`forgetting_a_gateway_revokes_this_phones_token_there`] | `forget_destination` revokes first |
//! | [`a_machine_that_is_not_the_pinned_gateway_is_untrusted_and_a_damaged_copy_is_damaged`] | a flipped bit is `DAMAGED`, another machine is `UNTRUSTED` |

mod common;

use std::collections::BTreeSet;

use centraid_api_proto::core_v1 as wire;
use centraid_media::sealed::{self, CHUNK_BYTES, Class, Name};

use common::*;

/// The sealed names of `plaintext`'s chunks as class `class`, under the test keys.
fn names_of(class: Class, plaintext: &[u8]) -> Vec<Name> {
    plaintext
        .chunks(CHUNK_BYTES)
        .map(|chunk| sealed::name_of(&keys().backup, class, chunk))
        .collect()
}

/// A `photo.add` of an owned original of `size` bytes, labelled `label`.
fn owned_photo(phone: &centraid_core::Handle, label: &str, size: usize) -> Vec<u8> {
    let bytes = bytes_of(label, size);
    let staged = stage(phone, owned("image/heic", &bytes), &bytes);
    add_asset(phone, &staged, "photo");
    bytes
}

/// What the gateway committed, by name: each object once.
fn committed(gateway: &Gateway) -> usize {
    gateway.spawned.commit_order().len()
}

#[test]
fn a_pass_backs_up_a_vault_to_two_gateways_and_they_hold_only_ciphertext() {
    let (one, two) = (gateway(), gateway());
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &one);
    pair(&phone, &two);

    let photo = owned_photo(&phone, "a photograph the app holds", CHUNK_BYTES + 700_000);
    let photo_handle = stage(&phone, owned("image/heic", &photo), &photo);
    let thumb = bytes_of("its thumbnail", 6_000);
    stage(&phone, thumb_of(&photo_handle, &thumb), &thumb);
    let still = bytes_of("a photograph the library holds", 150_001);
    let still_handle = stage(
        &phone,
        library("image/heic", "lib-still", &still, false),
        &still,
    );
    add_asset(&phone, &still_handle, "photo");

    // THE FIRST PASS: the records and the app's own bytes. The library item was only hashed at
    // import (nothing is sealed there), so the pass asks the shell for it.
    let first = drain(&phone, at_home());
    assert_eq!(first.stopped, wire::DrainStop::Empty as i32, "{first:?}");
    assert_eq!(first.need_bytes.len(), 1, "{first:?}");
    assert_eq!(first.need_bytes[0].os_ref, "lib-still");
    assert_eq!(first.need_bytes[0].size, still.len() as u64);
    assert_eq!(
        waiting(&status(&phone), wire::WaitReason::Bytes),
        1,
        "the library item waits for the shell"
    );

    // THE SHELL STREAMS IT, and the stage door seals its chunk into staging.
    stage(
        &phone,
        library("image/heic", "lib-still", &still, false),
        &still,
    );
    let second = drain(&phone, at_home());
    assert_eq!(second.stopped, wire::DrainStop::Empty as i32, "{second:?}");
    assert!(second.need_bytes.is_empty(), "{second:?}");
    assert_eq!(second.pending_bytes, 0);
    assert!(second.acked_at_ms.is_some());

    let backed = status(&phone);
    assert_eq!(backed.destinations.len(), 2);
    assert_eq!(backed.content_total, 3, "{backed:?}");
    assert_eq!(backed.content_confirmed, 3, "{backed:?}");
    assert!(backed.waiting.is_empty(), "{backed:?}");
    for class in &backed.classes {
        assert!(class.backed_up && class.owed == 0, "{backed:?}");
    }
    for destination in &backed.destinations {
        assert_eq!(destination.classes.len(), 3);
        assert!(destination.classes.iter().all(|class| class.backed_up));
    }

    // BOTH GATEWAYS HOLD THE SAME OBJECTS, EACH COMMITTED ONCE, and the names the vault's own
    // bytes seal to are among them.
    let vault = vault_id();
    let (held_one, held_two) = (one.held(&vault), two.held(&vault));
    assert_eq!(held_one, held_two);
    let mut media: BTreeSet<Name> = names_of(Class::Originals, &photo).into_iter().collect();
    media.extend(names_of(Class::Thumbnails, &thumb));
    media.extend(names_of(Class::Originals, &still));
    assert_eq!(
        media.len(),
        4,
        "two chunks of the photograph, its thumbnail, the still"
    );
    assert!(media.is_subset(&held_one), "every media chunk is there");
    assert_eq!(
        committed(&one),
        held_one.len(),
        "each object committed once"
    );
    assert_eq!(committed(&two), held_two.len());
    // The staged chunk of the library item went to both and was released.
    assert_eq!(
        drain(&phone, quietly()).confirmed_parts,
        0,
        "nothing is owed"
    );
    assert_eq!(
        status(&phone).spool_bytes,
        0,
        "staging is empty once every gateway holds it"
    );

    // A SECOND PASS WITH NOTHING NEW moves no object, asks `exists` of nothing and sends next
    // to nothing.
    let (asked_one, asked_two) = (one.spawned.exists_asked(), two.spawned.exists_asked());
    let (sent_one, commits_one) = (one.spawned.cable().sent(), committed(&one));
    let idle = drain(&phone, quietly());
    assert_eq!(idle.confirmed_parts, 0, "{idle:?}");
    assert_eq!(
        one.spawned.exists_asked(),
        asked_one,
        "no name was asked about"
    );
    assert_eq!(two.spawned.exists_asked(), asked_two);
    assert_eq!(committed(&one), commits_one);
    assert!(
        one.spawned.cable().sent() - sent_one < 64 * 1024,
        "an idle pass sends a head read and little else"
    );

    // THE CANARY (#1080 invariant): no plaintext, no plaintext hash and no key reaches either
    // gateway's directory.
    let keys = keys();
    for gateway in [&one, &two] {
        let files = gateway.files();
        assert!(files.len() > 4, "the gateway holds objects");
        for (label, plaintext) in [("photo", &photo), ("thumb", &thumb), ("still", &still)] {
            let middle = &plaintext[plaintext.len() / 2..plaintext.len() / 2 + 64];
            let hash = blake3::hash(plaintext);
            for (path, held) in &files {
                assert!(
                    !contains(held, middle),
                    "{label}'s bytes are in {}",
                    path.display()
                );
                assert!(
                    !contains(held, hash.as_bytes()),
                    "{label}'s hash is in {}",
                    path.display()
                );
                assert!(
                    !contains(held, hash.to_hex().as_bytes()),
                    "{label}'s hash, in hex, is in {}",
                    path.display()
                );
            }
        }
        for (path, held) in &files {
            for key in [
                keys.backup.k_backup(),
                keys.backup.k_name(),
                keys.vault.root.as_bytes(),
            ] {
                assert!(!contains(held, key), "a key is in {}", path.display());
            }
        }
    }
}

#[test]
fn a_cut_connection_mid_bundle_resends_at_most_the_cut_chunk() {
    let home = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &home);
    let mut names = BTreeSet::new();
    for label in ["one", "two", "three"] {
        let bytes = owned_photo(&phone, label, CHUNK_BYTES);
        names.extend(names_of(Class::Originals, &bytes));
    }
    assert_eq!(names.len(), 3, "three originals of one chunk each");
    let vault = vault_id();

    // THE CABLE IS CUT INSIDE THE ORIGINALS' BUNDLE: the records go first (a little over a
    // megabyte), then a body of three chunks, of which the cut lands inside the second.
    home.cable().cut_after(CHUNK_BYTES as u64 + 2 * 1024 * 1024);
    let cut = drain(&phone, at_home());
    assert_eq!(cut.stopped, wire::DrainStop::Unreachable as i32, "{cut:?}");
    let landed = names.intersection(&home.held(&vault)).count();
    assert!(
        (1..3).contains(&landed),
        "frames before the cut are committed and the cut one is not: {landed} of 3"
    );

    // MENDED, THE NEXT PASS SENDS WHAT IS MISSING AND NOTHING THAT LANDED: the bytes it sends
    // are bounded by the missing chunks (the cut one among them) plus a little for the records'
    // head and the questions.
    home.cable().mend();
    let sent = home.cable().sent();
    let done = drain(&phone, at_home());
    assert_eq!(done.stopped, wire::DrainStop::Empty as i32, "{done:?}");
    assert!(names.is_subset(&home.held(&vault)));
    let missing = (3 - landed) as u64 * (CHUNK_BYTES as u64 + 128);
    let resent = home.cable().sent() - sent;
    assert!(
        resent <= missing + 512 * 1024,
        "{resent} bytes sent for {missing} missing: a finished frame went again"
    );
    assert_eq!(
        committed(&home),
        home.held(&vault).len(),
        "no object committed twice"
    );
}

#[test]
fn the_members_rule_decides_each_class_and_video_originals_never_cross_a_metered_link() {
    let home = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &home);
    let photo = owned_photo(&phone, "a photograph", 40_000);
    let film = bytes_of("a film", 50_000);
    let film_handle = stage(&phone, owned("video/mp4", &film), &film);
    add_asset(&phone, &film_handle, "video");
    let thumb = bytes_of("the photograph's thumbnail", 3_000);
    let photo_handle = stage(&phone, owned("image/heic", &photo), &photo);
    stage(&phone, thumb_of(&photo_handle, &thumb), &thumb);
    let vault = vault_id();
    let metered = |rule, asked| wire::DrainRequest {
        metered: true,
        rule: rule as i32,
        asked,
        ..at_home()
    };
    let photo_chunks = names_of(Class::Originals, &photo);
    let film_chunks = names_of(Class::Originals, &film);
    let thumb_chunks = names_of(Class::Thumbnails, &thumb);

    // METERED, WI-FI ONLY, NOBODY ASKED: nothing crosses, records included.
    let held = drain(&phone, metered(wire::TransferRule::WifiOnly, false));
    assert_eq!(held.confirmed_parts, 0, "{held:?}");
    assert!(home.held(&vault).is_empty());
    assert!(waiting(&status(&phone), wire::WaitReason::Wifi) > 0);

    // "BACK UP NOW" ON A METERED LINK SENDS THE RECORDS, never a heavy original.
    let tapped = drain(&phone, metered(wire::TransferRule::WifiOnly, true));
    assert!(tapped.confirmed_parts > 0, "{tapped:?}");
    let after_tap = home.held(&vault);
    assert!(!after_tap.is_empty(), "the records went");
    for name in photo_chunks.iter().chain(&film_chunks).chain(&thumb_chunks) {
        assert!(
            !after_tap.contains(name),
            "a class the rule keeps home crossed"
        );
    }

    // PHOTOS ON CELLULAR: the photograph's original and thumbnail cross, the film's does not.
    drain(
        &phone,
        metered(wire::TransferRule::WifiAndCellularPhotos, false),
    );
    let on_cellular = home.held(&vault);
    for name in photo_chunks.iter().chain(&thumb_chunks) {
        assert!(
            on_cellular.contains(name),
            "a photograph did not cross on cellular"
        );
    }
    for name in &film_chunks {
        assert!(
            !on_cellular.contains(name),
            "a video original crossed a metered link"
        );
    }
    assert_eq!(
        waiting(&status(&phone), wire::WaitReason::Wifi),
        1,
        "the film waits for a link that is not metered"
    );

    // ON AN UNMETERED LINK THE FILM CROSSES TOO.
    let home_again = drain(&phone, at_home());
    assert_eq!(home_again.stopped, wire::DrainStop::Empty as i32);
    assert!(
        home.held(&vault)
            .is_superset(&film_chunks.iter().copied().collect())
    );
}

/// A library item (its bytes only the OS library holds), staged as the shell would at import.
fn import_library_item(phone: &centraid_core::Handle, os_ref: &str, media: &str, bytes: &[u8]) {
    let staged = stage(phone, library(media, os_ref, bytes, false), bytes);
    add_asset(
        phone,
        &staged,
        if media.starts_with("video/") {
            "video"
        } else {
            "photo"
        },
    );
}

#[test]
fn a_library_item_is_asked_for_streamed_through_the_stage_door_and_backed_up() {
    let home = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &home);
    let still = bytes_of("a photograph the library holds", 2 * CHUNK_BYTES + 1);
    import_library_item(&phone, "lib-still", "image/heic", &still);
    // NOTHING WAS SEALED AT IMPORT: staging is empty and no key reached a file.
    assert_eq!(status(&phone).spool_bytes, 0);

    let first = drain(&phone, at_home());
    assert_eq!(first.need_bytes.len(), 1, "{first:?}");
    assert_eq!(first.waiting_bytes_parts, 1);
    assert_eq!(status(&phone).content_confirmed, 0);

    // The shell streams the item; its three chunks are sealed as they pass and staged.
    stage(
        &phone,
        library("image/heic", "lib-still", &still, false),
        &still,
    );
    let staged = status(&phone).spool_bytes;
    assert!(
        staged >= 2 * CHUNK_BYTES as u64,
        "the chunks are staged: {staged}"
    );
    let done = drain(&phone, at_home());
    assert_eq!(done.stopped, wire::DrainStop::Empty as i32, "{done:?}");
    assert!(done.need_bytes.is_empty(), "{done:?}");
    let backed = status(&phone);
    assert_eq!(
        (backed.content_total, backed.content_confirmed),
        (1, 1),
        "{backed:?}"
    );
    let names = names_of(Class::Originals, &still);
    assert_eq!(names.len(), 3);
    assert!(
        home.held(&vault_id())
            .is_superset(&names.iter().copied().collect())
    );
    // The next pass releases what every gateway now holds.
    drain(&phone, quietly());
    assert_eq!(
        status(&phone).spool_bytes,
        0,
        "staging is released once confirmed"
    );
}

#[test]
fn a_library_film_larger_than_staging_backs_up_a_window_at_a_time() {
    let home = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    // STAGING HOLDS ONE CHUNK: the film's three chunks go a window per round.
    let ceiling = CHUNK_BYTES as u64 + 4096;
    let phone = phone_with(dir.path(), |config| config.with_staging_ceiling(ceiling));
    pair(&phone, &home);
    let film = bytes_of("a film the library holds", 3 * CHUNK_BYTES);
    import_library_item(&phone, "lib-film", "video/mp4", &film);
    let names = names_of(Class::Originals, &film);
    assert_eq!(names.len(), 3);

    let mut streams = 0;
    let mut round = drain(&phone, at_home());
    while !round.need_bytes.is_empty() {
        streams += 1;
        assert!(
            streams <= 4,
            "a window per round, and no more rounds than chunks"
        );
        stage(
            &phone,
            library("video/mp4", "lib-film", &film, false),
            &film,
        );
        assert!(
            status(&phone).spool_bytes <= ceiling,
            "staging never holds more than its ceiling"
        );
        round = drain(&phone, at_home());
    }
    assert_eq!(streams, 3, "one stream per chunk: {round:?}");
    assert_eq!(round.stopped, wire::DrainStop::Empty as i32);
    assert!(
        home.held(&vault_id())
            .is_superset(&names.into_iter().collect())
    );
    let backed = status(&phone);
    assert_eq!(
        (backed.content_total, backed.content_confirmed),
        (1, 1),
        "{backed:?}"
    );
}

#[test]
fn os_bundle_files_are_uploaded_by_the_os_and_only_wake_a_pass() {
    let home = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &home);
    let mut names = BTreeSet::new();
    for label in ["a", "b"] {
        names.extend(names_of(
            Class::Originals,
            &owned_photo(&phone, label, 300_000),
        ));
    }
    let vault = vault_id();
    // A WINDOW THAT ENDS AT ONCE leaves the work to the OS: the pass names its bundle files.
    let window = drain(
        &phone,
        wire::DrainRequest {
            deadline_ms: 1,
            os_uploads: true,
            ..at_home()
        },
    );
    assert!(window.os_bundles.len() <= centraid_vault::backup::engine::OS_BUNDLES);
    assert!(!window.os_bundles.is_empty(), "{window:?}");
    for part in &window.os_bundles {
        assert_eq!(part.method, "POST");
        assert!(part.size <= centraid_vault::backup::engine::OS_BUNDLE_BYTES);
        assert!(part.url.ends_with("/bundle"), "{}", part.url);
        assert_eq!(part.gateway_id, home.spawned.gateway_id.hex());
    }
    // THE OS UPLOADS THEM while the app is suspended. Nothing the OS says is recorded: the
    // status still reads the originals as not backed up until a pass re-reads the head.
    assert_eq!(
        the_os_uploads(&home, &window.os_bundles),
        window.os_bundles.len()
    );
    assert!(
        names.is_subset(&home.held(&vault)),
        "the gateway holds what the OS uploaded"
    );
    let unconfirmed = status(&phone);
    assert!(
        unconfirmed.classes.iter().any(|class| !class.backed_up),
        "an upload the OS reported confirms nothing: {unconfirmed:?}"
    );
    // A PASS WAKES, re-reads the head, finds the objects there and confirms them itself.
    let commits = committed(&home);
    let woken = drain(&phone, at_home());
    assert_eq!(woken.stopped, wire::DrainStop::Empty as i32, "{woken:?}");
    assert!(woken.confirmed_parts > 0);
    let backed = status(&phone);
    assert!(
        backed.classes.iter().all(|class| class.backed_up),
        "{backed:?}"
    );
    assert!(
        committed(&home) >= commits,
        "the objects the OS uploaded were answered there, not stored again"
    );
    assert_eq!(
        committed(&home),
        home.held(&vault).len(),
        "each object committed once"
    );
}

#[test]
fn held_whole_names_the_gateways_that_hold_an_original_and_says_none_before_the_pass() {
    let (one, two) = (gateway(), gateway());
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let one_id = pair(&phone, &one)
        .destination
        .expect("a destination")
        .gateway_id;
    let photo = bytes_of("a photograph", 60_000);
    let handle = stage(&phone, owned("image/heic", &photo), &photo);
    add_asset(&phone, &handle, "photo");
    let hash = hex::decode(&handle.content_hash).expect("hex");
    let held_whole = |hash: &[u8]| {
        let wire::response::Kind::HeldWhole(answer) = ask(
            &phone,
            wire::request::Kind::HeldWhole(wire::HeldWholeRequest {
                content_hash: hash.to_vec(),
                ..Default::default()
            }),
        ) else {
            panic!("a held_whole answers");
        };
        answer
    };
    assert!(
        !held_whole(&hash).held_whole,
        "before any pass no gateway holds it"
    );
    drain(&phone, at_home());
    assert_eq!(held_whole(&hash).gateway_ids, vec![one_id.clone()]);
    // A SECOND GATEWAY PAIRED LATER HOLDS IT ONLY ONCE A PASS FED IT.
    let two_id = pair(&phone, &two)
        .destination
        .expect("a destination")
        .gateway_id;
    assert_eq!(held_whole(&hash).gateway_ids, vec![one_id.clone()]);
    drain(&phone, at_home());
    let mut both = held_whole(&hash).gateway_ids;
    both.sort();
    let mut expected = vec![one_id, two_id];
    expected.sort();
    assert_eq!(both, expected);
    assert!(
        !held_whole(&[7; 32]).held_whole,
        "a hash nothing names is held nowhere"
    );
    // MANY AT ONCE: of three hashes with one repeated, only the one nothing holds comes back,
    // once, in the order asked.
    let wire::response::Kind::HeldWhole(many) = ask(
        &phone,
        wire::request::Kind::HeldWhole(wire::HeldWholeRequest {
            content_hash: Vec::new(),
            content_hashes: vec![vec![7; 32], hash.clone(), vec![7; 32], vec![8; 32]],
        }),
    ) else {
        panic!("a held_whole answers");
    };
    assert_eq!(many.not_held, vec![vec![7; 32], vec![8; 32]]);
    assert!(
        try_ask(
            &phone,
            wire::request::Kind::HeldWhole(wire::HeldWholeRequest {
                content_hash: vec![1, 2, 3],
                ..Default::default()
            })
        )
        .is_err(),
        "a hash is 32 bytes"
    );
}

/// An older gateway: real TLS, and `/v1/info` answers protocol 0.
mod older {
    use std::sync::Arc;

    use axum::Router;
    use axum::http::{StatusCode, Uri};
    use axum::response::{IntoResponse as _, Response};
    use axum::routing::any;
    use centraid_gateway::rules::ids::GatewayId;
    use centraid_gateway::server::serve::{TlsListener, bind, run_router};
    use centraid_gateway::server::tls::Identity;

    pub struct Stub {
        /// Kept alive: the stub serves on it.
        #[allow(dead_code)]
        pub runtime: tokio::runtime::Runtime,
        pub addr: std::net::SocketAddr,
        pub gateway_id: GatewayId,
        pub cert_der: Vec<u8>,
        pub paths: Arc<std::sync::Mutex<Vec<String>>>,
        _dir: tempfile::TempDir,
    }

    async fn answer(
        uri: Uri,
        paths: Arc<std::sync::Mutex<Vec<String>>>,
        gateway: GatewayId,
    ) -> Response {
        paths.lock().expect("paths").push(uri.path().to_owned());
        if uri.path() == "/v1/info" {
            return axum::Json(serde_json::json!({
                "gateway_id": gateway.hex(),
                "protocol": 0,
                "time_ms": 1
            }))
            .into_response();
        }
        (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"code": "NOT_FOUND", "time_ms": 1})),
        )
            .into_response()
    }

    pub fn spawn() -> Stub {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("a runtime");
        let dir = tempfile::tempdir().expect("a directory");
        let gateway_id = GatewayId::from_bytes([5; 16]);
        let identity = Identity::load_or_mint(dir.path(), || gateway_id).expect("a certificate");
        let paths: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
        let (addr, cert_der) = runtime.block_on(async {
            let listener = TlsListener::new(
                bind("127.0.0.1:0").await.expect("binds"),
                identity.server_config().expect("a TLS config"),
            )
            .expect("a TLS listener");
            let addr = listener.local();
            let seen = Arc::clone(&paths);
            let router = Router::new().fallback(any(move |uri: Uri| {
                answer(uri, Arc::clone(&seen), gateway_id)
            }));
            tokio::spawn(run_router(listener, router, std::future::pending()));
            (addr, identity.cert_der().to_vec())
        });
        Stub {
            runtime,
            addr,
            gateway_id,
            cert_der,
            paths,
            _dir: dir,
        }
    }
}

#[test]
fn a_gateway_older_than_this_build_is_told_to_be_updated() {
    use centraid_vault::backup::state::{Gateway as Row, Reach};
    use centraid_vault::backup::store::StoreError;

    // The typed reach: protocol below the required one is `too_old`, never `unreachable`.
    assert_eq!(
        centraid_core::phone::link::reach_of(&StoreError::GatewayOld {
            found: 0,
            required: 1
        }),
        Some(Reach::TooOld)
    );

    let stub = older::spawn();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    // A gateway that answers as protocol 0 cannot be paired through the client; the ledger row is
    // what a pairing made before the gateway was downgraded would have left.
    let state = centraid_core::phone::Plane::of(&dir.path().join("vault.db"))
        .state()
        .expect("opens");
    state
        .add_gateway(&Row::paired(
            stub.gateway_id.hex(),
            vec![stub.addr.to_string()],
            stub.cert_der.clone(),
            "old".to_owned(),
            1,
            1,
        ))
        .expect("writes");
    drop(state);
    let token = centraid_gateway::rules::ids::Token::from_bytes([9; 32]);
    ask(
        &phone,
        wire::request::Kind::GatewayTokens(wire::GatewayTokensRequest {
            tokens: vec![wire::GatewayToken {
                vault_id: keys().vault_hex(),
                gateway_id: stub.gateway_id.hex(),
                token: token.hex(),
            }],
        }),
    );
    // A vault with something to back up, so a pass would have work for a gateway.
    owned_photo(&phone, "a photograph", 10_000);
    let drained = drain(&phone, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::TooOld as i32,
        "{drained:?}"
    );
    let seen = stub.paths.lock().expect("paths").clone();
    assert!(
        seen.iter().all(|path| path == "/v1/info"),
        "nothing but the version was asked of it: {seen:?}"
    );
    let status = status(&phone);
    let destination = &status.destinations[0];
    assert_eq!(
        destination.reach_state,
        wire::DestinationReach::GatewayOld as i32
    );
    assert!(
        waiting(&status, wire::WaitReason::Gateway) > 0,
        "{status:?}"
    );
    assert_eq!(status.pending_bytes, 10_000);
}

fn refresh(
    handle: &centraid_core::Handle,
    id: &str,
    candidates: &[String],
) -> wire::RefreshDestinationResponse {
    let wire::response::Kind::RefreshDestination(answer) = ask(
        handle,
        wire::request::Kind::RefreshDestination(wire::RefreshDestinationRequest {
            gateway_id: id.to_owned(),
            candidates: candidates.to_vec(),
        }),
    ) else {
        panic!("a refresh answers");
    };
    answer
}

#[test]
fn a_gateway_that_moved_is_found_again_by_its_identity_and_only_by_it() {
    let first = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let handle = phone(dir.path());
    let id = pair(&handle, &first)
        .destination
        .expect("a destination")
        .gateway_id;
    let recorded = first.spawned.addr.to_string();
    drain(&handle, at_home());

    // THE LAPTOP WOKE AT ANOTHER ADDRESS: the same state and so the same
    // identity and certificate, on a new port.
    let Gateway {
        runtime,
        dir: state,
        spawned,
    } = first;
    runtime.block_on(spawned.shutdown());
    drop(runtime);
    let moved = gateway_in(state);
    let found = moved.spawned.addr.to_string();
    assert_ne!(found, recorded, "the test needs a new address");
    let cut = drain(&handle, at_home());
    assert_eq!(
        cut.stopped,
        wire::DrainStop::Unreachable as i32,
        "the recorded address is dead: {cut:?}"
    );

    // ANOTHER GATEWAY'S ADDRESS, A DEAD PORT, A NAME AND NONSENSE are never
    // recorded: the certificate refuses the first, nothing answers the second,
    // and the last two are not addresses the core dials.
    let stranger = gateway();
    let answer = refresh(
        &handle,
        &id,
        &[
            stranger.spawned.addr.to_string(),
            "127.0.0.1:1".to_owned(),
            "laptop.local:7443".to_owned(),
            "not an address".to_owned(),
            "[fe80::1]:7443".to_owned(),
        ],
    );
    assert!(!answer.refreshed, "{answer:?}");
    assert_eq!(answer.addrs, vec![recorded.clone()], "{answer:?}");

    // THE ONE THAT ANSWERS AS THE PINNED GATEWAY GOES FIRST, AHEAD OF THE
    // STALE ONE, which stays as a fallback.
    let answer = refresh(&handle, &id, &["127.0.0.1:1".to_owned(), found.clone()]);
    assert!(answer.refreshed, "{answer:?}");
    assert_eq!(answer.addrs, vec![found.clone(), recorded.clone()]);
    let wire::response::Kind::Pins(pins) =
        ask(&handle, wire::request::Kind::Pins(wire::PinsRequest {}))
    else {
        panic!("pins answer");
    };
    assert_eq!(pins.destinations[0].addrs, vec![found, recorded]);
    let back = drain(&handle, at_home());
    assert_ne!(
        back.stopped,
        wire::DrainStop::Unreachable as i32,
        "the next pass reaches it: {back:?}"
    );

    // A GATEWAY THE LEDGER DOES NOT HOLD IS AN ANSWER, NOT A REFUSAL.
    let none = refresh(
        &handle,
        "not-a-paired-gateway",
        &[moved.spawned.addr.to_string()],
    );
    assert!(!none.refreshed && none.addrs.is_empty(), "{none:?}");
}

#[test]
fn forgetting_a_gateway_revokes_this_phones_token_there() {
    let kept = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let handle = phone(dir.path());
    let id = pair(&handle, &kept)
        .destination
        .expect("a destination")
        .gateway_id;
    drain(&handle, at_home());
    assert_eq!(tokens(&kept), 1, "the pairing minted one token");

    let forgot = forget(&handle, &id);
    assert!(forgot.forgotten && forgot.revoked, "{forgot:?}");
    assert_eq!(tokens(&kept), 0, "the gateway forgot the token too");

    // A GATEWAY THAT IS GONE IS FORGOTTEN ANYWAY, and the answer says its
    // token was not revoked.
    let gone = gateway();
    let gone_id = pair(&handle, &gone)
        .destination
        .expect("a destination")
        .gateway_id;
    drop(gone);
    let forgot = forget(&handle, &gone_id);
    assert!(forgot.forgotten && !forgot.revoked, "{forgot:?}");
    let wire::response::Kind::Pins(pins) =
        ask(&handle, wire::request::Kind::Pins(wire::PinsRequest {}))
    else {
        panic!("pins answer");
    };
    assert!(pins.destinations.is_empty(), "{:?}", pins.destinations);
    assert!(
        !forget(&handle, &gone_id).forgotten,
        "a second forget finds nothing"
    );
}

#[test]
fn a_machine_that_is_not_the_pinned_gateway_is_untrusted_and_a_damaged_copy_is_damaged() {
    let home = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let id = pair(&phone, &home)
        .destination
        .expect("a destination")
        .gateway_id;
    let photo = bytes_of("an original the gateway will damage", 250_000);
    let photo_handle = stage(&phone, owned("image/heic", &photo), &photo);
    add_asset(&phone, &photo_handle, "photo");
    drain(&phone, at_home());
    let door = phone.bytes().expect("a door");
    let hash = centraid_blobs::ContentHash::parse_hex(&photo_handle.content_hash).expect("hex");
    assert!(door.store().remove(hash).expect("removes"));
    let fetch = || {
        let wire::response::Kind::FetchOriginal(fetched) = ask(
            &phone,
            wire::request::Kind::FetchOriginal(wire::FetchOriginalRequest {
                content_hash: hex::decode(&photo_handle.content_hash).expect("hex"),
            }),
        ) else {
            panic!("a fetch answers");
        };
        fetched
    };

    // DAMAGED: one bit flipped in the gateway's copy, which no scrub has
    // marked yet, so the gateway still serves it.
    let vault = vault_id();
    for name in names_of(Class::Originals, &photo) {
        home.spawned
            .corrupt(
                &vault,
                &centraid_gateway::rules::ids::Name::from_bytes(*name.as_bytes()),
            )
            .expect("a bit flips");
    }
    let damaged = fetch();
    assert_eq!(
        damaged.outcome,
        wire::FetchOutcome::Damaged as i32,
        "{damaged:?}"
    );
    assert!(
        door.store().path_of(hash).expect("reads").is_none(),
        "nothing damaged lands"
    );

    // UNTRUSTED: another machine answers at the pinned gateway's address.
    let impostor = gateway();
    let ledger =
        centraid_vault::backup::state::DeviceState::open_beside(&dir.path().join("vault.db"))
            .expect("the device state opens");
    let mut row = ledger
        .gateway(&id)
        .expect("reads")
        .expect("the gateway is paired");
    row.addrs = vec![impostor.spawned.addr.to_string()];
    ledger.add_gateway(&row).expect("writes");
    let untrusted = fetch();
    assert_eq!(
        untrusted.outcome,
        wire::FetchOutcome::Untrusted as i32,
        "{untrusted:?}"
    );
    let fresh = bytes_of("taken while another machine answers", 40_000);
    let fresh_handle = stage(&phone, owned("image/heic", &fresh), &fresh);
    add_asset(&phone, &fresh_handle, "photo");
    let drained = drain(&phone, at_home());
    assert_eq!(
        drained.stopped,
        wire::DrainStop::Untrusted as i32,
        "{drained:?}"
    );
    let status = status(&phone);
    assert!(
        status
            .waiting
            .iter()
            .any(|row| row.reason == wire::WaitReason::Untrusted as i32),
        "{status:?}"
    );
    assert_eq!(tokens(&impostor), 0, "nothing paired with the impostor");
}

#[test]
fn a_second_pass_with_no_write_walks_nothing() {
    let home = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &home);
    owned_photo(&phone, "a photograph the app holds", 90_000);

    let first = drain(&phone, at_home());
    assert_eq!(first.stopped, wire::DrainStop::Empty as i32, "{first:?}");
    let held = home.held(&vault_id());
    let commits = committed(&home);
    assert!(commits > 0, "the first pass sent the vault");

    // NOTHING WAS WRITTEN: the pass finds the vault unchanged, takes no snapshot, sends nothing.
    let second = drain(&phone, at_home());
    assert_eq!(second.stopped, wire::DrainStop::Empty as i32, "{second:?}");
    assert_eq!(second.confirmed_parts, 0, "{second:?}");
    assert_eq!(committed(&home), commits, "no object was committed again");
    assert_eq!(
        home.held(&vault_id()),
        held,
        "the gateway holds the same set"
    );
}

#[test]
fn a_phone_with_no_room_says_so() {
    let home = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone_with(dir.path(), |config| config.with_staging_ceiling(1));
    pair(&phone, &home);
    owned_photo(&phone, "a photograph the app holds", 90_000);

    drain(&phone, at_home());
    assert!(
        status(&phone)
            .waiting
            .iter()
            .any(|row| row.reason == wire::WaitReason::NoRoom as i32),
        "the page says there is no room"
    );
    assert!(home.held(&vault_id()).is_empty(), "nothing went anywhere");
}

#[test]
fn two_os_bundle_passes_over_the_same_missing_set_do_not_self_delete() {
    let home = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &home);
    for label in ["a", "b"] {
        owned_photo(&phone, label, 300_000);
    }
    let req = wire::DrainRequest {
        deadline_ms: 1,
        os_uploads: true,
        ..at_home()
    };
    let first = drain(&phone, req);
    assert!(!first.os_bundles.is_empty(), "{first:?}");
    for part in &first.os_bundles {
        assert!(
            std::path::Path::new(&part.path).exists(),
            "first pass bundle exists: {}",
            part.path
        );
    }
    // A second pass while the OS upload is still in flight sees the exact same missing set
    // and deterministic bundle path; rotation must not unlink the path still in use.
    let second = drain(&phone, req);
    assert_eq!(second.os_bundles.len(), first.os_bundles.len());
    for part in &second.os_bundles {
        assert!(
            std::path::Path::new(&part.path).exists(),
            "second pass bundle was self-deleted: {}",
            part.path
        );
    }
    assert_eq!(
        the_os_uploads(&home, &second.os_bundles),
        second.os_bundles.len()
    );
}

#[test]
fn restarting_after_os_bundle_handoff_does_not_leak_staging_bytes() {
    let home = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let vault_path = dir.path().join("vault.db");
    let first = {
        let phone = phone(dir.path());
        pair(&phone, &home);
        for label in ["a", "b"] {
            owned_photo(&phone, label, 300_000);
        }
        let window = drain(
            &phone,
            wire::DrainRequest {
                deadline_ms: 1,
                os_uploads: true,
                ..at_home()
            },
        );
        assert!(!window.os_bundles.is_empty(), "{window:?}");
        assert!(status(&phone).spool_bytes > 0);
        window
    };
    // Simulate an app kill and relaunch: files stay on disk until the next pass rotates them,
    // so an in-flight OS upload is not disrupted by reopen.
    let phone = reopen(&vault_path);
    for part in &first.os_bundles {
        assert!(
            std::path::Path::new(&part.path).exists(),
            "in-flight bundle survives reopen: {}",
            part.path
        );
    }
    assert_eq!(
        the_os_uploads(&home, &first.os_bundles),
        first.os_bundles.len()
    );
    // The next pass confirms the uploads and reclaims the persisted OS bundle files.
    let woken = drain(&phone, at_home());
    assert_eq!(woken.stopped, wire::DrainStop::Empty as i32, "{woken:?}");
    for part in &first.os_bundles {
        assert!(
            !std::path::Path::new(&part.path).exists(),
            "old OS bundle leaked across restart: {}",
            part.path
        );
    }
    assert_eq!(
        status(&phone).spool_bytes,
        0,
        "staging bytes are reclaimed after restart"
    );
}

#[test]
fn multiple_gateways_with_identical_missing_sets_keep_bundles_and_respect_cap() {
    let (one, two, three) = (gateway(), gateway(), gateway());
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &one);
    pair(&phone, &two);
    pair(&phone, &three);

    // One photo with a thumbnail gives 2 classes x 3 gateways = 6 potential bundles,
    // exceeding OS_BUNDLES (4), all with identical missing sets per class across gateways.
    let photo = bytes_of("shared photo", 200_000);
    let photo_handle = stage(&phone, owned("image/heic", &photo), &photo);
    add_asset(&phone, &photo_handle, "photo");
    let thumb = bytes_of("shared thumb", 8_000);
    stage(&phone, thumb_of(&photo_handle, &thumb), &thumb);

    let window = drain(
        &phone,
        wire::DrainRequest {
            deadline_ms: 1,
            os_uploads: true,
            ..at_home()
        },
    );
    assert_eq!(
        window.os_bundles.len(),
        centraid_vault::backup::engine::OS_BUNDLES,
        "capped at OS_BUNDLES: {window:?}"
    );
    for part in &window.os_bundles {
        assert!(
            std::path::Path::new(&part.path).exists(),
            "shared bundle file was unlinked by another gateway: {}",
            part.path
        );
        assert!(
            std::fs::read(&part.path).is_ok_and(|bytes| bytes.len() as u64 == part.size),
            "bundle file is readable and whole"
        );
    }
}

#[test]
fn staging_full_during_os_bundles_returns_parts_built_so_far_and_sets_no_room() {
    let home = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    // Large enough for the snapshot and the small thumbnail bundle, too small for the 300 KiB
    // original bundle.
    let phone = phone_with(dir.path(), |config| config.with_staging_ceiling(120_000));
    pair(&phone, &home);

    let photo = bytes_of("large original", 300_000);
    let photo_handle = stage(&phone, owned("image/heic", &photo), &photo);
    add_asset(&phone, &photo_handle, "photo");
    let thumb = bytes_of("small thumb", 6_000);
    stage(&phone, thumb_of(&photo_handle, &thumb), &thumb);

    // Confirm records first on a metered tap so snapshot ranges are released from staging
    // while both the thumbnail and the original remain owed.
    let records = drain(
        &phone,
        wire::DrainRequest {
            metered: true,
            asked: true,
            os_uploads: false,
            ..at_home()
        },
    );
    assert_eq!(
        records.stopped,
        wire::DrainStop::Empty as i32,
        "{records:?}"
    );
    assert_eq!(status(&phone).spool_bytes, 0);

    // Now build OS bundles: thumbnails fit, originals hit StagingFull. The drain must succeed
    // with the thumbnail bundle built so far and flag NoRoom.
    let window = drain(
        &phone,
        wire::DrainRequest {
            deadline_ms: 1,
            os_uploads: true,
            ..at_home()
        },
    );
    assert_eq!(
        window.os_bundles.len(),
        1,
        "returns the thumbnail bundle built before StagingFull: {window:?}"
    );
    assert!(
        std::path::Path::new(&window.os_bundles[0].path).exists(),
        "returned bundle exists on disk"
    );
    assert!(
        status(&phone)
            .waiting
            .iter()
            .any(|row| row.reason == wire::WaitReason::NoRoom as i32),
        "sets the no-room note: {:?}",
        status(&phone).waiting
    );
}

#[test]
fn exclude_videos_confirms_originals_without_stalling_and_toggling_back_uploads_the_video() {
    let home = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let gateway_id = pair(&phone, &home)
        .destination
        .expect("a destination")
        .gateway_id;

    let photo = bytes_of("a photograph", 40_000);
    let photo_handle = stage(&phone, owned("image/heic", &photo), &photo);
    add_asset(&phone, &photo_handle, "photo");
    let photo_hash = hex::decode(&photo_handle.content_hash).expect("hex");

    let film = bytes_of("a film", 50_000);
    let film_handle = stage(&phone, owned("video/mp4", &film), &film);
    add_asset(&phone, &film_handle, "video");
    let film_hash = hex::decode(&film_handle.content_hash).expect("hex");

    let poster = bytes_of("the film's poster", 3_000);
    stage(&phone, thumb_of(&film_handle, &poster), &poster);

    let vault = vault_id();
    let photo_chunks = names_of(Class::Originals, &photo);
    let film_chunks = names_of(Class::Originals, &film);
    let poster_chunks = names_of(Class::Thumbnails, &poster);

    let held_whole = |hash: &[u8]| {
        let wire::response::Kind::HeldWhole(answer) = ask(
            &phone,
            wire::request::Kind::HeldWhole(wire::HeldWholeRequest {
                content_hash: hash.to_vec(),
                ..Default::default()
            }),
        ) else {
            panic!("a held_whole answers");
        };
        answer
    };

    // DRAIN WITH EXCLUDE_VIDEOS ON UNMETERED WI-FI: the photo original and the video's poster
    // cross, the video original stays home, and `oroot` still advances to `conf`.
    let first = drain(
        &phone,
        wire::DrainRequest {
            exclude_videos: true,
            ..at_home()
        },
    );
    assert_eq!(first.stopped, wire::DrainStop::Empty as i32, "{first:?}");

    let held_after_first = home.held(&vault);
    for name in photo_chunks.iter().chain(&poster_chunks) {
        assert!(
            held_after_first.contains(name),
            "photo original and video poster should be backed up"
        );
    }
    for name in &film_chunks {
        assert!(
            !held_after_first.contains(name),
            "excluded video original must not be uploaded"
        );
    }

    let state = centraid_core::phone::Plane::of(&dir.path().join("vault.db"))
        .state()
        .expect("opens");
    let row = state
        .gateway(&gateway_id)
        .expect("reads")
        .expect("gateway row");
    assert!(row.conf.is_some(), "conf should be confirmed");
    assert_eq!(
        row.oroot.map(|(n, _)| n),
        row.conf.map(|(n, _)| n),
        "oroot must advance to conf when videos are excluded"
    );
    assert!(
        state.exclude_videos().expect("reads"),
        "device row records exclude_videos = true"
    );
    drop(state);

    let backed = status(&phone);
    for class in &backed.classes {
        assert!(
            class.backed_up && class.owed == 0,
            "all classes should read backed up: {backed:?}"
        );
    }
    assert_eq!(
        held_whole(&photo_hash).gateway_ids,
        vec![gateway_id.clone()],
        "backed-up photo is held whole"
    );
    assert!(
        !held_whole(&film_hash).held_whole,
        "excluded video must NOT be reported as held whole (R4)"
    );

    // TOGGLE EXCLUDE_VIDEOS OFF: a fresh snapshot is taken immediately, the video original is
    // uploaded, `oroot` advances again, and `held_whole` reports both photo and video as held.
    let second = drain(&phone, at_home());
    assert_eq!(second.stopped, wire::DrainStop::Empty as i32, "{second:?}");

    let held_after_second = home.held(&vault);
    for name in &film_chunks {
        assert!(
            held_after_second.contains(name),
            "video original should be uploaded once exclude_videos is turned off"
        );
    }
    let state = centraid_core::phone::Plane::of(&dir.path().join("vault.db"))
        .state()
        .expect("opens");
    let row = state
        .gateway(&gateway_id)
        .expect("reads")
        .expect("gateway row");
    assert_eq!(
        row.oroot.map(|(n, _)| n),
        row.conf.map(|(n, _)| n),
        "oroot advances to the new conf after re-including videos"
    );
    assert!(
        !state.exclude_videos().expect("reads"),
        "device row records exclude_videos = false"
    );
    drop(state);

    assert_eq!(
        held_whole(&photo_hash).gateway_ids,
        vec![gateway_id.clone()]
    );
    assert_eq!(
        held_whole(&film_hash).gateway_ids,
        vec![gateway_id],
        "video is now reported as held whole"
    );
}

#[test]
fn a_metered_wifi_only_pass_skips_read_back_with_zero_gets() {
    let home = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let gateway_id = pair(&phone, &home)
        .destination
        .expect("a destination")
        .gateway_id;
    owned_photo(&phone, "a photograph on the gateway", 250_000);

    // First pass on unmetered Wi-Fi backs everything up and runs one read-back sample.
    let first = drain(&phone, at_home());
    assert_eq!(first.stopped, wire::DrainStop::Empty as i32, "{first:?}");
    let sample_counter = || {
        centraid_core::phone::Plane::of(&dir.path().join("vault.db"))
            .state()
            .expect("opens")
            .gateway(&gateway_id)
            .expect("reads")
            .expect("gateway row")
            .sample_counter
    };
    let after_wifi = sample_counter();
    assert_eq!(
        after_wifi, 1,
        "unmetered pass should have run one read-back sample"
    );

    // METERED + WI-FI ONLY: read-back must NOT run (0 object GETs). Cap gateway response bytes
    // well below the 250 KiB photo so any object GET would cut the cable and fail the pass.
    home.cable().cut_after_answers(16 * 1024);
    let wifi_only = drain(
        &phone,
        wire::DrainRequest {
            metered: true,
            rule: wire::TransferRule::WifiOnly as i32,
            ..at_home()
        },
    );
    assert_eq!(
        wifi_only.stopped,
        wire::DrainStop::Empty as i32,
        "metered Wi-Fi-only pass must not issue object GETs: {wifi_only:?}"
    );
    assert_eq!(
        sample_counter(),
        after_wifi,
        "read-back must not advance sample_counter under metered Wi-Fi-only"
    );

    // METERED + MANUAL: read-back must also be skipped (0 object GETs).
    home.cable().cut_after_answers(16 * 1024);
    let manual = drain(
        &phone,
        wire::DrainRequest {
            metered: true,
            rule: wire::TransferRule::Manual as i32,
            ..at_home()
        },
    );
    assert_eq!(
        manual.stopped,
        wire::DrainStop::Empty as i32,
        "metered Manual pass must not issue object GETs: {manual:?}"
    );
    assert_eq!(
        sample_counter(),
        after_wifi,
        "read-back must not advance sample_counter under metered Manual"
    );

    // METERED + WIFI_AND_CELLULAR_PHOTOS: read-back runs with the metered sample size.
    home.cable().mend();
    let cellular_photos = drain(
        &phone,
        wire::DrainRequest {
            metered: true,
            rule: wire::TransferRule::WifiAndCellularPhotos as i32,
            ..at_home()
        },
    );
    assert_eq!(
        cellular_photos.stopped,
        wire::DrainStop::Empty as i32,
        "{cellular_photos:?}"
    );
    assert_eq!(
        sample_counter(),
        after_wifi + 1,
        "read-back should run under metered WifiAndCellularPhotos"
    );
}

#[test]
fn os_bundles_never_allow_cellular_for_video_frames() {
    let home = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &home);

    let photo = owned_photo(&phone, "a photograph for os bundle", 300_000);
    let film = bytes_of("a video for os bundle", 300_000);
    let film_handle = stage(&phone, owned("video/mp4", &film), &film);
    add_asset(&phone, &film_handle, "video");

    let photo_names: BTreeSet<Name> = names_of(Class::Originals, &photo).into_iter().collect();
    let film_names: BTreeSet<Name> = names_of(Class::Originals, &film).into_iter().collect();

    // Unmetered Wi-Fi with WifiAndCellularPhotos and a tight deadline so originals are handed off
    // to the OS as bundle files.
    let window = drain(
        &phone,
        wire::DrainRequest {
            deadline_ms: 1,
            os_uploads: true,
            rule: wire::TransferRule::WifiAndCellularPhotos as i32,
            ..at_home()
        },
    );
    assert!(
        window.os_bundles.len() >= 2,
        "photo and video originals must be packed into separate OS bundles: {window:?}"
    );

    let mut saw_photo_bundle = false;
    let mut saw_video_bundle = false;
    for part in &window.os_bundles {
        let body = std::fs::read(&part.path).expect("os bundle file exists");
        let frames = centraid_gateway::rules::bundle::decode(&body).expect("valid bundle framing");
        let frame_names: BTreeSet<Name> = frames
            .iter()
            .map(|frame| Name::from_bytes(*frame.name.as_bytes()))
            .collect();
        let has_photo = !frame_names.is_disjoint(&photo_names);
        let has_video = !frame_names.is_disjoint(&film_names);
        assert!(
            !(has_photo && has_video),
            "photo and video frames must not share an OS bundle"
        );
        if has_video {
            saw_video_bundle = true;
            assert!(
                !part.allows_cellular,
                "any OS bundle containing a video frame must have allows_cellular == false: {part:?}"
            );
        }
        if has_photo {
            saw_photo_bundle = true;
            assert!(
                part.allows_cellular,
                "photo-only OS bundle should have allows_cellular == true under WifiAndCellularPhotos: {part:?}"
            );
        }
    }
    assert!(saw_photo_bundle, "expected a photo-only OS bundle");
    assert!(saw_video_bundle, "expected a video OS bundle");
}

#[test]
fn a_zero_step_metered_pass_does_not_clear_an_earlier_refusal() {
    let home = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &home);
    owned_photo(&phone, "a photograph", 60_000);

    // Gateway disk full -> refusal is recorded in plane notes.
    home.spawned.fill_disk(true);
    let refused = drain(&phone, at_home());
    assert_eq!(
        refused.stopped,
        wire::DrainStop::Refused as i32,
        "{refused:?}"
    );
    assert!(
        waiting(&status(&phone), wire::WaitReason::Refused) > 0,
        "disk-full refusal should be surfaced"
    );

    // A metered Wi-Fi-only pass runs zero engine steps; it must not clear `notes.refusal`.
    // (Note: `link::reach_all` probed `/v1/info` and temporarily set `reach = Ok`, so once the
    // gateway is unreachable again, `status` surfaces `notes.refusal` if and only if the zero-step
    // pass preserved it.)
    let metered_noop = drain(
        &phone,
        wire::DrainRequest {
            metered: true,
            rule: wire::TransferRule::WifiOnly as i32,
            ..at_home()
        },
    );
    assert_eq!(metered_noop.confirmed_parts, 0, "{metered_noop:?}");

    home.cable().cut();
    let offline = drain(&phone, at_home());
    assert_eq!(
        offline.stopped,
        wire::DrainStop::Unreachable as i32,
        "{offline:?}"
    );
    assert!(
        waiting(&status(&phone), wire::WaitReason::Refused) > 0,
        "zero-step metered pass must not clear an earlier gateway refusal"
    );

    // Once the gateway has room again and a step actually runs, the refusal clears.
    home.cable().mend();
    home.spawned.fill_disk(false);
    let recovered = drain(&phone, at_home());
    assert_eq!(
        recovered.stopped,
        wire::DrainStop::Empty as i32,
        "{recovered:?}"
    );
    assert_eq!(
        waiting(&status(&phone), wire::WaitReason::Refused),
        0,
        "refusal clears once a pass actually steps and succeeds"
    );
}

