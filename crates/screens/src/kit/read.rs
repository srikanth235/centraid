//! THE THREE STATES OF A READ, once. A failed read is not an empty list: a
//! screen holds a [`Reading`] and draws loading, a [`wire::Failure`], a
//! [`wire::Denied`] gate or data, and never conjures an empty `data` out of a
//! refusal.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::follow::{Report, Store};
use crate::kit::follow::{Phone, Source};
use crate::screen::Ctx;
use crate::strings::{Locale, shared};

/// What one `load` came to.
#[derive(Clone, Debug, PartialEq)]
pub enum Reading<T> {
    Data(T),
    /// The vault would not let the app read: a gate to draw, not a failure.
    Denied(wire::AppQueryDenial),
    /// The core refused, or answered with something else.
    Failed,
}

impl<T> Reading<T> {
    /// The data, when there is data.
    #[must_use]
    pub fn data(&self) -> Option<&T> {
        match self {
            Self::Data(data) => Some(data),
            _ => None,
        }
    }
}

/// Load `request` and take the answer `pick` recognises.
pub fn read<T>(
    ctx: &Ctx,
    request: impl Into<wire::LoadRequest>,
    pick: impl FnOnce(Answer) -> Option<T>,
) -> Reading<T> {
    let Ok(response) = ctx.load(request.into()) else {
        return Reading::Failed;
    };
    match response.answer.and_then(|answer| answer.answer) {
        Some(Answer::Denied(denial)) => Reading::Denied(denial),
        Some(answer) => pick(answer).map_or(Reading::Failed, Reading::Data),
        None => Reading::Failed,
    }
}

/// The failure a view draws for a read that did not come back: one sentence and
/// the one thing to do.
#[must_use]
pub fn failure(locale: Locale) -> wire::Failure {
    wire::Failure {
        sentence: shared::read_failed(locale),
        remedy: shared::kit_retry(locale),
    }
}

/// The failure for an answer that arrived short: some of the reads a screen
/// needs came back and some did not, and neither can be made up.
#[must_use]
pub fn incomplete(locale: Locale) -> wire::Failure {
    wire::Failure {
        sentence: shared::read_incomplete(locale),
        remedy: shared::kit_retry(locale),
    }
}

// ---- THE PAGE (#1185) ------------------------------------------------------------------------

/// The kind of a [`Note`]; the stronger one wins when a page has both.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum NoteKind {
    /// Something beside the data was not checked (what the phone says). Carries no action.
    NotChecked,
    /// What is shown is some of it: a refresh that failed, or a follow that read part.
    Partial,
}

/// ONE SENTENCE OVER DATA, and at most one action (Retry). It only ever sits over data: nothing
/// shown means [`Page::Failed`], never a note.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Note {
    pub kind: NoteKind,
    pub sentence: String,
    /// Offer Retry. Only where trying again can help.
    pub retry: bool,
}

impl Note {
    /// A refresh failed over data already shown: it stays, with this note and Retry.
    #[must_use]
    pub fn refresh_failed(locale: Locale) -> Self {
        Self {
            kind: NoteKind::Partial,
            sentence: shared::read_refresh_failed(locale),
            retry: true,
        }
    }

    /// A follow pass the vault doubted or the phone reported incomplete, in the follow's own
    /// words. No Retry: reconnecting or the follow itself is the remedy, not a re-read.
    #[must_use]
    pub fn partial(report: &Report, locale: Locale, store: Store) -> Option<Self> {
        report.sentence(locale, store).map(|sentence| Self {
            kind: NoteKind::Partial,
            sentence,
            retry: false,
        })
    }

    /// A check beside the data that was not made ([`Phone`]). No action.
    #[must_use]
    pub fn unchecked(phone: &Phone, locale: Locale, source: Source<'_>) -> Option<Self> {
        phone.sentence(locale, source).map(|sentence| Self {
            kind: NoteKind::NotChecked,
            sentence,
            retry: false,
        })
    }

    fn wire(&self, locale: Locale) -> wire::PageNote {
        let kind = match self.kind {
            NoteKind::Partial => wire::page_note::Kind::Partial,
            NoteKind::NotChecked => wire::page_note::Kind::NotChecked,
        };
        wire::PageNote {
            kind: kind as i32,
            sentence: self.sentence.clone(),
            action_label: if self.retry {
                shared::kit_retry(locale)
            } else {
                String::new()
            },
        }
    }
}

/// WHAT A PAGE SHOWS FOR ITS READ, once for every app.
///
/// Precedence: first-load [`Page::Loading`] > [`Page::Refused`] (a gate, never retried by
/// itself) > [`Page::Failed`] (nothing to show) > [`Page::Ready`] (with at most one [`Note`],
/// Partial over NotChecked) > [`Page::Empty`], which only a read that succeeded with nothing
/// reaches. A refresh never blanks data on screen.
#[derive(Clone, Debug, PartialEq)]
pub enum Page<T> {
    Loading { first: bool },
    Failed,
    Refused(wire::AppQueryDenial),
    Empty,
    Ready { data: T, note: Option<Note> },
}

