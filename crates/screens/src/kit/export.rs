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
//! under `<app>.export`; and put [`entry`]'s row in the More sheet. See the `screen-change` skill.

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;

use super::owner::{Answer, Leaving, NoPasscode, OwnerGate};
use super::read::{self, Reading};
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
}

/// What a spec's `export` made: bytes in memory (a small file) or a file already on disk (a
/// streamed one). The machine hands the first to `SaveFile` and the second to `SaveFilePath`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Made {
    Bytes(ExportFile),
    Staged(StagedFile),
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
/// `{path, name, count}`. A refusal is the core's sentence; an answer with no path is empty (the
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
        rows: Reading::Failed,
        loaded: false,
        gate: OwnerGate::default(),
        stage: Stage::Choosing,
        chosen: String::new(),
        warning: String::new(),
        status: None,
    }))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// Waiting for a tap.
    Choosing,
    /// The owner check is up.
    Checking,
    /// The save sheet is up.
    Saving,
}

struct Export {
    spec: &'static ExportSpec,
    rows: Reading<Vec<Choice>>,
    loaded: bool,
    gate: OwnerGate,
    stage: Stage,
    /// What the check was asked for.
    chosen: String,
    /// What a phone with no passcode warned, said with the saved line.
    warning: String,
    status: Option<wire::StatusLine>,
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
        self.rows = (self.spec.choices)(ctx);
        self.loaded = true;
    }

    fn tapped(&mut self, ctx: &Ctx, key: &str) -> Vec<wire::Effect> {
        let known =
            matches!(&self.rows, Reading::Data(rows) if rows.iter().any(|row| row.key == key));
        if self.stage != Stage::Choosing || !known {
            return Vec::new();
        }
        self.chosen = key.to_owned();
        self.warning.clear();
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
            Ok(made) => {
                self.stage = Stage::Saving;
                if !self.warning.is_empty() {
                    let warning = self.warning.clone();
                    self.say(warning, false);
                }
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

    /// The save sheet answered: saved, failed, or dismissed (which says nothing).
    fn saved(&mut self, locale: Locale, result: &wire::EffectResult) {
        self.stage = Stage::Choosing;
        match &result.outcome {
            Some(wire::effect_result::Outcome::Done(_)) => {
                let done = shared::export_done(locale);
                let sentence = if self.warning.is_empty() {
                    done
                } else {
                    format!("{done}. {}", self.warning)
                };
                self.say(sentence, false);
            }
            Some(wire::effect_result::Outcome::Failed(failure)) if !failure.cancelled => {
                self.say(shared::export_failed(locale), true);
            }
            _ => self.status = None,
        }
        self.warning.clear();
    }
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
                (_, Stage::Saving) => {
                    self.saved(ctx.locale(), &result);
                    Vec::new()
                }
                _ => Vec::new(),
            },
            // Leaving withdraws a prompt that is still up, so none outlives the screen.
            Some(E::Left(_)) => {
                self.stage = Stage::Choosing;
                self.gate.cancel()
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let (rows, headline, lede) = match (&self.rows, self.loaded) {
            (_, false) => (Vec::new(), String::new(), (self.spec.lede)(locale)),
            (Reading::Data(choices), _) => (
                choices
                    .iter()
                    .map(|choice| row(&choice.key, &choice.label, &choice.value, true, "Upload"))
                    .collect(),
                shared::export_headline(locale),
                (self.spec.lede)(locale),
            ),
            // The gate the vault drew: its words in the headline and the lede, no rows.
            (Reading::Denied(denial), _) => {
                let denied = (self.spec.denied)(locale, denial);
                (Vec::new(), denied.title, denied.body)
            }
            (Reading::Failed, _) => (
                Vec::new(),
                read::failure(locale).sentence,
                (self.spec.lede)(locale),
            ),
        };
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
            })),
            ..wire::ViewState::default()
        }
    }
}
