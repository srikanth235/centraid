//! Table tests for the quick-add date parser. Every `now` is pinned; nothing reads a clock.

use centraid_apps_reminders::nl_date::{Now, Parsed, Repeat, Weekday, parse};

/// A Saturday, mid-morning.
const SAT: &str = "2026-11-07T10:30";
/// The same Saturday, late evening.
const SAT_LATE: &str = "2026-11-07T21:15";
/// A Thursday, year end.
const DEC31: &str = "2026-12-31T09:00";
/// Non-leap February 28.
const FEB28: &str = "2027-02-28T12:00";
/// Leap-year February 28.
const FEB28_LEAP: &str = "2028-02-28T12:00";

fn run(input: &str, now: &str) -> Parsed {
    let now = Now::parse(now).expect("table nows are well formed");
    parse(input, &now)
}

type Row = (
    &'static str,
    &'static str,
    &'static str,
    Option<&'static str>,
    Option<&'static str>,
);

fn check(rows: &[Row]) {
    for (input, now, title, due, rule) in rows {
        let p = run(input, now);
        let got_due = p.when.as_ref().map(|w| w.due());
        let got_rule = p.repeat.as_ref().map(|r| r.rule());
        assert_eq!(
            (p.title.as_str(), got_due.as_deref(), got_rule.as_deref()),
            (*title, *due, *rule),
            "input {input:?} at {now}"
        );
    }
}

#[test]
fn locale_neutral_numerics_are_left_alone() {
    for input in [
        "Dentist 12/4",
        "Dentist 4.12",
        "Dentist 12/4/2026",
        "Dentist 4/12 at 9am x",
    ] {
        let p = run(input, SAT);
        assert_eq!((p.title.as_str(), p.matched()), (input, false), "{input}");
    }
    check(&[(
        "Dentist 12/4 tomorrow",
        SAT,
        "Dentist 12/4",
        Some("2026-11-08"),
        None,
    )]);
}

#[test]
fn no_false_positives_in_titles() {
    for input in [
        "Meet at 6th street",
        "Read chapter 9",
        "Read chapter 14",
        "Pick up 6 eggs",
        "Watch Friday Night Lights",
        "March on Washington",
        "Buy may flowers",
        "Room 1:1 sync",
        "Room 1:30 sync",
        "Call 911",
        "Fix bug 2026-13-45",
        "Fix bug 2026-02-30",
        "Sync at 12:00 sharp",
        "See Sun Tzu",
        "Look at",
        "by",
        "x by on at",
    ] {
        let p = run(input, SAT);
        assert_eq!(p.title, input, "{input}");
        assert!(!p.matched() && p.when.is_none() && p.repeat.is_none() && p.phrase.is_none());
    }
}

#[test]
fn only_a_trailing_phrase_is_read() {
    check(&[
        ("tomorrow call mom", SAT, "tomorrow call mom", None, None),
        ("call tomorrow mom", SAT, "call tomorrow mom", None, None),
        (
            "Remind me to call mom friday",
            SAT,
            "Remind me to call mom",
            Some("2026-11-13"),
            None,
        ),
        (
            "Call Friday Night Lights fri",
            SAT,
            "Call Friday Night Lights",
            Some("2026-11-13"),
            None,
        ),
        (
            "Lunch on friday at noon",
            SAT,
            "Lunch",
            Some("2026-11-13T12:00:00"),
            None,
        ),
        ("Buy 2 may 5", SAT, "Buy 2", Some("2027-05-05"), None),
    ]);
}

#[test]
fn whole_input_is_never_taken() {
    for input in [
        "tomorrow",
        "at 9am",
        "every day",
        "dec 4",
        "fri",
        "next week",
        "2026-12-04",
        "  tomorrow  ",
    ] {
        let p = run(input, SAT);
        assert_eq!(p.title, input);
        assert!(!p.matched());
    }
}

#[test]
fn whitespace_case_and_unicode() {
    check(&[
        (
            "Call mom tomorrow   ",
            SAT,
            "Call mom",
            Some("2026-11-08"),
            None,
        ),
        (
            "Call mom tomorrow\t\n",
            SAT,
            "Call mom",
            Some("2026-11-08"),
            None,
        ),
        (
            "Call   mom   tomorrow  at   9am",
            SAT,
            "Call   mom",
            Some("2026-11-08T09:00:00"),
            None,
        ),
        (
            "CALL MOM TOMORROW AT 9AM",
            SAT,
            "CALL MOM",
            Some("2026-11-08T09:00:00"),
            None,
        ),
        (
            "Call Mom Next FRI",
            SAT,
            "Call Mom",
            Some("2026-11-13"),
            None,
        ),
        ("買い物 tomorrow", SAT, "買い物", Some("2026-11-08"), None),
        (
            "🍕 party fri at 7pm",
            SAT,
            "🍕 party",
            Some("2026-11-13T19:00:00"),
            None,
        ),
        (
            "Ünïcode ß İ tomorrow",
            SAT,
            "Ünïcode ß İ",
            Some("2026-11-08"),
            None,
        ),
        (
            "Call mom\u{3000}tomorrow",
            SAT,
            "Call mom",
            Some("2026-11-08"),
            None,
        ),
        ("Trailing space   ", SAT, "Trailing space   ", None, None),
    ]);
    // Unmatched input comes back byte for byte, whitespace included.
    let p = run("  Just a title  ", SAT);
    assert_eq!(p.title, "  Just a title  ");
}

