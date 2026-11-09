//! THE REMINDERS "FILTER AND SORT" MENU (#1173, `Main.dc.html`): which reminders the Reminders
//! home and the list pages draw, and in what order. One small model, shared by the home, the
//! smart-list pages and a list's own page.
//!
//! - **Show** (checked options): *Flagged only* narrows the rows, so it is the one thing that
//!   lights the funnel; *Completed* is a view (a list's completed rows open drawn), so it never does.
//! - **Sort**: Manual (the member's own order, the only one a row can be dragged in), Due date
//!   (undated last), Priority (most urgent first, unset last) and Title. A sort is not a filter.
//!   It orders the rows INSIDE each group and never moves one across groups. Today keeps its
//!   time-of-day order, because its groups are the parts of the day.
//!
//! The choice is a per-device habit for the Reminders place, kept in the keychain under
//! [`KEY`] and read again whenever a page appears, so a page opened after a pick wears it.

use centraid_api_proto::core_v1 as wire;

use crate::kit::menu::{self, Pick};
use crate::strings::{Locale, agenda_reminders as words};

/// The keychain entry the Reminders place keeps its choice under.
pub const KEY: &str = "agenda.reminders.view";

pub const SECTION_SHOW: &str = "show";
pub const SHOW_FLAGGED: &str = "flagged";
pub const SHOW_COMPLETED: &str = "completed";
pub const SORT_MANUAL: &str = "manual";
pub const SORT_DUE: &str = "due";
pub const SORT_PRIORITY: &str = "priority";
pub const SORT_TITLE: &str = "title";

/// How the rows of a group are ordered.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Sort {
    /// The member's own order (the tasks' positions).
    #[default]
    Manual,
    Due,
    Priority,
    Title,
}

impl Sort {
    const ALL: [(Self, &'static str); 4] = [
        (Self::Manual, SORT_MANUAL),
        (Self::Due, SORT_DUE),
        (Self::Priority, SORT_PRIORITY),
        (Self::Title, SORT_TITLE),
    ];

    fn key(self) -> &'static str {
        Self::ALL
            .iter()
            .find(|(sort, _)| *sort == self)
            .map_or(SORT_MANUAL, |(_, key)| key)
    }

    fn of(key: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .find(|(_, name)| *name == key)
            .map(|(sort, _)| *sort)
    }
}

/// What the menu holds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Options {
    pub flagged_only: bool,
    pub show_completed: bool,
    pub sort: Sort,
}

impl Options {
    /// The stored spelling: `sort=due;flagged=1;completed=0`.
    #[must_use]
    pub fn encode(&self) -> String {
        format!(
            "sort={};flagged={};completed={}",
            self.sort.key(),
            u8::from(self.flagged_only),
            u8::from(self.show_completed)
        )
    }

    /// The choice stored by [`Self::encode`]; anything unreadable is the default.
    #[must_use]
    pub fn decode(text: &str) -> Self {
        let mut out = Self::default();
        for part in text.split(';') {
            match part.split_once('=') {
                Some(("sort", key)) => out.sort = Sort::of(key).unwrap_or_default(),
                Some(("flagged", on)) => out.flagged_only = on == "1",
                Some(("completed", on)) => out.show_completed = on == "1",
                _ => {}
            }
        }
        out
    }

    /// A pick of the menu. Returns whether it changed anything.
    pub fn pick(&mut self, picked: Pick<'_>) -> bool {
        let before = *self;
        match (picked.section, picked.option) {
            (SECTION_SHOW, SHOW_FLAGGED) => self.flagged_only = !self.flagged_only,
            (SECTION_SHOW, SHOW_COMPLETED) => self.show_completed = !self.show_completed,
            (menu::SORT, key) => {
                if let Some(sort) = Sort::of(key) {
                    self.sort = sort;
                }
            }
            _ => {}
        }
        *self != before
    }

    /// "Clear filters": the narrowing goes, the sort and the views stay.
    pub fn clear(&mut self) -> bool {
        let was = self.flagged_only;
        self.flagged_only = false;
        was
    }

    /// Shape a group list: flagged roots only when asked, then each group in the chosen order.
    pub fn shape(&self, groups: &mut [wire::AgendaTaskGroup]) {
        for group in groups {
            if self.flagged_only {
                group.tasks.retain(|task| task.flagged);
            }
            match self.sort {
                Sort::Manual => {}
                Sort::Due => group.tasks.sort_by(|a, b| {
                    (a.due_day.is_empty(), &a.due_local, a.sort_order, &a.task_id).cmp(&(
                        b.due_day.is_empty(),
                        &b.due_local,
                        b.sort_order,
                        &b.task_id,
                    ))
                }),
                Sort::Priority => group.tasks.sort_by(|a, b| {
                    b.priority
                        .cmp(&a.priority)
                        .then(a.sort_order.cmp(&b.sort_order))
                        .then(a.task_id.cmp(&b.task_id))
                }),
                Sort::Title => group.tasks.sort_by_cached_key(|task| {
                    (
                        task.title.to_lowercase(),
                        task.sort_order,
                        task.task_id.clone(),
                    )
                }),
            }
        }
    }

