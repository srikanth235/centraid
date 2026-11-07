//! The Custom repeat sheet's own words (`agenda.editor`, #1173 wave 2): its
//! labels, the live summary sentence the sheet builds as the member changes the
//! rule, and the sentence each unfinished rule says it is missing. The editor's
//! other words are `strings::agenda_editor`'s and `strings::agenda`'s.

catalog! {
    plain title = ("Custom repeat", "Custom repeat");
    plain done = ("Done", "Done");
    plain frequency_label = ("Repeats", "Repeats");
    plain freq_daily = ("Daily", "Daily");
    plain freq_weekly = ("Weekly", "Weekly");
    plain freq_monthly = ("Monthly", "Monthly");
    plain freq_yearly = ("Yearly", "Yearly");
    plain interval_label = ("Every", "Every");
    counted unit_days = ("day", "days");
    counted unit_weeks = ("week", "weeks");
    counted unit_months = ("month", "months");
    counted unit_years = ("year", "years");
    plain weekdays_label = ("On", "On");
    plain mode_date = ("On days of the month", "On days of the month");
    plain mode_nth = ("On the", "On the");
    plain month_days_label = ("Days of the month", "Days of the month");
    plain last_day = ("Last day", "Last day");
    plain ordinal_first = ("First", "First");
    plain ordinal_second = ("Second", "Second");
    plain ordinal_third = ("Third", "Third");
    plain ordinal_fourth = ("Fourth", "Fourth");
    plain ordinal_fifth = ("Fifth", "Fifth");
    plain ordinal_last = ("Last", "Last");
    plain ends_label = ("Ends", "Ends");
    plain end_never = ("Never", "Never");
    plain end_on = ("On a date", "On a date");
    plain end_after = ("After", "After");
    counted count_label = ("time", "times");
    plain replace = ("Replace this rule", "Replace this rule");
    plain unrepresentable = (
        "This rule came from somewhere else and the editor cannot show its parts.",
        "This rule came from somewhere else and the editor cannot show its parts."
    );

    // THE ONE RECURRENCE SENTENCE (owner decision, #1173): the sheet's live
    // summary and every stored rule's sentence are built from these, in
    // `agenda::rule_words`. The cadence, then clauses for each part the rule
    // carries, then the end. A count of one is the singular form, so "Every
    // day" is the one-step rule.
    counted every_days = ("Every day", "Every {n} days");
    counted every_weeks = ("Every week", "Every {n} weeks");
    counted every_months = ("Every month", "Every {n} months");
    counted every_years = ("Every year", "Every {n} years");
    plain clause_on = ("on {items}", "on {items}");
    plain clause_when = ("when it falls on {items}", "when it falls on {items}");
    plain clause_in = ("in {items}", "in {items}");
    plain clause_among = ("among {items}", "among {items}");
    plain clause_year_days = ("on the {items} day of the year", "on the {items} day of the year");
    plain the_items = ("the {items}", "the {items}");
    plain nth_weekday = ("the {ordinal} {weekday}", "the {ordinal} {weekday}");
    plain each_weekdays = ("each {days}", "each {days}");
    plain ordinal_to_last = ("{ordinal} to last", "{ordinal} to last");
    plain day_to_last = ("{ordinal} to last day", "{ordinal} to last day");
    plain week_number = ("week {n}", "week {n}");
    plain week_last = ("the last week", "the last week");
    plain week_to_last = ("the {ordinal} to last week", "the {ordinal} to last week");
    plain set_weekday = ("the {ordinals} weekday", "the {ordinals} weekday");
    plain set_weekend_day = ("the {ordinals} weekend day", "the {ordinals} weekend day");
    plain set_of_days = ("the {ordinals} of {days}", "the {ordinals} of {days}");
    plain set_any_day = ("the {ordinals} day", "the {ordinals} day");
    plain list_last = ("{rest} and {last}", "{rest} and {last}");
    plain list_comma = ("{a}, {b}", "{a}, {b}");
    plain until_date = ("{weekday} {day} {month} {year}", "{weekday} {day} {month} {year}");
    plain ending_until = ("{cadence}, until {day}", "{cadence}, until {day}");
    counted ending_count = ("{cadence}, once", "{cadence}, {n} times");

    // What an unfinished rule is missing.
    plain error_weekday = ("Pick at least one day of the week.", "Pick at least one day of the week.");
    plain error_month_day = ("Pick at least one day of the month.", "Pick at least one day of the month.");
    plain error_interval = ("Repeat every 1 to 99 steps.", "Repeat every 1 to 99 steps.");
    plain error_until = ("Pick the day the repeat ends on.", "Pick the day the repeat ends on.");
    plain error_until_before = ("The repeat must end on or after its first day.", "The repeat must end on or after its first day.");
    plain error_rule = ("That repeat is not a rule yet.", "That repeat is not a rule yet.");
    plain error_count = ("Repeat between 1 and 999 times.", "Repeat between 1 and 999 times.");
}
