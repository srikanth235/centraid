//! AUTOSAVE (#1015 D3: autosave everywhere; close = done): an editor that
//! saves as the member writes.
//!
//! - An edit never writes at once: it (re)starts one debounce timer
//!   ([`DEBOUNCE`], through `ctx.start_timer`), so a burst of typing is one save.
//! - [`Autosave::flush`] saves NOW, and a screen calls it on `Left` (close =
//!   done) — the runtime's last chance for an `act` before the view is dropped.
//! - Each save is ONE action under a key no earlier gesture used
//!   ([`kit_act::fresh`]): the vault journals a key for good and answers a
//!   second delivery "replayed" without running it.
//! - Only the changed fields are sent, measured against the baseline: the
//!   draft's own [`Draft::request`] says which.
//! - **A change from the vault never overwrites words being typed.** While
//!   there are unsaved words, [`Autosave::loaded`] keeps the draft and notes
//!   `remote_changed`; once those words are saved the screen is told to read
//!   again.
//! - **A save checks what it is replacing (#1185).** A draft knows the revision of the record it
//!   was read from ([`Draft::base_rev`]) and its save names it (`expected_rev`); the vault refuses
//!   a save whose record has changed since (`stale_revision`) or was moved to the trash
//!   (`stale_trashed`). The editor then rests in [`Phase::Conflict`]: the words stay on screen with
//!   a sentence over them, nothing retries (not the timer, not leaving), and Reload
//!   ([`Autosave::resolve`]) first keeps the words as an earlier version of the record
//!   ([`Draft::keep_request`]) and lets the screen read the vault's row.
//! - A refused save keeps the words on screen with the sentence over them.
//!
//! `act` answers at once (the phone is the vault), so SAVING is a phase only
//! inside one call; a view never sees it, and the words typed "while a save is
//! in flight" cannot exist. The phase is still part of the wire
//! ([`wire::autosave::Phase`]) and its label ("Saving…") is still said.

use std::collections::BTreeSet;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use wire::autosave::Phase;

use super::act as kit_act;
use super::stale;
pub use super::stale::Stale;
use crate::screen::Ctx;
use crate::strings::{Locale, shared};

/// How long typing pauses before the words are saved.
pub const DEBOUNCE: Duration = Duration::from_millis(900);

/// The name of the debounce timer: a screen routes `TimerFired` with this name
/// to [`Autosave::fired`].
pub const TIMER: &str = "autosave";

/// The words a member types, as one editor saves them.
pub trait Draft: Clone + PartialEq {
    /// The action a save submits (the key's first part).
    const ACTION: &'static str;

    /// What the draft is about, for the key.
    fn subject(&self) -> &str;

    /// Why the draft cannot be saved as it stands, in a sentence, or `None`.
    fn refusal(&self, locale: Locale) -> Option<String>;

    /// The action naming ONLY what changed against `baseline`, or `None` when
    /// nothing did. App-owned: only the app knows its action's fields.
    fn request(&self, baseline: &Self) -> Option<wire::ActRequest>;

    /// A save of this draft committed, with the action's output (JSON). A draft
    /// whose save CREATED its row learns the id here and is an edit from now on, and one whose
    /// save answered `rev` takes it as its base.
    fn committed(&mut self, _output: &[u8]) {}

    /// The record is at `rev` now, after a write of this editor that was not its save: the new base.
    fn rebased(&mut self, _rev: i64) {}

    /// The id of the record the draft is of, once there is one (a new draft has none).
    fn subject_id(&self) -> Option<&str> {
        None
    }

    /// What the record is called in the sentences of a refused save: "note", "person".
    fn noun(locale: Locale) -> String;

    /// The revision of the record this draft was read from, which its save names as
    /// `expected_rev`; `None` for a draft not yet saved once (a create names none). Shown on the
    /// wire as `base_revision_id`.
    fn base_rev(&self) -> Option<i64> {
        None
    }

