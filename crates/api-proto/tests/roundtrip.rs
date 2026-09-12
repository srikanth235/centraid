//! Every message round-trips, and the two distinctions that cost v0 incidents
//! survive the encoder (#1020, D-1020-C3).
//!
//! A round-trip test over generated code looks like testing prost, and it is
//! not: what is under test is the *schema*. `optional` on a scalar and a
//! present-but-empty message are the two ways proto3 can express "absent versus
//! empty", and choosing the wrong one is a silent loss that no compiler
//! catches. So the tests below assert the shapes the census names as seams —
//! absent column versus SQL NULL (seam 2), the delta prior image (seam 3) — and
//! not that `prost::Message` works.

use centraid_api_proto::core_v1::{
    self as core, Conflict, Envelope, Error, Intent, LogPage, LogRow, PriorDelta, RecordKey,
    RowImage, Value, envelope, value,
};
use centraid_api_proto::screen_v1::ScreenState;
use prost::Message;

fn text(literal: &str) -> Value {
    Value {
        kind: Some(value::Kind::Text(literal.to_owned())),
    }
}

fn integer(number: i64) -> Value {
    Value {
        kind: Some(value::Kind::Integer(number)),
    }
}

fn null() -> Value {
    Value {
        kind: Some(value::Kind::Null(core::NullValue {})),
    }
}

fn roundtrip<M: Message + Default + PartialEq + std::fmt::Debug>(message: &M) {
    let bytes = message.encode_to_vec();
    let decoded = M::decode(bytes.as_slice()).expect("decode what we just encoded");
    assert_eq!(&decoded, message);
}

/// SQL NULL is a PRESENT value; an absent column is a key that is not in the
/// map. v0 states the same contract over JSON at
/// `packages/core/src/protocol/row-json.ts:25-28`, and census seam 2 is the
/// warning that a port conflates them.
#[test]
fn an_absent_column_and_sql_null_are_different_facts() {
    let mut row = RowImage::default();
    row.columns.insert("title".to_owned(), text("Milk"));
    row.columns.insert("note".to_owned(), null());
    // `amount` is deliberately not inserted.

    let decoded = RowImage::decode(row.encode_to_vec().as_slice()).expect("decode");
    assert_eq!(decoded.columns.get("note"), Some(&null()));
    assert!(
        decoded.columns.contains_key("note"),
        "SQL NULL is a present key"
    );
    assert!(
        !decoded.columns.contains_key("amount"),
        "an absent column stays absent through the encoder"
    );
    assert_eq!(decoded.columns.len(), 2);
}

/// An i64 beyond ±2^53−1 needs no escape. v0 had to send it as
/// `{i: "<decimal>"}` because JSON numbers are doubles
/// (`packages/core/src/protocol/row-json.ts:92-98`), and census seam 2 is the
/// warning that a Rust port must not emit that escape for every integer.
#[test]
fn a_wide_integer_survives_without_a_decimal_text_escape() {
    for number in [
        0,
        1,
        -1,
        9_007_199_254_740_991, // Number.MAX_SAFE_INTEGER
        9_007_199_254_740_993, // the first integer JSON cannot hold
        i64::MAX,
        i64::MIN,
    ] {
        let decoded =
            Value::decode(integer(number).encode_to_vec().as_slice()).expect("decode integer");
        assert_eq!(decoded, integer(number));
    }
}

/// Three claims, three encodings (census seam 3): no prior known is an ABSENT
/// `prior`; "the statement touched only the key" is a PRESENT, EMPTY
/// `PriorDelta`; a real delta is a present, non-empty one. `optional` on the
/// field is what keeps the first two apart.
#[test]
fn the_prior_delta_keeps_absent_empty_and_populated_apart() {
    let base = LogRow {
        seq: 7,
        commit_seq: 3,
        table: "tally_expense".to_owned(),
        op: core::LogOp::Update as i32,
        pk: Some(RecordKey {
            values: vec![text("exp_1")],
        }),
        ..LogRow::default()
    };

    let no_prior = LogRow {
        prior: None,
        ..base.clone()
    };
    let empty_prior = LogRow {
        prior: Some(PriorDelta::default()),
        ..base.clone()
    };
    let mut delta = PriorDelta::default();
    delta.columns.insert("amount".to_owned(), integer(120));
    let real_prior = LogRow {
        prior: Some(delta),
        ..base
    };

    for row in [&no_prior, &empty_prior, &real_prior] {
        roundtrip(row);
    }
    let decoded_empty =
        LogRow::decode(empty_prior.encode_to_vec().as_slice()).expect("decode empty prior");
    assert!(
        decoded_empty.prior.is_some(),
        "an empty delta is a real answer and must not decode as absent"
    );
    assert!(decoded_empty.prior.expect("present").columns.is_empty());
    assert!(
        LogRow::decode(no_prior.encode_to_vec().as_slice())
            .expect("decode")
            .prior
            .is_none()
    );
}

