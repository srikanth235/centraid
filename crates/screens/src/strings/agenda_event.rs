//! The event page's own sentences (`agenda.event`): the words a finished fact
//! row, a guest heading and a spoken label are made of. The page's other words
//! (RSVP answers, the scope rows, the cancel confirm) are `strings::agenda`'s.

catalog! {
    plain date_range = ("{from} – {to}", "{from} – {to}");
    plain day_long = ("{weekday} {day} {month}", "{weekday} {day} {month}");
    plain guest_awaiting_suffix = ("{heading} · {awaiting} awaiting", "{heading} · {awaiting} awaiting");
    counted guest_count = ("{n} guest", "{n} guests");
    plain guest_name_you = ("{name} · you", "{name} · you");
    plain guest_spoken = ("{name}, {reply}", "{name}, {reply}");
    counted reminder_minutes_before = ("{n} minute before", "{n} minutes before");
    plain spoken_range = ("{from} to {to}", "{from} to {to}");
}
