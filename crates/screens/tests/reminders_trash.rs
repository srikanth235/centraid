//! Agenda's trash, and the kit's one trash screen it is a parameter of
//! (`kit::trash`): ports of the `TasksSpec` trash case and the `KitLawsSpec`
//! trash laws, generically — the kit laws are driven through specs of their own,
//! so every app's trash can lean on them.

mod reminders_support;

#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda;
use centraid_screens::catalog::act;
use centraid_screens::kit::civil;
use centraid_screens::kit::read::Reading;
use centraid_screens::kit::trash::{self, TrashItem, TrashSpec};
use centraid_screens::strings::Locale;
use centraid_screens::testing::Driver;
use centraid_screens::{Registry, Runtime};
use reminders_support::*;
use wire::trash_event::{self as te, Kind as T};

fn confirm_of(v: &wire::ViewState) -> Option<&wire::Confirm> {
    trash(v).confirm.as_ref()
}

fn ids(v: &wire::ViewState) -> Vec<String> {
    trash_data(v)
        .rows
        .iter()
        .map(|row| row.id.clone())
        .collect()
}

fn trashed(d: &Driver, title: &str) -> String {
    let id = task(d, title);
    arrange(
        d,
        act::reminders::DeleteTask {
            task_id: id.clone(),
        },
    );
    id
}

/// Purge everything in the trash, so a test's own rows are the only ones.
fn empty_agendas_trash(d: &mut Driver) {
    let i = d.push(agenda::TAB, routes::trash());
    for id in ids(d.view(i)) {
        arrange(d, act::reminders::PurgeTask { task_id: id });
    }
    d.pop(agenda::TAB, i);
}

// -----------------------------------------------------------------------------
// agenda.trash
// -----------------------------------------------------------------------------

#[test]
fn the_trash_lists_deleted_tasks_with_the_day_they_were_deleted() {
    let mut d = driver();
    empty_agendas_trash(&mut d);
    let first = trashed(&d, "Rent");
    let second = trashed(&d, "Pay the deposit");
    let i = d.push(agenda::TAB, routes::trash());
    let view = trash(d.view(i));
    assert_eq!(view.app_id, "reminders");
    assert_eq!(view.title, "Trash");
    assert_eq!(view.back_label, "Reminders");
    let data = trash_data(d.view(i));
    assert_eq!(data.rows.len(), 2);
    assert_eq!(data.count_label, "Trash · 2");
    let order: Vec<&str> = data.rows.iter().map(|r| r.id.as_str()).collect();
    assert!(order.contains(&first.as_str()) && order.contains(&second.as_str()));
    let today = today(&d);
    let row = data.rows.iter().find(|r| r.id == first).unwrap();
    assert_eq!(row.title, "Rent");
    assert!(
        row.meta.starts_with(&format!(
            "Deleted {} · Erased ",
            civil::day_month(Locale::En, &today)
        )),
        "{}",
        row.meta
    );
    assert_eq!(row.restore_label, "Restore");
    assert_eq!(row.purge_label, "Delete forever");
    assert_eq!(row.icon_key, "Todo");
    assert_eq!(data.empty_label, "Empty trash");
}

#[test]
fn restore_asks_nothing_and_brings_the_task_back() {
    let mut d = driver();
    empty_agendas_trash(&mut d);
    let id = trashed(&d, "Rent");
    let i = d.push(agenda::TAB, routes::trash());
    send_trash(&mut d, i, T::Restore(te::RestoreTapped { id: id.clone() }));
    assert!(confirm_of(d.view(i)).is_none());
    assert!(
        ids(d.view(i)).is_empty(),
        "the list is read again after the write"
    );
    let status = trash(d.view(i)).status.clone().expect("a status line");
    assert_eq!(status.sentence, "Rent restored");
    assert_eq!(status.action_label, "Undo");
    assert!(!status.refused);
    assert_eq!(task_of(&d, &id).title, "Rent");
    // Undo puts it back in the trash, and says so.
    send_trash(&mut d, i, T::StatusActed(te::StatusActed {}));
    assert_eq!(ids(d.view(i)), [id]);
    let status = trash(d.view(i)).status.clone().expect("a status line");
    assert_eq!(status.sentence, "Rent moved to trash");
    assert_eq!(status.action_label, "");
}

