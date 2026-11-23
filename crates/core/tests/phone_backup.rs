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
    assert!(
        try_ask(
            &phone,
            wire::request::Kind::HeldWhole(wire::HeldWholeRequest {
                content_hash: vec![1, 2, 3],
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
