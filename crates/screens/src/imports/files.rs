//! `imports.files`: A FOLLOWED FOLDER, PHONE → DOCS (#1127, R-1127-7; #1135).
//!
//! The Rust form of the KMP `FilesFollow` + `FilesImport` + `DocsFollowBridge` + the follower's
//! gate. A picked folder is followed one way (R-1127-1). The phone sends RECORDS and **the vault
//! merges**, in one `follow-files` per folder: a file the vault lacks becomes a document in
//! the folder's own Docs folder, a changed file a new revision of the same document (never a
//! second one), a file gone from a complete read goes to the trash if the member never touched its
//! document, and a document the member edited in Centraid stands (R-1127-2). Nothing is written to
//! the folder.
//!
//! ## What the shell does (effects) and what is decided here
//!
//! The shell opens the folders it holds access to (`FoldersRead`: a listing, no bytes) and streams
//! one file through the stage door (`StageFolderFile`); it never opens a picker for a pass. Here:
//! which folders (the vault's), which files are records (named, not hidden, not empty, one per
//! path), the **stat pre-check** (a file whose `size:modified` the vault already holds reads no
//! bytes), the size the core counted for the bytes a record names (the vault claims them in the
//! same `follow-files` commit, so no bytes sit unreferenced between the two), whether the read was
//! whole (a file that would not read, or a partial listing, trashes nothing), and **when** a pass
//! runs.
//!
//! ## When a pass runs
//!
//! The follow coordinator ([`crate::follow`]) decides: the app coming forward, a folder picked
//! or pulled, and a background window are triggers it folds into one pass at a time with one
//! queued behind it, then wakes this service to run it (`Signalled`) and hears when it ended.
//! **A pass never runs for a vault that follows no folder**
//! (the vault holds no `files` origin): a foreground pass never imports into a vault that never
//! picked one. A read that has not answered in two minutes is abandoned, so one stuck read cannot
//! hold the follow for good. A complete read that lost most of what the vault follows here is
//! sent as it is: the vault doubts it (one guard for contacts, calendars and folders alike,
//! `follow.rs`) and trashes nothing, because a sync glitch looks like a mass delete and Keep is
//! the default (R-1127-9). The member is not asked; the KMP "keep or trash?" question went with
//! the Kotlin follower.
//!
//! ## What reaches it by name
//!
//! The Docs drive owns the picker effects (`FollowFolder`, `StopFollowing`) and posts what they
//! came to here ([`wire::imports_files_event`]); the drive reads the folders the vault follows
//! itself (`shell.files-followed`). The Reconnect page ([`crate::follow::reconnect`]) posts the
//! same pick with the earlier origin of the folder (`replaces`): the new origin fills the Docs
//! folder that one filled, and that one is retired.

use std::collections::{BTreeSet, VecDeque};
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use serde_json::{Value, json};
use wire::app_query_response::Answer;
use wire::imports_files_event::Kind as F;
use wire::screen_event::Kind as E;

use super::{effect, squash};
use crate::catalog::{act, load};
use crate::follow::Store;
use crate::kit::act as kit_act;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::imports as words;

const READ_TIMER: &str = "files-read";
/// A read that has not answered in two minutes is abandoned.
pub const READ_TIMEOUT: Duration = Duration::from_secs(120);

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::Imports(_)) = &route.args else {
        return None;
    };
    Some(Box::new(Files {
        held: Vec::new(),
        refusal: String::new(),
        pass: None,
    }))
}

/// A media type for a file the platform named none for, off its name: the core has no sniffer,
/// and bytes promoted as `application/octet-stream` are ones no stage will draw.
#[must_use]
pub fn media_type_of(name: &str, given: &str) -> String {
    if !given.trim().is_empty() {
        return given.trim().to_owned();
    }
    let extension = name
        .rsplit_once('.')
        .map_or("", |(_, ext)| ext)
        .to_lowercase();
    match extension.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "heic" => "image/heic",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => "application/octet-stream",
    }
    .to_owned()
}