    /// The words this draft holds that the record does not, as `table.column` to value, for the
    /// vault to keep as an earlier version when a save was refused as stale. Empty keeps nothing.
    fn kept_fields(&self, _baseline: &Self) -> Vec<(String, serde_json::Value)> {
        Vec::new()
    }
}

/// One autosaving editor's phase, seqs, draft and baseline.
///
/// `edit_seq` counts edits; `saved_seq` is the last edit the vault committed.
/// Unsaved words exist exactly when `edit_seq > saved_seq`.
#[derive(Clone, Debug)]
pub struct Autosave<D: Draft> {
    draft: Option<D>,
    /// The draft as the vault last had it.
    baseline: Option<D>,
    phase: Phase,
    edit_seq: u64,
    saved_seq: u64,
    saving_seq: u64,
    /// The refusal's sentence, while the phase is REFUSED.
    failure: Option<String>,
    remote_changed: bool,
    /// Why the vault refused the save as stale, while the phase is CONFLICT.
    conflict: Option<Stale>,
    /// The tables this editor's committed saves wrote since a screen last
    /// took them ([`Autosave::take_written`]).
    written: BTreeSet<String>,
}

impl<D: Draft> Default for Autosave<D> {
    fn default() -> Self {
        Self::new()
    }
}

impl<D: Draft> Autosave<D> {
    #[must_use]
    pub fn new() -> Self {
        Self {
            draft: None,
            baseline: None,
            phase: Phase::Clean,
            edit_seq: 0,
            saved_seq: 0,
            saving_seq: 0,
            failure: None,
            remote_changed: false,
            conflict: None,
            written: BTreeSet::new(),
        }
    }

    /// The draft as the vault last had it.
    #[must_use]
    pub fn baseline(&self) -> Option<&D> {
        self.baseline.as_ref()
    }

    /// The tables this editor's own committed saves wrote since the last call,
    /// emptied by it. A screen that must tell the core's change for its own
    /// commit from a foreign one marks these (the act's `tables`).
    pub fn take_written(&mut self) -> BTreeSet<String> {
        std::mem::take(&mut self.written)
    }

    /// The draft, once the vault's row has arrived.
    #[must_use]
    pub fn draft(&self) -> Option<&D> {
        self.draft.as_ref()
    }

    /// Are there words the vault does not have?
    #[must_use]
    pub fn unsaved(&self) -> bool {
        self.edit_seq > self.saved_seq
    }

    /// Is the editor resting with everything saved?
    #[must_use]
    pub fn saved(&self) -> bool {
        matches!(self.phase, Phase::Clean | Phase::Saved) && !self.unsaved()
    }

    /// The vault's row arrived. Over unsaved words it replaces NOTHING and
    /// notes that the vault moved (returns `false`); otherwise it is the draft
    /// and the baseline (returns `true`).
    pub fn loaded(&mut self, fresh: D) -> bool {
        if self.unsaved() && self.draft.is_some() {
            self.remote_changed = true;
            return false;
        }
        self.draft = Some(fresh.clone());
        self.baseline = Some(fresh);
        self.phase = Phase::Clean;
        self.saved_seq = self.edit_seq;
        self.failure = None;
        self.remote_changed = false;
        self.conflict = None;
        true
    }

    /// The vault moved under unsaved words in a way a read cannot show as a row (the record went
    /// to the trash): the draft stays and the screen is told to read again once they are saved.
    pub fn vault_moved(&mut self) {
        if self.unsaved() {
            self.remote_changed = true;
        }
    }

    /// An edit: DIRTY, a new seq, and a debounce. A change that leaves the
    /// draft as it was is nothing.
    pub fn edit(&mut self, ctx: &Ctx, change: impl FnOnce(&mut D)) {
        let Some(draft) = self.draft.as_mut() else {
            return;
        };
        let before = draft.clone();
        change(draft);
        if *draft == before {
            return;
        }
        self.edit_seq += 1;
        // The words go on being typed over a conflict, and nothing saves them: Reload keeps them.
        if self.phase == Phase::Conflict {
            return;
        }
        self.phase = Phase::Dirty;
        self.failure = None;
        ctx.start_timer(TIMER, DEBOUNCE);
    }

