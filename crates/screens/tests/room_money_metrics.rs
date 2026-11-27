use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_screens::room::snapshot;
use centraid_vault::clock::{FixedClock, SeededIds};
use serde_json::{Value, json};

const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";
const NOW: i64 = 1_795_687_200_000;
const ACCOUNT: &str = "01900000-0000-7000-8000-000000000101";
const HAND: &str = "01900000-0000-7000-8000-000000000201";

fn phone(dir: &std::path::Path) -> Handle {
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .unwrap()
        .seed();
    let handle = Core::open(
        CoreConfig::new(dir.join("vault.db"))
            .with_seed(seed, 0)
            .with_clock(
                Arc::new(FixedClock::at(NOW)),
                Arc::new(SeededIds::new("money-metrics")),
            ),
    )
    .unwrap();
    handle
        .with_vault(|vault| Ok(vault.found("Household", "Ada")?))
        .unwrap();
    centraid_screens::attach(&handle);
    handle
}

fn command(handle: &Handle, name: &str, input: Value, key: &str) -> Value {
    let result = handle.command(name, &input, key).unwrap();
    assert_eq!(
        result.status,
        centraid_vault::CommandStatus::Executed,
        "{name}: {:?}",
        result.reason
    );
    result.output
}

fn room_call(handle: &Handle, kind: wire::room_request::Kind) -> Vec<wire::RoomShown> {
    match handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(kind),
            })),
        })
        .unwrap()
        .kind
    {
        Some(wire::response::Kind::Room(response)) => response.shown,
        other => panic!("expected room response, got {other:?}"),
    }
}

fn open(handle: &Handle, key: &str) -> wire::RoomShown {
    room_call(
        handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: key.to_owned(),
            tab: "home".to_owned(),
            root: true,
            ..Default::default()
        }),
    )
    .remove(0)
}

fn tap(handle: &Handle, shown: &wire::RoomShown, selector: &str) -> wire::RoomShown {
    room_call(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance: shown.instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::Tap(wire::RoomTap {
                    selector_id: selector.to_owned(),
                })),
            }),
        }),
    )
    .into_iter()
    .last()
    .unwrap_or_else(|| panic!("tap `{selector}` returned no shown room"))
}

fn tap_and_ignore_result(handle: &Handle, shown: &wire::RoomShown, selector: &str) {
    let _ = room_call(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance: shown.instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::Tap(wire::RoomTap {
                    selector_id: selector.to_owned(),
                })),
            }),
        }),
    );
}

fn seed_account(handle: &Handle) {
    command(
        handle,
        "account.add",
        json!({
            "id": ACCOUNT, "title": "Checking", "type": "checking", "currency": "USD",
            "opening_minor": 0, "opening_on": "2026-01-01"
        }),
        "account",
    );
}

fn statements(count: usize, amount: i64) -> Value {
    let dates = ["2026-08-30", "2026-09-30", "2026-10-30", "2026-11-26"];
    json!({
        "origin": { "ref": ACCOUNT, "label": "Checking feed", "fills": ACCOUNT },
        "complete": true,
        "records": (0..count).map(|i| {
            let (title, day) = if i < dates.len() {
                ("Monthly utility".to_owned(), dates[i].to_owned())
            } else {
                (format!("Other line {i}"), "2026-11-26".to_owned())
            };
            json!({ "external_id": format!("bank:{i}"), "fields": {
                "title": title, "posted_on": day, "amount_minor": amount
            } })
        }).collect::<Vec<_>>()
    })
}

fn rows(room: &wire::Room) -> Vec<(String, String)> {
    let Some(wire::room::State::Ready(ready)) = room.state.as_ref() else {
        return Vec::new();
    };
    ready
        .blocks
        .iter()
        .flat_map(|block| {
            let Some(wire::room_block::Kind::Section(section)) = block.kind.as_ref() else {
                return Vec::new();
            };
            section
                .blocks
                .iter()
                .filter_map(|block| match block.kind.as_ref() {
                    Some(wire::room_block::Kind::Row(row)) => {
                        Some((row.selector_id.clone(), row.title.clone()))
                    }
                    _ => None,
                })
                .collect()
        })
        .collect()
}

