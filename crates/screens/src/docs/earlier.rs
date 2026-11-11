//! DOCS' EARLIER VERSIONS: the kit's one earlier-versions screen with Docs' spec (#1185).
//!
//! A document keeps its bytes, its name and the folder it is filed in. The line a version reads as
//! is what changed in it: for replaced bytes, the earlier file's type and size as the page words
//! them ("PDF · 2.4 MB", the info card's line); for a rename, the earlier name; for a move, the
//! earlier folder by name ("Docs" for the top level). A version that changed only what the page
//! does not show reads "Other details".
//!
//! Opening or sharing an earlier file before restoring was never offered by the old versions
//! screen (it listed sizes and dates), so it is not here either.

use serde_json::Value;
use wire::app_query_response::Answer;

use super::{denied, fold, folders};
use crate::catalog::load;
use crate::kit::earlier::{self, EarlierSpec, Field, Look, Names};
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{docs as words, shared};
use centraid_api_proto::core_v1 as wire;

/// Docs' earlier versions, as the kit's screen takes it.
pub static SPEC: EarlierSpec = EarlierSpec {
    app: "docs",
    noun: shared::trash_noun_document,
    denied,
    line,
    know: Some(know),
    gate: None,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    earlier::build(&SPEC, route)
}

/// The key a blob's file type is kept under among [`Names`] (the blob's own hash keeps its size).
fn kind_key(blob: &str) -> String {
    format!("kind:{blob}")
}

/// What the ids a version names stand for: each version's size and type by the hash of its bytes,
/// and each folder's name.
fn know(ctx: &Ctx, document_id: &str) -> Names {
    let mut names = Names::new();
    if let Reading::Data(history) = read::read(
        ctx,
        load::docs::History {
            document_id: document_id.to_owned(),
        },
        |answer| match answer {
            Answer::DocsDocument(document) => Some(document),
            _ => None,
        },
    ) {
        for version in &history.versions {
            names.insert(
                version.content_id.clone(),
                fold::size(ctx.locale(), ctx.units(), version.byte_size),
            );
            names.insert(
                kind_key(&version.content_id),
                kind_name(&version.media_type),
            );
        }
    }
    if let Reading::Data(drive) = read::read(
        ctx,
        load::docs::Drive {
            limit: 1,
            ..Default::default()
        },
        |answer| match answer {
            Answer::DocsDrive(drive) => Some(drive),
            _ => None,
        },
    ) {
        for folder in &drive.folders {
            names.insert(
                folder.folder_id.clone(),
                folders::label(ctx.locale(), &folder.name),
            );
        }
    }
    names
}

fn kind_name(media_type: &str) -> String {
    centraid_apps_docs::kind::kind_of(Some(media_type), None)
        .name()
        .to_owned()
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The one line a document's fields read as: `Lease · PDF · 2.4 MB · Taxes 2025`.
fn line(look: &Look, fields: &[Field]) -> String {
    let named = |name: &str| fields.iter().find(|field| field.name == name);
    let title = named("entity.title").and_then(|field| text(&field.value));
    let blob = named("document.blob").and_then(|field| text(&field.value));
    let kind = named("document.media_type")
        .and_then(|field| text(&field.value))
        .map(|media_type| kind_name(&media_type))
        .or_else(|| {
            blob.as_ref()
                .and_then(|blob| look.names.get(&kind_key(blob)).cloned())
        });
    let size = blob
        .as_ref()
        .and_then(|blob| look.names.get(blob))
        .filter(|size| !size.is_empty())
        .cloned();
    let file = [kind, size]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
    let folder = named("document.folder_id").and_then(|field| {
        text(&field.value).map_or_else(
            || Some(words::subtitle_root(look.locale)),
            |id| look.names.get(&id).cloned(),
        )
    });
    [title, Some(file).filter(|file| !file.is_empty()), folder]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ")
}
