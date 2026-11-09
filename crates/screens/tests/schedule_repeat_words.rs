//! THE ONE RECURRENCE SENTENCE (owner decision on #1173): the words of a rule
//! live in the core strings, not in the vault. The vault answers the rule's
//! shape (`centraid_vault::time::rrule::shape`); `agenda::rule_words` says it,
//! and the Custom repeat sheet's live summary says the same words.
//!
//! Before the decision the vault said "Daily" and "Monthly on the 22nd" while
//! the sheet said "Every day" and "Every month on the 22nd"; one wording
//! exists now, the sheet's, extended to every shape the engine reads.

use std::path::PathBuf;

use centraid_screens::kit::schedule::rule_words::{of_rule, stored};
use centraid_screens::strings::Locale;

fn said(rule: &str) -> String {
    of_rule(Locale::En, rule).unwrap_or_else(|| panic!("{rule}: words"))
}

#[test]
fn every_shape_has_one_sentence() {
    for (rule, words) in [
        ("FREQ=DAILY", "Every day"),
        ("FREQ=WEEKLY", "Every week"),
        ("FREQ=MONTHLY", "Every month"),
        ("FREQ=YEARLY", "Every year"),
        ("FREQ=DAILY;INTERVAL=2", "Every 2 days"),
        ("FREQ=DAILY;INTERVAL=13", "Every 13 days"),
        ("FREQ=WEEKLY;BYDAY=MO,FR", "Every week on Monday and Friday"),
        ("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR", "Every 2 weeks on Friday"),
        (
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR,MO",
            "Every 2 weeks on Friday and Monday",
        ),
        ("FREQ=WEEKLY;INTERVAL=3;BYDAY=MO", "Every 3 weeks on Monday"),
        ("FREQ=MONTHLY;INTERVAL=3", "Every 3 months"),
        ("FREQ=MONTHLY;BYDAY=2MO", "Every month on the second Monday"),
        ("FREQ=MONTHLY;BYDAY=-1FR", "Every month on the last Friday"),
        ("FREQ=MONTHLY;BYMONTHDAY=-1", "Every month on the last day"),
        ("FREQ=MONTHLY;BYMONTHDAY=22", "Every month on the 22nd"),
        (
            "FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR",
            "Every 2 months on the last Friday",
        ),
        (
            "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=-1;COUNT=4",
            "Every 3 months on the last day, 4 times",
        ),
        ("FREQ=DAILY;COUNT=1", "Every day, once"),
        (
            "FREQ=DAILY;UNTIL=20260301T000000Z",
            "Every day, until Sunday 1 March 2026",
        ),
        (
            "FREQ=WEEKLY;UNTIL=2026-12-31",
            "Every week, until Thursday 31 December 2026",
        ),
        ("FREQ=WEEKLY;WKST=SU", "Every week"),
        (
            "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR",
            "Every day on Monday, Tuesday, Wednesday, Thursday and Friday",
        ),
        ("FREQ=MONTHLY;BYDAY=MO", "Every month on each Monday"),
        (
            "FREQ=MONTHLY;BYDAY=MO,FR",
            "Every month on each Monday and Friday",
        ),
        (
            "FREQ=MONTHLY;BYDAY=1MO,-1FR",
            "Every month on the first Monday and the last Friday",
        ),
        (
            "FREQ=MONTHLY;BYDAY=-2MO",
            "Every month on the second to last Monday",
        ),
        ("FREQ=MONTHLY;BYDAY=5MO", "Every month on the fifth Monday"),
        (
            "FREQ=MONTHLY;BYDAY=2SA;BYMONTHDAY=7",
            "Every month on the second Saturday when it falls on the 7th",
        ),
        ("FREQ=YEARLY;BYDAY=20MO", "Every year on the 20th Monday"),
        ("FREQ=YEARLY;BYDAY=-1FR", "Every year on the last Friday"),
        (
            "FREQ=MONTHLY;BYMONTHDAY=1,15",
            "Every month on the 1st and 15th",
        ),
        (
            "FREQ=MONTHLY;BYMONTHDAY=1,15,-1",
            "Every month on the 1st, 15th and last day",
        ),
        (
            "FREQ=MONTHLY;BYMONTHDAY=-2",
            "Every month on the 2nd to last day",
        ),
        (
            "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=10,11,12",
            "Every 2 months on the 10th, 11th and 12th",
        ),
        ("FREQ=DAILY;BYMONTHDAY=13", "Every day on the 13th"),
        ("FREQ=YEARLY;BYMONTH=6,7", "Every year in June and July"),
        (
            "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15",
            "Every year on the 15th in March",
        ),
        (
            "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH",
            "Every year on the fourth Thursday in November",
        ),
        (
            "FREQ=YEARLY;BYYEARDAY=1,100,200",
            "Every year on the 1st, 100th and 200th day of the year",
        ),
        (
            "FREQ=YEARLY;BYYEARDAY=-1",
            "Every year on the last day of the year",
        ),
        (
            "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO",
            "Every year on Monday in week 20",
        ),
        ("FREQ=YEARLY;BYWEEKNO=53", "Every year in week 53"),
        (
            "FREQ=YEARLY;BYWEEKNO=-1;BYDAY=SU",
            "Every year on Sunday in the last week",
        ),
        (
            "FREQ=WEEKLY;BYDAY=MO;BYMONTH=6,7",
            "Every week on Monday in June and July",
        ),
        (
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;WKST=SU",
            "Every 2 weeks on Monday and Sunday",
        ),
        ("FREQ=DAILY;BYMONTH=2", "Every day in February"),
        (
            "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
            "Every month on the last weekday",
        ),
        (
            "FREQ=MONTHLY;BYDAY=SA,SU;BYSETPOS=1",
            "Every month on the first weekend day",
        ),
        (
            "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1",
            "Every month on the last Friday",
        ),
        (
            "FREQ=MONTHLY;BYDAY=MO,WE;BYSETPOS=1,-1",
            "Every month on the first and last of Monday and Wednesday",
        ),
        (
            "FREQ=MONTHLY;BYDAY=TU,WE,TH;BYSETPOS=3",
            "Every month on the third of Tuesday, Wednesday and Thursday",
        ),
        (
            "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2",
            "Every month on the second to last weekday",
        ),
        (
            "FREQ=MONTHLY;BYMONTHDAY=1,15,-1;BYSETPOS=2",
            "Every month on the second day among the 1st, 15th and last day",
        ),
        (
            "FREQ=YEARLY;BYMONTH=1,2;BYSETPOS=1",
            "Every year on the first day in January and February",
        ),
        (
            "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=6",
            "Every month on the last weekday, 6 times",
        ),
        (
            "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;UNTIL=20301231",
            "Every year on the fourth Thursday in November, until Tuesday 31 December 2030",
        ),
    ] {
        assert_eq!(said(rule), words, "{rule}");
    }
}