/// `actual_version == 0` means the row is gone
/// (`packages/client/src/replica/types.ts:93-109`). A sentinel inside the field
/// only works because `row_version` starts at 1, so zero cannot be a real
/// version; the test pins that the sentinel survives the encoder's default
/// elision, which is the one way it could have been lost.
#[test]
fn a_conflict_whose_row_is_gone_still_says_so_after_encoding() {
    let gone = Conflict {
        entity: "tally.expense".to_owned(),
        row_id: "exp_1".to_owned(),
        shape_id: None,
        expected_version: 4,
        actual_version: 0,
    };
    let decoded = Conflict::decode(gone.encode_to_vec().as_slice()).expect("decode");
    assert_eq!(decoded.actual_version, 0);
    assert_eq!(decoded, gone);
}

/// Request id zero is the handshake and nothing else; every other body carries
/// a non-zero id. The envelope round-trips each body variant, which is the
/// cheapest statement that the oneof tags do not collide.
#[test]
fn every_envelope_body_round_trips() {
    let bodies = [
        envelope::Body::Request(core::Request {
            kind: Some(core::request::Kind::Hello(core::Hello {
                schema_version: 1,
                min_supported: 1,
                product_version: "1.0.0-alpha.0".to_owned(),
                capabilities: vec!["replica".to_owned()],
            })),
        }),
        envelope::Body::Response(core::Response {
            kind: Some(core::response::Kind::Log(LogPage {
                epoch: "e1".to_owned(),
                watermark: 12,
                next: 12,
                ..LogPage::default()
            })),
        }),
        envelope::Body::Event(core::Event {
            kind: Some(core::event::Kind::Change(core::ChangeEvent {
                table: "tally_expense".to_owned(),
                pk_set: vec![RecordKey {
                    values: vec![text("exp_1")],
                }],
                commit_seq: 3,
            })),
        }),
        envelope::Body::Cancel(core::Cancel {}),
        envelope::Body::Error(Error {
            code: core::ErrorCode::Unauthorized as i32,
            detail: "not enrolled".to_owned(),
            diagnostic_id: String::new(),
            sentence: "This device is not enrolled on that vault.".to_owned(),
        }),
    ];
    for (index, body) in bodies.into_iter().enumerate() {
        let envelope = Envelope {
            request_id: index as u64 + 1,
            body: Some(body),
        };
        roundtrip(&envelope);
    }
}

/// The intent's input and the screen's state are OPAQUE BYTES, and that is
/// load-bearing: it is mechanism 2 of D-1020-C13, the reason a newer peer's
/// payload arrives whole even though prost drops unknown FIELDS.
#[test]
fn opaque_payloads_survive_byte_for_byte() {
    let payload: Vec<u8> = (0u8..=255).collect();
    let intent = Intent {
        intent_id: "int_1".to_owned(),
        app_id: "tally".to_owned(),
        action: "add-expense".to_owned(),
        input: payload.clone(),
        payload_hash: "0".repeat(64),
        online_only: false,
        ..Intent::default()
    };
    let decoded = Intent::decode(intent.encode_to_vec().as_slice()).expect("decode");
    assert_eq!(decoded.input, payload);

    let screen = ScreenState {
        screen_id: "tally.list".to_owned(),
        state: payload.clone(),
        revision: 9,
    };
    let decoded = ScreenState::decode(screen.encode_to_vec().as_slice()).expect("decode");
    assert_eq!(decoded.state, payload);
}

/// prost 0.14 has no unknown-field retention, and this test is what says so out
/// loud rather than leaving it to a comment (D-1020-C13). The red it would turn
/// if prost ever gained the feature is a welcome one: it means mechanism 1 can
/// be relaxed, and the decision gets re-made with evidence.
#[test]
fn prost_drops_unknown_fields_which_is_why_nothing_relays_a_decoded_message() {
    // A `Hello` plus field 99, varint 7 — a field no version of this schema
    // has. Tag byte for field 99, wire type 0 is `99 << 3 | 0 = 792`, encoded
    // as the varint [0x98, 0x06].
    let mut bytes = Envelope {
        request_id: 0,
        body: Some(envelope::Body::Request(core::Request {
            kind: Some(core::request::Kind::Hello(core::Hello {
                schema_version: 2,
                min_supported: 1,
                product_version: "9.9.9".to_owned(),
                capabilities: Vec::new(),
            })),
        })),
    }
    .encode_to_vec();
    let original = bytes.len();
    bytes.extend_from_slice(&[0x98, 0x06, 0x07]);

    let decoded =
        Envelope::decode(bytes.as_slice()).expect("an unknown field must not fail decode");
    assert_eq!(
        decoded.request_id, 0,
        "the known fields still decode around the unknown one"
    );
    let reencoded = decoded.encode_to_vec();
    assert_eq!(
        reencoded.len(),
        original,
        "prost drops the unknown field on re-encode — if this assertion ever fails, prost gained \
         unknown-field retention and D-1020-C13's mechanism 1 can be revisited"
    );
}
