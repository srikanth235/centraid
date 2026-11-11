//! NOTES' IMPORT (`notes.import`; #1173, item 14), the kit's transfer screen over Notes' import
//! command. The export is the kit's one export screen (`export.rs`).
//!
//! **Import is choose → preview → tap.** Choosing files or a folder is a `PickBytes` effect;
//! the picked text is held here while `note.import` is asked with `dry_run`, which writes
//! nothing and answers what importing would do. The primary action is the member's tap, and
//! only it writes. A second import of the same files adds nothing (the command skips a note it
//! already has).

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;

use crate::catalog::act;
use crate::kit::act as kit_act;
use crate::kit::transfer::{self, TextFile, action, row};
use crate::kit::undo::Undo as Door;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, notes as words};

/// The extensions an import offers the picker.
const ACCEPT: [&str; 4] = ["md", "markdown", "txt", "text/plain"];

const FILES: &str = "files";
const FOLDER: &str = "folder";
const AGAIN: &str = "again";
const IMPORT: &str = "import";

/// The `import-notes` request for the picked files: the dry run and the write say the same
/// arrival, the picked folder's (or file's) name, so the vault records one origin for them.
fn import_request(files: &[TextFile], dry_run: Option<bool>) -> act::notes::ImportNotes {
    let label = transfer::arrival_name(files);
    act::notes::ImportNotes {
        files: transfer::files_json(files),
        dry_run,
        arrived_system: label
            .is_some()
            .then_some(act::notes::ImportNotesArrivedSystem::Markdown),
        arrived_label: label,
    }
}

#[must_use]
pub fn build_import(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::Transfer(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Transfer {
        back: args.back_label.clone(),
        files: Vec::new(),
        plan: None,
        stage: Stage::Choosing,
        line: Door::default(),
    }))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// Nothing chosen yet, or the choice was empty.
    Choosing,
    /// The picker or the preview is under way.
    Reading,
    /// The preview is up and waits for the tap.
    Planned,
    /// The write is under way.
    Writing,
    /// It is done.
    Done,
}

/// What `note.import` answered with `dry_run`.
#[derive(Clone, Default)]
struct Plan {
    notes: u32,
    skipped: u32,
    ignored: u32,
    tags: u32,
    notebooks: u32,
    links: u32,
    unresolved: u32,
}

struct Transfer {
    back: String,
    files: Vec<TextFile>,
    plan: Option<Plan>,
    stage: Stage,
    line: Door,
}

impl Transfer {
    fn refuse(&mut self, sentence: String) {
        self.line.refuse(sentence);
    }

