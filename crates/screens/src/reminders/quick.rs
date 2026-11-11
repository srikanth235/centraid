//! THE QUICK ADD'S KEYBOARD TOOLBAR (#1173): Date, Tag, Flag, Link and Photo over
//! the keyboard, on To-do's home and on a project page.
//!
//! Each tool STAGES what the next add carries; Return adds the task with it,
//! clears the title and the staging, and leaves the field focused so the next
//! one can be typed at once. Date and Tag open a tray (the due choices, a tag
//! field); Flag is a switch with no tray. Link opens the kit's picker and Photo
//! the phone's, and what they hand back waits as a removable row in the staged
//! tray (`ListQuickStaged`): a link is made, and a photo filed, only when Return
//! adds the task, so a member who never adds leaves nothing in the vault.

use centraid_api_proto::core_v1 as wire;
use wire::effect_result::Outcome as O;

use crate::kit::attachments::refusal_of;
use crate::kit::links::{Kind, Links, Outcome};
use crate::reminders::detail::{self, NEXT_WEEK, NONE, TODAY, TOMORROW, WEEKEND};
use crate::screen::Ctx;
use crate::strings::{Locale, agenda_tasks as words, fill, links as link_words, task};

/// `TodoQuickTool.key`s.
pub const DATE: &str = "date";
pub const TAG: &str = "tag";
pub const FLAG: &str = "flag";
pub const LINK: &str = "link";
pub const PHOTO: &str = "photo";

/// What a staged row's `key` starts with, for each kind of row.
const LINK_ROW: &str = "link:";
const PHOTO_ROW: &str = "photo:";

const DUE_KEYS: [&str; 4] = [TODAY, TOMORROW, WEEKEND, NEXT_WEEK];

/// A link the next add will make: the item it names, as the picker showed it.
#[derive(Clone, Debug)]
struct StagedLink {
    kind: Kind,
    id: String,
    title: String,
}

/// What the answer to a `PickFile` came to, for the page to act on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Picked {
    /// Not an answer this toolbar was waiting for.
    NotMine,
    /// A photo is staged, or the picker was closed, or the bytes are still coming.
    Settled,
    /// The phone would not pick: the sentence says why, in the page's own status line.
    Refused(String),
}

/// What the next add carries, and the tray that is open.
#[derive(Clone, Debug)]
pub struct Quick {
    /// A `detail` due key (`today`, `tomorrow`, …), or empty for no date.
    due: String,
    /// Tags as typed, without the `#`, in order.
    tags: Vec<String>,
    flagged: bool,
    /// The tool whose tray is open: [`DATE`], [`TAG`] or empty.
    open: String,
    /// The picker the Link key opens, over every kind but Locker.
    links: Links,
    /// The items the next add links the new task to, in the order they were picked.
    linked: Vec<StagedLink>,
    /// The photos the next add files and attaches, as the phone staged them.
    photos: Vec<wire::FilePicked>,
    /// The phone's picker is up: a second press of Photo waits for it.
    picking: bool,
}

impl Default for Quick {
    fn default() -> Self {
        Self {
            due: String::new(),
            tags: Vec::new(),
            flagged: false,
            open: String::new(),
            links: Links::new(&Kind::ALL),
            linked: Vec::new(),
            photos: Vec::new(),
            picking: false,
        }
    }
}

impl Quick {
    /// A key of the toolbar: Date and Tag open their tray (a second press
    /// closes it); Flag flips the flag. Anything else is nothing.
    pub fn pick_tool(&mut self, key: &str) {
        match key {
            DATE | TAG => {
                self.open = if self.open == key {
                    String::new()
                } else {
                    key.to_owned()
                };
            }
            FLAG => {
                self.flagged = !self.flagged;
                self.open.clear();
            }
            _ => {}
        }
    }

    /// A key of the toolbar, with what the phone must do for it: Link opens the kit's picker (the
    /// kinds first), Photo asks the phone for one image and answers by [`Self::answer`]; every other
    /// key is [`Self::pick_tool`].
    pub fn press(&mut self, key: &str) -> Vec<wire::Effect> {
        match key {
            LINK => {
                self.open.clear();
                self.links.open_chooser();
                Vec::new()
            }
            PHOTO => {
                self.open.clear();
                if self.picking {
                    return Vec::new();
                }
                self.picking = true;
                vec![wire::Effect {
                    kind: Some(wire::effect::Kind::PickFile(wire::PickFile {
                        kind: wire::pick_file::Kind::Photo as i32,
                    })),
                }]
            }
            other => {
                self.pick_tool(other);
                Vec::new()
            }
        }
    }

    /// One tap in the link picker. The tap that picks an item stages it (the picker names it); a tap
    /// on one already staged takes it back off. Nothing is written yet.
    pub fn link_event(&mut self, ctx: &Ctx, event: &wire::LinkEvent) {
        let picked_title = match &event.kind {
            Some(wire::link_event::Kind::Pick(picked)) => self.links.candidate_title(&picked.id),
            _ => None,
        };
        let staged = self.linked_ids();
        match self.links.update(event, &staged, ctx) {
            Outcome::Moved => {}
            Outcome::Add { kind, id } => {
                if let Some(title) = picked_title
                    && !staged.contains(&id)
                {
                    self.linked.push(StagedLink { kind, id, title });
                }
            }
            Outcome::Remove { id } => self.linked.retain(|link| link.id != id),
        }
    }

