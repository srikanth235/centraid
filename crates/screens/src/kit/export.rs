//! THE KIT'S ONE EXPORT SCREEN (#1185, take out), the app an [`ExportSpec`]: Notes' `notes.export`,
//! People's `people.export` and every other app's `<app>.export` are this machine over their own
//! spec, so a member takes their data out the same way everywhere.
//!
//! **Choose, confirm it is you, save.** The rows are what the app offers ("All notes", each
//! notebook; an app with one export has one row). A tap asks the owner check
//! ([`OwnerGate`], `Leaving::Export`); only on a pass does the spec's `export` run, and the file
//! it answers goes to the OS save sheet (`SaveFile`; `SaveFilePath` for a file the core already
//! wrote to disk, a streamed export, [`Made::Staged`]). A phone with no passcode exports with a
//! warning the status line says ([`NoPasscode::Warn`]) or is refused ([`NoPasscode::Refuse`], the
//! app's choice). A cancelled check does nothing, and leaving the screen withdraws a prompt that is
//! still up.
//!
//! It is drawn with the wire Transfer view, so neither shell has a screen of its own for it. An
//! export writes nothing, so its manifest action declares `"writes_nothing": true`.
//!
//! The entry is [`entry`]: one row of the app's More sheet, in the same words and the same icon in
//! every app. `cargo xtask rules` (`promises`) holds an app to all of it.
//!
//! ADOPTING: a `crates/screens/src/<app>/export.rs` with a `static SPEC: ExportSpec` and
//! `pub fn build(route) -> Option<Box<dyn Screen>> { export::build(&SPEC, route) }`; register it
//! under `<app>.export`; and put [`entry`]'s row in the More sheet. See `.claude/skills/change/keep-a-promise.md`.

use centraid_api_proto::core_v1 as wire;
use prost::Message;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use wire::screen_event::Kind as E;

use super::owner::{Answer, Leaving, NoPasscode, OwnerGate};
use super::read::{Page, Reading};
use super::transfer::row;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, shared};

/// A sentence in a locale.
pub type Words = fn(Locale) -> String;

/// One row a member can pick: what to export.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    /// What the spec's `export` is asked for (an id, or the app's own word for everything).
    pub key: String,
    /// "All notes", a notebook's name.
    pub label: String,
    /// A count or a short fact beside the label; empty for none.
    pub value: String,
}

/// The file an export made, as the save sheet takes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExportFile {
    pub name: String,
    pub media_type: String,
    pub content: Vec<u8>,
}

/// A file the core already wrote to disk: an export too large to build in memory (#1185,
/// owner decision D17). The shell streams it to the save sheet and deletes it afterwards, so
/// nothing but its path passes through Rust's screens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StagedFile {
    /// Absolute path of the staged file, under the vault's staging folder.
    pub path: String,
    pub name: String,
    pub media_type: String,
    /// Files that went in; 0 when the command did not say.
    pub saved: u64,
    /// Originals the file leaves out (not on this phone, or not readable); 0 for none.
    pub missing: u64,
    /// The first of those, by name (the file itself, `Left out.txt`, names every one).
    pub left_out: Vec<String>,
    /// Why they are left out, in the app's words, said after the count; empty for no reason given.
    pub left_out_why: String,
}

/// What a spec's `export` made: bytes in memory (a small file) or a file already on disk (a
/// streamed one). The machine hands the first to `SaveFile` and the second to `SaveFilePath`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Made {
    Bytes(ExportFile),
    Staged(StagedFile),
    /// The whole-vault export is a core-owned job that needs one OS original at a time.
    Archive,
}

impl From<ExportFile> for Made {
    fn from(file: ExportFile) -> Self {
        Self::Bytes(file)
    }
}

impl From<StagedFile> for Made {
    fn from(file: StagedFile) -> Self {
        Self::Staged(file)
    }
}

