//! The sentences Agenda's home builds out of a number or a name: counts, the
//! absence notice, the quick add's destination, the window labels. Fixed words
//! live in `strings::agenda` and `strings::task`; only a sentence with a hole
//! in it is here.

catalog! {
    plain away_notice_one = ("You were away {days} days; 1 task came due", "You were away {days} days; 1 task came due");
    plain away_notice_many = ("You were away {days} days; {n} tasks came due", "You were away {days} days; {n} tasks came due");
    counted event_count = ("{n} event", "{n} events");
    plain from_day = ("From {day}", "From {day}");
    plain lands_in = ("Add to {place}", "Add to {place}");
    counted project_count = ("{n} project", "{n} projects");
    counted window_count = ("{n} task · more not shown", "{n} tasks · more not shown");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::strings::{Locale, fill};

    #[test]
    fn counts_pick_their_plural_and_holes_are_filled_by_name() {
        assert_eq!(event_count(Locale::En, 1), "1 event");
        assert_eq!(event_count(Locale::En, 3), "3 events");
        assert_eq!(project_count(Locale::En, 0), "0 projects");
        assert_eq!(window_count(Locale::En, 100), "100 tasks · more not shown");
        assert_eq!(
            fill(
                &away_notice_many(Locale::En),
                &[("days", "16"), ("n", "34")]
            ),
            "You were away 16 days; 34 tasks came due"
        );
        assert_eq!(
            fill(&lands_in(Locale::En), &[("place", "Inbox")]),
            "Add to Inbox"
        );
    }
}