/// The phone's half of a record: the cheap pre-check.
#[must_use]
pub fn stat_of(file: &wire::FolderFile) -> String {
    format!("{}:{}", file.size, file.modified_ms)
}

/// Whether a file is a record at all: named, not hidden, not empty.
#[must_use]
pub fn usable(file: &wire::FolderFile) -> bool {
    let name = file.path.rsplit('/').next().unwrap_or("");
    !squash(name).is_empty()
        && file.size > 0
        && file.path.split('/').all(|part| !part.starts_with('.'))
}

/// What one pass did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub added: u32,
    pub updated: u32,
    pub trashed: u32,
    pub refused: u32,
    /// Rows the vault doubted: a complete read that lost most of what the folder followed.
    pub doubted: u32,
    /// A listing or a file that would not read: the read did not cover the whole folder.
    pub incomplete: bool,
}

/// A folder the vault follows, as `files-followed` answered it.
struct Held {
    phone_origin: String,
    label: String,
    /// The Docs folder the origin fills.
    fills: Option<String>,
    stats: Vec<(String, String)>,
}

/// One folder's records, as they are made.
struct OriginPlan {
    origin: String,
    label: String,
    todo: VecDeque<wire::FolderFile>,
    records: Vec<Value>,
    refused: u32,
    whole: bool,
    held: Vec<(String, String)>,
}

enum Stage {
    Listing,
    Staging { file: wire::FolderFile },
}

struct Pass {
    stage: Stage,
    device: String,
    plan: VecDeque<OriginPlan>,
    outcome: Outcome,
}

struct Files {
    held: Vec<Held>,
    refusal: String,
    pass: Option<Pass>,
}