/// ONE APP'S EXPORT, as the parameter the one export screen takes. Every field is required: every
/// app can export, behind the owner check, and says so in the same words (#1185).
pub struct ExportSpec {
    /// `notes`: the app, and the prefix of the screen name `notes.export`.
    pub app: &'static str,
    /// "Export notes".
    pub title: Words,
    /// One sentence of what the file is ("Notes as Markdown files in a zip archive.").
    pub lede: Words,
    /// The back control's words: the app the page is pushed from ("Notes").
    pub back_label: Words,
    /// The gate drawn when the vault will not let the app read.
    pub denied: fn(Locale, &wire::AppQueryDenial) -> wire::Denied,
    /// What can be exported: every row a tap can pick. Rows are the app's own words.
    pub choices: fn(&Ctx) -> Reading<Vec<Choice>>,
    /// The app's own vault command for one choice, called only after the owner check passed. An
    /// `Err` is the sentence to show; an empty one is the kit's "Could not export".
    pub export: fn(&Ctx, &str) -> Result<Made, String>,
    /// What a phone with no passcode does: `Warn` everywhere but Locker, which refuses.
    pub no_passcode: NoPasscode,
}

/// The More-sheet entry every app adds the same way: its words, its icon, and the route.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub key: &'static str,
    pub label: String,
    pub icon_key: &'static str,
    pub route: wire::Route,
}

/// The key of the entry's row and the icon the kit draws it with.
pub const ENTRY_KEY: &str = "export";
const ENTRY_ICON: &str = "Upload";

/// `Export ›`: the row an app's More sheet carries. `screen` is the app's `<app>.export`; the
/// back control's words are the spec's.
#[must_use]
pub fn entry(locale: Locale, screen: &str) -> Entry {
    Entry {
        key: ENTRY_KEY,
        label: shared::export_entry(locale),
        icon_key: ENTRY_ICON,
        route: wire::Route {
            sheet: false,
            screen: screen.to_owned(),
            args: Some(wire::route::Args::Transfer(wire::TransferRoute {
                back_label: String::new(),
            })),
        },
    }
}

/// The file a command answered in the shape every export command shares: `{name, content}` with
/// the bytes in base64. A refusal is the core's sentence; a file that cannot be read is empty (the
/// kit's "Could not export").
///
/// # Errors
/// The core's refusal sentence, or an empty one when the answer was not a file.
pub fn file_of(
    settled: &super::act::Settled,
    media_type: &str,
    fallback_name: &str,
) -> Result<ExportFile, String> {
    if !settled.committed {
        return Err(settled.refusal.clone());
    }
    let content = settled
        .output_text("content")
        .and_then(|text| {
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, text).ok()
        })
        .ok_or_else(String::new)?;
    Ok(ExportFile {
        name: settled
            .output_text("name")
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| fallback_name.to_owned()),
        media_type: media_type.to_owned(),
        content,
    })
}

/// The file a command staged on disk, in the shape a streamed export command answers:
/// `{path, name, count, missing, left_out}`. A refusal is the core's sentence; an answer with no path is empty (the
/// kit's "Could not export").
///
/// # Errors
/// The core's refusal sentence, or an empty one when the answer was not a staged file.
pub fn staged_of(
    settled: &super::act::Settled,
    media_type: &str,
    fallback_name: &str,
) -> Result<StagedFile, String> {
    if !settled.committed {
        return Err(settled.refusal.clone());
    }
    let path = settled
        .output_text("path")
        .filter(|path| !path.is_empty())
        .ok_or_else(String::new)?;
    Ok(StagedFile {
        path,
        name: settled
            .output_text("name")
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| fallback_name.to_owned()),
        media_type: media_type.to_owned(),
        saved: u64::from(super::transfer::count(&settled.output, "count")),
        missing: u64::from(super::transfer::count(&settled.output, "missing")),
        left_out: super::transfer::names(&settled.output, "left_out"),
        left_out_why: String::new(),
    })
}

/// The registry factory for `spec`'s screen.
#[must_use]
pub fn build(spec: &'static ExportSpec, route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::Transfer(_)) = &route.args else {
        return None;
    };
    Some(Box::new(Export {
        spec,
        page: Page::loading(),
        gate: OwnerGate::default(),
        stage: Stage::Choosing,
        chosen: String::new(),
        warning: String::new(),
        saved: 0,
        missing: 0,
        left_out: Vec::new(),
        left_out_why: String::new(),
        status: None,
        archive_job: String::new(),
        archive_name: String::new(),
        archive_photo: None,
        archive_lease: ArchiveLease::default(),
    }))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// Waiting for a tap.
    Choosing,
    /// The owner check is up.
    Checking,
    Beginning,
    Building,
    Advancing,
    Supplying,
    Skipping,
    Finishing,
    Committing,
    /// The save sheet is up.
    Saving,
}