    /// The debounce came due: save, if there is a save to make. Returns whether
    /// the screen should read the vault again (it moved while words were
    /// unsaved, and they are saved now).
    #[must_use]
    pub fn fired(&mut self, ctx: &Ctx, timer: &str) -> bool {
        if timer != TIMER || self.phase != Phase::Dirty {
            return false;
        }
        self.save(ctx)
    }

    /// SAVE NOW, if there is anything to save: leaving (close = done). A
    /// refused save is tried once more — the member closing over it is asking
    /// for it to be kept. A CONFLICT is not tried again: the vault said the record is not the one
    /// these words were made from, and saying it twice changes nothing. Returns whether the screen
    /// should read again.
    #[must_use]
    pub fn flush(&mut self, ctx: &Ctx) -> bool {
        match self.phase {
            Phase::Dirty | Phase::Refused if self.unsaved() => {
                ctx.cancel_timer(TIMER);
                self.save(ctx)
            }
            _ => false,
        }
    }

    fn save(&mut self, ctx: &Ctx) -> bool {
        let Some(draft) = self.draft.clone() else {
            return false;
        };
        if let Some(sentence) = draft.refusal(ctx.locale()) {
            self.phase = Phase::Refused;
            self.failure = Some(sentence);
            return false;
        }
        let baseline = self.baseline.clone().unwrap_or_else(|| draft.clone());
        // NOTHING CHANGED against the baseline (an edit typed and undone):
        // saved, with no action.
        let Some(request) = draft.request(&baseline) else {
            self.phase = Phase::Saved;
            self.saved_seq = self.edit_seq;
            self.failure = None;
            return false;
        };
        self.phase = Phase::Saving;
        self.saving_seq = self.edit_seq;
        let key = kit_act::key(&[D::ACTION, draft.subject()], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        if !settled.committed {
            // THE WORDS STAY. The sentence goes over them, never instead.
            if let Some(stale) = settled.stale() {
                self.phase = Phase::Conflict;
                self.conflict = Some(stale);
                self.failure = Some(stale::sentence(ctx.locale(), &D::noun(ctx.locale()), stale));
                return false;
            }
            self.phase = Phase::Refused;
            self.failure = Some(settled.refusal);
            return false;
        }
        self.written.extend(settled.tables.iter().cloned());
        let mut draft = draft;
        draft.committed(&settled.output);
        self.draft = Some(draft.clone());
        self.baseline = Some(draft);
        self.saved_seq = self.saving_seq;
        self.failure = None;
        self.phase = Phase::Saved;
        // Everything is saved. If the vault moved meanwhile, read it now.
        std::mem::take(&mut self.remote_changed)
    }

    /// The status line's words for the phase: "Saved", "Edited", "Saving…",
    /// the refusal's own sentence or "Not saved", "Changed on another device".
    #[must_use]
    pub fn label(&self, locale: Locale) -> String {
        match self.phase {
            Phase::Clean | Phase::Saved => shared::autosave_saved(locale),
            Phase::Dirty => shared::autosave_edited(locale),
            Phase::Saving => shared::autosave_saving(locale),
            Phase::Refused => self
                .failure
                .clone()
                .filter(|sentence| !sentence.is_empty())
                .unwrap_or_else(|| shared::autosave_not_saved(locale)),
            Phase::Conflict => self
                .failure
                .clone()
                .filter(|sentence| !sentence.is_empty())
                .unwrap_or_else(|| shared::autosave_changed_elsewhere(locale)),
            Phase::Unspecified => String::new(),
        }
    }

    /// The wire message a view draws: the phase with its words, finished.
    #[must_use]
    pub fn view(&self, locale: Locale) -> wire::Autosave {
        wire::Autosave {
            phase: self.phase as i32,
            edit_seq: self.edit_seq,
            saved_seq: self.saved_seq,
            base_revision_id: self
                .draft
                .as_ref()
                .and_then(Draft::base_rev)
                .map(|rev| rev.to_string())
                .unwrap_or_default(),
            failure: self.failure.as_ref().map(|sentence| wire::Failure {
                sentence: sentence.clone(),
                remedy: String::new(),
            }),
            remote_changed: self.remote_changed,
            label: self.label(locale),
            refused: matches!(self.phase, Phase::Refused | Phase::Conflict),
        }
    }
}

/// What Reload came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolved {
    /// The editor was not in conflict: nothing was done.
    Nothing,
    /// The words are kept as an earlier version (`kept`) or the record already held them, and the
    /// editor holds no draft: the screen reads the vault's row.
    Reloaded { stale: Stale, kept: bool },
    /// The words could not be kept; they stay on screen under the vault's sentence.
    Failed,
}

