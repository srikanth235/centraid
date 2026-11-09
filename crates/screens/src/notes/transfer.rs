//! NOTES' IMPORT AND EXPORT (`notes.import`, `notes.export`; #1173, item 14), the kit's
//! transfer screen over Notes' two commands.
//!
//! **Import is choose → preview → tap.** Choosing files or a folder is a `PickBytes` effect;
//! the picked text is held here while `note.import` is asked with `dry_run`, which writes
//! nothing and answers what importing would do. The primary action is the member's tap, and
//! only it writes. A second import of the same files adds nothing (the command skips a note it
//! already has).
//!
//! **Export is choose → save.** The rows are "All notes" and each notebook; a tap asks
//! `note.export` and the archive it answers goes to the OS save sheet (`SaveFile`).

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;

use super::Phase;
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::read;
use crate::kit::transfer::{self, TextFile, action, row};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, notes as words};

/// The extensions an import offers the picker.
const ACCEPT: [&str; 4] = ["md", "markdown", "txt", "text/plain"];

const FILES: &str = "files";
const FOLDER: &str = "folder";
const AGAIN: &str = "again";
const IMPORT: &str = "import";
const ALL: &str = "all";

#[must_use]
pub fn build_import(route: &wire::Route) -> Option<Box<dyn Screen>> {
    build(route, false)
}

#[must_use]
pub fn build_export(route: &wire::Route) -> Option<Box<dyn Screen>> {
    build(route, true)
}

fn build(route: &wire::Route, export: bool) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::Transfer(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Transfer {
        export,
        back: args.back_label.clone(),
        files: Vec::new(),
        plan: None,
        stage: Stage::Choosing,
        status: None,
        notebooks: Phase::Loading,
        saving: 0,
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
    export: bool,
    back: String,
    files: Vec<TextFile>,
    plan: Option<Plan>,
    stage: Stage,
    status: Option<wire::StatusLine>,
    notebooks: Phase<wire::NotesNotebooks>,
    /// How many notes the archive being saved holds.
    saving: u32,
}

impl Transfer {
    fn refuse(&mut self, sentence: String) {
        self.status = Some(wire::StatusLine {
            sentence,
            action_label: String::new(),
            refused: true,
        });
    }

    fn say(&mut self, sentence: String) {
        self.status = Some(wire::StatusLine {
            sentence,
            action_label: String::new(),
            refused: false,
        });
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
        self.status = None;
        self.stage = Stage::Reading;
        let key = kit_act::key(&["note.import", "dry"], kit_act::fresh());
        let settled = kit_act::act(
            ctx,
            act::notes::ImportNotes {
                files: transfer::files_json(&self.files),
                dry_run: Some(true),
            },
            &key,
        );
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
        let settled = kit_act::act(
            ctx,
            act::notes::ImportNotes {
                files: transfer::files_json(&self.files),
                dry_run: None,
            },
            &key,
        );
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

    fn export_one(&mut self, ctx: &Ctx, key: &str) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        let notebook = (key != ALL).then(|| key.to_owned());
        let request_key = kit_act::key(&["note.export", key], kit_act::fresh());
        let settled = kit_act::act(
            ctx,
            act::notes::ExportNotes {
                notebook_id: notebook,
            },
            &request_key,
        );
        let Some(archive) = settled
            .committed
            .then(|| serde_json::from_slice::<serde_json::Value>(&settled.output).ok())
            .flatten()
        else {
            self.refuse(if settled.refusal.is_empty() {
                words::transfer_export_failed(locale)
            } else {
                settled.refusal
            });
            return Vec::new();
        };
        let content = archive
            .get("content")
            .and_then(serde_json::Value::as_str)
            .and_then(|text| {
                base64::Engine::decode(&base64::engine::general_purpose::STANDARD, text).ok()
            });
        let Some(content) = content else {
            self.refuse(words::transfer_export_failed(locale));
            return Vec::new();
        };
        self.saving = transfer::count(&settled.output, "count");
        self.stage = Stage::Writing;
        self.status = None;
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::SaveFile(wire::SaveFile {
                name: archive
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Notes.zip")
                    .to_owned(),
                media_type: "application/zip".to_owned(),
                content,
            })),
        }]
    }

    fn saved(&mut self, locale: Locale, result: &wire::EffectResult) {
        self.stage = Stage::Choosing;
        match &result.outcome {
            Some(wire::effect_result::Outcome::Done(_)) => {
                self.say(fill(
                    &words::transfer_export_done(locale),
                    &[("n", &self.saving.to_string())],
                ));
            }
            Some(wire::effect_result::Outcome::Failed(failure)) if !failure.cancelled => {
                self.refuse(words::transfer_export_failed(locale));
            }
            _ => {}
        }
    }

    fn reload(&mut self, ctx: &Ctx) {
        if self.export {
            self.notebooks =
                Phase::of(read::read(
                    ctx,
                    load::notes::Notebooks {},
                    |answer| match answer {
                        Answer::NotesNotebooks(notebooks) => Some(notebooks),
                        _ => None,
                    },
                ));
        }
    }

    fn rows_and_actions(
        &self,
        locale: Locale,
    ) -> (Vec<wire::TransferRow>, Vec<wire::TransferAction>, String) {
        if self.export {
            let mut rows = vec![row(
                ALL,
                &words::transfer_export_all(locale),
                "",
                true,
                "Book",
            )];
            if let Some(notebooks) = self.notebooks.data() {
                rows.extend(notebooks.notebooks.iter().map(|book| {
                    row(
                        &book.notebook_id,
                        &super::fold::notebook_name(locale, book),
                        &book.note_count.to_string(),
                        true,
                        "Book",
                    )
                }));
            }
            return (rows, Vec::new(), words::transfer_export_headline(locale));
        }
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
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
                Vec::new()
            }
            Some(E::Transfer(tapped)) => match (self.export, tapped.key.as_str()) {
                (false, FILES) if self.stage != Stage::Writing => Self::pick(false),
                (false, FOLDER) if self.stage != Stage::Writing => Self::pick(true),
                (false, AGAIN) if self.stage == Stage::Planned => {
                    self.stage = Stage::Choosing;
                    self.plan = None;
                    self.files.clear();
                    Vec::new()
                }
                (false, IMPORT) if self.stage == Stage::Planned => {
                    self.write(ctx);
                    Vec::new()
                }
                (true, key) if self.stage != Stage::Writing && !key.is_empty() => {
                    self.export_one(ctx, key)
                }
                _ => Vec::new(),
            },
            Some(E::EffectResult(result)) => {
                match result.outcome {
                    Some(wire::effect_result::Outcome::BytesPicked(ref picked)) => {
                        self.picked(ctx, picked);
                    }
                    _ if self.export => self.saved(ctx.locale(), &result),
                    _ => {}
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
                title: if self.export {
                    words::transfer_export_title(locale)
                } else {
                    words::transfer_import_title(locale)
                },
                back_label: self.back.clone(),
                headline,
                lede: if self.export {
                    words::transfer_export_lede(locale)
                } else {
                    words::transfer_import_lede(locale)
                },
                rows,
                actions,
                busy: matches!(self.stage, Stage::Reading | Stage::Writing),
                status: self.status.clone(),
            })),
            ..wire::ViewState::default()
        }
    }
}
