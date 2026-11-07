//! The editor's own sentences (`agenda.editor`): the repeat presets named for
//! the day they start on, and the rows spoken as day and time. Its other words
//! (the placeholders, the discard and skip questions, the scope rows) are
//! `strings::agenda`'s.

catalog! {
    plain field_location = ("Location", "Location");
    plain field_first_alert = ("Reminder", "Reminder");
    plain field_second_alert = ("Second reminder", "Second reminder");
    plain field_availability = ("Show as", "Show as");
    plain field_zone = ("Time zone", "Time zone");
    plain field_travel = ("Travel time", "Travel time");
    plain field_url = ("Address", "Address");
    plain placeholder_url = ("Paste a web address", "Paste a web address");
    plain placeholder_place_search = ("Search places", "Search places");
    plain placeholder_zone_search = ("Search time zones", "Search time zones");
    plain location_none = ("No location", "No location");
    plain place_unnamed = ("A place with no name", "A place with no name");
    plain no_places = ("No places match.", "No places match.");
    plain busy = ("Busy", "Busy");
    plain free = ("Free", "Free");
    plain zone_floating = ("No time zone", "No time zone");
    plain zone_name = ("{city}, {region}", "{city}, {region}");
    plain travel_none = ("None", "None");
    plain travel_5 = ("5 minutes", "5 minutes");
    plain travel_15 = ("15 minutes", "15 minutes");
    plain travel_30 = ("30 minutes", "30 minutes");
    plain travel_60 = ("1 hour", "1 hour");
    plain travel_90 = ("1 hour 30 minutes", "1 hour 30 minutes");
    plain travel_120 = ("2 hours", "2 hours");
    counted travel_minutes = ("{n} minute", "{n} minutes");
    plain block_url = ("That is not a web address.", "That is not a web address.");
    plain repeat_custom = ("Custom", "Custom");
    plain day_and_time = ("{day} · {time}", "{day} · {time}");
    plain repeat_biweekly_on = ("Every other week on {weekday}", "Every other week on {weekday}");
    plain repeat_monthly_on = ("Every month on the {ordinal}", "Every month on the {ordinal}");
    plain repeat_weekly_on = ("Every week on {weekday}", "Every week on {weekday}");
    plain repeat_yearly_on = ("Every year on {day_month}", "Every year on {day_month}");
}