impl<D: Draft> Autosave<D> {
    /// A write of the same record that is not this editor's save (a tap on a field) was refused as
    /// stale: the editor rests in conflict, whatever it held, and Reload reads the record again.
    pub fn conflicted(&mut self, locale: Locale, stale: Stale) {
        if self.draft.is_none() {
            return;
        }
        self.phase = Phase::Conflict;
        self.conflict = Some(stale);
        self.failure = Some(stale::sentence(locale, &D::noun(locale), stale));
    }

    /// The editor's own write of another field committed and left the record at `rev`: the draft
    /// and its baseline are of that revision from now on, so the next save is not refused for
    /// a change the member made themselves.
    pub fn rebase(&mut self, rev: i64) {
        for draft in [self.draft.as_mut(), self.baseline.as_mut()]
            .into_iter()
            .flatten()
        {
            draft.rebased(rev);
        }
    }

    /// The status line of a conflict, for a screen that draws a [`wire::StatusLine`]: the sentence
    /// and Reload.
    #[must_use]
    pub fn conflict_line(&self, locale: Locale) -> Option<wire::StatusLine> {
        let stale = self.conflict()?;
        Some(stale::line(locale, &D::noun(locale), stale))
    }

    /// Why the save was refused, while the editor rests in conflict.
    #[must_use]
    pub fn conflict(&self) -> Option<Stale> {
        self.conflict.filter(|_| self.phase == Phase::Conflict)
    }

    /// RELOAD, after a conflict: keep the member's words as an earlier version of the record
    /// ([`Draft::kept_fields`]), then let go of the draft so the screen's next read replaces it
    /// with the vault's row. A keep the vault refuses leaves everything as it was, the sentence
    /// being the vault's, and the words still on screen.
    pub fn resolve(&mut self, ctx: &Ctx) -> Resolved {
        let Some(stale) = self.conflict() else {
            return Resolved::Nothing;
        };
        let (Some(draft), Some(baseline)) = (self.draft.as_ref(), self.baseline.as_ref()) else {
            return Resolved::Nothing;
        };
        let fields = draft.kept_fields(baseline);
        let mut kept = false;
        if let (false, Some(id)) = (fields.is_empty(), draft.subject_id()) {
            match stale::keep(ctx, id, fields) {
                Ok(done) => {
                    self.written.extend(done.tables);
                    kept = done.written;
                }
                Err(sentence) => {
                    self.failure = Some(sentence);
                    return Resolved::Failed;
                }
            }
        }
        self.draft = None;
        self.baseline = None;
        self.saved_seq = self.edit_seq;
        self.phase = Phase::Clean;
        self.failure = None;
        self.conflict = None;
        self.remote_changed = false;
        Resolved::Reloaded { stale, kept }
    }
}