    fn say(&mut self, sentence: String) {
        self.line.say(sentence);
    }
    fn pick(folder: bool) -> Vec<wire::Effect> {
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::PickBytes(wire::PickBytes {
                accept: ACCEPT.iter().map(|entry| (*entry).to_owned()).collect(),
                multiple: !folder,
                folder,
            })),
        }]
    }

    fn picked(&mut self, ctx: &Ctx, picked: &wire::BytesPicked) {
        if picked.cancelled {
            return;
        }
        self.files = transfer::picked_files(picked);
        self.line.clear();
        self.stage = Stage::Reading;
        let key = kit_act::key(&["note.import", "dry"], kit_act::fresh());
        let settled = self
            .line
            .act_quietly(ctx, import_request(&self.files, Some(true)), &key);
        if !settled.committed {
            self.stage = Stage::Choosing;
            self.refuse(settled.refusal);
            return;
        }
        let plan = Plan {
            notes: transfer::count(&settled.output, "notes"),
            skipped: transfer::count(&settled.output, "skipped"),
            ignored: transfer::count(&settled.output, "ignored"),
            tags: transfer::count(&settled.output, "tags"),
            notebooks: transfer::count(&settled.output, "notebooks"),
            links: transfer::count(&settled.output, "links"),
            unresolved: transfer::count(&settled.output, "unresolved"),
        };
        self.stage = Stage::Planned;
        self.plan = Some(plan);
    }

    fn write(&mut self, ctx: &Ctx) {
        let locale = ctx.locale();
        let Some(plan) = self.plan.clone().filter(|plan| plan.notes > 0) else {
            return;
        };
        self.stage = Stage::Writing;
        let key = kit_act::key(&["note.import"], kit_act::fresh());
        let settled = self
            .line
            .act_quietly(ctx, import_request(&self.files, None), &key);
        if settled.committed {
            let made = transfer::count(&settled.output, "notes");
            self.say(fill(
                &words::transfer_import_done(locale),
                &[("n", &made.to_string())],
            ));
            self.stage = Stage::Done;
            self.files.clear();
            self.plan = Some(Plan {
                notes: made,
                ..Plan::default()
            });
            let _ = plan;
        } else {
            self.stage = Stage::Planned;
            self.refuse(settled.refusal);
        }
    }

    fn rows_and_actions(
        &self,
        locale: Locale,
    ) -> (Vec<wire::TransferRow>, Vec<wire::TransferAction>, String) {
        let choose = |primary: bool| {
            vec![
                action(
                    FILES,
                    &words::transfer_choose_files_action(locale),
                    primary,
                    true,
                ),
                action(
                    FOLDER,
                    &words::transfer_choose_folder_action(locale),
                    false,
                    true,
                ),
            ]
        };
        match (self.stage, &self.plan) {
            (Stage::Planned | Stage::Writing, Some(plan)) if plan.notes > 0 => {
                let mut rows = vec![row(
                    "notes",
                    &words::transfer_row_notes(locale),
                    &plan.notes.to_string(),
                    false,
                    "",
                )];
                for (key, label, value) in [
                    ("links", words::transfer_row_links(locale), plan.links),
                    ("tags", words::transfer_row_tags(locale), plan.tags),
                    (
                        "notebooks",
                        words::transfer_row_notebooks(locale),
                        plan.notebooks,
                    ),
                    (
                        "unlinked",
                        words::transfer_row_unlinked(locale),
                        plan.unresolved,
                    ),
                    ("skipped", words::transfer_row_skipped(locale), plan.skipped),
                    ("ignored", words::transfer_row_ignored(locale), plan.ignored),
                ] {
                    if value > 0 {
                        rows.push(row(key, &label, &value.to_string(), false, ""));
                    }
                }
                let actions = vec![
                    action(
                        IMPORT,
                        &fill(
                            &words::transfer_import_action(locale),
                            &[("n", &plan.notes.to_string())],
                        ),
                        true,
                        self.stage == Stage::Planned,
                    ),
                    action(
                        AGAIN,
                        &words::transfer_choose_again_action(locale),
                        false,
                        self.stage == Stage::Planned,
                    ),
                ];
                (rows, actions, words::transfer_import_ready(locale))
            }
            (Stage::Planned, Some(_)) => (
                Vec::new(),
                choose(true),
                words::transfer_import_nothing(locale),
            ),
            (Stage::Done, Some(plan)) => (
                Vec::new(),
                choose(false),
                fill(
                    &words::transfer_import_done(locale),
                    &[("n", &plan.notes.to_string())],
                ),
            ),
            _ => (
                Vec::new(),
                choose(true),
                words::transfer_import_headline(locale),
            ),
        }
    }
}

impl Screen for Transfer {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Transfer(tapped)) => match tapped.key.as_str() {
                FILES if self.stage != Stage::Writing => Self::pick(false),
                FOLDER if self.stage != Stage::Writing => Self::pick(true),
                AGAIN if self.stage == Stage::Planned => {
                    self.stage = Stage::Choosing;
                    self.plan = None;
                    self.files.clear();
                    Vec::new()
                }
                IMPORT if self.stage == Stage::Planned => {
                    self.write(ctx);
                    Vec::new()
                }
                _ => Vec::new(),
            },
            Some(E::EffectResult(result)) => {
                if let Some(wire::effect_result::Outcome::BytesPicked(ref picked)) = result.outcome
                {
                    self.picked(ctx, picked);
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let (rows, actions, headline) = self.rows_and_actions(locale);
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Transfer(wire::TransferView {
                app_id: "notes".to_owned(),
                title: words::transfer_import_title(locale),
                back_label: self.back.clone(),
                headline,
                lede: words::transfer_import_lede(locale),
                rows,
                actions,
                busy: matches!(self.stage, Stage::Reading | Stage::Writing),
                status: self.line.status(),
            })),
            ..wire::ViewState::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dry_run_and_the_write_carry_the_same_arrival() {
        let file = |path: &str| TextFile {
            path: path.to_owned(),
            text: "words".to_owned(),
        };
        let files = vec![file("Vault/one.md"), file("Vault/sub/two.md")];
        for request in [
            import_request(&files, Some(true)),
            import_request(&files, None),
        ] {
            let request: wire::ActRequest = request.into();
            let text = |key: &str| match &request.input[key].kind {
                Some(wire::value::Kind::Text(text)) => text.clone(),
                other => panic!("{key}: {other:?}"),
            };
            assert_eq!(text("arrived_system"), "markdown");
            assert_eq!(text("arrived_label"), "Vault");
        }
        let none: wire::ActRequest = import_request(&[], None).into();
        assert!(!none.input.contains_key("arrived_system"));
    }
}
