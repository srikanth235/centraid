use super::*;

#[test]
fn an_id_names_its_vault_and_what_it_is_about() {
    assert_eq!(
        parse("task|v1|t-1|2026-11-10T09:00"),
        Some(Target::Task {
            vault: "v1".into(),
            task_id: "t-1".into()
        })
    );
    assert_eq!(
        parse("event|v1|ev@2026-11-10T09:00|10"),
        Some(Target::Event {
            vault: "v1".into(),
            instance_key: "ev@2026-11-10T09:00".into()
        })
    );
    assert_eq!(
        parse("receipt|v1|77|t-1|"),
        Some(Target::Receipt {
            vault: "v1".into(),
            task_id: "t-1".into(),
            undo: None
        })
    );
    assert_eq!(parse("junk"), None);
    assert_eq!(parse("what|v1|x|y"), None);
    assert_eq!(parse("task|v1"), None);
}

#[test]
fn a_snooze_is_an_elapsed_hour_as_a_utc_instant() {
    assert_eq!(
        snooze_until("2026-11-10T08:15", "America/New_York").as_deref(),
        Some("2026-11-10T14:15:00.000Z")
    );
    assert_eq!(
        snooze_until("2026-11-10T23:30", "Asia/Tokyo").as_deref(),
        Some("2026-11-10T15:30:00.000Z")
    );
    assert_eq!(snooze_until("2026-11-10T08:15", "Not/AZone"), None);
    // 01:30 EST on the spring-forward night: an hour on is 03:30 EDT, which is 07:30Z.
    assert_eq!(
        snooze_until("2026-03-08T01:30", "America/New_York").as_deref(),
        Some("2026-03-08T07:30:00.000Z")
    );
}

#[test]
fn tomorrow_keeps_the_time_of_day() {
    assert_eq!(
        tomorrow_due("2026-11-10", "09:00").as_deref(),
        Some("2026-11-11T09:00")
    );
    assert_eq!(
        tomorrow_due("2026-12-31", "23:45").as_deref(),
        Some("2027-01-01T23:45")
    );
    assert_eq!(
        tomorrow_due("2026-11-10", "").as_deref(),
        Some("2026-11-11")
    );
    assert_eq!(tomorrow_due("nope", "09:00"), None);
}

#[test]
fn tomorrow_on_a_dst_day_is_written_as_the_wall_clock_the_core_places() {
    // The 8th of March has no 02:30 in New York; the due is kept as the member
    // wrote it and the core resolves it (a gap is read at the offset before it).
    assert_eq!(
        tomorrow_due("2026-03-07", "02:30").as_deref(),
        Some("2026-03-08T02:30")
    );
    let zone = FireZone::named("America/New_York").unwrap();
    assert!(parse_civil_ms("2026-03-08T02:30", &zone).is_some());
}

#[test]
fn a_receipts_undo_travels_in_its_id_so_it_outlives_the_process() {
    use base64::Engine as _;
    use prost::Message as _;
    let undo = wire::ActRequest {
        app: "history".into(),
        action: "undo-change".into(),
        ..Default::default()
    };
    let carried = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(undo.encode_to_vec());
    let Some(Target::Receipt {
        task_id,
        undo: bytes,
        ..
    }) = parse(&format!("receipt|v1|9|t-7|{carried}"))
    else {
        panic!("a receipt");
    };
    assert_eq!(task_id, "t-7");
    assert_eq!(
        wire::ActRequest::decode(bytes.expect("the undo").as_slice()).expect("decodes"),
        undo
    );
}

#[test]
fn a_press_with_an_id_is_run_under_a_key_made_from_it_so_a_second_send_is_a_replay() {
    assert_eq!(
        key("complete-task", "t-1", "p-9"),
        key("complete-task", "t-1", "p-9")
    );
    assert_ne!(
        key("complete-task", "t-1", ""),
        key("complete-task", "t-1", "")
    );
}