    /// A staged row's ×: the link or the photo is not carried by the next add.
    pub fn remove_staged(&mut self, key: &str) {
        if let Some(id) = key.strip_prefix(LINK_ROW) {
            self.linked.retain(|link| link.id != id);
        } else if let Some(blob) = key.strip_prefix(PHOTO_ROW) {
            self.photos.retain(|photo| photo.blob != blob);
        }
    }

    /// The phone's answer to the Photo key. A pick is staged; a closed picker says nothing; a refusal
    /// (no grant, no picker, a file that would not go) is the page's status line, by the same words
    /// as an attach anywhere (`kit::attachments`).
    pub fn answer(&mut self, locale: Locale, outcome: &O) -> Picked {
        if !self.picking {
            return Picked::NotMine;
        }
        match outcome {
            O::FileProgress(_) => {}
            O::FilePicked(picked) => {
                self.picking = false;
                if !self.photos.iter().any(|have| have.blob == picked.blob) {
                    self.photos.push(picked.clone());
                }
            }
            O::Done(_) => self.picking = false,
            O::Failed(failed) => {
                self.picking = false;
                if !failed.cancelled {
                    return Picked::Refused(refusal_of(locale, failed));
                }
            }
            _ => return Picked::NotMine,
        }
        Picked::Settled
    }

    /// The ids the next add links the new task to.
    fn linked_ids(&self) -> Vec<String> {
        self.linked.iter().map(|link| link.id.clone()).collect()
    }

    /// What the next add links to: the item's id and its title as the member picked it.
    #[must_use]
    pub fn links(&self) -> Vec<(String, String)> {
        self.linked
            .iter()
            .map(|link| (link.id.clone(), link.title.clone()))
            .collect()
    }

    /// The photos the next add files and attaches.
    #[must_use]
    pub fn photos(&self) -> &[wire::FilePicked] {
        &self.photos
    }

    /// A picker is up, or a link or photo is staged: the keyboard leaving is not the member closing
    /// the bar, and shutting it would throw the staging away.
    #[must_use]
    pub fn holds_more(&self) -> bool {
        self.links.is_open() || self.picking || !self.linked.is_empty() || !self.photos.is_empty()
    }

    /// The picker sheet over the quick add, closed when no link is being chosen.
    #[must_use]
    pub fn link_picker(&self, locale: Locale) -> wire::LinkPicker {
        self.links.picker(locale, &self.linked_ids())
    }

