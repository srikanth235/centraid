//! NOTES' EXPORT (`notes.export`, #1185), the kit's one export screen over `note.export`: the
//! rows are "All notes" and each notebook, and the archive the command answers goes to the OS
//! save sheet once the owner check passed.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::export::{self, Choice, ExportSpec};
use crate::kit::owner::NoPasscode;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::notes as words;

/// The row that exports every note.
const ALL: &str = "all";

static SPEC: ExportSpec = ExportSpec {
    app: "notes",
    title: words::transfer_export_title,
    lede: words::transfer_export_lede,
    back_label: words::title,
    denied: super::denied,
    choices,
    export,
    no_passcode: NoPasscode::Warn,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    export::build(&SPEC, route)
}

fn choices(ctx: &Ctx) -> Reading<Vec<Choice>> {
    let locale = ctx.locale();
    let notebooks = read::read(ctx, load::notes::Notebooks {}, |answer| match answer {
        Answer::NotesNotebooks(notebooks) => Some(notebooks),
        _ => None,
    });
    match notebooks {
        Reading::Data(notebooks) => {
            let mut rows = vec![Choice {
                key: ALL.to_owned(),
                label: words::transfer_export_all(locale),
                value: String::new(),
            }];
            rows.extend(notebooks.notebooks.iter().map(|book| Choice {
                key: book.notebook_id.clone(),
                label: super::fold::notebook_name(locale, book),
                value: book.note_count.to_string(),
            }));
            Reading::Data(rows)
        }
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}

fn export(ctx: &Ctx, key: &str) -> Result<export::ExportFile, String> {
    // undo-exempt: an export writes nothing (`writes_nothing` in the manifest), so there is nothing to take back.
    let settled = kit_act::act(
        ctx,
        act::notes::ExportNotes {
            notebook_id: (key != ALL).then(|| key.to_owned()),
        },
        &kit_act::key(&["note.export", key], kit_act::fresh()),
    );
    export::file_of(&settled, "application/zip", "Notes.zip")
}
