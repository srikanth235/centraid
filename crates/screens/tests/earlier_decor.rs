//! What decorates a record in its earlier versions (#1185): a tag, a star and a hand-made link are
//! versions of the record like a changed field, each worded in the kit's one place whatever the app,
//! and Restore puts them back. Over a real vault, through the door a shell uses, on a task (the
//! kit's screen is the same for every app).

mod reminders_support;

#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::testing::Driver;
use centraid_screens::{agenda, reminders};
use reminders_support::*;

/// 2026-03-02 12:00 UTC.
const SEEDED_AT_MS: i64 = 1_772_452_800_000;

fn seeded() -> Driver {
    let mut d = Driver::with_runtime_at(agenda::runtime(), SEEDED_AT_MS);
    d.start();
    d
}

fn rows(v: &wire::ViewState) -> Vec<wire::EarlierRow> {
    match &v.kind {
        Some(wire::view_state::Kind::Earlier(view)) => match &view.content {
            Some(wire::earlier_view::Content::Data(data)) => data.rows.clone(),
            other => panic!("no data: {other:?}"),
        },
        other => panic!("not the earlier-versions screen: {other:?}"),
    }
}

fn open_earlier(d: &mut Driver, id: &str) -> u64 {
    let page = d.push(agenda::TAB, routes::task(id));
    let entry = detail(d.view(page)).earlier.clone().expect("the entry");
    assert_eq!(
        entry.route.as_ref().map(|r| r.screen.as_str()),
        Some(reminders::EARLIER)
    );
    d.push(agenda::TAB, entry.route.expect("a route"))
}

fn restore(d: &mut Driver, i: u64, seq: i64) {
    d.send(
        i,
        wire::screen_event::Kind::Earlier(wire::EarlierEvent {
            kind: Some(wire::earlier_event::Kind::Restore(
                wire::earlier_event::RestoreTapped { seq },
            )),
        }),
    );
}

#[test]
fn a_tag_a_star_and_a_link_are_versions_worded_by_the_kit_and_restore_puts_them_back() {
    let mut d = seeded();
    let id = task(&d, "Pay rent");
    let trip = task(&d, "Book flights");
    arrange(
        &d,
        act::reminders::AddTaskTag {
            task_id: id.clone(),
            label: "Errand".to_owned(),
        },
    );
    arrange(
        &d,
        act::reminders::StarTask {
            task_id: id.clone(),
        },
    );
    arrange(
        &d,
        act::reminders::Link {
            from: id.clone(),
            to: trip.clone(),
        },
    );
    arrange(
        &d,
        act::reminders::Unlink {
            from: id.clone(),
            to: trip.clone(),
        },
    );
    arrange(
        &d,
        act::reminders::UnstarTask {
            task_id: id.clone(),
        },
    );
    arrange(
        &d,
        act::reminders::RemoveTaskTag {
            task_id: id.clone(),
            label: "Errand".to_owned(),
        },
    );

    let i = open_earlier(&mut d, &id);
    let listed = rows(d.view(i));
    let lines: Vec<&str> = listed.iter().map(|row| row.value.as_str()).collect();
    // Current (nothing decorating), then each version newest first: before the tag came off it was
    // tagged; before the star came off it was starred; before the unlink it was linked; and so on
    // back to the task as it was made.
    assert_eq!(
        lines,
        [
            "Without #Errand",
            "#Errand",
            "Starred",
            "Linked to Book flights",
            "Not linked to Book flights",
            "Not starred",
            "Without #Errand",
        ],
        "{lines:?}"
    );
    assert_eq!(listed.len(), 7);

    // Restore the version that was tagged, starred and linked: all three come back.
    restore(&mut d, i, listed[3].seq);
    let task = task_of(&d, &id);
    assert!(task.flagged, "the star is back");
    assert_eq!(task.tags.len(), 1, "the tag is back");
    let linked: Vec<String> = match answer(
        &d,
        load::shell::Links {
            entity_id: id.clone(),
        },
    ) {
        wire::app_query_response::Answer::LinkedItems(found) => {
            found.items.into_iter().map(|item| item.title).collect()
        }
        other => panic!("links answered {other:?}"),
    };
    assert_eq!(linked, ["Book flights"], "the link is back");
}
