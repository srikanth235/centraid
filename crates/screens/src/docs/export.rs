//! DOCS' EXPORT (`docs.export`, #1185), the kit's one export screen over `document.export_zip`:
//! the rows are "All documents" and each top-level folder, and the archive the command writes is
//! a STREAMED FILE (owner decision D17): the core stages the zip on disk and the OS save sheet
//! copies it by streaming (`SaveFilePath`), so an export of a large drive never sits in memory.
//! The owner check comes first, as for every export.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog::{act, load};
use crate::field::Field;
use crate::kit::act as kit_act;
use crate::kit::export::{self, Choice, ExportSpec, Made};
use crate::kit::owner::NoPasscode;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::docs as words;

/// The row that exports every document.
const ALL: &str = "all";

static SPEC: ExportSpec = ExportSpec {
    app: act::docs::APP,
    title: words::export_title,
    lede: words::export_lede,
    back_label: words::app_title,
    denied: super::denied,
    choices,
    export,
    no_passcode: NoPasscode::Warn,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    export::build(&SPEC, route)
}

/// "All documents" and each folder at the top level (the folders below one go with it).
fn choices(ctx: &Ctx) -> Reading<Vec<Choice>> {
    let drive = read::read(
        ctx,
        load::docs::Drive {
            limit: 1,
            ..Default::default()
        },
        |answer| match answer {
            Answer::DocsDrive(drive) => Some(drive),
            _ => None,
        },
    );
    match drive {
        Reading::Data(drive) => {
            let mut rows = vec![Choice {
                key: ALL.to_owned(),
                label: words::export_all(ctx.locale()),
                value: String::new(),
            }];
            rows.extend(
                drive
                    .folders
                    .iter()
                    .filter(|folder| folder.parent_id.is_empty())
                    .map(|folder| Choice {
                        key: folder.folder_id.clone(),
                        label: super::folders::label(ctx.locale(), &folder.name),
                        value: String::new(),
                    }),
            );
            Reading::Data(rows)
        }
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}

/// The archive of one folder (and the folders below it) or of every document, staged on disk
/// through the same command the export screen calls. Nothing in it means nothing to save.
fn export(ctx: &Ctx, key: &str) -> Result<Made, String> {
    // undo-exempt: an export writes nothing (`writes_nothing` in the manifest), so there is nothing to take back.
    let settled = kit_act::act(
        ctx,
        act::docs::ExportZip {
            folder_id: if key == ALL {
                Field::Keep
            } else {
                Field::Is(key.to_owned())
            },
        },
        &kit_act::key(&["document.export_zip", key], kit_act::fresh()),
    );
    let staged = export::staged_of(&settled, "application/zip", "Documents.zip")?;
    if crate::kit::transfer::count(&settled.output, "count") == 0 {
        return Err(words::export_nothing(ctx.locale()));
    }
    Ok(staged.into())
}