#[test]
fn nothing_panics_on_odd_utf8() {
    let pieces = [
        "🍕",
        "買い物",
        "ß",
        "İ",
        "at",
        "9",
        "am",
        ":",
        "30",
        "tomorrow",
        "dec",
        "4th",
        "every",
        "\u{200b}",
        "e\u{301}",
        "in",
        "２０２６-１２-０４",
        "٣",
        "fri",
        "\u{3000}",
        "next",
        "2026-12-04",
        "٩:٣٠",
        "9:30",
        "this",
        "evening",
        "\u{0}",
        "😀😀",
    ];
    let now = Now::parse(SAT).expect("well formed");
    for a in pieces {
        for b in pieces {
            for c in pieces {
                for sep in [" ", "", "\u{3000}"] {
                    let input = format!("x{sep}{a}{sep}{b}{sep}{c}{sep}");
                    let p = parse(&input, &now);
                    if let Some(r) = &p.phrase {
                        assert!(
                            input.get(r.clone()).is_some(),
                            "range splits a char in {input:?}"
                        );
                        assert!(input.is_char_boundary(r.start) && input.is_char_boundary(r.end));
                    }
                    assert!(p.matched() || p.title == input);
                    assert!(p.repeat.is_none() || p.when.is_some());
                }
            }
        }
    }
    for empty in ["", " ", "\n", "\u{3000}"] {
        assert!(!parse(empty, &now).matched());
        assert_eq!(parse(empty, &now).title, empty);
    }
}

#[test]
fn a_clock_time_round_trips_for_every_hour_and_minute() {
    let now = Now::parse(SAT).expect("well formed");
    for h in 0..24u8 {
        for m in (0..60u8).step_by(5) {
            let p = parse(&format!("Task at {h:02}:{m:02}"), &now);
            let when = p.when.expect("a padded 24-hour clock time always matches");
            assert_eq!(p.title, "Task");
            assert_eq!(when.time, Some((h, m)), "{h:02}:{m:02}");
            assert!(when.day.as_str() >= "2026-11-07", "{}", when.day);
            let later = (h, m) > (10, 30);
            assert_eq!(
                when.day,
                if later { "2026-11-07" } else { "2026-11-08" },
                "{h:02}:{m:02}"
            );
            assert!(p.repeat.is_none());
        }
    }
    for h12 in 1..=12u8 {
        for (suffix, base) in [("am", 0u8), ("pm", 12u8)] {
            for m in [0u8, 7, 30, 59] {
                let p = parse(&format!("Task {h12}:{m:02}{suffix}"), &now);
                let when = p.when.expect("am/pm times match without `at`");
                assert_eq!(
                    when.time,
                    Some((h12 % 12 + base, m)),
                    "{h12}:{m:02}{suffix}"
                );
                assert_eq!(p.title, "Task");
            }
        }
    }
}

#[test]
fn due_and_rule_spellings() {
    let p = run("x tomorrow at 9:05pm", SAT);
    let when = p.when.expect("matches");
    assert_eq!(when.day, "2026-11-08");
    assert_eq!(when.time, Some((21, 5)));
    assert_eq!(when.due(), "2026-11-08T21:05:00");
    let p = run("x tomorrow", SAT);
    assert_eq!(p.when.expect("matches").due(), "2026-11-08");

    assert_eq!(Repeat::Daily.rule(), "FREQ=DAILY");
    assert_eq!(Repeat::Weekdays.rule(), "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    assert_eq!(Repeat::Monthly.rule(), "FREQ=MONTHLY");
    assert_eq!(Repeat::Yearly.rule(), "FREQ=YEARLY");
    let days = [
        (Weekday::Mon, "MO"),
        (Weekday::Tue, "TU"),
        (Weekday::Wed, "WE"),
        (Weekday::Thu, "TH"),
        (Weekday::Fri, "FR"),
        (Weekday::Sat, "SA"),
        (Weekday::Sun, "SU"),
    ];
    for (d, code) in days {
        assert_eq!(
            Repeat::Weekly(d).rule(),
            format!("FREQ=WEEKLY;BYDAY={code}")
        );
    }
    assert_eq!(
        run("x every friday", SAT).repeat,
        Some(Repeat::Weekly(Weekday::Fri))
    );
    assert_eq!(run("x every weekday", SAT).repeat, Some(Repeat::Weekdays));
}

#[test]
fn a_repeat_always_has_a_day_on_or_after_today() {
    for now in [SAT, SAT_LATE, DEC31, FEB28, FEB28_LEAP] {
        let today = &now[..10];
        for phrase in [
            "every day",
            "daily",
            "every weekday",
            "every week",
            "weekly",
            "every month",
            "monthly",
            "every year",
            "yearly",
            "annually",
            "every mon",
            "every fri at 9am",
            "daily at 11pm",
        ] {
            let p = run(&format!("x {phrase}"), now);
            let when = p.when.expect("a repeat comes with a day");
            assert!(p.repeat.is_some());
            assert!(
                when.day.as_str() >= today,
                "{phrase} at {now}: {}",
                when.day
            );
        }
    }
}

#[test]
fn phrase_range_and_matched() {
    let input = "Call mom on friday at 6pm";
    let p = run(input, SAT);
    assert!(p.matched());
    assert_eq!(
        p.phrase.clone().and_then(|r| input.get(r)),
        Some("on friday at 6pm")
    );
    let input = "  Pay rent every month  ";
    let p = run(input, SAT);
    assert_eq!(p.title, "  Pay rent");
    assert_eq!(
        p.phrase.clone().and_then(|r| input.get(r)),
        Some("every month")
    );
}

#[test]
fn a_malformed_now_matches_nothing() {
    assert!(Now::parse("nope").is_none());
    let bad = Now {
        year: 2026,
        month: 13,
        day: 1,
        hour: 0,
        minute: 0,
    };
    let p = parse("x tomorrow", &bad);
    assert_eq!(p.title, "x tomorrow");
    assert!(!p.matched());
}
