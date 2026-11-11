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
    let staged = export::staged_of(&settled, "application/zip", "Photos.zip")?;
    if crate::kit::transfer::count(&settled.output, "count") == 0 {
        return Err(words::photos_export_nothing(ctx.locale()));
    }
    Ok(staged.into())
}