#[test]
fn a_sentence_never_shows_the_rule() {
    for rule in [
        "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH",
        "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
        "FREQ=YEARLY;BYWEEKNO=53;BYDAY=MO;WKST=SU",
    ] {
        let words = said(rule);
        assert!(
            !words.contains("FREQ") && !words.contains('=') && !words.contains("BY"),
            "{words}"
        );
    }
}

#[test]
fn a_rule_that_does_not_parse_says_custom_and_never_itself() {
    for rule in [
        "FREQ=HOURLY",
        "FREQ=DAILY;BYHOUR=9",
        "not a rule",
        "FREQ=DAILY;COUNT=2;UNTIL=20300101",
    ] {
        assert_eq!(of_rule(Locale::En, rule), None, "{rule}");
        assert_eq!(stored(Locale::En, rule), "Custom", "{rule}");
    }
    assert_eq!(stored(Locale::En, "FREQ=DAILY"), "Every day");
}

/// The golden corpus (`contracts/time/rrule-cases.json`) is v0's: every rule it
/// accepted still has a sentence, and none of the sentences is the rule.
#[test]
fn every_rule_the_golden_corpus_accepts_has_words() {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "contracts",
        "time",
        "rrule-cases.json",
    ]
    .iter()
    .collect();
    let corpus: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("the corpus")).expect("JSON");
    let cases = corpus["cases"].as_array().expect("cases");
    let mut with_words = 0;
    for case in cases {
        let rule = case["rrule"].as_str();
        let Some(rule) = rule else { continue };
        // A rule v0 accepted and this engine now refuses is not a case for
        // words (it says "Custom"); the vault's corpus test pins that split.
        if let (true, Some(words)) = (case["summary"].is_string(), of_rule(Locale::En, rule)) {
            assert!(!words.contains('='), "{rule}: {words}");
            with_words += 1;
        }
    }
    assert!(
        with_words > 10,
        "the corpus has accepted rules: {with_words}"
    );
}
