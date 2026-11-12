//! PHOTOS' EARLIER VERSIONS: the kit's one earlier-versions screen with Photos' spec (#1185).
//!
//! A photograph keeps what the member can change on it and the details sheet shows: its caption,
//! when it was captured (the time and its offset, worded as the sheet words the "Captured" fact) and
//! its place. A version's line is the ones it held: `Caption: Morning walk · 4 November 2026 07:48 ·
//! Cubbon Park`. Labels, stars and archive are flags with their own verbs, and albums and people
//! are links; none is a version. The pixels are not here either: an EDITED photograph is a NEW
//! photograph with the original as its source, so editing never makes a version of the original.
//! What the sheet does not show reads "Other details".

use centraid_api_proto::core_v1 as wire;
use serde_json::Value;
use wire::app_query_response::Answer;

use super::lightbox::offset_label;
use super::{cells, media};
use crate::catalog::load;
use crate::kit::earlier::{self, EarlierSpec, Field, Look, Names};
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{fill, photos_lightbox as own, shared};

/// Photos' earlier versions, as the kit's screen takes it.
pub static SPEC: EarlierSpec = EarlierSpec {
    app: "photos",
    noun: shared::trash_noun_photo,
    denied,
    parts,
    know: Some(know),
    gate: None,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    earlier::build(&SPEC, route)
}

fn denied(locale: crate::strings::Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    wire::Denied {
        title: own::denied_title(locale),
        body: own::denied_body(locale),
        receipt: denial.code.clone().unwrap_or_default(),
    }
}

/// The key of the photograph's own offset among [`Names`], which no id can be.
const OWN_OFFSET: &str = "photo.offset";

/// The names a version's ids stand for: each place the vault lists, and the offset the photograph
/// is captured in now, for a time that changed without one beside it.
fn know(ctx: &Ctx, photo_id: &str) -> Names {
    let mut names = Names::new();
    if let Reading::Data(places) =
        read::read(
            ctx,
            load::photos::Places::default(),
            |answer| match answer {
                Answer::PhotosPlaces(places) => Some(places),
                _ => None,
            },
        )
    {
        for card in &places.places {
            let Some(place) = card.place.as_ref() else {
                continue;
            };
            let name = card
                .name
                .clone()
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| card.phrase.clone());
            names.insert(place.place_id.clone(), name);
        }
    }
    if let Reading::Data(found) = read::read(
        ctx,
        load::photos::Photo {
            id: photo_id.to_owned(),
        },
        |answer| match answer {
            Answer::PhotosPhoto(found) => Some(found),
            _ => None,
        },
    ) {
        let cell = found.photo.and_then(|photo| photo.cell);
        if let Some(offset) = cell.and_then(|cell| cell.offset_min) {
            names.insert(OWN_OFFSET.to_owned(), offset.to_string());
        }
    }
    names
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The one line a photograph's fields read as.
fn parts(look: &Look, fields: &[Field]) -> Vec<String> {
    let locale = look.locale;
    let named = |name: &str| fields.iter().find(|field| field.name == name);
    let mut parts = Vec::new();
    if let Some(field) = named("entity.title") {
        parts.push(Some(text(&field.value).map_or_else(
            || own::earlier_no_caption(locale),
            |caption| fill(&own::earlier_caption(locale), &[("caption", &caption)]),
        )));
    }
    let offset = named("photo.offset_min")
        .and_then(|field| field.value.as_i64())
        .or_else(|| look.names.get(OWN_OFFSET).and_then(|n| n.parse().ok()))
        .unwrap_or(0);
    match named("photo.taken_at").and_then(|field| text(&field.value)) {
        Some(at) => {
            let day = media::stamp_date(locale, &at, offset);
            let clock = cells::capture_clock(locale, &at, offset, look.cycle);
            parts.push(Some(format!("{day} {clock}").trim().to_owned()));
        }
        // An offset corrected on its own.
        None if named("photo.taken_at").is_none() => {
            if let Some(field) = named("photo.offset_min") {
                parts.push(field.value.as_i64().map(|minutes| {
                    if minutes == 0 {
                        own::utc(locale)
                    } else {
                        offset_label(minutes)
                    }
                }));
            }
        }
        None => {}
    }
    if let Some(field) = named("photo.place_id") {
        parts.push(Some(match text(&field.value) {
            Some(id) => look
                .names
                .get(&id)
                .map(|name| name.trim().to_owned())
                .filter(|name| !name.is_empty())
                .unwrap_or_default(),
            None => own::earlier_no_place(locale),
        }));
    }
    parts
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect()
}
