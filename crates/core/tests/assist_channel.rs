//! A SEALED VALUE IS A CHANNEL THE CHAT KEEPS CLOSED (#1135), driven through the real chat plane.
//!
//! The assistant and the member have the same functionality, and the one Locker rule is that a
//! secret's value never reaches the model. This plants a unique marker in every sealed cell Locker
//! has (a login's password and code seed, a card's number and cvv, a note's content), a sealed
//! custom field and a passkey's private key, all sealed under the member's real `K`, so a path that
//! could open them would. It then asks the chat everything a member could: find, open, search, a
//! reveal of every field, the code, a create with a secret the member typed, an edit, a confirm.
//!
//! Then it searches every place a secret must not be, for the markers and for any `lk1:`
//! ciphertext: every prompt the model received, every event the plane sank, every row of the thread
//! tables, the journal and the search index. The secret the member typed is the one value the
//! channel may carry, and only on the turn they typed it: it ends sealed in the vault and is absent
//! from the stored question and from every prompt after the card was parked.

mod common;

use std::sync::Arc;

use centraid_assist::model::Model;
use centraid_assist::native::park::Confirmed;
use centraid_core::api_proto as wire;
use centraid_vault::custody::locker_key::encrypt_under_locker_key;
use common::chat::{script, step};

const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
     abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
     abandon abandon abandon abandon abandon art";

/// One marker for each place a sealed value lives.
const MARKERS: [(&str, &str); 8] = [
    ("password", "MARK-PASSWORD-q7xk4"),
    ("otp_seed", "MARK-OTPSEED-mv9wr2"),
    ("card_number", "MARK-CARDNUMBER-kp5ny1"),
    ("cvv", "MARK-CVV-fw2js6"),
    ("content", "MARK-CONTENT-zt3bh8"),
    ("field", "MARK-CUSTOMFIELD-rd6cn9"),
    ("passkey", "MARK-PASSKEY-ye4lg5"),
    ("unused", "MARK-UNUSED-aa1bb2"),
];

fn marker(name: &str) -> &'static str {
    MARKERS
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, text)| *text)
        .expect("a marker")
}

const TYPED_CREATE: &str = "TYPED-GYM-4471";
const TYPED_EDIT: &str = "TYPED-EDIT-9902";

fn answered(sent: &wire::AssistSent) -> &wire::AssistAnswer {
    match sent.outcome.as_ref().expect("an outcome") {
        wire::assist_sent::Outcome::Answered(answer) => answer,
        other => panic!("expected an answer, got {other:?}"),
    }
}

/// Plant the three items, through the owner's own door, every sealed cell under the member's `K`.
fn plant(sample: &common::chat::Sample) {
    let keys = centraid_identity::derive::restore_vault_keys(
        &centraid_identity::RecoveryPhrase::parse(WORDS)
            .expect("the words parse")
            .seed(),
        0,
    )
    .expect("the keys derive");
    let key_id = sample
        .handle
        .with_vault(|vault| {
            vault
                .locker_generation()
                .map_err(|error| centraid_core::CoreError::InvalidRequest {
                    detail: error.to_string(),
                })
        })
        .expect("the key plane lands");
    let seal = |row: &str, plaintext: &str| {
        encrypt_under_locker_key(keys.locker.as_bytes(), &key_id, row, plaintext)
            .expect("the cell seals")
    };
    let owner = sample.handle.owner();
    let run = |name: &str, input: serde_json::Value| {
        let ran = sample
            .handle
            .with_vault(|vault| {
                vault
                    .execute(
                        sample.handle.registry(),
                        &owner,
                        &centraid_vault::commands::Command::new(name, input),
                    )
                    .map_err(centraid_core::CoreError::from)
            })
            .expect("the owner's command answers");
        assert_eq!(
            ran.status,
            centraid_vault::CommandStatus::Executed,
            "{name}: {:?}",
            ran.reason
        );
    };
    run(
        "locker.add_item",
        serde_json::json!({
            "item_id": "lk-login", "type": "login", "title": "Planted login",
            "username": "plainname", "url": "https://planted.example",
            "password": seal("lk-login", marker("password")),
            "otp_seed": seal("lk-login", marker("otp_seed")),
            "password_rotated": true, "key_id": key_id
        }),
    );
    run(
        "locker.set_field",
        serde_json::json!({
            "item_id": "lk-login", "field_id": "field-1", "label": "Recovery", "kind": "sealed",
            "value": seal("field-1", marker("field")), "key_id": key_id
        }),
    );
    run(
        "locker.set_passkey",
        serde_json::json!({
            "item_id": "lk-login", "rp_id": "planted.example", "user_handle": "ada",
            "display_name": "Ada", "credential_id": "cred-1", "algorithm": "ES256",
            "private_key": seal("lk-login", marker("passkey")), "key_id": key_id
        }),
    );
    run(
        "locker.add_item",
        serde_json::json!({
            "item_id": "lk-card", "type": "card", "title": "Planted card",
            "cardholder": "Ada",
            "card_number": seal("lk-card", marker("card_number")),
            "cvv": seal("lk-card", marker("cvv")), "key_id": key_id
        }),
    );
    run(
        "locker.add_item",
        serde_json::json!({
            "item_id": "lk-note", "type": "note", "title": "Planted note",
            "content": seal("lk-note", marker("content")), "key_id": key_id
        }),
    );
}

