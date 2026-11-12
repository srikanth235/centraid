//! THE KIT'S ONE SHARE (#1185, take out): a detail screen of a primary record hands ONE item to
//! the OS share sheet, the same way in every app: a "Share" entry in the page's menu
//! ([`LABEL`], [`ICON`], [`KEY`]), the owner check ([`OwnerGate`], `Leaving::Share`, a phone with
//! no passcode warns and goes ahead), then the item as a file (`ShareBytes`).
//!
//! The screen holds a [`Share`] and does three things: send [`Share::tap`] when the member picks
//! the entry, give [`Share::result`] every `EffectResult` with the closure that makes the item
//! (called only after the check passed), and draw [`Share::status`] in its status line. A
//! screen cannot forget the owner check: the item is only ever made inside [`Share::result`].
//!
//! Docs shares its stored file (`ShareFile`) and Photos its originals (`ExportOriginals`); both
//! are named in `promises.rs`. Locker shares nothing by decision (D11).
//!
//! ADOPTING, in the screen of a primary record: a `share: Share` field; the menu entry
//! (`share::KEY` / `share::label(locale)`) whose pick calls `self.share.tap(locale)`; in the
//! `EffectResult` arm `self.share.result(ctx, &result, |ctx| Ok(file))` and return its effects;
//! `status: self.share.status().or(..)`; `E::Left` returns `self.share.left()`.

use centraid_api_proto::core_v1 as wire;

use super::export::ExportFile;
use super::owner::{Answer, Leaving, NoPasscode, OwnerGate};
use crate::screen::Ctx;
use crate::strings::{Locale, shared};

/// The key of the entry, in every app's menu.
pub const KEY: &str = "share";
/// The kit's glyph for it.
pub const ICON: &str = "Share";

/// `Share`.
#[must_use]
pub fn label(locale: Locale) -> String {
    shared::share_entry(locale)
}

/// A file name for an item the member calls `title`: the title with its extension, no path
/// separators, and `fallback` ("Note") when there is no title.
#[must_use]
pub fn file_name(title: &str, extension: &str, fallback: &str) -> String {
    let stem: String = title
        .trim()
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '\n' | '\r') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let stem = stem.trim();
    format!(
        "{}.{extension}",
        if stem.is_empty() { fallback } else { stem }
    )
}

/// One share in flight, or none.
#[derive(Default)]
pub struct Share {
    gate: OwnerGate,
    /// The sheet is being raised; its answer is this share's.
    sending: bool,
    status: Option<wire::StatusLine>,
}

impl Share {
    /// The member picked Share: ask the owner check.
    pub fn tap(&mut self, locale: Locale) -> Vec<wire::Effect> {
        if self.gate.asking() || self.sending {
            return Vec::new();
        }
        self.status = None;
        self.gate.begin(locale, Leaving::Share)
    }

    /// An effect answered. Not this share's: nothing. The owner check's answer: on a pass `item`
    /// makes the file and the share sheet is raised; a refusal is the status line. The sheet's
    /// answer: a failure is the status line.
    pub fn result(
        &mut self,
        ctx: &Ctx,
        result: &wire::EffectResult,
        item: impl FnOnce(&Ctx) -> Result<ExportFile, String>,
    ) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        match &result.outcome {
            Some(wire::effect_result::Outcome::OwnerChecked(checked)) => {
                let Some(answer) = self.gate.answer(locale, NoPasscode::Warn, checked) else {
                    return Vec::new();
                };
                match answer {
                    Answer::Passed => self.send(ctx, item),
                    // No passcode: it goes ahead, and the line says nothing confirmed the owner.
                    Answer::PassedUnprotected(warning) => {
                        let effects = self.send(ctx, item);
                        if self.sending {
                            self.status = Some(wire::StatusLine {
                                sentence: warning,
                                action_label: String::new(),
                                refused: false,
                            });
                        }
                        effects
                    }
                    Answer::Refused(sentence) => {
                        self.say(sentence);
                        Vec::new()
                    }
                    Answer::Cancelled => Vec::new(),
                }
            }
            Some(wire::effect_result::Outcome::Failed(failure))
                if self.sending && !failure.cancelled =>
            {
                self.sending = false;
                self.say(shared::share_failed(locale));
                Vec::new()
            }
            Some(_) if self.sending => {
                self.sending = false;
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn send(
        &mut self,
        ctx: &Ctx,
        item: impl FnOnce(&Ctx) -> Result<ExportFile, String>,
    ) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        match item(ctx) {
            Ok(file) => {
                self.sending = true;
                vec![wire::Effect {
                    kind: Some(wire::effect::Kind::ShareBytes(wire::ShareBytes {
                        name: file.name,
                        media_type: file.media_type,
                        content: file.content,
                        chooser_title: shared::share_title(locale),
                    })),
                }]
            }
            Err(sentence) => {
                self.say(if sentence.is_empty() {
                    shared::share_failed(locale)
                } else {
                    sentence
                });
                Vec::new()
            }
        }
    }

    /// The member left the screen: take the prompt down if it is up.
    pub fn left(&mut self) -> Vec<wire::Effect> {
        self.gate.cancel()
    }

    /// The sentence the screen shows for the last attempt: a refusal, a failure, or the warning of a
    /// phone with no passcode.
    #[must_use]
    pub fn status(&self) -> Option<wire::StatusLine> {
        self.status.clone()
    }

    fn say(&mut self, sentence: String) {
        self.status = Some(wire::StatusLine {
            sentence,
            action_label: String::new(),
            refused: true,
        });
    }
}