struct Export {
    spec: &'static ExportSpec,
    /// What can be exported: loading until the vault has said, a failure with Retry, the gate, or
    /// the choices (#1185).
    page: Page<Vec<Choice>>,
    gate: OwnerGate,
    stage: Stage,
    /// What the check was asked for.
    chosen: String,
    /// What a phone with no passcode warned, said with the saved line.
    warning: String,
    /// How many files the staged file holds, said with the saved line; 0 for none or unknown.
    saved: u64,
    /// Originals the file just made leaves out, and the first few by name, said with the saved line.
    missing: u64,
    left_out: Vec<String>,
    left_out_why: String,
    status: Option<wire::StatusLine>,
    archive_job: String,
    archive_name: String,
    archive_photo: Option<wire::VaultExportOriginal>,
    archive_lease: ArchiveLease,
}

/// The screen's lease covers BEGIN completing after the screen has already closed.
#[derive(Clone, Default)]
struct ArchiveLease {
    cancelled: Arc<AtomicBool>,
    job_id: Arc<Mutex<Option<String>>>,
}

impl ArchiveLease {
    /// Remember BEGIN's id and report whether closure has already requested cancellation.
    fn began(&self, job_id: String) -> bool {
        if let Ok(mut slot) = self.job_id.lock() {
            *slot = Some(job_id);
        }
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Cancel a known job now; a not-yet-known job is cancelled by `began` when BEGIN returns.
    fn close(&self, cancel: impl FnOnce(&str)) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(job_id) = self.job_id.lock().ok().and_then(|slot| slot.clone()) {
            cancel(&job_id);
        }
    }
}

impl Export {
    fn say(&mut self, sentence: String, refused: bool) {
        self.status = Some(wire::StatusLine {
            sentence,
            action_label: String::new(),
            refused,
        });
    }

    fn reload(&mut self, ctx: &Ctx) {
        let kept = std::mem::replace(&mut self.page, Page::loading());
        self.page = kept
            .refreshing()
            .after((self.spec.choices)(ctx), ctx.locale(), |_| false);
    }

    fn tapped(&mut self, ctx: &Ctx, key: &str) -> Vec<wire::Effect> {
        let known = self
            .page
            .data()
            .is_some_and(|rows| rows.iter().any(|row| row.key == key));
        if self.stage != Stage::Choosing || !known {
            return Vec::new();
        }
        self.chosen = key.to_owned();
        self.warning.clear();
        self.saved = 0;
        self.missing = 0;
        self.left_out.clear();
        self.left_out_why.clear();
        self.status = None;
        self.stage = Stage::Checking;
        self.gate.begin(ctx.locale(), Leaving::Export)
    }