#[test]
fn delete_forever_asks_in_full_sentences_and_destroys_only_when_confirmed() {
    let mut d = driver();
    empty_agendas_trash(&mut d);
    let id = trashed(&d, "Rent");
    let i = d.push(agenda::TAB, routes::trash());
    send_trash(&mut d, i, T::Purge(te::PurgeTapped { id: id.clone() }));
    let confirm = confirm_of(d.view(i)).expect("a confirm");
    assert_eq!(confirm.title, "Delete this task forever?");
    assert_eq!(
        confirm.body,
        "It and the subtasks trashed with it leave this vault for good. This cannot be undone."
    );
    assert_eq!(confirm.confirm_label, "Delete forever");
    assert!(confirm.destructive);
    // Dismissed: nothing happens.
    send_trash(&mut d, i, T::Dismissed(te::Dismissed {}));
    assert!(confirm_of(d.view(i)).is_none());
    assert_eq!(ids(d.view(i)), std::slice::from_ref(&id));
    send_trash(&mut d, i, T::Purge(te::PurgeTapped { id: id.clone() }));
    send_trash(&mut d, i, T::Confirmed(te::Confirmed {}));
    assert!(confirm_of(d.view(i)).is_none());
    assert!(ids(d.view(i)).is_empty());
    let trash_gone = trash_data(d.view(i));
    // A trash of no rows names no scope: the count line is empty, never "Trash · 0".
    assert_eq!(trash_gone.count_label, "");
    assert_eq!(
        trash_gone.empty.as_ref().unwrap().headline,
        "Trash is empty."
    );
    assert_eq!(
        trash_gone.empty.as_ref().unwrap().body,
        "Deleted items wait here for 30 days, then they are erased."
    );
    // It is gone for good: a restore of it is refused by there being nothing to restore.
    send_trash(&mut d, i, T::Restore(te::RestoreTapped { id }));
    assert!(ids(d.view(i)).is_empty());
}

#[test]
fn empty_trash_asks_first_and_destroys_every_task_when_confirmed() {
    let mut d = driver();
    empty_agendas_trash(&mut d);
    trashed(&d, "Rent");
    trashed(&d, "Pay the deposit");
    let i = d.push(agenda::TAB, routes::trash());
    send_trash(&mut d, i, T::Empty(te::EmptyTapped {}));
    let confirm = confirm_of(d.view(i)).expect("a confirm");
    assert_eq!(confirm.title, "Empty trash?");
    assert_eq!(
        confirm.body,
        "Everything in trash leaves this vault for good. This cannot be undone."
    );
    assert_eq!(confirm.confirm_label, "Empty trash");
    assert!(confirm.destructive);
    send_trash(&mut d, i, T::Dismissed(te::Dismissed {}));
    assert_eq!(trash_data(d.view(i)).rows.len(), 2);
    send_trash(&mut d, i, T::Empty(te::EmptyTapped {}));
    send_trash(&mut d, i, T::Confirmed(te::Confirmed {}));
    assert!(ids(d.view(i)).is_empty());
    assert_eq!(trash_data(d.view(i)).empty_label, "");
}

#[test]
fn a_confirm_for_a_row_that_left_the_trash_destroys_nothing() {
    let mut d = driver();
    empty_agendas_trash(&mut d);
    let id = trashed(&d, "Rent");
    let i = d.push(agenda::TAB, routes::trash());
    send_trash(&mut d, i, T::Purge(te::PurgeTapped { id: id.clone() }));
    // Restored on another surface while the confirm is up.
    arrange(
        &d,
        act::reminders::RestoreTask {
            task_id: id.clone(),
        },
    );
    send_trash(&mut d, i, T::Confirmed(te::Confirmed {}));
    assert_eq!(task_of(&d, &id).title, "Rent", "a live task is not purged");
}

