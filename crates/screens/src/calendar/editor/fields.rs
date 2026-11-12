//! THE EVENT EDITOR'S FIELDS ON EXISTING VAULT COLUMNS (#1173 wave 2): the
//! place (chosen from the vault's places), the second alert, availability, the
//! time zone and travel time, and a task's address. Each is a draft value, a
//! choice list the view draws and the handler that changes the value.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use super::Editor;
use crate::calendar::event::reminder_label;
use crate::catalog::act;
use crate::catalog::load;
use crate::kit::act as kit_act;
use crate::kit::read::{self as kit_read, Reading};
use crate::kit::schedule::draft::{
    Draft, REMINDER_NONE, REMINDERS, TRAVELS, ZONE_FLOATING, alerts_of,
};
use crate::screen::Ctx;
use crate::strings::{Locale, agenda as words, agenda_editor as editor_words, fill};

/// The key of the choice that takes the words the member typed as the place: `text:<words>`.
const TYPED: &str = "text:";
/// A place's name is at most this long (the vault's bound).
const MAX_PLACE_NAME: usize = 120;

pub const AVAILABILITY_BUSY: &str = "busy";
pub const AVAILABILITY_FREE: &str = "free";

/// A place the vault holds, as the picker lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Place {
    pub id: String,
    pub label: String,
}

/// The vault's named places (the photos app's one places read), A to Z. A refused or
/// failed read is an empty list: an event can still be saved without a place.
pub fn read_places(ctx: &Ctx) -> Vec<Place> {
    let reading = kit_read::read(
        ctx,
        load::photos::Places::default(),
        |answer| match answer {
            Answer::PhotosPlaces(places) => Some(places),
            _ => None,
        },
    );
    let Reading::Data(places) = reading else {
        return Vec::new();
    };
    let mut listed: Vec<Place> = places
        .places
        .into_iter()
        // ONLY A PLACE THE MEMBER NAMED is offered. A photograph's bare spot ("near Truckee",
        // "A place with no name yet") is not somewhere an event happens; the event's own place
        // stays listed by `place_choices` whatever its name.
        .filter_map(|card| {
            let id = card.place?.place_id;
            let label = card.name.filter(|name| !name.trim().is_empty())?;
            (!id.is_empty()).then_some(Place { id, label })
        })
        .collect();
    listed.sort_by_cached_key(|place| (place.label.to_lowercase(), place.id.clone()));
    listed
}

/// The zones the picker offers, beside the phone's own and the event's: a
/// curated spread of the world's, by IANA id. The vault refuses an id it does
/// not know, so a zone here is one it takes.
pub const ZONES: [&str; 74] = [
    "UTC",
    "Europe/London",
    "Europe/Dublin",
    "Europe/Lisbon",
    "Europe/Madrid",
    "Europe/Paris",
    "Europe/Brussels",
    "Europe/Amsterdam",
    "Europe/Berlin",
    "Europe/Zurich",
    "Europe/Rome",
    "Europe/Vienna",
    "Europe/Prague",
    "Europe/Warsaw",
    "Europe/Stockholm",
    "Europe/Oslo",
    "Europe/Copenhagen",
    "Europe/Helsinki",
    "Europe/Athens",
    "Europe/Istanbul",
    "Europe/Kyiv",
    "Europe/Moscow",
    "Atlantic/Reykjavik",
    "Atlantic/Azores",
    "Africa/Casablanca",
    "Africa/Lagos",
    "Africa/Cairo",
    "Africa/Nairobi",
    "Africa/Johannesburg",
    "Asia/Jerusalem",
    "Asia/Riyadh",
    "Asia/Dubai",
    "Asia/Tehran",
    "Asia/Karachi",
    "Asia/Kolkata",
    "Asia/Dhaka",
    "Asia/Bangkok",
    "Asia/Jakarta",
    "Asia/Singapore",
    "Asia/Hong_Kong",
    "Asia/Shanghai",
    "Asia/Taipei",
    "Asia/Manila",
    "Asia/Seoul",
    "Asia/Tokyo",
    "Australia/Perth",
    "Australia/Adelaide",
    "Australia/Darwin",
    "Australia/Brisbane",
    "Australia/Sydney",
    "Australia/Melbourne",
    "Pacific/Auckland",
    "Pacific/Fiji",
    "Pacific/Honolulu",
    "America/Anchorage",
    "America/Los_Angeles",
    "America/Vancouver",
    "America/Phoenix",
    "America/Denver",
    "America/Chicago",
    "America/Mexico_City",
    "America/Costa_Rica",
    "America/New_York",
    "America/Toronto",
    "America/Halifax",
    "America/St_Johns",
    "America/Bogota",
    "America/Lima",
    "America/Caracas",
    "America/Santiago",
    "America/Sao_Paulo",
    "America/Argentina/Buenos_Aires",
    "America/Havana",
    "America/Jamaica",
];

