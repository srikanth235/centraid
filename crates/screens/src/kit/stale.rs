//! A SAVE THAT CHECKS WHAT IT IS REPLACING (#1185): the words every editor says when the vault
//! refuses a save because the record is no longer the one the screen read.
//!
//! Every editor reads the record's revision with the record and names it (`expected_rev`) in
//! each save. The vault refuses a save whose record changed since (`stale_revision`) or was moved
//! to the trash (`stale_trashed`); [`super::act::Settled::stale`] says which. What the member then
//! sees is the same in every app:
//!
//! - **The sentence**, over their words, which stay: "This note changed somewhere else." or "This
//!   note was moved to the trash." ([`sentence`]), with one verb, Reload ([`line`]).
//! - **Reload** first keeps the member's unsaved words as the newest earlier version of the
//!   record ([`keep`]: the shell's `keep-version`, which leaves the record as the vault has it),
//!   then the screen reads the record again. It says where the words went ([`kept`]). A record in
//!   the trash is shown as trashed; the words come back with it, in its Earlier versions.
//!
//! An autosaving editor gets all of this from [`super::autosave::Autosave`]. An editor that saves
//! on a button (an event, an account, a Locker item) calls these directly: it reads the revision
//! with [`read_rev`] before the record, names it in the save, and on a refusal
//! ([`super::act::Settled::stale`]) calls [`on_button`], which keeps the words and returns the
//! sentence the screen says over the record it then reads again (the Reload is done for the
//! member, who has just pressed Save and has nothing else to press).

use centraid_api_proto::core_v1 as wire;

pub use super::act::Stale;
use super::act::{self as kit_act, Settled};
use crate::catalog::act as catalog_act;
use crate::screen::Ctx;
use crate::strings::{Locale, fill, shared};

/// The sentence over the words of a refused save; `noun` is what the record is called.
#[must_use]
pub fn sentence(locale: Locale, noun: &str, stale: Stale) -> String {
    let template = match stale {
        Stale::Changed => shared::stale_changed_note(locale),
        Stale::Trashed => shared::stale_trashed_note(locale),
    };
    fill(&template, &[("noun", noun)])
}

/// The status line of a conflict: the sentence and its one verb.
#[must_use]
pub fn line(locale: Locale, noun: &str, stale: Stale) -> wire::StatusLine {
    wire::StatusLine {
        sentence: sentence(locale, noun, stale),
        action_label: shared::stale_reload_label(locale),
        refused: true,
    }
}

/// What the status line says after Reload kept the words: where they are.
#[must_use]
pub fn kept(locale: Locale) -> String {
    shared::stale_kept_note(locale)
}

/// What a trashed record's page says after Reload kept the words: how to find them.
#[must_use]
pub fn kept_in_trash(locale: Locale) -> String {
    shared::stale_trashed_kept_note(locale)
}

/// What keeping the words came to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Kept {
    /// A version was written (the record did not already hold the words).
    pub written: bool,
    /// The tables the commit wrote, for a screen that tells its own changes from foreign ones.
    pub tables: Vec<String>,
}

/// Keep `fields` (`table.column` to the value the member typed) as the newest earlier version of
/// record `id`; the record itself is not changed. `Err` carries the vault's sentence, and then
/// nothing was kept.
///
/// # Errors
///
/// The vault's refusal, as a sentence.
pub fn keep(ctx: &Ctx, id: &str, fields: Vec<(String, serde_json::Value)>) -> Result<Kept, String> {
    let request: wire::ActRequest = catalog_act::shell::KeepVersion {
        earlier_version_id: id.to_owned(),
        fields: serde_json::Value::Object(fields.into_iter().collect()).to_string(),
    }
    .into();
    let key = kit_act::key(&["keep-version", id], kit_act::fresh());
    let settled: Settled = kit_act::act(ctx, request, &key);
    if !settled.committed {
        return Err(settled.refusal);
    }
    Ok(Kept {
        written: settled.output_flag("kept").unwrap_or(true),
        tables: settled.tables,
    })
}

/// `request`, naming the revision it replaces (`expected_rev`) when it is one of `actions` and
/// names none: for a screen whose writes go through one door and only some are saves of the
/// record's own fields.
#[must_use]
pub fn guarded(
    mut request: wire::ActRequest,
    actions: &[&str],
    rev: Option<i64>,
) -> wire::ActRequest {
    if let Some(rev) = rev
        && actions.contains(&request.action.as_str())
    {
        request
            .input
            .entry("expected_rev".to_owned())
            .or_insert_with(|| crate::field::whole(rev));
    }
    request
}

/// The record's revision, as a button-save editor reads it: how many earlier versions the
/// record's history holds, which is the newest version's number. Read it BEFORE the record, so a
/// change landing between the two refuses the save instead of slipping past it. `None` when the
/// read did not land (the save then names none).
#[must_use]
pub fn read_rev(ctx: &Ctx, id: &str) -> Option<i64> {
    use crate::catalog::load;
    use crate::kit::read::{self, Reading};
    use wire::app_query_response::Answer;
    match read::read(
        ctx,
        load::shell::EarlierCount {
            entity_id: id.to_owned(),
        },
        |answer| match answer {
            Answer::EarlierCount(counted) => Some(counted.count),
            _ => None,
        },
    ) {
        Reading::Data(count) => Some(i64::from(count)),
        _ => None,
    }
}

/// What a button-save the vault refused as stale comes to: the words are kept as the newest
/// earlier version (`fields`, as [`keep`] takes them; none keeps nothing) and the sentence is the
/// one to say over the record as the vault has it now, with where the words went.
#[must_use]
pub fn on_button(
    ctx: &Ctx,
    noun: &str,
    id: &str,
    stale: Stale,
    fields: Vec<(String, serde_json::Value)>,
) -> String {
    let locale = ctx.locale();
    let said = sentence(locale, noun, stale);
    if fields.is_empty() {
        return said;
    }
    match keep(ctx, id, fields) {
        Ok(Kept { written: true, .. }) => {
            let where_to = match stale {
                Stale::Changed => kept(locale),
                Stale::Trashed => kept_in_trash(locale),
            };
            format!("{said} {where_to}")
        }
        _ => said,
    }
}