fn read_held(ctx: &Ctx) -> Reading<Vec<Held>> {
    match read::read(
        ctx,
        load::shell::FilesFollowed::default(),
        |answer| match answer {
            Answer::ImportsFilesHeld(held) => Some(held),
            _ => None,
        },
    ) {
        Reading::Data(held) => Reading::Data(
            held.folders
                .into_iter()
                .map(|folder| Held {
                    phone_origin: folder.origin_ref,
                    label: folder.label,
                    fills: Some(folder.docs_folder).filter(|folder| !folder.is_empty()),
                    stats: folder
                        .files
                        .into_iter()
                        .map(|file| (file.path, file.stat))
                        .collect(),
                })
                .collect(),
        ),
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}

impl Files {
    fn reload(&mut self, ctx: &Ctx) -> bool {
        match read_held(ctx) {
            Reading::Data(held) => {
                self.held = held;
                true
            }
            _ => false,
        }
    }

    /// The folder store may have changed: the coordinator coalesces it with every other trigger
    /// and asks for a pass ([`crate::follow`]). Nothing for a vault that follows no folder.
    fn request(&mut self, ctx: &Ctx) {
        if self.held.is_empty() {
            return;
        }
        ctx.follows().changed(ctx, Store::Files);
    }

    /// One pass, when the coordinator asks: read what the vault holds, then ask the shell for the
    /// folders' listing. A pass already out is the one it asked for.
    fn begin(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.pass.is_some() {
            return Vec::new();
        }
        // A vault that would not say is a pass that did nothing: the next trigger tries again.
        if !self.reload(ctx) || self.held.is_empty() {
            return self.finish(ctx);
        }
        self.pass = Some(Pass {
            stage: Stage::Listing,
            device: String::new(),
            plan: VecDeque::new(),
            outcome: Outcome::default(),
        });
        ctx.start_timer(READ_TIMER, READ_TIMEOUT);
        vec![effect(wire::effect::Kind::FoldersRead(wire::FoldersRead {
            origins: self
                .held
                .iter()
                .map(|folder| folder.phone_origin.clone())
                .collect(),
        }))]
    }

    /// The pass is over, however it ended: the coordinator is told, and runs the one it queued if
    /// a trigger came during this one.
    fn finish(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        ctx.cancel_timer(READ_TIMER);
        if let Some(pass) = self.pass.take() {
            ctx.follows()
                .judged(Store::Files, pass.outcome.doubted, pass.outcome.incomplete);
        }
        self.reload(ctx);
        ctx.follows().files_ended(ctx);
        Vec::new()
    }

    /// The shell listed the folders: decide the records, then stage what the vault has not seen.
    fn listed(&mut self, ctx: &Ctx, listing: wire::FoldersListing) -> Vec<wire::Effect> {
        let Some(pass) = self.pass.as_mut() else {
            return Vec::new();
        };
        pass.device = listing.device_id.clone();
        let mut plan = VecDeque::new();
        for folder in &listing.folders {
            // A folder the vault does not follow is not sent; a folder the shell could not reach
            // is not in the listing at all, so nothing is trashed for it.
            let Some(held) = self
                .held
                .iter()
                .find(|held| held.phone_origin == folder.origin)
            else {
                continue;
            };
            let mut seen = BTreeSet::new();
            let todo: VecDeque<wire::FolderFile> = folder
                .files
                .iter()
                .filter(|file| usable(file) && seen.insert(file.path.clone()))
                .cloned()
                .collect();
            plan.push_back(OriginPlan {
                origin: folder.origin.clone(),
                label: if folder.label.is_empty() {
                    held.label.clone()
                } else {
                    squash(&folder.label)
                },
                whole: listing.complete,
                todo,
                records: Vec::new(),
                refused: 0,
                held: held.stats.clone(),
            });
        }
        pass.plan = plan;
        self.advance(ctx)
    }

    /// Take the next file that needs bytes, or finish a folder, until the plan is empty.
    fn advance(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        loop {
            let Some(pass) = self.pass.as_mut() else {
                return Vec::new();
            };
            let Some(plan) = pass.plan.front_mut() else {
                return self.finish(ctx);
            };
            let Some(file) = plan.todo.pop_front() else {
                let plan = pass.plan.pop_front().expect("the front was just seen");
                self.tell(ctx, plan);
                continue;
            };
            let stat = stat_of(&file);
            let held = plan
                .held
                .iter()
                .find(|(path, _)| *path == file.path)
                .map(|(_, stat)| stat.clone());
            if held.as_deref() == Some(stat.as_str()) {
                plan.records.push(record(&file, &stat, None));
                continue;
            }
            let effect = effect(wire::effect::Kind::StageFolderFile(wire::StageFolderFile {
                origin: plan.origin.clone(),
                path: file.path.clone(),
                media_type: media_type_of(&name_of(&file.path), &file.media_type),
            }));
            pass.stage = Stage::Staging { file };
            return vec![effect];
        }
    }

    /// The shell staged (or could not stage) the file asked for.
    fn staged(&mut self, ctx: &Ctx, staged: &wire::FolderFileStaged) -> Vec<wire::Effect> {
        let Some(pass) = self.pass.as_mut() else {
            return Vec::new();
        };
        let Stage::Staging { file } = std::mem::replace(&mut pass.stage, Stage::Listing) else {
            return Vec::new();
        };
        let Some(plan) = pass.plan.front_mut() else {
            return Vec::new();
        };
        if staged.ok {
            // The record names the bytes and says how large the core counted them: the vault
            // claims them in the `follow-files` commit that names them.
            let media = media_type_of(&name_of(&file.path), &file.media_type);
            plan.records.push(record(
                &file,
                &stat_of(&file),
                Some((
                    &staged.content_hash,
                    &media,
                    i64::try_from(staged.byte_size).unwrap_or(i64::MAX),
                )),
            ));
        } else {
            // A file that would not read is neither sent nor missed: the read is not whole.
            plan.refused += 1;
            plan.whole = false;
        }
        self.advance(ctx)
    }

    /// One `follow-files` for a folder whose records are made.
    fn tell(&mut self, ctx: &Ctx, plan: OriginPlan) {
        let Some(pass) = self.pass.as_mut() else {
            return;
        };
        let sent = plan.records.len();
        pass.outcome.incomplete |= !plan.whole;
        let request = act::shell::FollowFiles {
            origin: json!({
                "ref": plan.origin,
                "label": plan.label,
                "device_id": pass.device,
            })
            .to_string(),
            records: Value::Array(plan.records).to_string(),
            complete: Some(plan.whole),
        };
        let key = kit_act::key(&["follow-files", &plan.origin], kit_act::fresh());
        let told = kit_act::act(ctx, request, &key);
        if told.committed {
            let output: Value = serde_json::from_slice(&told.output).unwrap_or(Value::Null);
            pass.outcome.added += count(&output, "added") + count(&output, "matched");
            pass.outcome.updated += count(&output, "updated");
            pass.outcome.trashed += count(&output, "trashed");
            pass.outcome.doubted += count(&output, "doubted");
            pass.outcome.refused += plan.refused;
        } else {
            // The vault refusing a folder counts its records as refused; the next folder still goes.
            pass.outcome.refused += plan.refused + u32::try_from(sent).unwrap_or(u32::MAX);
        }
    }

    /// The member picked a folder: its Docs folder (made here, named as the phone names the folder)
    /// and its origin, so the next pass reads it. A folder already followed keeps its Docs folder.
    ///
    /// `replaces` names the earlier origin of the same folder (a reconnect): the Docs folder THAT
    /// origin filled is the new one's too, found by the origin and never by the folder's name, so
    /// the documents already there are matched by the next pass and not made twice; the earlier
    /// origin is retired once the new one stands. An earlier origin that filled nothing, or whose
    /// folder is gone, leaves the new origin a Docs folder of its own.
    fn follow(&mut self, ctx: &Ctx, origin: &str, name: &str, replaces: Option<&str>) {
        self.refusal.clear();
        if !self.reload(ctx) {
            self.refusal = words::follow_failed(ctx.locale());
            return;
        }
        let label = match squash(name) {
            label if label.is_empty() => origin.to_owned(),
            label => label,
        };
        let earlier = replaces
            .filter(|earlier| *earlier != origin)
            .and_then(|earlier| self.held.iter().find(|held| held.phone_origin == earlier))
            // A Docs folder the member deleted is not filled again.
            .map(|held| {
                let live = held
                    .fills
                    .as_deref()
                    .filter(|fills| docs_folder_is_live(ctx, fills));
                (held.phone_origin.clone(), live.map(str::to_owned))
            });
        let known = self.held.iter().any(|held| held.phone_origin == origin);
        let tell = |fills: Option<&str>| {
            kit_act::act(
                ctx,
                act::shell::FollowFiles {
                    origin: json!({ "ref": origin, "label": label, "fills": fills }).to_string(),
                    records: "[]".to_owned(),
                    complete: Some(false),
                },
                &kit_act::key(&["follow-folder", origin], kit_act::fresh()),
            )
        };
        let mut told = None;
        if !known && let Some(fills) = earlier.as_ref().and_then(|(_, fills)| fills.as_deref()) {
            // A folder the vault refuses is made anew.
            told = Some(tell(Some(fills))).filter(|told| told.committed);
        }
        let told = match told {
            Some(told) => told,
            None => {
                let fills = if known {
                    None
                } else {
                    let made = kit_act::act(
                        ctx,
                        act::docs::CreateFolder {
                            title: label.clone(),
                            ..act::docs::CreateFolder::default()
                        },
                        &kit_act::key(&["follow-folder-made", origin], kit_act::fresh()),
                    );
                    match made.output_text("id") {
                        Some(id) if made.committed => Some(id),
                        _ => {
                            self.refusal = words::follow_failed(ctx.locale());
                            return;
                        }
                    }
                };
                tell(fills.as_deref())
            }
        };
        if !told.committed {
            self.refusal = words::follow_failed(ctx.locale());
            return;
        }
        if let Some((earlier, _)) = earlier {
            self.stop(ctx, &earlier);
        }
        self.reload(ctx);
        self.request(ctx);
    }

    /// The member stopped following: the sources are forgotten and the origin retired. Every
    /// document stays.
    fn stop(&mut self, ctx: &Ctx, origin: &str) {
        let stopped = kit_act::act(
            ctx,
            act::shell::StopFollowingFiles {
                r#ref: origin.to_owned(),
            },
            &kit_act::key(&["stop-following-files", origin], kit_act::fresh()),
        );
        if !stopped.committed {
            self.refusal = words::follow_failed(ctx.locale());
        }
        self.reload(ctx);
    }
}

/// Whether `id` is a Docs folder that is not in the trash.
fn docs_folder_is_live(ctx: &Ctx, id: &str) -> bool {
    matches!(
        read::read(
            ctx,
            load::docs::Drive {
                limit: 1,
                ..load::docs::Drive::default()
            },
            |answer| match answer {
                Answer::DocsDrive(drive) => Some(drive.folders),
                _ => None,
            },
        ),
        Reading::Data(folders) if folders.iter().any(|folder| folder.folder_id == id)
    )
}

fn name_of(path: &str) -> String {
    squash(path.rsplit('/').next().unwrap_or(path))
}

/// ONE FILE AS A RECORD: its stat alone when the vault already holds it as last stated, else its
/// bytes too (the hash the core named, the media type, and the size the core counted).
fn record(file: &wire::FolderFile, stat: &str, bytes: Option<(&str, &str, i64)>) -> Value {
    let mut fields = serde_json::Map::new();
    fields.insert("title".to_owned(), json!(name_of(&file.path)));
    let mut size = None;
    if let Some((hash, media, counted)) = bytes {
        fields.insert("blob".to_owned(), json!(hash));
        fields.insert("media_type".to_owned(), json!(media));
        size = Some(counted);
    }
    fields.insert("stat".to_owned(), json!(stat));
    let mut record = json!({ "external_id": file.path, "fields": fields });
    if let Some(size) = size {
        record["size"] = json!(size);
    }
    record
}

fn count(output: &Value, name: &str) -> u32 {
    output
        .get(name)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0)
}

