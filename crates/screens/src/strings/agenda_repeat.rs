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

    // The live sentence: the cadence, then the end. A count of one is the
    // singular form, so "Every day" is the one-step rule.
    counted every_days = ("Every day", "Every {n} days");
    counted every_weeks = ("Every week", "Every {n} weeks");
    counted every_months = ("Every month", "Every {n} months");
    counted every_years = ("Every year", "Every {n} years");
    counted weekly_on = ("Every week on {days}", "Every {n} weeks on {days}");
    counted monthly_on_dates = (
        "Every month on the {days}",
        "Every {n} months on the {days}"
    );
    counted monthly_on_nth = (
        "Every month on the {ordinal} {weekday}",
        "Every {n} months on the {ordinal} {weekday}"
    );
    plain list_last = ("{rest} and {last}", "{rest} and {last}");
    plain list_comma = ("{a}, {b}", "{a}, {b}");
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