/// `London, Europe` for `Europe/London`: the page's one spelling of a zone.
fn zone_title(locale: Locale, id: &str) -> String {
    crate::calendar::event::zone_title(locale, id)
}

/// Whether `text` is in the choice's words, in any case, an underscore being a space.
fn matches_query(query: &str, haystacks: &[&str]) -> bool {
    let query = query.trim().to_lowercase();
    query.is_empty()
        || haystacks
            .iter()
            .any(|text| text.to_lowercase().replace('_', " ").contains(&query))
}

impl Editor {
    /// Open a sheet the editor draws. The second alert waits for the first and
    /// the zone for a timed event.
    pub(super) fn open_sheet(&mut self, sheet: wire::agenda_editor_state::Sheet) {
        use wire::agenda_editor_state::Sheet;
        let Some(draft) = &self.draft else { return };
        let (no_first_alert, all_day) = (draft.reminder_key == REMINDER_NONE, draft.all_day);
        match sheet {
            Sheet::CustomRepeat => self.open_custom(),
            Sheet::SecondReminder if no_first_alert => {}
            Sheet::Zone if all_day => {}
            _ => {
                self.close_sheet();
                self.sheet = sheet;
            }
        }
    }

    /// A timed event always has a zone but one that is floating by choice: an
    /// all-day event made timed gets the phone's.
    pub(super) fn settle_zone(&mut self, ctx: &Ctx) {
        let floating_by_choice = self.mode == wire::agenda_editor_state::Mode::Edit
            && self
                .baseline
                .as_ref()
                .is_some_and(|base| !base.all_day && base.zone.is_empty());
        if floating_by_choice {
            return;
        }
        let device = ctx.zone().to_owned();
        if let Some(draft) = &mut self.draft
            && !draft.all_day
            && draft.zone.is_empty()
        {
            draft.zone = device;
        }
    }

    // -- the place ----------------------------------------------------------

    fn place_known(&self, id: &str) -> bool {
        self.loaded
            .as_ref()
            .is_some_and(|loaded| loaded.places.iter().any(|place| place.id == id))
            || self
                .baseline
                .as_ref()
                .is_some_and(|base| !id.is_empty() && base.place_id == id)
    }

    pub(super) fn pick_place(&mut self, id: &str) {
        // THE ROW THAT TAKES THE TYPED WORDS: the place is founded when the event saves.
        if let Some(typed) = id.strip_prefix(TYPED) {
            let typed: String = typed.trim().chars().take(MAX_PLACE_NAME).collect();
            if typed.is_empty() {
                return;
            }
            self.close_sheet();
            self.typed_place = typed;
            self.edit(|d| {
                Some(Draft {
                    place_id: String::new(),
                    ..d.clone()
                })
            });
            return;
        }
        if !self.place_known(id) {
            return;
        }
        self.close_sheet();
        self.typed_place.clear();
        let id = id.to_owned();
        self.edit(|d| {
            Some(Draft {
                place_id: id,
                ..d.clone()
            })
        });
    }

    pub(super) fn clear_place(&mut self) {
        self.close_sheet();
        self.typed_place.clear();
        self.edit(|d| {
            Some(Draft {
                place_id: String::new(),
                ..d.clone()
            })
        });
    }

    /// The typed place as a place of the vault: one already called that (the list, A to Z, is
    /// the vault's), else a new one. `None` says why on the status line and saves nothing.
    pub(super) fn found_typed_place(&mut self, ctx: &Ctx) -> Option<String> {
        let name = self.typed_place.trim().to_owned();
        // THE VAULT'S PLACES NOW, not the list read when the page opened: another page may have
        // founded these words since.
        if let Some(known) = read_places(ctx)
            .into_iter()
            .find(|place| place.label.trim().eq_ignore_ascii_case(&name))
        {
            return Some(known.id);
        }
        let key = kit_act::key(&["add-place", &name], kit_act::fresh());
        let settled = self.undo.act_also(
            ctx,
            act::calendar::AddPlace {
                title: name,
                ..Default::default()
            },
            &key,
        );
        if !settled.committed {
            return None;
        }
        settled.output_text("id")
    }

