//! PHOTOS' EXPORT (`photos.export`, #1185), the kit's one export screen over `photo.export_zip`:
//! the rows are "All photos and videos" and each album, and the archive the command writes is a
//! STREAMED FILE (owner decision D17): the core stages the zip on disk and the OS save sheet
//! copies it by streaming (`SaveFilePath`), so an export of a large library never sits in memory.
//! The archive holds the originals as stored, named by when they were taken. The owner check
//! comes first, as for every export.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog::{act, load};
use crate::field::Field;
use crate::kit::act as kit_act;
use crate::kit::export::{self, Choice, ExportSpec, Made};
use crate::kit::owner::NoPasscode;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, photos as words, photos_lightbox as own};

/// The row that exports every photograph and video.
const ALL: &str = "all";

static SPEC: ExportSpec = ExportSpec {
    app: act::photos::APP,
    title: words::photos_export_title,
    lede: words::photos_export_lede,
    back_label: words::photos_title,
    denied,
    choices,
    export,
    no_passcode: NoPasscode::Warn,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    export::build(&SPEC, route)
}

fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    wire::Denied {
        title: own::denied_title(locale),
        body: own::denied_body(locale),
        receipt: denial.code.clone().unwrap_or_default(),
    }
}

/// "All photos and videos" and each album.
fn choices(ctx: &Ctx) -> Reading<Vec<Choice>> {
    let albums = read::read(
        ctx,
        load::photos::Albums::default(),
        |answer| match answer {
            Answer::PhotosAlbums(albums) => Some(*albums),
            _ => None,
        },
    );
    match albums {
        Reading::Data(albums) => {
            let mut rows = vec![Choice {
                key: ALL.to_owned(),
                label: words::photos_export_all(ctx.locale()),
                value: String::new(),
            }];
            rows.extend(albums.albums.iter().map(|album| Choice {
                key: album.album_id.clone(),
                label: if album.title.is_empty() {
                    words::photos_untitled_album(ctx.locale())
                } else {
                    album.title.clone()
                },
                value: String::new(),
            }));
            Reading::Data(rows)
        }
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}

/// The archive of one album or of the whole library, staged on disk through the same command the
/// export screen calls. Nothing in it means nothing to save.
fn export(ctx: &Ctx, key: &str) -> Result<Made, String> {
    // undo-exempt: an export writes nothing (`writes_nothing` in the manifest), so there is nothing to take back.
    let settled = kit_act::act(
        ctx,
        act::photos::ExportZip {
            album_id: if key == ALL {
                Field::Keep
            } else {
                Field::Is(key.to_owned())
            },
        },
        &kit_act::key(&["photo.export_zip", key], kit_act::fresh()),
    );
    let mut staged = export::staged_of(&settled, "application/zip", "Photos.zip")?;
    let count = crate::kit::transfer::count(&settled.output, "count");
    let missing = crate::kit::transfer::count(&settled.output, "missing");
    if let Some(sentence) = nothing_to_save(ctx.locale(), count, missing) {
        return Err(sentence);
    }
    // SOME ORIGINALS ARE NOT ON THIS PHONE: the status line says how many were left out, and why.
    if staged.missing > 0 {
        staged.left_out_why = words::photos_export_left_out_why(ctx.locale());
    }
    Ok(staged.into())
}

/// WHY AN ARCHIVE HOLDS NOTHING: the library is empty, or it holds photographs whose originals are
/// not on this phone (a camera-roll import keeps them in the phone's own library, a freed-up one
/// on a gateway). Never "no photos" while the library holds some.
fn nothing_to_save(locale: crate::strings::Locale, count: u32, missing: u32) -> Option<String> {
    match (count, missing) {
        (0, 0) => Some(words::photos_export_nothing(locale)),
        (0, _) => Some(words::photos_export_not_here(locale)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::strings::Locale;

    #[test]
    fn a_library_whose_originals_are_elsewhere_is_not_an_empty_one() {
        let said = |count, missing| nothing_to_save(Locale::En, count, missing);
        assert_eq!(
            said(0, 0).as_deref(),
            Some("There are no photos or videos on this phone to export.")
        );
        assert!(said(0, 3).is_some_and(|line| line.contains("not on this phone")));
        assert_eq!(said(2, 1), None);
    }
}