#[test]
fn recurring_room_consumes_every_observation_page_and_never_invents_future_dates() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    seed_account(&handle);
    command(
        &handle,
        "follow.statement",
        statements(56, -4800),
        "statements",
    );

    let shown = open(&handle, "money/recurring");
    let rendered = snapshot::render(shown.room.as_ref().unwrap());
    assert!(rendered.contains("Monthly utility"), "{rendered}");
    assert!(!rendered.contains("monthly utility"), "{rendered}");
    assert!(
        rendered.contains("Monthly · 4 payments · Checking"),
        "{rendered}"
    );
    assert!(rendered.contains("$48"), "{rendered}");
    assert!(rendered.contains("last 90 days"), "{rendered}");
    assert!(
        !rendered.contains("Next payment"),
        "derived pattern must not predict a date: {rendered}"
    );
    assert!(
        !rendered.contains("Paid"),
        "derived pattern is not a persisted bill: {rendered}"
    );
}

#[test]
fn matching_pages_candidates_and_waits_for_explicit_member_confirmation() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    seed_account(&handle);
    command(
        &handle,
        "txn.add",
        json!({
            "id": HAND, "account_id": ACCOUNT, "posted_on": "2026-11-25",
            "amount_minor": -1250, "title": "Coffee shop"
        }),
        "hand",
    );
    command(
        &handle,
        "follow.statement",
        statements(56, -1250),
        "statements",
    );

    let accounts = open(&handle, "money/matches");
    let hand_list = tap(&handle, &accounts, &format!("account/{ACCOUNT}"));
    let proposal_text = snapshot::render(hand_list.room.as_ref().unwrap());
    assert!(proposal_text.contains("Coffee shop"), "{proposal_text}");
    assert!(proposal_text.contains("$12.50"), "{proposal_text}");

    // Merely opening suggestions leaves the hand-entered item available for explicit review.
    let candidates = tap(&handle, &hand_list, &format!("hand/{HAND}"));
    let first_page = rows(candidates.room.as_ref().unwrap());
    assert_eq!(
        first_page
            .iter()
            .filter(|(id, _)| id.starts_with("candidate/"))
            .count(),
        50
    );
    let first_candidate = rows(candidates.room.as_ref().unwrap())
        .into_iter()
        .find(|(id, _)| id.starts_with("candidate/"))
        .expect("candidate to dismiss");
    let dismissed_review = tap(&handle, &candidates, &first_candidate.0);
    tap_and_ignore_result(&handle, &dismissed_review, "confirm/no");

    // The explicit dismiss removes this pair, but leaves the hand and all other suggestions.
    let candidates = open(&handle, &format!("money/matches/hand/{HAND}"));
    let first_page = rows(candidates.room.as_ref().unwrap());
    assert_eq!(
        first_page
            .iter()
            .filter(|(id, _)| id.starts_with("candidate/"))
            .count(),
        50
    );
    assert!(!first_page.iter().any(|(id, _)| id == &first_candidate.0));

    let second_page = tap(&handle, &candidates, "page/next");
    let second_rows = rows(second_page.room.as_ref().unwrap());
    let last = second_rows
        .iter()
        .find(|(id, _)| id.starts_with("candidate/"))
        .expect("51st match candidate");
    let review = tap(&handle, &second_page, &last.0);
    let review_text = snapshot::render(review.room.as_ref().unwrap());
    assert!(review_text.contains("Confirm match"), "{review_text}");
    assert!(review_text.contains("Dismiss pair"), "{review_text}");
    assert!(review_text.contains("Coffee shop"), "{review_text}");
    assert!(review_text.contains(&last.1), "{review_text}");

    tap_and_ignore_result(&handle, &review, "confirm/yes");
    let refreshed = open(&handle, &format!("money/matches/account/{ACCOUNT}"));
    assert!(
        !snapshot::render(refreshed.room.as_ref().unwrap()).contains("Coffee shop"),
        "confirmation should merge only after the explicit tap"
    );
}
