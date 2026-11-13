use super::*;

fn task(id: &str) -> wire::AgendaTask {
    wire::AgendaTask {
        task_id: id.to_owned(),
        title: "Call home".to_owned(),
        status: "open".to_owned(),
        due_at: Some("2026-11-10T09:00:00Z".to_owned()),
        remind_before_min: Some(0),
        remind_at_local: "2026-11-10T09:00".to_owned(),
        ..Default::default()
    }
}

#[test]
fn task_digest_ignores_display_clock_period_and_unrelated_edits_but_tracks_alert_changes() {
    let original = task("t");
    let mut decorated = original.clone();
    decorated.updated_at = Some("later".to_owned());
    decorated.description = Some("new private draft".to_owned());
    decorated.next_due = Some("2035-12-31T09:00:00Z".to_owned());
    decorated.remind_at_local = "2035-12-31T18:00".to_owned();
    decorated.due_time = "18:00".to_owned();
    decorated
        .attachments
        .push(wire::AgendaTaskAttachment::default());
    assert_eq!(task_fingerprint(&original), task_fingerprint(&decorated));
    for field in ["title", "due", "lead", "status", "recurrence"] {
        let mut changed = original.clone();
        match field {
            "title" => changed.title = "Changed".to_owned(),
            "due" => changed.due_at = Some("2026-11-11T09:00:00Z".to_owned()),
            "lead" => changed.remind_before_min = None,
            "status" => changed.status = "done".to_owned(),
            "recurrence" => changed.rrule = Some("FREQ=DAILY".to_owned()),
            _ => unreachable!(),
        }
        assert_ne!(
            task_fingerprint(&original),
            task_fingerprint(&changed),
            "{field}"
        );
    }
}

#[test]
fn event_digest_uses_series_configuration_not_display_or_unrelated_fields() {
    let original = wire::AgendaEvent {
        event_id: "e".to_owned(),
        instance_key: "e:2026-11-10T09:00".to_owned(),
        summary: Some("Lunch".to_owned()),
        dtstart: "2026-11-10T09:00".to_owned(),
        start_tz: Some("America/New_York".to_owned()),
        reminders: vec![wire::AgendaReminder { minutes_before: 10 }],
        ..Default::default()
    };
    let mut decorated = original.clone();
    decorated.local_start = "2026-11-10T23:00".to_owned();
    decorated.local_days = vec!["2026-11-11".to_owned()];
    decorated.updated_at = Some("later".to_owned());
    decorated.description = Some("new draft".to_owned());
    decorated
        .attachments
        .push(wire::AgendaAttachment::default());
    assert_eq!(
        event_fingerprint(&original, 10),
        event_fingerprint(&decorated, 10)
    );
    decorated.dtstart = "2026-11-10T10:00".to_owned();
    assert_ne!(
        event_fingerprint(&original, 10),
        event_fingerprint(&decorated, 10)
    );
    assert_ne!(
        event_fingerprint(&original, 10),
        event_fingerprint(&original, 5)
    );
    assert!(!event_eligible(&original, 5));
}

#[test]
fn actual_inventory_preserves_valid_legacy_and_failed_reads_and_cancels_only_definite_changes() {
    let driver = crate::testing::Driver::with_runtime(crate::agenda::runtime());
    let valid = task("valid");
    let before = task("changed");
    let mut changed = before.clone();
    changed.title = "A changed alert".to_owned();
    let mut sources = Sources::of(&[valid.clone(), changed], &[]);
    sources.tasks.insert("failed".to_owned(), Source::Failed);
    sources
        .tasks
        .insert("missing".to_owned(), Source::Data(None));
    let delivered = BTreeMap::from([
        (
            "task||valid|2026-11-10T09:00".to_owned(),
            task_fingerprint(&valid),
        ),
        ("task||valid|2026-11-09T09:00".to_owned(), String::new()),
        (
            "task||changed|2026-11-10T09:00".to_owned(),
            task_fingerprint(&before),
        ),
        (
            "task||failed|2026-11-10T09:00".to_owned(),
            "previous".to_owned(),
        ),
        (
            "task||missing|2026-11-10T09:00".to_owned(),
            "previous".to_owned(),
        ),
        (
            "task|other|valid|2026-11-10T09:00".to_owned(),
            task_fingerprint(&valid),
        ),
        ("receipt||expired".to_owned(), String::new()),
        ("malformed".to_owned(), String::new()),
    ]);
    let cancel = driver.with_ctx(|ctx| sources.cancellations(ctx, "", &delivered, None, 0));
    assert_eq!(
        cancel,
        BTreeSet::from([
            "task||changed|2026-11-10T09:00".to_owned(),
            "task||missing|2026-11-10T09:00".to_owned(),
            "task|other|valid|2026-11-10T09:00".to_owned(),
            "receipt||expired".to_owned(),
            "malformed".to_owned(),
        ])
    );
}

struct ReadDoor<'a> {
    inner: &'a dyn centraid_core::screens::ScreenCtx,
    calls: std::cell::RefCell<Vec<(String, String)>>,
    fail: bool,
}