impl Screen for Files {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::effect_result::Outcome as O;
        match event.kind {
            Some(E::Appeared(_)) => {
                self.reload(ctx);
                self.request(ctx);
                Vec::new()
            }
            Some(E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
                Vec::new()
            }
            // The coordinator asks for a pass (the app came forward, a trigger settled, a
            // background window): it wakes this service by name.
            Some(E::Signalled(_)) => {
                if ctx.follows().take_run_files() {
                    return self.begin(ctx);
                }
                Vec::new()
            }
            Some(E::ImportsFiles(files)) => {
                match files.kind {
                    Some(F::Requested(_)) => self.request(ctx),
                    Some(F::FolderFollowed(followed)) => {
                        self.follow(
                            ctx,
                            &followed.origin,
                            &followed.name,
                            followed.replaces.as_deref(),
                        );
                    }
                    Some(F::FolderStopped(stopped)) => self.stop(ctx, &stopped.origin),
                    None => {}
                }
                Vec::new()
            }
            Some(E::TimerFired(fired)) if fired.timer == READ_TIMER => {
                if self.pass.is_some() {
                    self.finish(ctx)
                } else {
                    Vec::new()
                }
            }
            Some(E::EffectResult(result)) => {
                match (self.pass.as_ref().map(|p| &p.stage), result.outcome) {
                    (Some(Stage::Listing), Some(O::FoldersListing(listing))) => {
                        self.listed(ctx, listing)
                    }
                    (Some(Stage::Staging { .. }), Some(O::FolderFileStaged(staged))) => {
                        self.staged(ctx, &staged)
                    }
                    // The shell cannot read at all: a pass that did nothing.
                    (Some(_), Some(O::Failed(_))) => self.finish(ctx),
                    _ => Vec::new(),
                }
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState {
            kind: Some(wire::view_state::Kind::ImportsFiles(
                wire::ImportsFilesState {
                    refusal: self.refusal.clone(),
                    running: self.pass.is_some(),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
