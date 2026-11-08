//! THE STYLE SHEET (#1173 wave 2): one draft and one sheet for making a list or
//! a calendar and for changing its name, colour and icon.
//!
//! The draft lives in the core. A shell draws [`wire::AgendaStyleSheet`] (the name
//! field, the eight swatches, the icon grid, "No icon") and sends the member's
//! picks. Colours are the `[list]` palette KEYS and icons are `design/icons.toml`
//! KEYS; a shell looks both up, and a key outside the curated sets
//! ([`LIST_COLORS`], [`LIST_ICONS`]) is ignored here before the vault is asked.
//!
//! A list that never stored a colour shows the one its id lands on
//! (`centraid_design::list_color_key`) as selected, and a Save that leaves the
//! colour alone writes none, so an unstyled list keeps its derived colour.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::commands::container::{LIST_COLORS, LIST_ICONS};

use super::todo::ops::Ops;
use crate::catalog::act;
use crate::field::Field;
use crate::screen::Ctx;
use crate::strings::{Locale, agenda_lists as words};

/// What the sheet makes or edits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Subject {
    List,
    Calendar,
}

/// What an edit started from, so a Save writes only what changed.
#[derive(Clone, Debug)]
struct Initial {
    id: String,
    name: String,
    color: String,
    icon: Option<String>,
}

/// The sheet's draft.
#[derive(Clone, Debug)]
pub(super) struct Draft {
    subject: Subject,
    /// `None` while making one.
    initial: Option<Initial>,
    name: String,
    /// Always a palette key: the selected swatch.
    color: String,
    icon: Option<String>,
}

impl Draft {
    /// A new list or calendar: no name, the palette's first colour, no icon.
    pub(super) fn making(subject: Subject) -> Self {
        Self {
            subject,
            initial: None,
            name: String::new(),
            color: LIST_COLORS[0].to_owned(),
            icon: None,
        }
    }

    /// An existing list or calendar, from what it stored.
    pub(super) fn editing(
        subject: Subject,
        id: &str,
        name: &str,
        stored_color: Option<&str>,
        icon: Option<&str>,
    ) -> Self {
        let color = centraid_design::list_color_key(id, stored_color).to_owned();
        let icon = icon
            .filter(|key| LIST_ICONS.contains(key))
            .map(str::to_owned);
        Self {
            subject,
            initial: Some(Initial {
                id: id.to_owned(),
                name: name.to_owned(),
                color: color.clone(),
                icon: icon.clone(),
            }),
            name: name.to_owned(),
            color,
            icon,
        }
    }

    pub(super) fn set_name(&mut self, name: String) {
        self.name = name;
    }

    /// A palette key picks its swatch; anything else is nothing.
    pub(super) fn pick_color(&mut self, key: &str) {
        if LIST_COLORS.contains(&key) {
            self.color = key.to_owned();
        }
    }

    /// A curated icon key picks it; an empty key clears it; anything else is nothing.
    pub(super) fn pick_icon(&mut self, key: &str) {
        if key.is_empty() {
            self.icon = None;
        } else if LIST_ICONS.contains(&key) {
            self.icon = Some(key.to_owned());
        }
    }

    fn name_changed(&self) -> bool {
        self.initial
            .as_ref()
            .is_none_or(|initial| self.name.trim() != initial.name.trim())
    }

    fn color_changed(&self) -> bool {
        self.initial
            .as_ref()
            .is_none_or(|initial| self.color != initial.color)
    }

    fn icon_changed(&self) -> bool {
        self.initial
            .as_ref()
            .is_none_or(|initial| self.icon != initial.icon)
    }

    /// Create or Save is armed by a name. An edit stays armed with nothing changed (the
    /// board's Save is solid); a submit that changes nothing writes nothing and closes.
    pub(super) fn can_submit(&self) -> bool {
        !self.name.trim().is_empty()
    }

    /// The sheet, as a shell draws it.
    pub(super) fn sheet(&self, locale: Locale) -> wire::AgendaStyleSheet {
        let editing = self.initial.is_some();
        wire::AgendaStyleSheet {
            title: match (self.subject, editing) {
                (Subject::List, false) => words::new_list_title(locale),
                (Subject::List, true) => words::edit_list_title(locale),
                (Subject::Calendar, false) => words::new_calendar_title(locale),
                (Subject::Calendar, true) => words::edit_calendar_title(locale),
            },
            name: self.name.clone(),
            name_placeholder: match self.subject {
                Subject::List => words::list_name_placeholder(locale),
                Subject::Calendar => words::calendar_name_placeholder(locale),
            },
            can_submit: self.can_submit(),
            submit_label: if editing {
                words::save(locale)
            } else {
                words::create(locale)
            },
            color_label: words::color_label(locale),
            colors: LIST_COLORS
                .iter()
                .map(|key| wire::AgendaStyleSwatch {
                    key: (*key).to_owned(),
                    label: words::color_name(locale, key),
                    selected: self.color == *key,
                })
                .collect(),
            icon_label: words::icon_label(locale),
            icons: LIST_ICONS
                .iter()
                .map(|key| wire::AgendaStyleIcon {
                    key: (*key).to_owned(),
                    label: words::icon_name(locale, key),
                    selected: self.icon.as_deref() == Some(*key),
                })
                .collect(),
            no_icon_label: words::no_icon(locale),
            no_icon_selected: self.icon.is_none(),
            color_key: self.color.clone(),
            icon_key: self.icon.clone().unwrap_or_default(),
            cancel_label: words::cancel(locale),
        }
    }

