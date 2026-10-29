//! EXPORT AND IMPORT (#1047 T2): every secret in a file, and a password-manager
//! file read, reviewed and sealed in.
//!
//! **Export asks three times, in order, before a byte exists**: the confirm,
//! which names the consequence; the phone's owner check, raised AFRESH whether
//! or not Locker is already open; then the core, which runs the one
//! confirmed mass reveal before it opens a cell. The file the core answers goes
//! to the OS save sheet (`SaveFile`) and nowhere else — this screen keeps no
//! copy, and any answer ends the sheet.
//!
//! **Import is draft → review → publish.** Choosing is a `PickBytes` effect; the
//! picked bytes are held here — never in a view — while the core plans them. Add
//! writes the plan (every secret sealed by the core on the way in) and drops the
//! file; Discard drops it and writes nothing; so does a relock or leaving.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::locker_export_event::Kind as X;
use wire::locker_import_event::Kind as I;
use wire::screen_event::Kind as E;

use super::shared::{self, Phase};
use super::types;
use super::wall::{Change, Wall};
use crate::catalog::load;
use crate::kit::read;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, locker as words};

/// The item count both pages read: the shelf's own counts, a small window.
fn read_count(ctx: &Ctx) -> Phase<wire::LockerItems> {
    Phase::of(read::read(
        ctx,
        load::locker::Items {
            archived: None,
            limit: 20,
        },
        |answer| match answer {
            Answer::LockerItems(items) => Some(items),
            _ => None,
        },
    ))
}

/// Live and archived items — what an export writes. `None` while unknown.
fn exportable(items: &wire::LockerItems) -> Option<u32> {
    Some(items.total? + items.archived_count.unwrap_or(0))
}

// ---------------------------------------------------------------------------
// locker.export
// ---------------------------------------------------------------------------

#[must_use]
pub fn build_export(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::LockerExport(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Export {
        parent: args.parent.clone(),
        wall: Wall::default(),
        count: Phase::Loading,
        json: false,
        confirm: false,
        phase: wire::locker_export_state::Phase::Idle,
        status: None,
        unopened: 0,
    }))
}

struct Export {
    parent: String,
    wall: Wall,
    count: Phase<wire::LockerItems>,
    json: bool,
    confirm: bool,
    phase: wire::locker_export_state::Phase,
    status: Option<wire::StatusLine>,
    /// Sealed values that did not open and are not in the file.
    unopened: u32,
}

impl Export {
    fn idle(&self) -> bool {
        self.phase == wire::locker_export_state::Phase::Idle
    }

    fn reload(&mut self, ctx: &Ctx) {
        if self.wall.is_open() {
            self.count = read_count(ctx);
        }
    }

    fn walled(&mut self, ctx: &Ctx, step: super::wall::Step) -> Vec<wire::Effect> {
        match step.change {
            Change::Opened => self.reload(ctx),
            Change::Closed => {
                self.count = Phase::Loading;
                self.confirm = false;
                self.phase = wire::locker_export_state::Phase::Idle;
                self.status = None;
            }
            Change::None => {}
        }
        step.effects
    }

