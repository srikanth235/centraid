//! A CALENDAR'S COLOUR, ONE FOR EVERY SURFACE (#1173): the grid, the picker, the event page and the
//! More sheet's mark all read the same list-palette token.

use std::collections::HashMap;

use centraid_api_proto::core_v1 as wire;

/// A party hue for an event on no calendar: neutral, and never a brand.
pub const NO_CALENDAR_HUE: &str = "cSlate";

/// The calendar's colour role by id: People's convention, so no view converts
/// a wheel word. A calendar that stores `var(--c-<hue>)` gets that hue; one that
/// stores nothing, or a colour the wheel cannot name, gets its id's own.
pub struct Hues<'a> {
    stored: HashMap<&'a str, Option<&'a str>>,
}

impl<'a> Hues<'a> {
    pub fn of(calendars: &'a [wire::AgendaCalendar]) -> Self {
        Self {
            stored: calendars
                .iter()
                .map(|calendar| (calendar.calendar_id.as_str(), calendar.color.as_deref()))
                .collect(),
        }
    }

    /// THE ONE COLOUR OF A CALENDAR (#1173): its list-palette token (`listBlue`), the colour
    /// the member chose or else the id's own place on the palette (`list_color_key`), which is
    /// also what the More sheet's mark wears. So a block, a chip, a dot, the picker and the
    /// event page all read the same colour; an event on no calendar is the neutral one.
    pub fn grid_hue(&self, id: Option<&str>) -> String {
        let Some(id) = id else {
            return NO_CALENDAR_HUE.to_owned();
        };
        let stored = self.stored.get(id).copied().flatten().map(str::trim);
        let key = centraid_design::list_color_key(id, stored);
        let mut chars = key.chars();
        let first = chars.next().map(|c| c.to_ascii_uppercase());
        format!("list{}{}", first.unwrap_or_default(), chars.as_str())
    }
}