    /// Make or change it, one write at a time, the status line saying what
    /// happened (or the vault's refusal). Returns whether every write committed,
    /// so the sheet shuts only then and a refused sheet keeps the member's words.
    pub(super) fn submit(&self, ctx: &Ctx, ops: &mut Ops) -> bool {
        if !self.can_submit() {
            return false;
        }
        let locale = ctx.locale();
        let name = self.name.trim().to_owned();
        let icon = |keep: bool| match (&self.icon, keep) {
            (Some(key), true) => Field::Is(key.clone()),
            (None, true) => Field::Clear,
            (_, false) => Field::Keep,
        };
        let Some(initial) = &self.initial else {
            return match self.subject {
                Subject::List => ops.created(
                    ctx,
                    act::agenda::CreateProject {
                        kind: act::agenda::CreateProjectKind::Project,
                        title: name.clone(),
                        color: Field::Is(self.color.clone()),
                        icon: self.icon.clone().map_or(Field::Keep, Field::Is),
                        ..Default::default()
                    },
                    &format!("list/{name}"),
                    words::list_created(locale),
                ),
                Subject::Calendar => ops.created(
                    ctx,
                    act::agenda::CreateCalendar {
                        title: name.clone(),
                        color: Field::Is(create_color(&self.color)),
                        icon: self.icon.clone().map_or(Field::Keep, Field::Is),
                        ..Default::default()
                    },
                    &format!("calendar/{name}"),
                    words::calendar_created(locale),
                ),
            };
        };
        let done = match self.subject {
            Subject::List => words::list_updated(locale),
            Subject::Calendar => words::calendar_updated(locale),
        };
        if self.name_changed()
            && !ops.created(
                ctx,
                act::agenda::RenameList {
                    list_id: initial.id.clone(),
                    title: name.clone(),
                },
                &format!("{}={name}", initial.id),
                done.clone(),
            )
        {
            return false;
        }
        if self.color_changed() || self.icon_changed() {
            return ops.created(
                ctx,
                act::agenda::StyleContainer {
                    list_id: initial.id.clone(),
                    color: if self.color_changed() {
                        Field::Is(style_color(&self.color))
                    } else {
                        Field::Keep
                    },
                    icon: icon(self.icon_changed()),
                },
                &format!(
                    "{}:style:{}:{}",
                    initial.id,
                    self.color,
                    self.icon.as_deref().unwrap_or_default()
                ),
                done,
            );
        }
        true
    }
}

/// The icon a list or calendar wears: its stored key when it is one of the curated
/// set, else none (a key the set lacks would draw as a blank mark).
#[must_use]
pub(super) fn icon_of(stored: Option<&str>) -> String {
    stored
        .filter(|key| LIST_ICONS.contains(key))
        .map(str::to_owned)
        .unwrap_or_default()
}

fn create_color(key: &str) -> act::agenda::CreateCalendarColor {
    use act::agenda::CreateCalendarColor as C;
    match key {
        "mustard" => C::Mustard,
        "violet" => C::Violet,
        "petrol" => C::Petrol,
        "indigo" => C::Indigo,
        "graphite" => C::Graphite,
        "raspberry" => C::Raspberry,
        "orchid" => C::Orchid,
        _ => C::Blue,
    }
}

fn style_color(key: &str) -> act::agenda::StyleContainerColor {
    use act::agenda::StyleContainerColor as C;
    match key {
        "mustard" => C::Mustard,
        "violet" => C::Violet,
        "petrol" => C::Petrol,
        "indigo" => C::Indigo,
        "graphite" => C::Graphite,
        "raspberry" => C::Raspberry,
        "orchid" => C::Orchid,
        _ => C::Blue,
    }
}

/// The events' hue role (the wheel's `cIndigo`) nearest to a list colour, for
/// the places that still draw a calendar in the hue wheel: the same calendar
/// reads as nearly the same colour on its events as on its dot.
#[must_use]
pub(super) fn wheel_of_list_color(key: &str) -> Option<&'static str> {
    Some(match key {
        "blue" | "indigo" => "indigo",
        "mustard" => "ochre",
        "violet" | "orchid" => "violet",
        "petrol" => "teal",
        "graphite" => "slate",
        "raspberry" => "rose",
        _ => return None,
    })
}