impl<T> Page<T> {
    /// The seeded first load.
    #[must_use]
    pub fn loading() -> Self {
        Self::Loading { first: true }
    }

    /// A reading as a page; `is_empty` says whether data that arrived holds nothing.
    #[must_use]
    pub fn of(reading: Reading<T>, is_empty: impl FnOnce(&T) -> bool) -> Self {
        match reading {
            Reading::Denied(denial) => Self::Refused(denial),
            Reading::Failed => Self::Failed,
            Reading::Data(data) if is_empty(&data) => Self::Empty,
            Reading::Data(data) => Self::Ready { data, note: None },
        }
    }

    /// The page to hold while a re-read runs: data (or an empty answer) already shown stays; a
    /// failure or gate goes back to the skeleton, as nothing is shown.
    #[must_use]
    pub fn refreshing(self) -> Self {
        match self {
            kept @ (Self::Ready { .. } | Self::Empty) => kept,
            _ => Self::loading(),
        }
    }

    /// The page after `reading` landed over `self` (the page before). A gate wins over what was
    /// shown; a failed refresh over data keeps it with [`Note::refresh_failed`] (rule 1); a failed
    /// read with nothing shown is [`Page::Failed`], never empty.
    #[must_use]
    pub fn after(
        self,
        reading: Reading<T>,
        locale: Locale,
        is_empty: impl FnOnce(&T) -> bool,
    ) -> Self {
        match (self, reading) {
            (Self::Ready { data, .. }, Reading::Failed) => Self::Ready {
                data,
                note: Some(Note::refresh_failed(locale)),
            },
            (_, reading) => Self::of(reading, is_empty),
        }
    }

    /// Add a note over data. Only [`Page::Ready`] takes one; the stronger kind wins, the first
    /// of equal kinds stays.
    #[must_use]
    pub fn noted(mut self, note: Option<Note>) -> Self {
        if let (Self::Ready { note: held, .. }, Some(note)) = (&mut self, note)
            && held.as_ref().is_none_or(|held| note.kind > held.kind)
        {
            *held = Some(note);
        }
        self
    }

    /// The data, when the page is ready.
    #[must_use]
    pub fn data(&self) -> Option<&T> {
        match self {
            Self::Ready { data, .. } => Some(data),
            _ => None,
        }
    }

    /// The note, when there is one.
    #[must_use]
    pub fn note(&self) -> Option<&Note> {
        match self {
            Self::Ready { note, .. } => note.as_ref(),
            _ => None,
        }
    }