    /// The staged tray, one row to a staged link and photo, each removable.
    fn staged_rows(&self, locale: Locale) -> Vec<wire::TodoStagedRow> {
        let links = self.linked.iter().map(|link| wire::TodoStagedRow {
            key: format!("{LINK_ROW}{}", link.id),
            kind_label: fill(
                &words::quick_staged_link(locale),
                &[("kind", link.kind.name(locale).as_str())],
            ),
            title: link.title.clone(),
            icon_key: "Link".to_owned(),
            remove_label: fill(
                &link_words::remove(locale),
                &[("name", link.title.as_str())],
            ),
        });
        let photos = self.photos.iter().map(|photo| {
            let title = Some(photo.name.trim().to_owned())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| words::quick_photo(locale));
            wire::TodoStagedRow {
                key: format!("{PHOTO_ROW}{}", photo.blob),
                kind_label: words::quick_photo(locale),
                remove_label: fill(&link_words::remove(locale), &[("name", title.as_str())]),
                title,
                icon_key: "Image".to_owned(),
            }
        });
        links.chain(photos).collect()
    }

    /// A due choice: a day key stages it, `none` clears it; the tray closes.
    pub fn pick_due(&mut self, key: &str) {
        if key == NONE {
            self.due.clear();
        } else if DUE_KEYS.contains(&key) {
            self.due = key.to_owned();
        } else {
            return;
        }
        self.open.clear();
    }

    /// A tag typed in the tray: trimmed, a leading `#` dropped, and a tag
    /// already staged (in any case) is not staged twice. The tray stays open
    /// for the next one.
    pub fn add_tag(&mut self, text: &str) {
        let tag = text.trim().trim_start_matches('#').trim();
        if tag.is_empty() || self.tags.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
            return;
        }
        self.tags.push(tag.to_owned());
    }

    /// The add committed: nothing is staged and no tray is open.
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    /// The staged due as a day from the core's `today`, or empty for none.
    #[must_use]
    pub fn due_day(&self, today: &str) -> String {
        detail::day_for(&self.due, today).unwrap_or_default()
    }

    #[must_use]
    pub fn tags(&self) -> &[String] {
        &self.tags
    }

    #[must_use]
    pub fn flagged(&self) -> bool {
        self.flagged
    }

    #[must_use]
    pub fn staged(&self) -> bool {
        !self.due.is_empty()
            || !self.tags.is_empty()
            || self.flagged
            || !self.linked.is_empty()
            || !self.photos.is_empty()
    }

    /// "Tomorrow · #errand · Flagged"; empty when nothing is staged.
    #[must_use]
    pub fn staged_label(&self, locale: Locale) -> String {
        let mut parts: Vec<String> = Vec::new();
        if !self.due.is_empty() {
            parts.push(due_label(locale, &self.due));
        }
        parts.extend(self.tags.iter().map(|tag| format!("#{tag}")));
        if self.flagged {
            parts.push(words::quick_flagged(locale));
        }
        parts.join(" · ")
    }

    fn tools(&self, locale: Locale) -> Vec<wire::TodoQuickTool> {
        [
            (
                DATE,
                words::quick_date(locale),
                "Calendar",
                !self.due.is_empty(),
            ),
            (TAG, words::quick_tag(locale), "Tag", !self.tags.is_empty()),
            (FLAG, words::quick_flag(locale), "Flag", self.flagged),
            (
                LINK,
                words::quick_link(locale),
                "Link",
                !self.linked.is_empty(),
            ),
            (
                PHOTO,
                words::quick_photo(locale),
                "Image",
                !self.photos.is_empty(),
            ),
        ]
        .into_iter()
        .map(|(key, label, icon, on)| wire::TodoQuickTool {
            key: key.to_owned(),
            label,
            icon_key: icon.to_owned(),
            on,
        })
        .collect()
    }

    fn due_choices(&self, locale: Locale) -> Vec<wire::TodoChoice> {
        DUE_KEYS
            .iter()
            .map(|key| (*key, self.due == *key))
            .chain(std::iter::once((NONE, self.due.is_empty())))
            .map(|(key, selected)| wire::TodoChoice {
                key: key.to_owned(),
                label: due_label(locale, key),
                selected,
                enabled: true,
                ..wire::TodoChoice::default()
            })
            .collect()
    }

    /// Draw the toolbar's half of a quick add.
    pub fn fill(&self, locale: Locale, quick: &mut wire::TodoQuickAdd) {
        quick.tools = self.tools(locale);
        quick.staged_label = self.staged_label(locale);
        quick.open_tool.clone_from(&self.open);
        quick.due_choices = if self.open == DATE {
            self.due_choices(locale)
        } else {
            Vec::new()
        };
        quick.tag_placeholder = task::tags_add(locale);
        quick.staged_rows = self.staged_rows(locale);
        quick.staged_group_label = words::quick_staged_group(locale);
        quick.link_picker = Some(self.link_picker(locale)).filter(|picker| picker.open);
    }
}

fn due_label(locale: Locale, key: &str) -> String {
    match key {
        TODAY => task::when_today(locale),
        TOMORROW => task::when_tomorrow(locale),
        WEEKEND => task::when_weekend(locale),
        NEXT_WEEK => task::when_next_week(locale),
        _ => task::when_none(locale),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: Locale = Locale::En;

    #[test]
    fn date_and_tag_toggle_their_tray_and_flag_is_a_switch() {
        let mut quick = Quick::default();
        quick.pick_tool(DATE);
        assert_eq!(quick.open, DATE);
        quick.pick_tool(TAG);
        assert_eq!(quick.open, TAG, "one tray at a time");
        quick.pick_tool(TAG);
        assert!(quick.open.is_empty());
        quick.pick_tool(FLAG);
        assert!(quick.flagged() && quick.open.is_empty());
        quick.pick_tool(FLAG);
        assert!(!quick.flagged());
        quick.pick_tool("photo");
        assert!(!quick.staged());
    }

    #[test]
    fn a_due_choice_stages_and_closes_the_tray_and_an_unknown_key_is_nothing() {
        let mut quick = Quick::default();
        quick.pick_tool(DATE);
        quick.pick_due("later");
        assert_eq!(quick.open, DATE);
        assert!(!quick.staged());
        quick.pick_due(TOMORROW);
        assert!(quick.open.is_empty());
        assert_eq!(quick.due_day("2026-11-07"), "2026-11-08");
        quick.pick_due(NONE);
        assert_eq!(quick.due_day("2026-11-07"), "");
    }

    #[test]
    fn tags_are_trimmed_and_deduped_in_any_case_and_the_label_joins_what_is_staged() {
        let mut quick = Quick::default();
        for tag in [" #Errand ", "errand", "", "  ", "home"] {
            quick.add_tag(tag);
        }
        assert_eq!(quick.tags(), ["Errand".to_owned(), "home".to_owned()]);
        quick.pick_due(TOMORROW);
        quick.pick_tool(FLAG);
        assert_eq!(
            quick.staged_label(EN),
            "Tomorrow · #Errand · #home · Flagged"
        );
        quick.clear();
        assert_eq!(quick.staged_label(EN), "");
    }
}