    /// The owner check's answer, for an export that is checking.
    fn checked(&mut self, ctx: &Ctx, checked: &wire::OwnerChecked) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        if checked.outcome != wire::owner_checked::Outcome::Succeeded as i32 {
            self.phase = wire::locker_export_state::Phase::Idle;
            self.status = shared::status(words::export_not_confirmed(locale));
            return Vec::new();
        }
        self.phase = wire::locker_export_state::Phase::Writing;
        let format = if self.json {
            wire::LockerExportFormat::Json
        } else {
            wire::LockerExportFormat::Csv
        };
        let answer = ctx.locker(&wire::LockerSessionRequest {
            step: Some(wire::locker_session_request::Step::Export(
                wire::LockerExportAsk {
                    format: format as i32,
                    tz: ctx.zone().to_owned(),
                },
            )),
        });
        let exported = match answer {
            Ok(answer) => match answer.exported {
                Some(exported) => exported,
                None => {
                    self.phase = wire::locker_export_state::Phase::Idle;
                    let locked = answer.refusal == wire::LockerRevealRefusal::Locked as i32;
                    self.status = shared::refused(if locked {
                        words::reveal_locked(locale)
                    } else {
                        words::export_failed(locale)
                    });
                    if locked {
                        let step = self.wall.recheck(ctx);
                        return self.walled(ctx, step);
                    }
                    return Vec::new();
                }
            },
            Err(error) => {
                self.phase = wire::locker_export_state::Phase::Idle;
                self.status = shared::refused(error.sentence());
                return Vec::new();
            }
        };
        self.unopened = exported.unopened;
        self.phase = wire::locker_export_state::Phase::Saving;
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::SaveFile(wire::SaveFile {
                name: exported.file_name,
                media_type: exported.media_type,
                content: exported.content,
            })),
        }]
    }

    /// The save sheet's answer ends the export.
    fn saved(&mut self, ctx: &Ctx, result: &wire::EffectResult) {
        let locale = ctx.locale();
        let (sentence, refused) = match &result.outcome {
            Some(wire::effect_result::Outcome::Done(_)) if self.unopened > 0 => (
                fill(
                    &words::export_written_partial(locale),
                    &[("n", &self.unopened.to_string())],
                ),
                false,
            ),
            Some(wire::effect_result::Outcome::Done(_)) => (words::export_written(locale), false),
            Some(wire::effect_result::Outcome::Failed(failed)) if failed.cancelled => {
                (words::export_not_saved(locale), false)
            }
            _ => (words::export_save_refused(locale), true),
        };
        self.phase = wire::locker_export_state::Phase::Idle;
        self.unopened = 0;
        self.status = Some(wire::StatusLine {
            sentence,
            action_label: String::new(),
            refused,
        });
    }

    fn event(&mut self, event: wire::LockerExportEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        match event.kind {
            Some(X::Format(picked)) if self.idle() => {
                match picked.key.as_str() {
                    "csv" => self.json = false,
                    "json" => self.json = true,
                    _ => {}
                }
                Vec::new()
            }
            Some(X::Commit(_)) if self.idle() => {
                if self.count.data().and_then(exportable).unwrap_or(0) > 0 {
                    self.status = None;
                    self.confirm = true;
                }
                Vec::new()
            }
            Some(X::Dismissed(_)) => {
                self.confirm = false;
                Vec::new()
            }
            // THE OWNER CHECK, AFRESH.
            Some(X::Confirmed(_)) if self.confirm => {
                self.confirm = false;
                self.phase = wire::locker_export_state::Phase::Checking;
                vec![wire::Effect {
                    kind: Some(wire::effect::Kind::OwnerCheck(wire::OwnerCheck {
                        ask: true,
                        reason: words::export_prompt_reason(locale),
                        title: words::export_prompt_title(locale),
                        subtitle: words::export_prompt_subtitle(locale),
                    })),
                }]
            }
            Some(X::Refreshed(_)) => {
                self.reload(ctx);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn data(&self, locale: Locale, items: &wire::LockerItems) -> Option<wire::LockerExportData> {
        let count = exportable(items)?;
        let busy = !self.idle();
        use wire::locker_export_state::Phase as P;
        Some(wire::LockerExportData {
            lede: words::export_lede(locale),
            what_label: words::export_what(locale),
            what_value: fill(
                &if count == 1 {
                    words::export_what_one(locale)
                } else {
                    words::export_what_many(locale)
                },
                &[("n", &count.to_string())],
            ),
            leaves_out: words::export_leaves_out(locale),
            format_label: words::export_format(locale),
            formats: vec![
                choice("csv", words::export_format_csv(locale), !self.json),
                choice("json", words::export_format_json(locale), self.json),
            ],
            format_note: if self.json {
                words::export_format_json_note(locale)
            } else {
                words::export_format_csv_note(locale)
            },
            where_label: words::export_where(locale),
            where_value: words::export_where_value(locale),
            where_note: words::export_where_note(locale),
            commit_label: if busy || count == 0 {
                String::new()
            } else {
                words::export_commit(locale)
            },
            commit_note: match self.phase {
                _ if count == 0 => words::export_nothing(locale),
                P::Writing => words::export_writing(locale),
                P::Saving => words::export_saving(locale),
                _ => words::export_commit_note(locale),
            },
        })
    }
}

fn choice(key: &str, label: String, selected: bool) -> wire::LockerChoice {
    wire::LockerChoice {
        key: key.to_owned(),
        label,
        selected,
        detail: String::new(),
    }
}

impl Screen for Export {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                let step = self.wall.appeared(ctx, false);
                let effects = self.walled(ctx, step);
                if self.wall.is_open() && matches!(self.count, Phase::Loading) {
                    self.reload(ctx);
                }
                effects
            }
            Some(E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                if self.wall.is_open() {
                    self.reload(ctx);
                    Vec::new()
                } else {
                    let step = self.wall.recheck(ctx);
                    self.walled(ctx, step)
                }
            }
            Some(E::LockerWall(wall)) => {
                let step = self.wall.event(ctx, wall);
                self.walled(ctx, step)
            }
            Some(E::Lifecycle(lifecycle)) => {
                // LEAVING THE FOREGROUND DROPS A PROMPT NOBODY WILL ANSWER.
                if !lifecycle.foreground {
                    self.confirm = false;
                    self.phase = wire::locker_export_state::Phase::Idle;
                }
                let step = self.wall.lifecycle(ctx, lifecycle.foreground);
                self.walled(ctx, step)
            }
            Some(E::LockerExport(export)) => {
                if self.wall.is_open() {
                    self.event(export, ctx)
                } else {
                    let step = self.wall.recheck(ctx);
                    self.walled(ctx, step)
                }
            }
            Some(E::EffectResult(result)) => match (&result.outcome, self.phase) {
                (
                    Some(wire::effect_result::Outcome::OwnerChecked(checked)),
                    wire::locker_export_state::Phase::Checking,
                ) => self.checked(ctx, checked),
                (_, wire::locker_export_state::Phase::Saving) => {
                    self.saved(ctx, &result);
                    Vec::new()
                }
                _ => {
                    let step = self.wall.answered(ctx, &result);
                    self.walled(ctx, step)
                }
            },
            Some(E::Left(_)) => {
                self.confirm = false;
                self.phase = wire::locker_export_state::Phase::Idle;
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let open = self.wall.is_open();
        let content = open.then(|| match &self.count {
            Phase::Loading => {
                wire::locker_export_state::Content::Loading(wire::Loading { first_load: true })
            }
            Phase::Failed => wire::locker_export_state::Content::Failure(read::failure(locale)),
            Phase::Denied(denial) => {
                wire::locker_export_state::Content::Denied(shared::denied(locale, denial))
            }
            Phase::Ready(items) => match self.data(locale, items) {
                Some(data) => wire::locker_export_state::Content::Data(Box::new(data)),
                None => wire::locker_export_state::Content::Failure(read::incomplete(locale)),
            },
        });
        wire::ViewState {
            kind: Some(wire::view_state::Kind::LockerExport(
                wire::LockerExportState {
                    wall: self.wall.view(locale),
                    secure: open,
                    content,
                    chrome: Some(wire::LockerExportChrome {
                        title: words::export_title(locale),
                        back_label: if self.parent.is_empty() {
                            words::app_name(locale)
                        } else {
                            self.parent.clone()
                        },
                        retry: words::retry(locale),
                    }),
                    confirm: self.confirm.then(|| wire::Confirm {
                        title: words::export_confirm_title(locale),
                        body: words::export_confirm_body(locale),
                        confirm_label: words::export_confirm(locale),
                        destructive: true,
                    }),
                    phase: self.phase as i32,
                    status: self.status.clone(),
                    format: if self.json { "json" } else { "csv" }.to_owned(),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}

// ---------------------------------------------------------------------------
// locker.import
// ---------------------------------------------------------------------------

#[must_use]
pub fn build_import(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::LockerImport(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Import {
        parent: args.parent.clone(),
        wall: Wall::default(),
        count: Phase::Loading,
        phase: wire::locker_import_state::Phase::Idle,
        file: None,
        plan: None,
        status: None,
    }))
}

/// A picked file, held only as long as this screen. Its bytes are secrets in
/// the clear, so a derived `Debug` would print them.
struct Held {
    name: String,
    bytes: Vec<u8>,
}

struct Import {
    parent: String,
    wall: Wall,
    count: Phase<wire::LockerItems>,
    phase: wire::locker_import_state::Phase,
    file: Option<Held>,
    plan: Option<wire::LockerImportPlan>,
    status: Option<wire::StatusLine>,
}

impl Import {
    fn reload(&mut self, ctx: &Ctx) {
        if self.wall.is_open() {
            self.count = read_count(ctx);
        }
    }

    /// LEAVING OR A RELOCK DROPS THE FILE; a write under way still lands.
    fn drop_file(&mut self) {
        self.file = None;
        self.plan = None;
    }

    fn walled(&mut self, ctx: &Ctx, step: super::wall::Step) -> Vec<wire::Effect> {
        match step.change {
            Change::Opened => self.reload(ctx),
            Change::Closed => {
                self.count = Phase::Loading;
                self.drop_file();
                self.phase = wire::locker_import_state::Phase::Idle;
                self.status = None;
            }
            Change::None => {}
        }
        step.effects
    }

    fn writes(&self) -> u32 {
        self.plan
            .as_ref()
            .map_or(0, |plan| plan.new_count + plan.fill_count)
    }

    /// Ask the core to plan the held file, or to write the plan.
    fn run(&mut self, ctx: &Ctx, publish: bool) {
        let locale = ctx.locale();
        let Some(file) = &self.file else {
            return;
        };
        let answer = ctx.locker(&wire::LockerSessionRequest {
            step: Some(wire::locker_session_request::Step::ImportFile(
                wire::LockerImportAsk {
                    content: file.bytes.clone(),
                    publish,
                },
            )),
        });
        let refusal = |this: &mut Self, sentence: String| {
            // A REFUSED PUBLISH KEEPS THE PLAN, so Add can be tried again; a
            // refused read has nothing to keep.
            if publish {
                this.phase = wire::locker_import_state::Phase::Planned;
            } else {
                this.drop_file();
                this.phase = wire::locker_import_state::Phase::Idle;
            }
            this.status = shared::refused(sentence);
        };
        let answer = match answer {
            Ok(answer) => answer,
            Err(error) => return refusal(self, error.sentence()),
        };
        let Some(plan) = answer.import_plan else {
            let sentence = match wire::LockerRevealRefusal::try_from(answer.refusal) {
                Ok(wire::LockerRevealRefusal::NotReadable) => words::import_not_readable(locale),
                Ok(wire::LockerRevealRefusal::Locked) => words::reveal_locked(locale),
                _ => words::import_failed(locale),
            };
            return refusal(self, sentence);
        };
        if plan.published {
            let mut sentence = fill(
                &words::import_published(locale),
                &[
                    ("created", &plan.created.to_string()),
                    ("filled", &plan.filled.to_string()),
                    ("held", &plan.held_count.to_string()),
                ],
            );
            if plan.failed > 0 {
                sentence.push_str(&fill(
                    &words::import_failed_rows(locale),
                    &[("n", &plan.failed.to_string())],
                ));
            }
            self.status = Some(wire::StatusLine {
                sentence,
                action_label: String::new(),
                refused: plan.failed > 0,
            });
            self.file = None;
            self.plan = Some(*plan);
            self.phase = wire::locker_import_state::Phase::Published;
        } else {
            self.plan = Some(*plan);
            self.phase = wire::locker_import_state::Phase::Planned;
        }
    }

    fn event(&mut self, event: wire::LockerImportEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::locker_import_state::Phase as P;
        let locale = ctx.locale();
        match event.kind {
            Some(I::Choose(_)) if !matches!(self.phase, P::Reading | P::Publishing) => {
                vec![wire::Effect {
                    kind: Some(wire::effect::Kind::PickBytes(wire::PickBytes {
                        accept: vec![
                            "text/csv".to_owned(),
                            "application/json".to_owned(),
                            "text/plain".to_owned(),
                        ],
                    })),
                }]
            }
            Some(I::Publish(_)) if self.phase == P::Planned && self.writes() > 0 => {
                self.phase = P::Publishing;
                self.status = None;
                self.run(ctx, true);
                Vec::new()
            }
            Some(I::Discard(_)) if self.phase == P::Planned => {
                self.drop_file();
                self.phase = P::Idle;
                self.status = shared::status(words::import_discarded(locale));
                Vec::new()
            }
            Some(I::Refreshed(_)) => {
                self.reload(ctx);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// The OS picker handed over a file (or was dismissed).
    fn picked(&mut self, ctx: &Ctx, file: wire::BytesPicked) {
        use wire::locker_import_state::Phase as P;
        if file.cancelled || matches!(self.phase, P::Reading | P::Publishing) {
            return;
        }
        self.file = Some(Held {
            name: file.name,
            bytes: file.content,
        });
        self.plan = None;
        self.status = None;
        self.phase = P::Reading;
        self.run(ctx, false);
    }

    fn data(&self, locale: Locale) -> wire::LockerImportData {
        use wire::locker_import_state::Phase as P;
        let drawn = self
            .plan
            .as_ref()
            .filter(|_| matches!(self.phase, P::Planned | P::Publishing | P::Published));
        let busy = matches!(self.phase, P::Reading | P::Publishing);
        let verdicts = [
            (
                words::import_chip_new(locale),
                words::import_verdict_new(locale),
            ),
            (
                words::import_chip_fill(locale),
                words::import_verdict_fill(locale),
            ),
            (
                words::import_chip_held(locale),
                words::import_verdict_held(locale),
            ),
            (
                words::import_chip_skipped(locale),
                words::import_verdict_skipped(locale),
            ),
        ];
        let planned_writes = self.phase == P::Planned && self.writes() > 0;
        wire::LockerImportData {
            lede: words::import_lede(locale),
            file_label: words::import_file(locale),
            file_value: self
                .file
                .as_ref()
                .map_or_else(|| words::import_no_file(locale), |file| file.name.clone()),
            file_note: match self.phase {
                P::Reading => words::import_reading(locale),
                P::Published => words::import_done_note(locale),
                _ => words::import_file_note(locale),
            },
            choose_label: if busy {
                String::new()
            } else {
                words::import_choose(locale)
            },
            verdicts_label: words::import_verdicts(locale),
            verdicts: verdicts
                .iter()
                .map(|(chip, sentence)| wire::LockerFact {
                    label: chip.clone(),
                    detail: sentence.clone(),
                })
                .collect(),
            counts: drawn
                .map(|plan| {
                    fill(
                        &words::import_counts(locale),
                        &[
                            ("new", &plan.new_count.to_string()),
                            ("fill", &plan.fill_count.to_string()),
                            ("held", &plan.held_count.to_string()),
                            ("skipped", &plan.skipped_count.to_string()),
                        ],
                    )
                })
                .unwrap_or_default(),
            rows_label: if drawn.is_some_and(|plan| !plan.rows.is_empty()) {
                words::import_rows(locale)
            } else {
                String::new()
            },
            rows: drawn
                .map(|plan| {
                    plan.rows
                        .iter()
                        .enumerate()
                        .map(|(index, row)| {
                            let verdict = wire::LockerImportVerdict::try_from(row.verdict)
                                .unwrap_or_default();
                            let (chip, sentence) = &verdicts[match verdict {
                                wire::LockerImportVerdict::New => 0,
                                wire::LockerImportVerdict::Fill => 1,
                                wire::LockerImportVerdict::Held => 2,
                                _ => 3,
                            }];
                            let title = if row.title.is_empty() {
                                words::import_untitled(locale)
                            } else {
                                row.title.clone()
                            };
                            let meta = [
                                (types::of(&row.r#type).label)(locale),
                                row.subtitle.clone(),
                                sentence.clone(),
                            ]
                            .into_iter()
                            .filter(|part| !part.is_empty())
                            .collect::<Vec<_>>()
                            .join(" · ");
                            wire::LockerImportLine {
                                key: format!("row:{index}"),
                                accessibility_label: [title.as_str(), meta.as_str(), chip.as_str()]
                                    .into_iter()
                                    .filter(|part| !part.is_empty())
                                    .collect::<Vec<_>>()
                                    .join(", "),
                                title,
                                meta,
                                chip: Some(wire::StatusChip {
                                    label: chip.clone(),
                                    tone: if matches!(
                                        verdict,
                                        wire::LockerImportVerdict::New
                                            | wire::LockerImportVerdict::Fill
                                    ) {
                                        wire::status_chip::Tone::Unspecified
                                    } else {
                                        wire::status_chip::Tone::Seam
                                    } as i32,
                                }),
                            }
                        })
                        .collect()
                })
                .unwrap_or_default(),
            publish_label: if planned_writes {
                words::import_publish(locale)
            } else {
                String::new()
            },
            publish_note: if planned_writes {
                words::import_publish_note(locale)
            } else {
                String::new()
            },
            discard_label: if self.phase == P::Planned {
                words::import_discard(locale)
            } else {
                String::new()
            },
            empty: drawn
                .filter(|plan| plan.rows.is_empty())
                .map(|_| wire::EmptyState {
                    headline: words::import_nothing(locale),
                    body: words::import_nothing_body(locale),
                    ..wire::EmptyState::default()
                }),
        }
    }
}

impl Screen for Import {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                let step = self.wall.appeared(ctx, false);
                let effects = self.walled(ctx, step);
                if self.wall.is_open() && matches!(self.count, Phase::Loading) {
                    self.reload(ctx);
                }
                effects
            }
            Some(E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                if self.wall.is_open() {
                    self.reload(ctx);
                    Vec::new()
                } else {
                    let step = self.wall.recheck(ctx);
                    self.walled(ctx, step)
                }
            }
            Some(E::LockerWall(wall)) => {
                let step = self.wall.event(ctx, wall);
                self.walled(ctx, step)
            }
            Some(E::Lifecycle(lifecycle)) => {
                let step = self.wall.lifecycle(ctx, lifecycle.foreground);
                self.walled(ctx, step)
            }
            Some(E::LockerImport(import)) => {
                if self.wall.is_open() {
                    self.event(import, ctx)
                } else {
                    let step = self.wall.recheck(ctx);
                    self.walled(ctx, step)
                }
            }
            Some(E::EffectResult(result)) => match result.outcome {
                Some(wire::effect_result::Outcome::BytesPicked(file)) => {
                    if self.wall.is_open() {
                        self.picked(ctx, file);
                    }
                    Vec::new()
                }
                _ => {
                    let step = self.wall.answered(ctx, &result);
                    self.walled(ctx, step)
                }
            },
            Some(E::Left(_)) => {
                if self.phase != wire::locker_import_state::Phase::Publishing {
                    self.drop_file();
                    self.phase = wire::locker_import_state::Phase::Idle;
                    self.status = None;
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let open = self.wall.is_open();
        let content = open.then(|| match &self.count {
            Phase::Loading => {
                wire::locker_import_state::Content::Loading(wire::Loading { first_load: true })
            }
            Phase::Failed => wire::locker_import_state::Content::Failure(read::failure(locale)),
            Phase::Denied(denial) => {
                wire::locker_import_state::Content::Denied(shared::denied(locale, denial))
            }
            Phase::Ready(_) => {
                wire::locker_import_state::Content::Data(Box::new(self.data(locale)))
            }
        });
        wire::ViewState {
            kind: Some(wire::view_state::Kind::LockerImport(
                wire::LockerImportState {
                    wall: self.wall.view(locale),
                    secure: open,
                    content,
                    chrome: Some(wire::LockerImportChrome {
                        title: words::import_title(locale),
                        back_label: if self.parent.is_empty() {
                            words::app_name(locale)
                        } else {
                            self.parent.clone()
                        },
                        retry: words::retry(locale),
                    }),
                    phase: self.phase as i32,
                    status: self.status.clone(),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
