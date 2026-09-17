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
    self as core, Envelope, Error, RecordKey, RowImage, Value, envelope, value,
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
/// map, and census seam 2 is the warning that a port conflates them.
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
/// `{i: "<decimal>"}` because JSON numbers are doubles, and census seam 2 is
/// the warning that a Rust port must not emit that escape for every integer.
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

// TWO TESTS STOOD HERE AND THEIR MESSAGES ARE DELETED (#1029 §1).
//
// `the_prior_delta_keeps_absent_empty_and_populated_apart` pinned census seam
// 3 on a `LogRow`: absent `prior` means "no prior is known" and forces a
// re-bootstrap, a PRESENT EMPTY `PriorDelta` means "the statement touched only
// the key". `a_conflict_whose_row_is_gone_still_says_so_after_encoding` pinned
// `Conflict.actual_version == 0` as "the row is gone", a sentinel a SEAT read
// off a refused intent. `log.proto` and `intent.proto` are deleted with the
// replica log plane and the intent plane, so neither message exists.

/// Request id zero is the handshake and nothing else; every other body carries
/// a non-zero id. The envelope round-trips each body variant, which is the
/// cheapest statement that the oneof tags do not collide.
#[test]
fn every_envelope_body_round_trips() {
    let bodies = [
        envelope::Body::Request(core::Request {
            kind: Some(core::request::Kind::Hello(core::Hello {
                identity: None,
                schema_version: 1,
                min_supported: 1,
                product_version: "1.0.0-alpha.0".to_owned(),
                capabilities: vec!["replica".to_owned()],
            })),
        }),
        envelope::Body::Response(core::Response {
            kind: Some(core::response::Kind::Command(core::CommandOutcome {
                status: core::CommandStatus::Executed as i32,
                invocation_id: "inv_1".to_owned(),
                ..core::CommandOutcome::default()
            })),
        }),
        envelope::Body::Event(core::Event {
            kind: Some(core::event::Kind::Change(core::ChangeEvent {
                table: "tally_expense".to_owned(),
                pk_set: vec![RecordKey {
                    values: vec![text("exp_1")],
                }],
            })),
        }),
        envelope::Body::Cancel(core::Cancel {}),
        envelope::Body::Error(Error {
            code: core::ErrorCode::Unauthorized as i32,
            detail: "not enrolled".to_owned(),
            diagnostic_id: String::new(),
            sentence: "This device is not enrolled on that vault.".to_owned(),
            moved: None,
        }),
        // THE REFUSAL THAT CARRIES A COMPANION (#1029 W5). `VAULT_MOVED` is
        // the one code with a message riding beside it, and a round trip that
        // only ever encoded the companion-less shape would not notice a field
        // number collision on the day a second companion is added.
        envelope::Body::Error(Error {
            code: core::ErrorCode::VaultMoved as i32,
            detail: "gateway: vault moved".to_owned(),
            diagnostic_id: String::new(),
            sentence: "This vault moved to your other phone.".to_owned(),
            moved: Some(core::VaultMoved {
                current_epoch: 7,
                moved_at_ms: 1_773_500_000_000,
            }),
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

/// A command's input and the screen's state are OPAQUE BYTES, and that is
/// load-bearing: it is mechanism 2 of D-1020-C13, the reason a newer peer's
/// payload arrives whole even though prost drops unknown FIELDS.
///
/// It used to drive `Intent.input` as well; `intent.proto` is deleted (#1029
/// §1) and `Command.input` carries the same claim for the verb that survived.
#[test]
fn opaque_payloads_survive_byte_for_byte() {
    let payload: Vec<u8> = (0u8..=255).collect();
    let command = core::Command {
        name: "tally.add_expense".to_owned(),
        input: payload.clone(),
        invoke_key: "k1".to_owned(),
        ..core::Command::default()
    };
    let decoded = core::Command::decode(command.encode_to_vec().as_slice()).expect("decode");
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
                identity: None,
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

// ------------------------------------------------- the gateway protocol ----
//
// Same discipline as above: what is under test is the SCHEMA, not prost. The
// gateway's two absent-versus-empty seams are `prev_head` (no head yet versus a
// head this writer read) and `purge_after_ms` (live versus tombstoned), and
// both are `optional` because a singular field cannot carry the distinction
// (#1029 §3, F7).

/// A FIRST COMMIT AND A COMMIT THAT READ AN EMPTY HEAD ARE DIFFERENT FACTS.
///
/// This is the compare-and-set fence itself (F7). If absent and empty collapsed
/// into one value, a writer that had never read the vault could present the
/// same bytes as a writer that had, and the gateway would have no way to refuse
/// it — which is precisely the rollback the fence exists to make impossible.
#[test]
fn a_commit_with_no_previous_head_is_not_a_commit_with_an_empty_one() {
    let first = core::CommitRequest {
        generation: "e1d0f0b3b39a4c6f9c5f1d2a3b4c5d6e".to_owned(),
        objects: vec![vec![1_u8; 32]],
        manifest_head: vec![2_u8; 32],
        prev_head: None,
        first_txid: 1,
        last_txid: 9,
    };
    let mut stale = first.clone();
    stale.prev_head = Some(Vec::new());

    roundtrip(&first);
    roundtrip(&stale);

    let decoded_first =
        core::CommitRequest::decode(first.encode_to_vec().as_slice()).expect("decode");
    let decoded_stale =
        core::CommitRequest::decode(stale.encode_to_vec().as_slice()).expect("decode");
    assert_eq!(decoded_first.prev_head, None, "no head yet stays absent");
    assert_eq!(
        decoded_stale.prev_head,
        Some(Vec::new()),
        "a present-but-empty head stays present"
    );
    assert_ne!(decoded_first, decoded_stale);
}

/// A LIVE OBJECT AND A TOMBSTONED ONE WHOSE GRACE PERIOD ENDED AT THE EPOCH.
///
/// `purge_after_ms` absent means "not tombstoned". A singular `int64` would
/// make zero — a real instant — indistinguishable from "live", and the purge
/// sweep would read every live object as purgeable.
#[test]
fn a_live_object_and_a_tombstone_at_time_zero_are_different_facts() {
    let live = core::ObjectEntry {
        name: vec![3_u8; 32],
        kind: core::ObjectKind::Base as i32,
        padded_size: 4 * 1024 * 1024,
        received_at_ms: 1_770_000_000_000,
        purge_after_ms: None,
    };
    let mut tombstoned = live.clone();
    tombstoned.purge_after_ms = Some(0);

    roundtrip(&live);
    roundtrip(&tombstoned);
    assert_ne!(
        core::ObjectEntry::decode(live.encode_to_vec().as_slice()).expect("decode"),
        core::ObjectEntry::decode(tombstoned.encode_to_vec().as_slice()).expect("decode")
    );
}

/// THE BLIND-GATEWAY CANARY, AT THE SCHEMA LEVEL.
///
/// Every message a gateway receives is built from these fields, so a field that
/// could carry plaintext is the only way plaintext could reach one. The object
/// declaration is the narrowest place to hold the line: a name, a checksum, a
/// kind and a PADDED size, and nothing whose value depends on what the object
/// says.
#[test]
fn an_object_declaration_carries_no_plaintext_shaped_field() {
    let declaration = core::ObjectDeclaration {
        name: vec![4_u8; 32],
        attested_checksum: vec![5_u8; 32],
        kind: core::ObjectKind::Segment as i32,
        padded_size: 65_536,
    };
    roundtrip(&declaration);
    // Four fields, and the encoding proves there is no fifth to smuggle one in.
    let bytes = declaration.encode_to_vec();
    let decoded = core::ObjectDeclaration::decode(bytes.as_slice()).expect("decode");
    assert_eq!(decoded, declaration);
    assert_eq!(
        decoded.name.len(),
        32,
        "the name is a 32-byte digest and never a path, a table or a title"
    );
}

/// Version skew reads the same in both directions, which is why it is one
/// message: a phone too old for a server and a server too old for a phone are
/// the same comparison seen from two ends.
#[test]
fn a_version_refusal_reads_the_same_in_both_directions() {
    let phone_too_old = core::VersionRefusal {
        server: Some(core::ProtocolRange { min: 4, max: 6 }),
        client: Some(core::ProtocolRange { min: 1, max: 3 }),
    };
    let server_too_old = core::VersionRefusal {
        server: Some(core::ProtocolRange { min: 1, max: 3 }),
        client: Some(core::ProtocolRange { min: 4, max: 6 }),
    };
    roundtrip(&phone_too_old);
    roundtrip(&server_too_old);
    assert_ne!(phone_too_old, server_too_old);
}

/// A skew refusal carries the SERVER's time, so the client can re-sign once
/// (Reference B, "Protocol"). A refusal without it is a refusal a phone with a
/// wrong clock can only answer by retrying with the same wrong clock.
#[test]
fn a_clock_skew_refusal_carries_the_server_time_and_the_window() {
    let skew = core::ClockSkew {
        server_time_ms: 1_770_000_000_000,
        replay_window_seconds: 300,
    };
    roundtrip(&skew);
    assert!(skew.server_time_ms > 0 && skew.replay_window_seconds > 0);
}
