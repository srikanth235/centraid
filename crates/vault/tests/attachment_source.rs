//! WHAT THE CHAT MAY READ FOR AN ATTACHMENT (`Vault::attachment_photo`,
//! `Vault::attachment_document`).
//!
//! The chat takes an asset id or a document id from a shell and asks the vault
//! for bytes or text. These tests pin the rules a member would otherwise meet
//! as a wrong answer: a photograph is read through its `preview` before its
//! original, a video is not an image, a trashed row is not there, a PDF is not
//! text, and a markdown document is.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::content::{DocumentSource, PhotoSource};
use serde_json::{Value, json};

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new(seed: &str) -> Self {
        let scratch = common::Scratch::founded_with_blobs(seed).expect("a vault with a store");
        let registry = Registry::with_system_commands().expect("the system commands register");
        registry
            .install(&scratch.vault)
            .expect("the record installs");
        Self { scratch, registry }
    }

    fn run(&self, command: &str, input: Value) -> Value {
        let outcome = self
            .scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(command, input),
            )
            .expect("the command runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{:?}",
            outcome.reason
        );
        outcome.output
    }

    fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let mut canvas = image::RgbImage::new(width, height);
        for (x, y, pixel) in canvas.enumerate_pixels_mut() {
            *pixel = image::Rgb([(x % 255) as u8, (y % 255) as u8, 90]);
        }
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(canvas)
            .write_to(
                &mut std::io::Cursor::new(&mut out),
                image::ImageFormat::Jpeg,
            )
            .expect("the fixture encodes");
        out
    }

    fn photo(&self, kind: &str, title: &str) -> String {
        let bytes = Self::jpeg(2400, 1600);
        let hash = self
            .scratch
            .vault
            .blobs()
            .expect("a store")
            .put(&bytes)
            .expect("the bytes store");
        self.scratch
            .vault
            .stage_bytes(&[centraid_vault::content::NeededBytes {
                hash: hash.clone(),
                byte_size: i64::try_from(bytes.len()).expect("a small blob"),
                media_type: "image/jpeg".to_owned(),
            }])
            .expect("the staging row lands");
        self.run(
            "media.add_asset",
            json!({ "staged_sha": hash, "kind": kind, "title": title }),
        )["asset_id"]
            .as_str()
            .expect("an asset id")
            .to_owned()
    }

    fn document(&self, title: &str, data_uri: &str) -> String {
        self.run(
            "core.add_document",
            json!({ "title": title, "data_uri": data_uri }),
        )["document_id"]
            .as_str()
            .expect("a document id")
            .to_owned()
    }
}

#[test]
fn a_photograph_is_read_through_its_preview_and_carries_its_caption() {
    let world = World::new("attach-photo");
    let asset = world.photo("photo", "Truckee river bend");
    let source = world
        .scratch
        .vault
        .attachment_photo(&asset)
        .expect("a read");
    let PhotoSource::Held {
        path,
        variant,
        title,
    } = source
    else {
        panic!("a held photograph, not {source:?}");
    };
    assert_eq!(variant, "preview", "the derivative, not the original");
    assert_eq!(title.as_deref(), Some("Truckee river bend"));
    let decoded = image::load_from_memory(&std::fs::read(&path).expect("the file reads"))
        .expect("the preview decodes");
    assert_eq!(
        decoded.width().max(decoded.height()),
        2048,
        "a 2048-pixel preview"
    );
}

#[test]
fn a_video_is_not_an_image_and_a_stranger_is_not_there() {
    let world = World::new("attach-video");
    let video = world.photo("video", "A clip");
    assert_eq!(
        world.scratch.vault.attachment_photo(&video).unwrap(),
        PhotoSource::NotAnImage
    );
    assert_eq!(
        world
            .scratch
            .vault
            .attachment_photo("no-such-asset")
            .unwrap(),
        PhotoSource::Missing
    );
}

#[test]
fn a_markdown_document_is_read_and_a_pdf_is_not() {
    let world = World::new("attach-doc");
    let notes = world.document(
        "Tahoe packing list",
        "data:text/markdown;charset=utf-8,%23%20Packing%0A-%20tent%0A-%20stove",
    );
    assert_eq!(
        world.scratch.vault.attachment_document(&notes).unwrap(),
        DocumentSource::Text {
            title: "Tahoe packing list".to_owned(),
            text: "# Packing\n- tent\n- stove".to_owned()
        }
    );
    let plain = world.document("Plain", "data:text/plain;charset=utf-8,hello");
    assert!(matches!(
        world.scratch.vault.attachment_document(&plain).unwrap(),
        DocumentSource::Text { text, .. } if text == "hello"
    ));

    // A PDF is bytes in the store, not text in the row.
    let hash = world
        .scratch
        .vault
        .blobs()
        .expect("a store")
        .put(b"%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n")
        .expect("the bytes store");
    world
        .scratch
        .vault
        .stage_bytes(&[centraid_vault::content::NeededBytes {
            hash: hash.clone(),
            byte_size: 33,
            media_type: "application/pdf".to_owned(),
        }])
        .expect("staged");
    let pdf = world.run(
        "core.add_document",
        json!({ "title": "Lease", "staged_sha": hash }),
    )["document_id"]
        .as_str()
        .expect("a document id")
        .to_owned();
    assert_eq!(
        world.scratch.vault.attachment_document(&pdf).unwrap(),
        DocumentSource::Unsupported {
            media_type: "application/pdf".to_owned()
        }
    );
    assert_eq!(
        world.scratch.vault.attachment_document("nope").unwrap(),
        DocumentSource::Missing
    );
}

#[test]
fn a_trashed_document_is_not_there() {
    let world = World::new("attach-trash");
    let id = world.document("Gone", "data:text/plain;charset=utf-8,x");
    world.run("core.trash_document", json!({ "document_id": id }));
    assert_eq!(
        world.scratch.vault.attachment_document(&id).unwrap(),
        DocumentSource::Missing
    );
}

#[test]
fn the_picker_lists_only_what_an_attach_would_read() {
    let world = World::new("attach-list");
    let older = world.document("Older note", "data:text/plain;charset=utf-8,one");
    let newer = world.document(
        "Newer markdown",
        "data:text/markdown;charset=utf-8,%23%20two",
    );
    let hash = world
        .scratch
        .vault
        .blobs()
        .expect("a store")
        .put(b"%PDF-1.7\n%%EOF\n")
        .expect("the bytes store");
    world
        .scratch
        .vault
        .stage_bytes(&[centraid_vault::content::NeededBytes {
            hash: hash.clone(),
            byte_size: 15,
            media_type: "application/pdf".to_owned(),
        }])
        .expect("staged");
    world.run(
        "core.add_document",
        json!({ "title": "A PDF", "staged_sha": hash }),
    );
    let trashed = world.document("Trashed", "data:text/plain;charset=utf-8,x");
    world.run("core.trash_document", json!({ "document_id": trashed }));

    let listed = world
        .scratch
        .vault
        .attachable_documents(10)
        .expect("a list");
    let titles: Vec<&str> = listed.iter().map(|d| d.title.as_str()).collect();
    assert_eq!(
        titles.len(),
        2,
        "the PDF and the trashed one are not offered: {titles:?}"
    );
    assert!(titles.contains(&"Older note") && titles.contains(&"Newer markdown"));
    assert!(listed.iter().any(|d| d.document_id == older));
    assert!(listed.iter().any(|d| d.document_id == newer));
    assert_eq!(
        world
            .scratch
            .vault
            .attachable_documents(1)
            .expect("a list")
            .len(),
        1
    );
}