impl centraid_core::screens::ScreenCtx for ReadDoor<'_> {
    fn load(&self, request: &wire::LoadRequest) -> centraid_core::Result<wire::LoadResponse> {
        self.calls
            .borrow_mut()
            .push((request.app.clone(), request.query.clone()));
        if self.fail {
            return Err(centraid_core::CoreError::Unavailable {
                reason: "fixture unavailable".to_owned(),
            });
        }
        self.inner.load(request)
    }
    fn act(&self, request: &wire::ActRequest) -> centraid_core::Result<wire::ActResponse> {
        self.inner.act(request)
    }
    fn push(&self, _: wire::ScreenUpdate) {}
    fn wake_after(&self, _: std::time::Duration) {}
}

fn write(driver: &crate::testing::Driver, request: impl Into<wire::ActRequest>) -> String {
    use crate::field::Keyed;
    let response = driver.act(request.into().keyed(crate::kit::act::fresh().to_string()));
    assert_eq!(
        response.status,
        wire::ActStatus::Executed as i32,
        "{}",
        response.reason
    );
    serde_json::from_slice::<serde_json::Value>(&response.output).expect("output")["id"]
        .as_str()
        .expect("id")
        .to_owned()
}

#[test]
fn actual_past_inventory_reads_only_each_distinct_source_once_and_failure_preserves_it() {
    use crate::{catalog::act, field::Field, screen::Environment};
    let driver = crate::testing::Driver::with_runtime(crate::agenda::runtime());
    let id = write(
        &driver,
        act::reminders::AddTask {
            title: "Old alert".to_owned(),
            due: Field::Is("2000-01-01T09:00".to_owned()),
            remind_before_min: Field::Is(0),
            ..Default::default()
        },
    );
    let original = driver.with_ctx(|ctx| match Sources::default().task(ctx, &id) {
        Source::Data(Some(row)) => row,
        _ => panic!("exact task"),
    });
    let delivered = BTreeMap::from([
        (
            format!("task||{id}|2000-01-01T09:00"),
            task_fingerprint(&original),
        ),
        (
            format!("task||{id}|2000-01-02T09:00"),
            task_fingerprint(&original),
        ),
    ]);
    let future = (0..500)
        .map(|n| task(&format!("future-{n}")))
        .collect::<Vec<_>>();
    let expected: wire::LoadRequest = load::reminders::Task { task_id: id }.into();
    for fail in [false, true] {
        let door = ReadDoor {
            inner: &*driver.handle,
            calls: Default::default(),
            fail,
        };
        let env = Environment::default();
        let ctx = Ctx::new(&door, &env);
        assert!(
            Sources::of(&future, &[])
                .cancellations(&ctx, "", &delivered, None, 0)
                .is_empty()
        );
        assert_eq!(
            *door.calls.borrow(),
            vec![(expected.app.clone(), expected.query.clone())]
        );
    }
}

#[test]
fn a_past_calendar_occurrence_uses_one_exact_read_for_retention_and_open_route() {
    use crate::{catalog::act, field::Field, screen::Environment};
    let driver = crate::testing::Driver::with_runtime(crate::agenda::runtime());
    let id = write(
        &driver,
        act::calendar::Propose {
            title: "Old event".to_owned(),
            starts: "2000-01-01T09:00".to_owned(),
            ends: Field::Is("2000-01-01T10:00".to_owned()),
            zone: Field::Is("UTC".to_owned()),
            reminders: Field::Is("[10]".to_owned()),
            ..Default::default()
        },
    );
    let event = driver.with_ctx(|ctx| match Sources::default().event(ctx, &id) {
        Source::Data(Some(row)) => row,
        _ => panic!("exact event"),
    });
    let answered = wire::NotificationAnswered {
        notification_id: format!("event||{id}|10"),
        verb: wire::NotificationVerb::Open as i32,
    };
    let delivered = BTreeMap::from([(
        answered.notification_id.clone(),
        event_fingerprint(&event, 10),
    )]);
    let door = ReadDoor {
        inner: &*driver.handle,
        calls: Default::default(),
        fail: false,
    };
    let env = Environment::default();
    let ctx = Ctx::new(&door, &env);
    let mut sources = Sources::default();
    assert!(
        sources
            .cancellations(&ctx, "", &delivered, None, 0)
            .is_empty()
    );
    let mut facts = Facts::of("2026-11-13", "2026-11-13T09:00", &[], &[]);
    sources
        .augment_facts(&ctx, "", &mut facts, &answered)
        .expect("exact source");
    let answer::Handled::Open(route) = answer::handle(&ctx, "", &facts, None, &answered) else {
        panic!("past occurrence opens")
    };
    let Some(wire::route::Args::AgendaEvent(args)) = route.args else {
        panic!("event route")
    };
    assert_eq!(args.event_id, id);
    assert_eq!(args.instance_key, event.instance_key);
    assert_eq!(args.day, "2000-01-01");
    assert_eq!(
        door.calls.borrow().len(),
        1,
        "retention and Open share the exact source read"
    );
}