    /// The place's name: the vault's list, else the event's own answer.
    fn place_name(&self, id: &str) -> Option<String> {
        self.loaded
            .as_ref()?
            .places
            .iter()
            .find(|place| place.id == id)
            .map(|place| place.label.clone())
            .or_else(|| {
                let event = self.event()?;
                (event.location_place_id.as_deref() == Some(id))
                    .then(|| event.location_name.clone())
                    .flatten()
                    .filter(|name| !name.trim().is_empty())
            })
    }

    pub(super) fn location_label(&self, locale: Locale, draft: &Draft) -> String {
        if !self.typed_place.trim().is_empty() {
            return self.typed_place.trim().to_owned();
        }
        if draft.place_id.is_empty() {
            return editor_words::location_none(locale);
        }
        self.place_name(&draft.place_id)
            .unwrap_or_else(|| editor_words::place_unnamed(locale))
    }

    /// The places that match the search, the chosen one marked (and kept in the
    /// list, so the sheet always shows where the event is).
    pub(super) fn place_choices(&self, locale: Locale, draft: &Draft) -> Vec<wire::AgendaChoice> {
        let Some(loaded) = &self.loaded else {
            return Vec::new();
        };
        let mut choices: Vec<wire::AgendaChoice> = loaded
            .places
            .iter()
            .filter(|place| matches_query(&self.place_query, &[&place.label]))
            .map(|place| {
                choice(
                    &place.id,
                    &place.label,
                    self.typed_place.trim().is_empty() && place.id == draft.place_id,
                )
            })
            .collect();
        // WHAT THE MEMBER TYPED is a place too: the chosen words stay in the list, and the words
        // in the search box are offered unless a place is already called that.
        let typed = self.typed_place.trim();
        if !typed.is_empty() && matches_query(&self.place_query, &[typed]) {
            choices.insert(0, choice(&format!("{TYPED}{typed}"), typed, true));
        }
        let query = self.place_query.trim();
        let offered = !query.is_empty()
            && !query.eq_ignore_ascii_case(typed)
            && !loaded
                .places
                .iter()
                .any(|place| place.label.trim().eq_ignore_ascii_case(query));
        if offered {
            let label = fill(&editor_words::place_use(locale), &[("place", query)]);
            choices.push(choice(&format!("{TYPED}{query}"), &label, false));
        }
        let chosen_listed = loaded.places.iter().any(|place| place.id == draft.place_id);
        if !draft.place_id.is_empty() && !chosen_listed && typed.is_empty() {
            let label = self.location_label(locale, draft);
            if matches_query(&self.place_query, &[&label]) {
                choices.insert(0, choice(&draft.place_id, &label, true));
            }
        }
        choices
    }

    // -- the alerts ---------------------------------------------------------

    /// The second alert's choices: none, then every lead but the first's.
    pub(super) fn second_reminder_keys(&self, draft: &Draft) -> Vec<String> {
        self.reminder_keys()
            .into_iter()
            .filter(|key| *key == REMINDER_NONE || *key != draft.reminder_key)
            .collect()
    }

    pub(super) fn pick_second_reminder(&mut self, key: &str) {
        let Some(draft) = &self.draft else { return };
        if draft.reminder_key == REMINDER_NONE
            || !self.second_reminder_keys(draft).iter().any(|k| k == key)
        {
            return;
        }
        self.close_sheet();
        let key = key.to_owned();
        self.edit(|d| {
            Some(Draft {
                second_reminder_key: key,
                ..d.clone()
            })
        });
    }

    pub(super) fn second_reminder_choices(
        &self,
        locale: Locale,
        draft: &Draft,
    ) -> Vec<wire::AgendaChoice> {
        self.second_reminder_keys(draft)
            .into_iter()
            .map(|key| {
                let label = key.parse::<i64>().map_or_else(
                    |_| words::reminder_none(locale),
                    |minutes| reminder_label(locale, minutes),
                );
                let selected = alerts_of(draft).get(1).map_or_else(
                    || key == REMINDER_NONE,
                    |second| key.parse::<i64>().ok() == Some(*second),
                );
                choice(&key, &label, selected)
            })
            .collect()
    }

    /// The leads a baseline already holds beside the offered ones: an alert set
    /// elsewhere stays choosable.
    pub(super) fn stored_leads(&self) -> Vec<i64> {
        self.baseline
            .iter()
            .flat_map(|base| [&base.reminder_key, &base.second_reminder_key])
            .filter_map(|key| key.parse::<i64>().ok())
            .chain(REMINDERS)
            .collect()
    }

    // -- availability -------------------------------------------------------

