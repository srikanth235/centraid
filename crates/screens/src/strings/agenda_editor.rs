//! The editor's own sentences (`agenda.editor`): the repeat presets named for
//! the day they start on, and the rows spoken as day and time. Its other words
//! (the placeholders, the discard and skip questions, the scope rows) are
//! `strings::agenda`'s.

catalog! {
    plain day_and_time = ("{day} · {time}", "{day} · {time}");
    plain repeat_biweekly_on = ("Every other week on {weekday}", "Every other week on {weekday}");
    plain repeat_monthly_on = ("Every month on the {ordinal}", "Every month on the {ordinal}");
    plain repeat_weekly_on = ("Every week on {weekday}", "Every week on {weekday}");
    plain repeat_yearly_on = ("Every year on {day_month}", "Every year on {day_month}");
}
