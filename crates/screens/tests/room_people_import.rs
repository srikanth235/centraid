use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_screens::room::snapshot;
use centraid_vault::clock::{FixedClock, SeededIds};

const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";
const NOW: i64 = 1_795_687_200_000;
const VCARD: &[u8] =
    b"BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Imported Contact\r\nN:Contact;Imported;;;\r\nEND:VCARD\r\n";

fn phone(dir: &std::path::Path) -> Handle {
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("valid test recovery phrase")
        .seed();
    let handle = Core::open(
        CoreConfig::new(dir.join("vault.db"))
            .with_seed(seed, 0)
            .with_clock(
                Arc::new(FixedClock::at(NOW)),
                Arc::new(SeededIds::new("people-import")),
            ),
    )
    .expect("core opens");
    handle
        .with_vault(|vault| Ok(vault.found("Household", "Ada")?))
        .expect("vault exists");
    handle
        .open_own_bytes(dir.join("vault.bytes"))
        .expect("owned byte store opens");
    centraid_screens::attach(&handle);
    handle
}

fn call(handle: &Handle, kind: wire::room_request::Kind) -> wire::RoomResponse {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(kind),
            })),
        })
        .expect("room call succeeds")
        .kind
        .expect("response has a kind");
    let wire::response::Kind::Room(response) = answer else {
        panic!("expected a Room response")
    };
    response
}

fn stage(handle: &Handle, bytes: &[u8]) -> wire::StageHandle {
    let frame = |kind| {
        let answer = handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Stage(wire::StageRequest {
                    kind: Some(kind),
                })),
            })
            .expect("staging call succeeds")
            .kind
            .expect("staging response has a kind");
        let wire::response::Kind::Stage(response) = answer else {
            panic!("expected Stage response")
        };
        response.kind.expect("Stage response has a result")
    };
    let wire::stage_response::Kind::Begun(begun) =
        frame(wire::stage_request::Kind::Begin(wire::StageBegin {
            media_type: "text/vcard".to_owned(),
            byte_size: bytes.len() as u64,
            source: wire::StageSource::Owned as i32,
            ..Default::default()
        }))
    else {
        panic!("stage did not begin")
    };
    let wire::stage_response::Kind::Chunked(_) =
        frame(wire::stage_request::Kind::Chunk(wire::StageChunk {
            staging_id: begun.staging_id.clone(),
            seq: 0,
            payload: bytes.to_vec(),
        }))
    else {
        panic!("stage did not accept the bytes")
    };
    let wire::stage_response::Kind::Handle(staged) =
        frame(wire::stage_request::Kind::End(wire::StageEnd {
            staging_id: begun.staging_id,
        }))
    else {
        panic!("stage did not produce a held handle")
    };
    staged
}

fn tap(selector_id: &str) -> wire::room_event::Kind {
    wire::room_event::Kind::Tap(wire::RoomTap {
        selector_id: selector_id.to_owned(),
    })
}

#[test]
fn staged_vcard_is_previewed_before_confirmed_import() {
    let dir = tempfile::tempdir().expect("temp directory");
    let handle = phone(dir.path());
    let opened = call(
        &handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: "people".to_owned(),
            tab: "people".to_owned(),
            root: true,
            ..Default::default()
        }),
    );
    let root = opened.shown.last().expect("People root is open");

    let requested = call(
        &handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance: root.instance,
            event: Some(wire::RoomEvent {
                kind: Some(tap("more/import")),
            }),
        }),
    );
    let pick = requested
        .effects
        .iter()
        .find(|effect| matches!(effect.kind, Some(wire::shell_effect::Kind::PickFile(_))))
        .expect("import opens a native file picker");
    let staged = stage(&handle, VCARD);
    let preview = call(
        &handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance: root.instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::EffectResult(
                    wire::ShellEffectResult {
                        effect_id: pick.effect_id,
                        outcome: Some(wire::shell_effect_result::Outcome::Picked(
                            wire::ShellPicked {
                                items: vec![wire::ShellPickedItem {
                                    name: "contacts.vcf".to_owned(),
                                    media_type: "text/vcard".to_owned(),
                                    size: staged.byte_size,
                                    stage_handle: Some(staged),
                                    ..Default::default()
                                }],
                            },
                        )),
                    },
                )),
            }),
        }),
    );
    let review = preview.shown.last().expect("People review is shown");
    let review_text = snapshot::render(review.room.as_ref().expect("review room exists"));
    assert!(review_text.contains("1 new"), "{review_text}");
    assert!(review_text.contains("confirm/yes"), "{review_text}");
    assert!(
        preview.effects.is_empty(),
        "preview does not write to the OS"
    );

    let confirmed = call(
        &handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance: review.instance,
            event: Some(wire::RoomEvent {
                kind: Some(tap("confirm/yes")),
            }),
        }),
    );
    let result = confirmed.shown.last().expect("People root returns");
    assert!(
        snapshot::render(result.room.as_ref().expect("room exists")).contains("Imported Contact"),
        "only the explicit confirmation imports the contact"
    );
    assert!(
        result
            .room
            .as_ref()
            .and_then(|room| room.status_line.as_ref())
            .is_some_and(|line| !line.action_label.is_empty()),
        "the import command reports its undo action"
    );
}