    /// The menu the Reminders header draws.
    #[must_use]
    pub fn menu(&self, locale: Locale) -> wire::FilterMenu {
        let sort =
            |key: &str, label: String, which: Sort| menu::option(key, label, self.sort == which);
        menu::menu(
            locale,
            vec![
                menu::multi(
                    SECTION_SHOW,
                    words::menu_show(locale),
                    vec![
                        menu::option(
                            SHOW_FLAGGED,
                            words::menu_flagged_only(locale),
                            self.flagged_only,
                        ),
                        menu::option(
                            SHOW_COMPLETED,
                            words::menu_completed(locale),
                            self.show_completed,
                        ),
                    ],
                ),
                menu::single(
                    menu::SORT,
                    words::menu_sort(locale),
                    vec![
                        sort(SORT_MANUAL, words::sort_manual(locale), Sort::Manual),
                        sort(SORT_DUE, words::sort_due(locale), Sort::Due),
                        sort(SORT_PRIORITY, words::sort_priority(locale), Sort::Priority),
                        sort(SORT_TITLE, words::sort_title(locale), Sort::Title),
                    ],
                ),
            ],
            self.flagged_only,
        )
    }
}

/// Where a screen is in reading the stored choice.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Stage {
    #[default]
    Unasked,
    /// Another keychain read is out (the calendar's flag): ask when it lands.
    Later,
    /// The read is out; the next keychain answer is this screen's.
    Waiting,
    Done,
}

/// A screen's copy of the choice and its read of the keychain.
#[derive(Clone, Debug, Default)]
pub struct Prefs {
    pub options: Options,
    stage: Stage,
}

impl Prefs {
    /// A page appeared: read the choice again, so a pick made elsewhere since is worn.
    pub fn reset_and_ask(&mut self) -> Vec<wire::Effect> {
        self.stage = Stage::Unasked;
        self.ask()
    }

    /// Read the choice. Asked once until [`Self::reset_and_ask`].
    pub fn ask(&mut self) -> Vec<wire::Effect> {
        if matches!(self.stage, Stage::Waiting | Stage::Done) {
            return Vec::new();
        }
        self.stage = Stage::Waiting;
        vec![keychain(wire::keychain_op::Op::Get, Vec::new())]
    }

    /// Another keychain read is out: ask when it has been answered ([`Self::after_other`]).
    pub fn defer(&mut self) {
        if self.stage == Stage::Unasked {
            self.stage = Stage::Later;
        }
    }

    /// The other read landed: this screen's turn.
    pub fn after_other(&mut self) -> Vec<wire::Effect> {
        if self.stage == Stage::Later {
            self.stage = Stage::Unasked;
            return self.ask();
        }
        Vec::new()
    }

    /// Take the answer to [`Self::ask`]. True when the result was this screen's.
    pub fn answers(&mut self, result: &wire::EffectResult) -> bool {
        use wire::effect_result::Outcome as O;
        if self.stage != Stage::Waiting {
            return false;
        }
        let Some(O::Keychain(value)) = &result.outcome else {
            return false;
        };
        if value.found {
            self.options = Options::decode(&String::from_utf8_lossy(&value.value));
        }
        self.stage = Stage::Done;
        true
    }

    /// Whether the choice has been read (or there is nothing stored): a page waits on this to
    /// take the completed rows' default.
    #[must_use]
    pub fn is_read(&self) -> bool {
        self.stage == Stage::Done
    }

    /// The effect that keeps the choice.
    #[must_use]
    pub fn save(&self) -> wire::Effect {
        keychain(
            wire::keychain_op::Op::Set,
            self.options.encode().into_bytes(),
        )
    }
}

