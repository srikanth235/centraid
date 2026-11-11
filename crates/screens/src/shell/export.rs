//! EXPORT EVERYTHING (`home.export`, #1185), the kit's one export screen over `vault.export_all`:
//! one row, "Everything on this phone", and the archive the command writes is a STREAMED FILE
//! (owner decision D17): the core stages the zip on disk and the OS save sheet copies it by
//! streaming (`SaveFilePath`), so a large library never sits in memory. The owner check comes
//! first, as for every export. **Locker is not in it** (owner decision D11): its contents leave
//! only through its own export, which asks its own, stricter check.
//!
//! Not an app's action: `vault.export_all` is one of the shell's own commands, run through
//! [`Ctx::command`] and declared by no manifest. It writes nothing to the vault.

use centraid_api_proto::core_v1 as wire;

use crate::kit::act as kit_act;
use crate::kit::export::{self, Choice, ExportSpec, Made};
use crate::kit::owner::NoPasscode;
use crate::kit::read::Reading;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, settings as words, shared};

/// The one row.
const ALL: &str = "all";

static SPEC: ExportSpec = ExportSpec {
    app: "shell",
    title: words::settings_export_title,
    lede: words::settings_export_lede,
    back_label: words::settings_title,
    denied,
    choices,
    export,
    no_passcode: NoPasscode::Warn,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    export::build(&SPEC, route)
}

/// The page reads nothing the vault could refuse; this is only the type's answer.
fn denied(locale: Locale, _denial: &wire::AppQueryDenial) -> wire::Denied {
    wire::Denied {
        title: shared::export_failed(locale),
        body: String::new(),
        receipt: String::new(),
    }
}

fn choices(ctx: &Ctx) -> Reading<Vec<Choice>> {
    Reading::Data(vec![Choice {
        key: ALL.to_owned(),
        label: words::settings_export_all(ctx.locale()),
        value: words::settings_export_all_value(ctx.locale()),
    }])
}

/// The archive of every app but Locker, staged on disk by the vault.
fn export(ctx: &Ctx, key: &str) -> Result<Made, String> {
    // undo-exempt: an export writes nothing, so there is nothing to take back.
    let settled = ctx.command(
        "vault.export_all",
        &serde_json::json!({}),
        &kit_act::key(&["vault.export_all", key], kit_act::fresh()),
    );
    Ok(export::staged_of(&settled, "application/zip", "Centraid export.zip")?.into())
}
