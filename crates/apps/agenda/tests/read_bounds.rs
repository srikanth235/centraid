//! Answers without a continuation must report a reached read bound.
use centraid_apps_agenda::queries::{
    EVENT_WINDOW_CAP, PARTY_CAP, RECURRING_ANCHOR_CAP, load_day_context, load_parties,
    load_upcoming,
};
use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::page::{Page, PageCursor, PageRequest};
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::Row;
use centraid_apps_kit::statement::PageQuery;
use centraid_vault::time::zone::FireZone;

struct LongerThanTheBound(&'static str);
impl PageDoor for LongerThanTheBound {
    fn page(&self, query: &PageQuery, request: &PageRequest) -> KitResult<Page<Row>> {
        if query.name != self.0 {
            return Ok(Page {
                rows: Vec::new(),
                next: None,
            });
        }
        Ok(Page {
            rows: vec![Row::new(); request.limit],
            next: Some(PageCursor {
                sort_key: "next".into(),
                pk: "next".into(),
            }),
        })
    }
}

#[test]
fn agenda_answers_report_each_reached_bound() {
    let zone = FireZone::named("Etc/UTC").expect("UTC");
    let now = "2026-01-01T00:00:00.000Z";
    for (query, cap) in [
        ("agenda.upcoming.window", EVENT_WINDOW_CAP),
        ("agenda.upcoming.recurringAnchors", RECURRING_ANCHOR_CAP),
        ("agenda.dayContext.birthdays", PARTY_CAP),
        ("agenda.parties.people", PARTY_CAP),
    ] {
        let door = LongerThanTheBound(query);
        let error = match query {
            "agenda.dayContext.birthdays" => {
                load_day_context(&door, None, None, now, &zone).map(|_| ())
            }
            "agenda.parties.people" => load_parties(&door).map(|_| ()),
            _ => load_upcoming(&door, None, None, now, &zone).map(|_| ()),
        }
        .expect_err("a partial answer is not a complete agenda");
        assert!(
            matches!(error, KitError::FanOutExceeded { query: found, cap: found_cap }
            if found == query && found_cap == cap)
        );
    }
}