    /// The wire state. `denied` words the gate (apps word their own and add the receipt); `empty`
    /// is the screen's empty state, asked only when the page is empty.
    #[must_use]
    pub fn wire(
        &self,
        locale: Locale,
        denied: impl FnOnce(&wire::AppQueryDenial) -> wire::Denied,
        empty: impl FnOnce() -> wire::EmptyState,
    ) -> wire::PageState {
        use wire::page_state::State;
        let (state, note) = match self {
            Self::Loading { first } => (
                Some(State::Loading(wire::Loading { first_load: *first })),
                None,
            ),
            Self::Failed => (Some(State::Failed(failure(locale))), None),
            Self::Refused(denial) => (Some(State::Refused(denied(denial))), None),
            Self::Empty => (Some(State::Empty(empty())), None),
            Self::Ready { note, .. } => (None, note.as_ref().map(|note| note.wire(locale))),
        };
        wire::PageState { state, note }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wire::page_state::State;

    const EN: Locale = Locale::En;

    fn full(items: &[u8]) -> Reading<Vec<u8>> {
        Reading::Data(items.to_vec())
    }

    fn page(reading: Reading<Vec<u8>>) -> Page<Vec<u8>> {
        Page::of(reading, Vec::is_empty)
    }

    fn denial() -> wire::AppQueryDenial {
        wire::AppQueryDenial::default()
    }

    fn state(page: &Page<Vec<u8>>) -> wire::PageState {
        page.wire(EN, |_| wire::Denied::default(), wire::EmptyState::default)
    }

    fn not_checked() -> Option<Note> {
        Some(Note {
            kind: NoteKind::NotChecked,
            sentence: "Couldn’t check what your phone says.".to_owned(),
            retry: false,
        })
    }

    #[test]
    fn a_first_read_is_loading_until_it_lands() {
        let wired = state(&Page::loading());
        assert_eq!(
            wired.state,
            Some(State::Loading(wire::Loading { first_load: true }))
        );
        assert!(wired.note.is_none());
    }

    #[test]
    fn a_refresh_never_blanks_what_is_shown() {
        let ready = page(full(&[1]));
        assert_eq!(ready.clone().refreshing(), ready);
        assert_eq!(page(full(&[])).refreshing(), Page::Empty);
        assert_eq!(Page::<Vec<u8>>::Failed.refreshing(), Page::loading());
        assert_eq!(
            Page::<Vec<u8>>::Refused(denial()).refreshing(),
            Page::loading()
        );
    }

    #[test]
    fn a_failed_refresh_keeps_the_data_with_a_note_and_retry() {
        let after = page(full(&[1])).after(Reading::Failed, EN, Vec::is_empty);
        assert_eq!(after.data(), Some(&vec![1]));
        let note = after.note().expect("a note");
        assert_eq!(note.kind, NoteKind::Partial);
        assert_eq!(note.sentence, shared::read_refresh_failed(EN));
        let wired = state(&after);
        assert!(wired.state.is_none(), "ready draws the page's own content");
        let wired = wired.note.expect("wire note");
        assert_eq!(wired.kind, wire::page_note::Kind::Partial as i32);
        assert_eq!(wired.action_label, shared::kit_retry(EN));
    }

    #[test]
    fn a_failure_with_nothing_shown_is_failed_and_never_empty() {
        for before in [Page::loading(), Page::Failed, Page::Empty] {
            let after = before.after(Reading::Failed, EN, Vec::is_empty);
            assert_eq!(after, Page::Failed);
            match state(&after).state {
                Some(State::Failed(failure)) => {
                    assert_eq!(failure.sentence, shared::read_failed(EN));
                    assert_eq!(failure.remedy, shared::kit_retry(EN));
                }
                other => panic!("expected failed, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_refusal_is_a_gate_never_failed_or_empty_even_over_data() {
        for before in [Page::loading(), Page::Failed, Page::Empty, page(full(&[1]))] {
            let after = before.after(Reading::Denied(denial()), EN, Vec::is_empty);
            assert!(matches!(after, Page::Refused(_)));
            assert!(matches!(state(&after).state, Some(State::Refused(_))));
        }
        assert!(matches!(page(Reading::Denied(denial())), Page::Refused(_)));
    }

    #[test]
    fn empty_only_follows_a_read_that_succeeded_with_nothing() {
        assert_eq!(page(full(&[])), Page::Empty);
        assert_eq!(
            page(full(&[])).after(full(&[]), EN, Vec::is_empty),
            Page::Empty
        );
        assert!(matches!(state(&Page::Empty).state, Some(State::Empty(_))));
        assert_ne!(page(Reading::Failed), Page::Empty);
    }

    #[test]
    fn data_after_a_failed_refresh_clears_the_note() {
        let noted = page(full(&[1])).after(Reading::Failed, EN, Vec::is_empty);
        assert!(noted.note().is_some());
        let healed = noted.after(full(&[2]), EN, Vec::is_empty);
        assert_eq!(healed.data(), Some(&vec![2]));
        assert!(healed.note().is_none());
    }

    #[test]
    fn partial_beats_not_checked_and_a_note_needs_data() {
        let report = Report {
            incomplete: true,
            ..Report::default()
        };
        let partial = Note::partial(&report, EN, Store::Files);
        assert!(partial.is_some());
        for (first, second) in [
            (not_checked(), partial.clone()),
            (partial.clone(), not_checked()),
        ] {
            let both = page(full(&[1])).noted(first).noted(second);
            assert_eq!(both.note().map(|n| n.kind), Some(NoteKind::Partial));
        }
        assert!(
            Page::<Vec<u8>>::Empty
                .noted(partial.clone())
                .note()
                .is_none()
        );
        assert!(Page::<Vec<u8>>::Failed.noted(partial).note().is_none());
    }

    #[test]
    fn not_checked_carries_no_action() {
        let wired = not_checked().expect("a note").wire(EN);
        assert_eq!(wired.kind, wire::page_note::Kind::NotChecked as i32);
        assert!(wired.action_label.is_empty());
        assert!(Note::unchecked(&Phone::default(), EN, Source::Phone).is_none());
    }

    #[test]
    fn a_partial_follow_uses_the_follows_words_and_no_retry() {
        let incomplete = Report {
            incomplete: true,
            ..Report::default()
        };
        let note = Note::partial(&incomplete, EN, Store::Contacts).expect("incomplete is partial");
        assert!(!note.retry);
        assert_eq!(
            Some(note.sentence.clone()),
            incomplete.sentence(EN, Store::Contacts)
        );
        assert!(note.wire(EN).action_label.is_empty());
        let doubted = Report {
            doubted: 3,
            incomplete: true,
            ..Report::default()
        };
        assert_eq!(
            Note::partial(&doubted, EN, Store::Contacts).map(|n| n.sentence),
            doubted.sentence(EN, Store::Contacts)
        );
        assert!(Note::partial(&Report::default(), EN, Store::Contacts).is_none());
    }
}