    pub(super) fn pick_availability(&mut self, key: &str) {
        let free = match key {
            AVAILABILITY_BUSY => false,
            AVAILABILITY_FREE => true,
            _ => return,
        };
        self.close_sheet();
        self.edit(|d| Some(Draft { free, ..d.clone() }));
    }

    pub(super) fn availability_choices(locale: Locale, draft: &Draft) -> Vec<wire::AgendaChoice> {
        vec![
            choice(AVAILABILITY_BUSY, &editor_words::busy(locale), !draft.free),
            choice(AVAILABILITY_FREE, &editor_words::free(locale), draft.free),
        ]
    }

    // -- the zone -----------------------------------------------------------

    /// Every zone the picker can pick, the phone's and the event's among them.
    /// "No time zone" is offered to an event that has none by choice.
    fn zone_ids(&self, device: &str, draft: &Draft) -> Vec<String> {
        let mut ids: Vec<String> = ZONES.iter().map(|id| (*id).to_owned()).collect();
        let base_zone = self.baseline.as_ref().map(|base| base.zone.clone());
        ids.extend(
            [device.to_owned(), draft.zone.clone()]
                .into_iter()
                .chain(base_zone)
                .filter(|id| !id.is_empty()),
        );
        ids.sort();
        ids.dedup();
        ids
    }

    fn offers_floating(&self) -> bool {
        self.mode == wire::agenda_editor_state::Mode::Edit
            && self
                .baseline
                .as_ref()
                .is_some_and(|base| !base.all_day && base.zone.is_empty())
    }

    pub(super) fn pick_zone(&mut self, key: &str, device: &str) {
        let Some(draft) = &self.draft else { return };
        let zone = if key == ZONE_FLOATING && self.offers_floating() {
            String::new()
        } else if self.zone_ids(device, draft).iter().any(|id| id == key) {
            key.to_owned()
        } else {
            return;
        };
        self.close_sheet();
        self.edit(|d| Some(Draft { zone, ..d.clone() }));
    }

    pub(super) fn zone_label(&self, locale: Locale, draft: &Draft) -> String {
        if draft.zone.is_empty() {
            editor_words::zone_floating(locale)
        } else {
            zone_title(locale, &draft.zone)
        }
    }

    pub(super) fn zone_choices(
        &self,
        locale: Locale,
        device: &str,
        draft: &Draft,
    ) -> Vec<wire::AgendaChoice> {
        let floating = self.offers_floating().then(|| {
            let label = editor_words::zone_floating(locale);
            (ZONE_FLOATING.to_owned(), label, draft.zone.is_empty())
        });
        let mut zones: Vec<(String, String, bool)> = self
            .zone_ids(device, draft)
            .into_iter()
            .map(|id| {
                let label = zone_title(locale, &id);
                let selected = id == draft.zone;
                (id, label, selected)
            })
            .collect();
        zones.sort_by_cached_key(|(_, label, _)| label.to_lowercase());
        floating
            .into_iter()
            .chain(zones)
            .filter(|(id, label, _)| matches_query(&self.zone_query, &[label, id]))
            .map(|(id, label, selected)| choice(&id, &label, selected))
            .collect()
    }

    // -- travel -------------------------------------------------------------

    fn travel_keys(&self) -> Vec<i32> {
        let stored = self.baseline.as_ref().map(|base| base.travel_min);
        let mut minutes: Vec<i32> = TRAVELS.iter().copied().chain(stored).collect();
        minutes.sort_unstable();
        minutes.dedup();
        minutes
    }

    pub(super) fn pick_travel(&mut self, key: &str) {
        let Some(minutes) = key
            .parse::<i32>()
            .ok()
            .filter(|minutes| self.travel_keys().contains(minutes))
        else {
            return;
        };
        self.close_sheet();
        self.edit(|d| {
            Some(Draft {
                travel_min: minutes,
                ..d.clone()
            })
        });
    }

    pub(super) fn travel_label(locale: Locale, minutes: i32) -> String {
        crate::calendar::event::travel_label(locale, i64::from(minutes))
    }

    pub(super) fn travel_choices(&self, locale: Locale, draft: &Draft) -> Vec<wire::AgendaChoice> {
        self.travel_keys()
            .into_iter()
            .map(|minutes| {
                choice(
                    &minutes.to_string(),
                    &Self::travel_label(locale, minutes),
                    minutes == draft.travel_min,
                )
            })
            .collect()
    }
}

pub(super) fn choice(key: &str, label: &str, selected: bool) -> wire::AgendaChoice {
    wire::AgendaChoice {
        key: key.to_owned(),
        label: label.to_owned(),
        selected,
        hue_key: String::new(),
        accessibility_label: label.to_owned(),
    }
}