/// Every row of the tables a secret must not reach, as text: the thread, the journal and the index.
fn stored_text(sample: &common::chat::Sample, tables: &dyn Fn(&str) -> bool) -> String {
    sample
        .handle
        .with_vault(|vault| {
            vault
                .read(|connection| {
                    Ok(centraid_vault::testdoor::text_of_tables(
                        connection, tables,
                    )?)
                })
                .map_err(centraid_core::CoreError::from)
        })
        .expect("the vault reads")
}

fn assert_clean(what: &str, bytes: &str, typed: &[&str]) {
    let lowered = bytes.to_lowercase();
    for (_, planted) in MARKERS {
        assert!(!bytes.contains(planted), "{what} carried {planted}");
        assert!(
            !lowered.contains(&planted.to_lowercase()),
            "{what} carried {planted} (folded)"
        );
    }
    assert!(!bytes.contains("lk1:"), "{what} carried a ciphertext");
    for secret in typed {
        assert!(!bytes.contains(secret), "{what} carried the typed {secret}");
    }
}

fn settle(
    sample: &common::chat::Sample,
    session: u64,
    pending: &str,
) -> centraid_core::assist::Confirmation {
    sample
        .handle
        .assist_confirm(session, pending)
        .expect("a confirm answers")
}

fn unlock(sample: &common::chat::Sample) {
    let answer = sample
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Locker(wire::LockerSessionRequest {
                step: Some(wire::locker_session_request::Step::Unlock(
                    wire::LockerUnlock {},
                )),
            })),
        })
        .expect("the session answers");
    let Some(wire::response::Kind::Locker(answer)) = answer.kind else {
        panic!("a locker answer");
    };
    assert_eq!(answer.state, wire::LockerSessionState::Unlocked as i32);
}

fn reveal(sample: &common::chat::Sample, item: &str, column: &str) -> Option<String> {
    let answer = sample
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Locker(wire::LockerSessionRequest {
                step: Some(wire::locker_session_request::Step::Reveal(
                    wire::LockerReveal {
                        item_id: item.to_owned(),
                        column: column.to_owned(),
                        ..wire::LockerReveal::default()
                    },
                )),
            })),
        })
        .expect("the session answers");
    let Some(wire::response::Kind::Locker(answer)) = answer.kind else {
        panic!("a locker answer");
    };
    answer.revealed.map(|shown| shown.value)
}