    /// The owner check answered; on a pass the file is made and goes to the save sheet.
    fn checked(&mut self, ctx: &Ctx, checked: &wire::OwnerChecked) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        let Some(answer) = self.gate.answer(locale, self.spec.no_passcode, checked) else {
            return Vec::new();
        };
        match answer {
            Answer::Passed => self.save(ctx),
            Answer::PassedUnprotected(warning) => {
                self.warning = warning;
                self.save(ctx)
            }
            Answer::Refused(sentence) => {
                self.stage = Stage::Choosing;
                self.say(sentence, true);
                Vec::new()
            }
            Answer::Cancelled => {
                self.stage = Stage::Choosing;
                Vec::new()
            }
        }
    }

    fn save(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        match (self.spec.export)(ctx, &self.chosen) {
            Ok(Made::Archive) => {
                self.stage = Stage::Beginning;
                self.archive_job.clear();
                self.archive_photo = None;
                self.archive_lease = ArchiveLease::default();
                let lease = self.archive_lease.clone();
                ctx.off_thread("export.everything.begin", move |handle| {
                    let request = wire::Request {
                        kind: Some(wire::request::Kind::VaultExport(wire::VaultExportRequest {
                            action: wire::vault_export_request::Action::Begin as i32,
                            ..wire::VaultExportRequest::default()
                        })),
                    };
                    let called = match handle.call(&request) {
                        Ok(response) => wire::VaultCalled {
                            response: response.encode_to_vec(),
                            error: None,
                        },
                        Err(error) => wire::VaultCalled {
                            response: Vec::new(),
                            error: Some(error.to_wire()),
                        },
                    };
                    if let Ok(response) = wire::Response::decode(called.response.as_slice())
                        && let Some(wire::response::Kind::VaultExport(answer)) = response.kind
                        && lease.began(answer.job_id.clone())
                        && !answer.job_id.is_empty()
                    {
                        let _ = handle.call(&wire::Request {
                            kind: Some(wire::request::Kind::VaultExport(
                                wire::VaultExportRequest {
                                    action: wire::vault_export_request::Action::Cancel as i32,
                                    job_id: answer.job_id,
                                    ..wire::VaultExportRequest::default()
                                },
                            )),
                        });
                    }
                    called.encode_to_vec()
                });
                Vec::new()
            }
            Ok(made) => {
                self.stage = Stage::Saving;
                if !self.warning.is_empty() {
                    let warning = self.warning.clone();
                    self.say(warning, false);
                }
                (self.saved, self.missing, self.left_out, self.left_out_why) = match &made {
                    Made::Staged(file) => (
                        file.saved,
                        file.missing,
                        file.left_out.clone(),
                        file.left_out_why.clone(),
                    ),
                    Made::Bytes(_) => (0, 0, Vec::new(), String::new()),
                    Made::Archive => unreachable!("archive jobs are handled before the file path"),
                };
                let kind = match made {
                    Made::Bytes(file) => wire::effect::Kind::SaveFile(wire::SaveFile {
                        name: file.name,
                        media_type: file.media_type,
                        content: file.content,
                    }),
                    // A streamed export: only its path goes to the shell, which copies it.
                    Made::Staged(file) => wire::effect::Kind::SaveFilePath(wire::SaveFilePath {
                        path: file.path,
                        name: file.name,
                        media_type: file.media_type,
                    }),
                    Made::Archive => unreachable!("archive jobs are handled before the file path"),
                };
                vec![wire::Effect { kind: Some(kind) }]
            }
            Err(sentence) => {
                self.stage = Stage::Choosing;
                self.say(
                    if sentence.is_empty() {
                        shared::export_failed(locale)
                    } else {
                        sentence
                    },
                    true,
                );
                Vec::new()
            }
        }
    }

    fn ask_next_original(&mut self, ctx: &Ctx) {
        self.stage = Stage::Advancing;
        ctx.vault_async(
            "export.everything.next",
            centraid_core::screens::VaultRequest::Export(wire::VaultExportRequest {
                action: wire::vault_export_request::Action::Next as i32,
                job_id: self.archive_job.clone(),
                ..wire::VaultExportRequest::default()
            }),
        );
    }

    fn skip_current_original(&mut self, ctx: &Ctx, reason: wire::vault_export_request::SkipReason) {
        let Some(photo) = self.archive_photo.as_ref() else {
            self.archive_failed(ctx, shared::export_failed(ctx.locale()));
            return;
        };
        self.stage = Stage::Skipping;
        ctx.vault_async(
            "export.everything.skip",
            centraid_core::screens::VaultRequest::Export(wire::VaultExportRequest {
                action: wire::vault_export_request::Action::Skip as i32,
                job_id: self.archive_job.clone(),
                photo_id: photo.photo_id.clone(),
                skip_reason: reason as i32,
                ..wire::VaultExportRequest::default()
            }),
        );
    }

    fn commit_current_original(&mut self, ctx: &Ctx, stage_id: String) {
        let Some(photo) = self.archive_photo.as_ref() else {
            self.archive_failed(ctx, shared::export_failed(ctx.locale()));
            return;
        };
        self.stage = Stage::Committing;
        ctx.vault_async(
            "export.everything.commit",
            centraid_core::screens::VaultRequest::Export(wire::VaultExportRequest {
                action: wire::vault_export_request::Action::Commit as i32,
                job_id: self.archive_job.clone(),
                photo_id: photo.photo_id.clone(),
                stage_id,
                ..wire::VaultExportRequest::default()
            }),
        );
    }

    fn archive_failed(&mut self, ctx: &Ctx, sentence: String) {
        if !self.archive_job.is_empty() {
            ctx.vault_async(
                "export.everything.cancel",
                centraid_core::screens::VaultRequest::Export(wire::VaultExportRequest {
                    action: wire::vault_export_request::Action::Cancel as i32,
                    job_id: self.archive_job.clone(),
                    ..wire::VaultExportRequest::default()
                }),
            );
        }
        self.archive_job.clear();
        self.archive_photo = None;
        self.stage = Stage::Choosing;
        self.say(sentence, true);
    }

    fn archive_request_done(&mut self, ctx: &Ctx, done: &wire::OffThreadDone) -> Vec<wire::Effect> {
        let called = match wire::VaultCalled::decode(done.bytes.as_slice()) {
            Ok(called) if called.error.is_none() => called,
            _ => {
                self.archive_failed(ctx, shared::export_failed(ctx.locale()));
                return Vec::new();
            }
        };
        let response = match wire::Response::decode(called.response.as_slice()) {
            Ok(response) => response,
            Err(_) => {
                self.archive_failed(ctx, shared::export_failed(ctx.locale()));
                return Vec::new();
            }
        };
        let Some(wire::response::Kind::VaultExport(answer)) = response.kind else {
            self.archive_failed(ctx, shared::export_failed(ctx.locale()));
            return Vec::new();
        };
        match done.tag.as_str() {
            "export.everything.begin" if self.stage == Stage::Beginning => {
                if answer.job_id.is_empty() {
                    self.archive_failed(ctx, shared::export_failed(ctx.locale()));
                } else {
                    self.archive_job = answer.job_id;
                    self.archive_name = answer.name;
                    self.stage = Stage::Building;
                    ctx.vault_async(
                        "export.everything.build",
                        centraid_core::screens::VaultRequest::Export(wire::VaultExportRequest {
                            action: wire::vault_export_request::Action::Build as i32,
                            job_id: self.archive_job.clone(),
                            ..wire::VaultExportRequest::default()
                        }),
                    );
                }
            }
            "export.everything.build" if self.stage == Stage::Building => {
                if answer.ready {
                    self.ask_next_original(ctx);
                } else {
                    self.archive_failed(ctx, shared::export_failed(ctx.locale()));
                }
            }
            "export.everything.next" if self.stage == Stage::Advancing => {
                if let Some(original) = answer.original {
                    self.archive_photo = Some(original.clone());
                    self.stage = Stage::Supplying;
                    return vec![wire::Effect {
                        kind: Some(wire::effect::Kind::ExportOriginals(wire::ExportOriginals {
                            photo_ids: vec![original.photo_id.clone()],
                            mode: wire::export_originals::Mode::Archive as i32,
                            export_job_id: self.archive_job.clone(),
                            export_photo_id: original.photo_id,
                            export_os_ref: original.os_ref,
                            export_byte_size: original.byte_size,
                            export_content_hash: original.content_hash,
                            export_media_type: original.media_type,
                        })),
                    }];
                }
                if answer.complete {
                    self.stage = Stage::Finishing;
                    ctx.vault_async(
                        "export.everything.finish",
                        centraid_core::screens::VaultRequest::Export(wire::VaultExportRequest {
                            action: wire::vault_export_request::Action::Finish as i32,
                            job_id: self.archive_job.clone(),
                            ..wire::VaultExportRequest::default()
                        }),
                    );
                } else {
                    self.ask_next_original(ctx);
                }
            }
            "export.everything.skip" if self.stage == Stage::Skipping => {
                self.archive_photo = None;
                self.ask_next_original(ctx);
            }
            "export.everything.commit" if self.stage == Stage::Committing => {
                match wire::vault_export_response::ArchiveDisposition::try_from(
                    answer.archive_disposition,
                )
                .unwrap_or(wire::vault_export_response::ArchiveDisposition::Unspecified)
                {
                    wire::vault_export_response::ArchiveDisposition::Added
                    | wire::vault_export_response::ArchiveDisposition::Changed
                    | wire::vault_export_response::ArchiveDisposition::Unreadable => {
                        self.archive_photo = None;
                        self.ask_next_original(ctx);
                    }
                    wire::vault_export_response::ArchiveDisposition::Unspecified => {
                        self.archive_failed(ctx, shared::export_failed(ctx.locale()))
                    }
                }
            }
            "export.everything.finish" if self.stage == Stage::Finishing => {
                if answer.path.is_empty() {
                    self.archive_failed(ctx, shared::export_failed(ctx.locale()));
                } else {
                    self.stage = Stage::Saving;
                    self.saved = answer.count;
                    self.missing = answer.missing;
                    self.left_out = answer
                        .left_out
                        .iter()
                        .take(NAMED_ON_THE_LINE)
                        .map(|item| item.name.clone())
                        .collect();
                    return vec![wire::Effect {
                        kind: Some(wire::effect::Kind::SaveFilePath(wire::SaveFilePath {
                            path: answer.path,
                            name: if answer.name.is_empty() {
                                self.archive_name.clone()
                            } else {
                                answer.name
                            },
                            media_type: "application/zip".to_owned(),
                        })),
                    }];
                }
            }
            _ => {}
        }
        Vec::new()
    }

    fn archive_original_done(
        &mut self,
        ctx: &Ctx,
        result: &wire::EffectResult,
    ) -> Vec<wire::Effect> {
        let disposition = match &result.outcome {
            Some(wire::effect_result::Outcome::OriginalsExported(answer)) => {
                wire::originals_exported::ArchiveDisposition::try_from(answer.archive_disposition)
                    .unwrap_or(wire::originals_exported::ArchiveDisposition::Unspecified)
            }
            Some(wire::effect_result::Outcome::Failed(_)) => {
                wire::originals_exported::ArchiveDisposition::Unreadable
            }
            _ => wire::originals_exported::ArchiveDisposition::Unspecified,
        };
        match disposition {
            wire::originals_exported::ArchiveDisposition::Staged => {
                let Some(wire::effect_result::Outcome::OriginalsExported(answer)) = &result.outcome
                else {
                    self.archive_failed(ctx, shared::export_failed(ctx.locale()));
                    return Vec::new();
                };
                self.commit_current_original(ctx, answer.archive_stage_id.clone());
            }
            wire::originals_exported::ArchiveDisposition::Unavailable => {
                self.skip_current_original(ctx, wire::vault_export_request::SkipReason::Unavailable)
            }
            wire::originals_exported::ArchiveDisposition::Unreadable
            | wire::originals_exported::ArchiveDisposition::Unspecified => {
                self.skip_current_original(ctx, wire::vault_export_request::SkipReason::Unreadable)
            }
        }
        Vec::new()
    }

    /// The save sheet answered: saved, failed, or dismissed (which says nothing).
    fn saved(&mut self, ctx: &Ctx, result: &wire::EffectResult) {
        let locale = ctx.locale();
        if !self.archive_job.is_empty() {
            let action = if matches!(&result.outcome, Some(wire::effect_result::Outcome::Done(_))) {
                wire::vault_export_request::Action::Release
            } else {
                wire::vault_export_request::Action::Cancel
            };
            ctx.vault_async(
                "export.everything.release",
                centraid_core::screens::VaultRequest::Export(wire::VaultExportRequest {
                    action: action as i32,
                    job_id: self.archive_job.clone(),
                    ..wire::VaultExportRequest::default()
                }),
            );
            if action == wire::vault_export_request::Action::Release {
                self.archive_job.clear();
                if let Ok(mut slot) = self.archive_lease.job_id.lock() {
                    *slot = None;
                }
            }
        }
        self.stage = Stage::Choosing;
        match &result.outcome {
            Some(wire::effect_result::Outcome::Done(_)) => {
                let mut sentence = if self.saved > 0 {
                    shared::export_saved_files(locale, self.saved)
                } else {
                    shared::export_done(locale)
                };
                if self.missing > 0 {
                    sentence = format!(
                        "{sentence}. {}",
                        left_out_line(locale, self.missing, &self.left_out)
                    );
                    if !self.left_out_why.is_empty() {
                        sentence = format!("{sentence}. {}", self.left_out_why);
                    }
                }
                if !self.warning.is_empty() {
                    sentence = format!("{sentence}. {}", self.warning);
                }
                self.say(sentence, false);
            }
            Some(wire::effect_result::Outcome::Failed(failure)) if !failure.cancelled => {
                self.say(shared::export_failed(locale), true);
            }
            _ => self.status = None,
        }
        self.warning.clear();
        self.saved = 0;
        self.missing = 0;
        self.left_out.clear();
        self.left_out_why.clear();
    }
}

