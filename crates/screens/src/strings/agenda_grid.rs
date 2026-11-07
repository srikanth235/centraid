//! The Calendar's grids (#1173): the view menu's Week, Month and Year, the
//! week strip's initials and swipe names, the hour grid's words and the status
//! lines of a dragged event. The sentences are `design/mockups/Calendar.dc.html`'s.

catalog! {
    plain birthday = ("birthday", "birthday");
    plain event_changed = ("Event changed", "Event changed");
    plain event_moved = ("Event moved", "Event moved");
    plain grid_all_day = ("all-day", "all-day");
    plain initial_fri = ("F", "F");
    plain initial_mon = ("M", "M");
    plain initial_sat = ("S", "S");
    plain initial_sun = ("S", "S");
    plain initial_thu = ("T", "T");
    plain initial_tue = ("T", "T");
    plain initial_wed = ("W", "W");
    plain move_label = ("Move", "Move");
    plain next_month = ("Next month", "Next month");
    plain next_week = ("Next week", "Next week");
    plain next_year = ("Next year", "Next year");
    plain previous_month = ("Previous month", "Previous month");
    plain previous_week = ("Previous week", "Previous week");
    plain previous_year = ("Previous year", "Previous year");
    plain resize_label = ("Change end time", "Change end time");
    plain slot_hint = ("Hold to add an event", "Hold to add an event");
    plain style_grid = ("Grid", "Grid");
    plain style_list = ("List", "List");
    plain view_month = ("Month", "Month");
    plain view_week = ("Week", "Week");
    plain view_year = ("Year", "Year");
    plain week_of = ("Week of {day}", "Week of {day}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::strings::{Locale, fill};

    #[test]
    fn the_week_label_takes_its_day() {
        assert_eq!(
            fill(&week_of(Locale::En), &[("day", "2 November")]),
            "Week of 2 November"
        );
    }
}