#[test]
fn a_row_the_list_does_not_show_is_not_restored_or_asked_about() {
    let mut d = driver();
    empty_agendas_trash(&mut d);
    let id = task(&d, "Alive");
    let i = d.push(agenda::TAB, routes::trash());
    send_trash(&mut d, i, T::Purge(te::PurgeTapped { id: id.clone() }));
    assert!(confirm_of(d.view(i)).is_none());
    send_trash(&mut d, i, T::Restore(te::RestoreTapped { id: id.clone() }));
    assert!(trash(d.view(i)).status.is_none());
}

#[test]
fn a_task_deleted_elsewhere_appears_without_a_refresh() {
    let mut d = driver();
    empty_agendas_trash(&mut d);
    let i = d.push(agenda::TAB, routes::trash());
    assert!(ids(d.view(i)).is_empty());
    let id = trashed(&d, "Late");
    d.pump(std::time::Duration::from_millis(400));
    assert_eq!(ids(d.view(i)), [id]);
}

// -----------------------------------------------------------------------------
// The kit's laws, over specs of their own
// -----------------------------------------------------------------------------

mod kit {
    use super::*;

    const ROOT: &str = "fake.trash";

    fn route() -> wire::Route {
        wire::Route {
            sheet: false,
            screen: ROOT.to_owned(),
            args: Some(wire::route::Args::Trash(wire::TrashRoute {})),
        }
    }

    fn runtime(build: fn(&wire::Route) -> Option<Box<dyn centraid_screens::Screen>>) -> Runtime {
        Runtime::new(
            Registry::default().with(ROOT, build),
            vec![("fake".to_owned(), route())],
        )
    }

    fn driver_of(
        build: fn(&wire::Route) -> Option<Box<dyn centraid_screens::Screen>>,
    ) -> (Driver, u64) {
        let mut d = Driver::with_runtime(runtime(build));
        d.start();
        let i = d.navigation.as_ref().unwrap().tabs[0].entries[0].instance;
        (d, i)
    }

    fn two_rows(_: &centraid_screens::Ctx) -> Reading<Vec<TrashItem>> {
        Reading::Data(vec![
            TrashItem {
                id: "t1".into(),
                title: "Buy milk".into(),
                deleted_day: "2026-03-12".into(),
                purge_day: "2026-04-11".into(),
            },
            TrashItem {
                id: "t2".into(),
                title: "  ".into(),
                deleted_day: String::new(),
                purge_day: String::new(),
            },
        ])
    }

    fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
        let _ = locale;
        wire::Denied {
            title: "No".into(),
            body: "Not you".into(),
            receipt: denial.code.clone().unwrap_or_default(),
        }
    }

    fn restore(_: &str) -> wire::ActRequest {
        // Refused by the core: nothing has this id.
        act::reminders::RestoreTask {
            task_id: "no-such-task".into(),
        }
        .into()
    }

    fn purge(_: &str) -> wire::ActRequest {
        act::reminders::CreateProject {
            title: "Purged marker".into(),
            ..Default::default()
        }
        .into()
    }

    fn empty() -> wire::ActRequest {
        act::reminders::CreateProject {
            title: "Emptied marker".into(),
            ..Default::default()
        }
        .into()
    }

    fn app_name(_: Locale) -> String {
        "Notes".to_owned()
    }

    fn app_lead(_: Locale) -> String {
        "Its pages go too.".to_owned()
    }

    fn noun(_: Locale) -> String {
        "page".to_owned()
    }

    fn trash_marker(_: &str) -> wire::ActRequest {
        act::reminders::CreateProject {
            title: "Trashed marker".into(),
            ..Default::default()
        }
        .into()
    }

    static FULL: TrashSpec = TrashSpec {
        app: "fake",
        icon_key: "Note",
        noun,
        purge_lead: None,
        back_label: app_name,
        denied,
        load: two_rows,
        trash: trash_marker,
        restore,
        purge,
        empty,
    };

    static OWN_LEAD: TrashSpec = TrashSpec {
        purge_lead: Some(app_lead),
        ..clone_of_full()
    };

    static NOTHING: TrashSpec = TrashSpec {
        load: none,
        ..clone_of_full()
    };

    fn none(_: &centraid_screens::Ctx) -> Reading<Vec<TrashItem>> {
        Reading::Data(Vec::new())
    }

    const fn clone_of_full() -> TrashSpec {
        TrashSpec {
            app: "fake",
            icon_key: "Note",
            noun,
            purge_lead: None,
            back_label: app_name,
            denied,
            load: two_rows,
            trash: trash_marker,
            restore,
            purge,
            empty,
        }
    }

    fn full(_: &wire::Route) -> Option<Box<dyn centraid_screens::Screen>> {
        trash::build(&FULL)
    }

    fn own_lead(_: &wire::Route) -> Option<Box<dyn centraid_screens::Screen>> {
        trash::build(&OWN_LEAD)
    }

    fn nothing(_: &wire::Route) -> Option<Box<dyn centraid_screens::Screen>> {
        trash::build(&NOTHING)
    }

    fn markers(d: &Driver) -> Vec<String> {
        match answer(
            d,
            centraid_screens::catalog::load::reminders::Projects::default(),
        ) {
            wire::app_query_response::Answer::AgendaTaskProjects(p) => {
                p.projects.into_iter().map(|p| p.name).collect()
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn restore_writes_at_once_while_purge_and_empty_ask_first_destructively() {
        let (mut d, i) = driver_of(full);
        let data = trash_data(d.view(i));
        assert_eq!(data.rows[0].purge_label, "Delete forever");
        assert_eq!(data.empty_label, "Empty trash");
        assert!(confirm_of(d.view(i)).is_none());

        // Purge asks, destructively, and dismissing writes nothing.
        send_trash(&mut d, i, T::Purge(te::PurgeTapped { id: "t1".into() }));
        let confirm = confirm_of(d.view(i)).unwrap();
        assert!(confirm.destructive);
        assert_eq!(confirm.title, "Delete this page forever?");
        send_trash(&mut d, i, T::Dismissed(te::Dismissed {}));
        assert!(confirm_of(d.view(i)).is_none());
        assert!(!markers(&d).contains(&"Purged marker".to_owned()));
        send_trash(&mut d, i, T::Purge(te::PurgeTapped { id: "t1".into() }));
        send_trash(&mut d, i, T::Confirmed(te::Confirmed {}));
        assert!(
            markers(&d).contains(&"Purged marker".to_owned()),
            "the spec's purge action ran"
        );
        assert!(confirm_of(d.view(i)).is_none());

        // Empty asks too, in the kit's words, and its confirm runs the spec's empty action.
        send_trash(&mut d, i, T::Empty(te::EmptyTapped {}));
        let confirm = confirm_of(d.view(i)).unwrap();
        assert_eq!(confirm.title, "Empty trash?");
        assert_eq!(
            confirm.body,
            "Everything in trash leaves this vault for good. This cannot be undone."
        );
        assert_eq!(confirm.confirm_label, "Empty trash");
        assert!(confirm.destructive);
        send_trash(&mut d, i, T::Confirmed(te::Confirmed {}));
        assert!(markers(&d).contains(&"Emptied marker".to_owned()));
        // A second Confirmed with nothing asked is nothing.
        send_trash(&mut d, i, T::Confirmed(te::Confirmed {}));
        assert_eq!(
            markers(&d)
                .iter()
                .filter(|m| *m == "Emptied marker")
                .count(),
            1
        );
    }

    #[test]
    fn a_refused_restore_keeps_the_list_and_says_the_cores_sentence() {
        let (mut d, i) = driver_of(full);
        send_trash(&mut d, i, T::Restore(te::RestoreTapped { id: "t1".into() }));
        assert_eq!(trash_data(d.view(i)).rows.len(), 2);
        let status = trash(d.view(i)).status.clone().expect("a status line");
        assert!(status.refused && !status.sentence.is_empty());
        // The next attempt clears the old sentence.
        send_trash(&mut d, i, T::Purge(te::PurgeTapped { id: "t2".into() }));
        send_trash(&mut d, i, T::Confirmed(te::Confirmed {}));
        assert!(trash(d.view(i)).status.is_none());
    }

    #[test]
    fn an_app_may_replace_the_first_sentence_of_the_purge_confirm_and_nothing_else() {
        let (mut d, i) = driver_of(own_lead);
        send_trash(&mut d, i, T::Purge(te::PurgeTapped { id: "t1".into() }));
        let confirm = confirm_of(d.view(i)).unwrap();
        assert_eq!(confirm.body, "Its pages go too. This cannot be undone.");
        assert_eq!(confirm.title, "Delete this page forever?");
        send_trash(&mut d, i, T::Dismissed(te::Dismissed {}));
        send_trash(&mut d, i, T::Empty(te::EmptyTapped {}));
        assert_eq!(
            confirm_of(d.view(i)).unwrap().body,
            "Everything in trash leaves this vault for good. This cannot be undone."
        );
        let (d2, j) = driver_of(nothing);
        let data = trash_data(d2.view(j));
        assert_eq!(data.empty.as_ref().unwrap().headline, "Trash is empty.");
        assert_eq!(
            data.empty.as_ref().unwrap().body,
            "Deleted items wait here for 30 days, then they are erased."
        );
        assert_eq!(data.empty_label, "", "nothing to empty");
    }

    #[test]
    fn the_deletion_day_and_the_erase_day_are_the_cores_civil_days_never_a_utc_slice() {
        let (d, i) = driver_of(full);
        let data = trash_data(d.view(i));
        assert_eq!(
            data.rows[0].meta,
            "Deleted Thu 12 March · Erased Sat 11 April"
        );
        // A row with no day from the core says none; an untitled one the kit's word.
        assert_eq!(data.rows[1].meta, "");
        assert_eq!(data.rows[1].title, "Untitled");
        // A row the core gave no erase day says nothing about one.
        assert_eq!(data.rows[1].meta, "");
    }

    fn refused(_: &centraid_screens::Ctx) -> Reading<Vec<TrashItem>> {
        Reading::Failed
    }

    fn gated(_: &centraid_screens::Ctx) -> Reading<Vec<TrashItem>> {
        Reading::Denied(wire::AppQueryDenial {
            code: Some("no_grant".into()),
            ..Default::default()
        })
    }

    #[test]
    fn a_failed_read_is_a_failure_and_a_denied_one_is_the_apps_gate_never_an_empty_list() {
        static FAILS: TrashSpec = TrashSpec {
            load: refused,
            ..clone_of_full()
        };
        static GATED: TrashSpec = TrashSpec {
            load: gated,
            ..clone_of_full()
        };
        fn fails(_: &wire::Route) -> Option<Box<dyn centraid_screens::Screen>> {
            trash::build(&FAILS)
        }
        fn gate(_: &wire::Route) -> Option<Box<dyn centraid_screens::Screen>> {
            trash::build(&GATED)
        }
        let (d, i) = driver_of(fails);
        match &trash(d.view(i)).content {
            Some(wire::trash_view::Content::Failure(failure)) => {
                assert_eq!(failure.remedy, "Try again");
                assert!(!failure.sentence.is_empty());
            }
            other => panic!("expected a failure, got {other:?}"),
        }
        let (d, i) = driver_of(gate);
        match &trash(d.view(i)).content {
            Some(wire::trash_view::Content::Denied(denied)) => {
                assert_eq!(
                    (denied.title.as_str(), denied.receipt.as_str()),
                    ("No", "no_grant")
                );
            }
            other => panic!("expected the gate, got {other:?}"),
        }
    }

    #[test]
    fn the_screen_shows_what_it_was_asked_for() {
        let (d, i) = driver_of(full);
        let view = trash(d.view(i));
        assert_eq!(
            (
                view.app_id.as_str(),
                view.back_label.as_str(),
                view.title.as_str()
            ),
            ("fake", "Notes", "Trash")
        );
        assert_eq!(trash_data(d.view(i)).rows[0].icon_key, "Note");
    }
}