/// The most left-out names the status line spells out.
const NAMED_ON_THE_LINE: usize = 3;

/// "2 originals were left out: A.pdf, B.jpg", with "and 5 more" when there are more than the line
/// names, and just the count when the command named none.
fn left_out_line(locale: Locale, missing: u64, names: &[String]) -> String {
    let count = shared::export_missing(locale, missing);
    if names.is_empty() {
        return count;
    }
    let mut list = names
        .iter()
        .take(NAMED_ON_THE_LINE)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let more = missing.saturating_sub(NAMED_ON_THE_LINE.min(names.len()) as u64);
    if more > 0 {
        list = format!("{list} {}", shared::export_more(locale, more));
    }
    format!("{count}: {list}")
}

impl Screen for Export {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
                Vec::new()
            }
            Some(E::Transfer(tapped)) => self.tapped(ctx, &tapped.key),
            Some(E::EffectResult(result)) => match (&result.outcome, self.stage) {
                (Some(wire::effect_result::Outcome::OwnerChecked(checked)), Stage::Checking) => {
                    self.checked(ctx, checked)
                }
                (_, Stage::Supplying) => self.archive_original_done(ctx, &result),
                (_, Stage::Saving) => {
                    self.saved(ctx, &result);
                    Vec::new()
                }
                _ => Vec::new(),
            },
            Some(E::OffThreadDone(done))
                if matches!(
                    self.stage,
                    Stage::Beginning
                        | Stage::Building
                        | Stage::Advancing
                        | Stage::Skipping
                        | Stage::Finishing
                        | Stage::Committing
                ) =>
            {
                self.archive_request_done(ctx, &done)
            }
            // Leaving withdraws a prompt that is still up, so none outlives the screen.
            Some(E::Left(_)) => {
                if !self.archive_job.is_empty() {
                    ctx.vault_async(
                        "export.everything.cancel",
                        centraid_core::screens::VaultRequest::Export(wire::VaultExportRequest {
                            action: wire::vault_export_request::Action::Cancel as i32,
                            job_id: self.archive_job.clone(),
                            ..wire::VaultExportRequest::default()
                        }),
                    );
                }
                self.archive_lease.cancelled.store(true, Ordering::SeqCst);
                self.archive_job.clear();
                self.stage = Stage::Choosing;
                self.gate.cancel()
            }
            _ => Vec::new(),
        }
    }

    fn closing(&mut self, core: &dyn centraid_core::screens::ScreenCtx) {
        self.archive_lease
            .close(|job_id| core.cancel_vault_export(job_id));
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let (rows, headline) = match self.page.data() {
            Some(choices) => (
                choices
                    .iter()
                    .map(|choice| row(&choice.key, &choice.label, &choice.value, true, "Upload"))
                    .collect(),
                shared::export_headline(locale),
            ),
            None => (Vec::new(), String::new()),
        };
        let lede = (self.spec.lede)(locale);
        let page = self.page.wire(
            locale,
            |denial| (self.spec.denied)(locale, denial),
            wire::EmptyState::default,
        );
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Transfer(wire::TransferView {
                app_id: self.spec.app.to_owned(),
                title: (self.spec.title)(locale),
                back_label: (self.spec.back_label)(locale),
                headline,
                lede,
                rows,
                actions: Vec::new(),
                busy: self.stage != Stage::Choosing,
                status: self.status.clone(),
                page: Some(page),
            })),
            ..wire::ViewState::default()
        }
    }
}

#[cfg(test)]
mod archive_lease_tests {
    use super::*;

    #[test]
    fn a_pop_while_begin_is_in_flight_cancels_the_late_job_id() {
        let lease = ArchiveLease::default();
        let mut cancelled = Vec::new();

        // A screen pop lands before the worker's BEGIN response.
        lease.close(|job_id| cancelled.push(job_id.to_owned()));
        assert!(cancelled.is_empty(), "there is no id to cancel yet");

        // When the blocked worker returns, it sees the closed lease and cancels before
        // its completion can be delivered to a screen that no longer exists.
        if lease.began("vault-export-late".to_owned()) {
            cancelled.push("vault-export-late".to_owned());
        }
        assert_eq!(cancelled, ["vault-export-late"]);
    }
}