#[test]
fn no_sealed_value_reaches_the_model_an_event_the_thread_the_journal_or_the_index() {
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the words parse")
        .seed();
    let sample = common::chat::sample_with_seed(seed);
    plant(&sample);

    let reveal_step = |name: &str, field: &str| {
        step(
            "plan: secret",
            "act",
            &[
                ("verb", "reveal"),
                ("kind", "locker_item"),
                ("name", name),
                ("args", &format!("field: {field}")),
            ],
        )
    };
    let steps = [
        // 1. find, 2. open, 3. search
        vec![
            step("plan: look", "find", &[("kind", "locker_item")]),
            step("plan: answer", "answer", &[("rows", "@1")]),
        ],
        vec![
            step(
                "plan: look",
                "find",
                &[("kind", "locker_item"), ("name", "Planted login")],
            ),
            step("plan: open", "open", &[("row", "@1")]),
            step("plan: answer", "answer", &[("rows", "@1")]),
        ],
        vec![
            step("plan: look", "search", &[("text", "planted")]),
            step("plan: answer", "answer", &[("rows", "@1")]),
        ],
        // 4. a reveal of each field, and the code
        vec![reveal_step("Planted login", "password")],
        vec![reveal_step("Planted login", "code")],
        vec![reveal_step("Planted card", "card_number")],
        vec![reveal_step("Planted card", "cvv")],
        vec![reveal_step("Planted note", "notes")],
        // 5. a create with a secret the member typed
        vec![step(
            "plan: save",
            "act",
            &[
                ("verb", "create"),
                ("kind", "locker_item"),
                (
                    "args",
                    &format!("name: Gym locker\ntype: login\npassword: {TYPED_CREATE}"),
                ),
            ],
        )],
        // 6. an edit with a typed secret, 7. an edit with none (the member's to type)
        vec![step(
            "plan: edit",
            "act",
            &[
                ("verb", "edit"),
                ("kind", "locker_item"),
                ("name", "Gym locker"),
                ("args", &format!("password: {TYPED_EDIT}")),
            ],
        )],
        vec![step(
            "plan: edit",
            "act",
            &[
                ("verb", "edit"),
                ("kind", "locker_item"),
                ("name", "Gym locker"),
                ("args", "password: "),
            ],
        )],
        // 8. a last read, whose prompt follows every typed secret
        vec![
            step("plan: look", "find", &[("kind", "locker_item")]),
            step("plan: answer", "answer", &[("rows", "@1")]),
        ],
    ];
    let model = script(&steps.iter().flatten().cloned().collect::<Vec<_>>());
    sample.install(Arc::clone(&model) as Arc<dyn Model>);
    let session = sample.start("");
    let mut turn = 0;
    let mut send = |text: &str| {
        turn += 1;
        sample.send(session, turn, text)
    };

    // Reads.
    for ask in ["my logins", "the planted login", "anything planted"] {
        let sent = send(ask);
        assert!(!answered(&sent).cards.is_empty(), "{ask}");
    }

    // Every reveal is a member action: a card, never a value.
    for (ask, qualifier) in [
        ("planted login password", "reveal:password"),
        ("planted login code", "code:otp_seed"),
        ("planted card number", "reveal:card_number"),
        ("planted card cvv", "reveal:cvv"),
        ("planted note", "reveal:content"),
    ] {
        let sent = send(ask);
        let [card] = answered(&sent).cards.as_slice() else {
            panic!("{ask}: one card");
        };
        assert_eq!(card.entity, "locker_item", "{ask}");
        assert_eq!(card.qualifier, qualifier, "{ask}");
    }

    // A secret the member typed is a parked write, shown masked.
    let before_create = model.prompts().len();
    let sent = send(&format!("save my gym locker code {TYPED_CREATE}"));
    let card = sample
        .handle
        .assist_pending(session)
        .expect("a chat")
        .expect("a card waits");
    assert!(
        answered(&sent).text.contains("password ••••"),
        "{}",
        answered(&sent).text
    );
    let after_create = model.prompts().len();
    assert!(after_create > before_create);

    // The Locker is shut: the confirm stops first and the card still waits.
    assert!(matches!(
        settle(&sample, session, &card.id).outcome,
        Confirmed::Locked
    ));
    assert!(sample.handle.assist_pending(session).unwrap().is_some());
    unlock(&sample);
    let done = settle(&sample, session, &card.id);
    assert!(matches!(done.outcome, Confirmed::Done { .. }), "{done:?}");

    // It is stored sealed, and the member's own Locker opens it to what they typed.
    let stored = stored_text(&sample, &|name| name == "locker_item");
    assert!(stored.contains("lk1:"));
    assert!(!stored.contains(TYPED_CREATE), "stored as typed");
    let gym = {
        use centraid_assist::native::Door as _;
        let door = sample.handle.assist_door();
        let rows = door
            .table_where(
                "entity",
                "id, title",
                "id",
                "id",
                "title = ?",
                &["Gym locker".to_owned()],
            )
            .expect("the door reads");
        centraid_assist::native::door::text(rows.first().expect("the new item"), "id")
            .expect("an id")
    };
    assert_eq!(
        reveal(&sample, &gym, "password").as_deref(),
        Some(TYPED_CREATE)
    );
    // …and the planted values are real: the member's Locker opens them too (the control).
    assert_eq!(
        reveal(&sample, "lk-login", "password").as_deref(),
        Some(marker("password"))
    );

    // An edit with a typed secret parks and settles the same way; one with none is a card.
    let before_edit = model.prompts().len();
    let sent = send(&format!("change the gym locker code to {TYPED_EDIT}"));
    let after_edit = model.prompts().len();
    assert!(answered(&sent).text.contains("password ••••"));
    let card = sample
        .handle
        .assist_pending(session)
        .unwrap()
        .expect("a card");
    assert!(matches!(
        settle(&sample, session, &card.id).outcome,
        Confirmed::Done { .. }
    ));
    assert_eq!(
        reveal(&sample, &gym, "password").as_deref(),
        Some(TYPED_EDIT)
    );
    let sent = send("I want to set the gym locker code myself");
    assert_eq!(answered(&sent).cards[0].qualifier, "edit_secret:password");
    send("my logins again");

    // THE CHANNEL: nowhere a secret must not be.
    let prompts = model.prompts();
    for (index, prompt) in prompts.iter().enumerate() {
        // the turn the member typed a secret in has their own words in front of the model; every
        // other prompt, before and after, holds neither
        let typed_here: &[&str] = if (before_create..after_create).contains(&index) {
            &[TYPED_EDIT]
        } else if (before_edit..after_edit).contains(&index) {
            &[TYPED_CREATE]
        } else {
            &[TYPED_CREATE, TYPED_EDIT]
        };
        assert_clean(&format!("prompt {index}"), prompt, typed_here);
    }
    let events = format!("{:?}", sample.drain_assist_events());
    assert_clean("the events", &events, &[TYPED_CREATE, TYPED_EDIT]);
    let thread = stored_text(&sample, &|name| {
        name.starts_with("thread") || name.starts_with("message") || name.starts_with("chat")
    });
    assert!(
        thread.contains("«sealed»"),
        "the stored question holds the placeholder"
    );
    assert_clean("the thread tables", &thread, &[TYPED_CREATE, TYPED_EDIT]);
    let journal = stored_text(&sample, &|name| name == "journal");
    assert_clean("the journal", &journal, &[TYPED_CREATE, TYPED_EDIT]);
    let index = stored_text(&sample, &|name| name.starts_with("search_"));
    assert_clean("the index", &index, &[TYPED_CREATE, TYPED_EDIT]);
}