fn keychain(op: wire::keychain_op::Op, value: Vec<u8>) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::Keychain(wire::KeychainOp {
            op: op as i32,
            key: KEY.to_owned(),
            value,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(
        id: &str,
        title: &str,
        due: &str,
        priority: i64,
        order: i64,
        flagged: bool,
    ) -> wire::AgendaTask {
        wire::AgendaTask {
            task_id: id.to_owned(),
            title: title.to_owned(),
            due_day: due.get(..10).unwrap_or_default().to_owned(),
            due_local: due.to_owned(),
            priority,
            sort_order: order,
            flagged,
            ..wire::AgendaTask::default()
        }
    }

    fn groups() -> Vec<wire::AgendaTaskGroup> {
        vec![
            wire::AgendaTaskGroup {
                tasks: vec![
                    task("a", "banana", "", 0, 1, false),
                    task("b", "Apple", "2026-11-12", 5, 2, true),
                    task("c", "cherry", "2026-11-10T09:00", 9, 3, false),
                ],
                ..wire::AgendaTaskGroup::default()
            },
            wire::AgendaTaskGroup {
                tasks: vec![task("d", "zed", "2026-11-01", 1, 1, true)],
                ..wire::AgendaTaskGroup::default()
            },
        ]
    }

    fn ids(groups: &[wire::AgendaTaskGroup]) -> Vec<Vec<&str>> {
        groups
            .iter()
            .map(|g| g.tasks.iter().map(|t| t.task_id.as_str()).collect())
            .collect()
    }

    #[test]
    fn manual_is_the_cores_order_and_each_sort_orders_inside_a_group() {
        let mut shaped = groups();
        Options::default().shape(&mut shaped);
        assert_eq!(ids(&shaped), [vec!["a", "b", "c"], vec!["d"]]);
        let sorted = |sort| {
            let mut g = groups();
            Options {
                sort,
                ..Options::default()
            }
            .shape(&mut g);
            g
        };
        // Undated last.
        assert_eq!(ids(&sorted(Sort::Due))[0], ["c", "b", "a"]);
        // Higher is more urgent, unset last.
        assert_eq!(ids(&sorted(Sort::Priority))[0], ["c", "b", "a"]);
        // Case-insensitive; a row never leaves its group.
        let title = sorted(Sort::Title);
        assert_eq!(ids(&title), [vec!["b", "a", "c"], vec!["d"]]);
    }

    #[test]
    fn flagged_only_keeps_the_flagged_roots_and_is_the_only_thing_that_lights_the_funnel() {
        let mut shaped = groups();
        let options = Options {
            flagged_only: true,
            ..Options::default()
        };
        options.shape(&mut shaped);
        assert_eq!(ids(&shaped), [vec!["b"], vec!["d"]]);
        assert!(options.menu(Locale::En).filtering);
        for lit in [
            Options {
                sort: Sort::Title,
                ..Options::default()
            },
            Options {
                show_completed: true,
                ..Options::default()
            },
        ] {
            assert!(!lit.menu(Locale::En).filtering);
        }
    }

    #[test]
    fn a_pick_toggles_or_moves_the_check_and_clear_only_clears_the_filter() {
        let mut options = Options::default();
        let pick = |section, option| Pick { section, option };
        assert!(options.pick(pick(SECTION_SHOW, SHOW_FLAGGED)));
        assert!(options.pick(pick(SECTION_SHOW, SHOW_COMPLETED)));
        assert!(options.pick(pick(menu::SORT, SORT_PRIORITY)));
        assert!(
            !options.pick(pick(menu::SORT, SORT_PRIORITY)),
            "no change is no write"
        );
        assert!(!options.pick(pick("elsewhere", "x")));
        assert!(options.clear());
        assert_eq!(
            options,
            Options {
                flagged_only: false,
                show_completed: true,
                sort: Sort::Priority
            }
        );
        assert!(!options.clear());
    }

    #[test]
    fn the_choice_survives_its_storage_and_garbage_reads_as_the_default() {
        let options = Options {
            flagged_only: true,
            show_completed: true,
            sort: Sort::Due,
        };
        assert_eq!(Options::decode(&options.encode()), options);
        assert_eq!(
            Options::decode("sort=nope;flagged=maybe"),
            Options::default()
        );
        assert_eq!(Options::decode(""), Options::default());
    }

    #[test]
    fn prefs_read_once_wait_their_turn_and_take_only_a_keychain_answer() {
        let answer = |found, text: &str| wire::EffectResult {
            effect_id: 1,
            outcome: Some(wire::effect_result::Outcome::Keychain(
                wire::KeychainValue {
                    found,
                    value: text.as_bytes().to_vec(),
                },
            )),
        };
        let mut prefs = Prefs::default();
        prefs.defer();
        assert!(!prefs.answers(&answer(true, "sort=title")), "not asked yet");
        assert_eq!(prefs.after_other().len(), 1, "the other read landed");
        assert!(prefs.ask().is_empty(), "asked once");
        let done = wire::EffectResult {
            effect_id: 2,
            outcome: Some(wire::effect_result::Outcome::Done(
                wire::EffectDone::default(),
            )),
        };
        assert!(!prefs.answers(&done));
        assert!(prefs.answers(&answer(true, "sort=title;flagged=1;completed=1")));
        assert!(prefs.is_read());
        assert_eq!(prefs.options.sort, Sort::Title);
        assert!(prefs.options.flagged_only && prefs.options.show_completed);
    }
}
