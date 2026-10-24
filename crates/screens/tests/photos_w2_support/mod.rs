//! Arranging a real vault for the shelf, picker and places tests: photographs,
//! albums, and the writes another surface would make while a screen is open.
#![allow(dead_code)]

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::field::Keyed;
use centraid_screens::kit::act as kit_act;
use centraid_screens::photos;
use centraid_screens::testing::Driver;

pub fn driver() -> Driver {
    let mut driver = Driver::with_runtime(photos::runtime());
    driver.start();
    driver
}

fn command(d: &Driver, name: &str, input: serde_json::Value) {
    let response = d
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Command(wire::Command {
                name: name.to_owned(),
                input: serde_json::to_vec(&input).expect("json"),
                invoke_key: format!("w2:{name}:{}", kit_act::fresh()),
                ..wire::Command::default()
            })),
        })
        .unwrap_or_else(|error| panic!("{name} refused: {error}"));
    let Some(wire::response::Kind::Command(outcome)) = response.kind else {
        panic!("a command answered with something else");
    };
    assert_eq!(
        outcome.status,
        wire::CommandStatus::Executed as i32,
        "{name}: {}",
        outcome.reason
    );
}

/// Run an action another surface would, and answer its output.
pub fn arrange(d: &Driver, request: impl Into<wire::ActRequest>) -> serde_json::Value {
    let response = d.act(request.into().keyed(format!("arrange:{}", kit_act::fresh())));
    assert_eq!(
        response.status,
        wire::ActStatus::Executed as i32,
        "{}",
        response.reason
    );
    serde_json::from_slice(&response.output).unwrap_or(serde_json::Value::Null)
}

/// One photograph in the library; the seed makes its bytes unique.
pub fn photo(d: &Driver, seed: &str) -> String {
    let hash = centraid_vault::blob::content_digest(seed.as_bytes());
    command(
        d,
        "blob.stage",
        serde_json::json!({ "hash": hash, "size": seed.len() }),
    );
    let out = arrange(
        d,
        act::photos::Upload {
            blob: hash,
            media_type: "image/jpeg".to_owned(),
            form: Some(act::photos::UploadForm::Photo),
            ..Default::default()
        },
    );
    out["id"].as_str().expect("an id").to_owned()
}

pub fn album(d: &Driver, title: &str) -> String {
    let out = arrange(
        d,
        act::photos::CreateAlbum {
            title: title.to_owned(),
            id: None,
        },
    );
    out["id"].as_str().expect("an id").to_owned()
}

pub fn put_in(d: &Driver, album: &str, photo: &str) {
    arrange(
        d,
        act::photos::AddToAlbum {
            from: album.to_owned(),
            to: photo.to_owned(),
            ..Default::default()
        },
    );
}

pub fn trash(d: &Driver, photo: &str) {
    arrange(
        d,
        act::photos::DeletePhoto {
            photo_id: photo.to_owned(),
        },
    );
}

pub fn star(d: &Driver, photo: &str) {
    arrange(
        d,
        act::photos::FlagPhoto {
            photo_id: photo.to_owned(),
        },
    );
}

pub fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|id| (*id).to_owned()).collect()
}
