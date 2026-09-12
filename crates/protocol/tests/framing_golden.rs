//! `contracts/protocol/framing-golden.json` — the byte-level facts, as data.
//!
//! v0 has the same fixture for the same reason
//! (`packages/tunnel/fixtures/wire-golden.json`): a framing rule stated only in
//! one language's source is a rule the other two implementations can disagree
//! with, and the disagreement surfaces at a page boundary on a real network. So
//! the frame bytes for named messages live in `contracts/`, where a Rust test,
//! a Swift XCTest and a Kotlin JUnit test can each read the same file.
//!
//! **This test regenerates and diffs.** It never edits the fixture to match the
//! code: it builds what the code would produce, compares, and on a difference
//! prints both. `CENTRAID_UPDATE_FIXTURES=1` writes the regenerated file — and
//! the comparison still runs afterwards, so the env var is a generator and not
//! a way to go green.
//!
//! One property of the vectors is deliberate and load-bearing: **no vector
//! carries a protobuf `map` with more than one entry.** prost encodes a map in
//! its iteration order, which is not stable, so a multi-entry map has no single
//! byte answer to be golden about. A fixture that ignored this would be flaky
//! in a way that looks like a protocol bug.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use centraid_api_proto::core_v1::{
    self as core, Envelope, Hello, LogCursor, LogPage, LogRequest, LogRow, PairRequest, RecordKey,
    RowImage, UpgradeRequired, UpgradeSide, Value, request, response, value,
};
use centraid_protocol::alpn;
use centraid_protocol::framing::{CHUNK_BYTES, MAX_FRAME_BYTES, PREFIX_BYTES, frame_bytes};
use centraid_protocol::version::{MIN_SUPPORTED, SCHEMA_VERSION, WINDOW_MINORS};
use centraid_protocol::wire::{request as request_envelope, response as response_envelope};
use prost::Message as _;
use serde_json::{Value as Json, json};

const SCHEMA: &str = "centraid-protocol-framing/1";

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("the repository root")
        .join("contracts/protocol/framing-golden.json")
}

fn text(literal: &str) -> Value {
    Value {
        kind: Some(value::Kind::Text(literal.to_owned())),
    }
}

/// The named vectors: a message, its fully-qualified type, and the frame it
/// becomes. Each one is a message that actually crosses the wire in the seat
/// lane, not a synthetic shape.
fn vectors() -> Vec<(&'static str, &'static str, Vec<u8>)> {
    let hello = Hello {
        schema_version: 1,
        min_supported: 1,
        // Pinned, not `env!("CARGO_PKG_VERSION")`: a fixture whose bytes move
        // when the crate version bumps is a fixture that fails on release day.
        product_version: "1.0.0-fixture".to_owned(),
        capabilities: vec!["replica".to_owned(), "commands".to_owned()],
    };

    let mut row = RowImage::default();
    row.columns.insert("title".to_owned(), text("Milk"));

    let log_page = LogPage {
        vault_id: "vault_fixture".to_owned(),
        epoch: "epoch_fixture".to_owned(),
        schema_epoch: 4,
        ddl_version: 0,
        floor: 0,
        watermark: 3,
        next: 3,
        has_more: false,
        rows: vec![LogRow {
            seq: 3,
            commit_seq: 2,
            schema_epoch: 4,
            ddl_version: 0,
            table: "tally_expense".to_owned(),
            op: core::LogOp::Insert as i32,
            pk: Some(RecordKey {
                values: vec![text("exp_1")],
            }),
            row: Some(row),
            prior: None,
            indirect: false,
            deferred: false,
            producer: "gateway".to_owned(),
            committed_at: "2026-01-01T00:00:00.000Z".to_owned(),
        }],
    };

    vec![
        (
            "helloRequest",
            "centraid.core.v1.Envelope",
            request_envelope(
                0,
                core::Request {
                    kind: Some(request::Kind::Hello(hello.clone())),
                },
            )
            .encode_to_vec(),
        ),
        (
            "helloResponse",
            "centraid.core.v1.Envelope",
            response_envelope(
                0,
                core::Response {
                    kind: Some(response::Kind::Hello(hello)),
                },
            )
            .encode_to_vec(),
        ),
        (
            "upgradeRequiredResponse",
            "centraid.core.v1.Envelope",
            response_envelope(
                0,
                core::Response {
                    kind: Some(response::Kind::UpgradeRequired(UpgradeRequired {
                        schema_version: 4,
                        min_supported: 3,
                        peer_schema_version: 1,
                        peer_min_supported: 1,
                        side: UpgradeSide::Peer as i32,
                    })),
                },
            )
            .encode_to_vec(),
        ),
        (
            "logRequest",
            "centraid.core.v1.Envelope",
            request_envelope(
                1,
                core::Request {
                    kind: Some(request::Kind::Log(LogRequest {
                        since: Some(LogCursor {
                            epoch: "epoch_fixture".to_owned(),
                            seq: 2,
                        }),
                        limit: 1_000,
                    })),
                },
            )
            .encode_to_vec(),
        ),
        (
            "logPageResponse",
            "centraid.core.v1.Envelope",
            response_envelope(
                1,
                core::Response {
                    kind: Some(response::Kind::Log(log_page)),
                },
            )
            .encode_to_vec(),
        ),
        (
            "cancel",
            "centraid.core.v1.Envelope",
            centraid_protocol::wire::cancel(1).encode_to_vec(),
        ),
        (
            "pairRequest",
            "centraid.core.v1.Envelope",
            request_envelope(
                2,
                core::Request {
                    kind: Some(request::Kind::Pair(PairRequest {
                        code: vec![0xab; 16],
                        ticket_id: "tkt_fixture".to_owned(),
                        device_name: "Fixture Phone".to_owned(),
                        platform: "ios".to_owned(),
                        device_public_key: vec![0xcd; 32],
                    })),
                },
            )
            .encode_to_vec(),
        ),
    ]
}

fn generated() -> Json {
    let alpns = json!({
        "seat": {
            "utf8": String::from_utf8_lossy(alpn::SEAT),
            "base64": BASE64.encode(alpn::SEAT),
        },
        "pair": {
            "utf8": String::from_utf8_lossy(alpn::PAIR),
            "base64": BASE64.encode(alpn::PAIR),
        },
        "peer": {
            "utf8": String::from_utf8_lossy(alpn::PEER),
            "base64": BASE64.encode(alpn::PEER),
        },
    });

    let vectors: Vec<Json> = vectors()
        .into_iter()
        .map(|(name, type_name, body)| {
            let frame = frame_bytes(&body).expect("a fixture vector is within the ceiling");
            json!({
                "name": name,
                "type": type_name,
                "bodyBytes": body.len(),
                "frameBase64": BASE64.encode(&frame),
            })
        })
        .collect();

    json!({
        "schema": SCHEMA,
        "framing": "u32BE(len) || bytes",
        "caps": {
            "maxFrameBytes": MAX_FRAME_BYTES,
            "chunkBytes": CHUNK_BYTES,
            "prefixBytes": PREFIX_BYTES,
        },
        "versionWindow": {
            "schemaVersion": SCHEMA_VERSION,
            "minSupported": MIN_SUPPORTED,
            "windowMinors": WINDOW_MINORS,
        },
        "alpns": alpns,
        "vectors": vectors,
    })
}

/// The committed fixture is what the code produces, byte for byte at the frame
/// level. The comparison is over parsed JSON rather than raw text, because
/// `oxfmt` owns the file's formatting and a whitespace diff is not a protocol
/// difference.
#[test]
fn the_committed_fixture_is_what_this_build_produces() {
    let path = fixture_path();
    let expected = generated();

    if std::env::var_os("CENTRAID_UPDATE_FIXTURES").is_some() {
        fs::create_dir_all(path.parent().expect("a parent")).expect("create contracts/protocol");
        fs::write(
            &path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&expected).expect("serialise")
            ),
        )
        .expect("write the fixture");
        eprintln!(
            "regenerated {} — run `bun run format` and commit it",
            path.display()
        );
    }

    let committed: Json = serde_json::from_str(
        &fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!(
                "{} is missing ({error}). Regenerate with CENTRAID_UPDATE_FIXTURES=1 cargo test -p centraid-protocol",
                path.display()
            )
        }),
    )
    .expect("the fixture is JSON");

    if committed != expected {
        panic!(
            "contracts/protocol/framing-golden.json is not what this build produces.\n\
             committed: {}\n\
             generated: {}\n\
             If the change is intended, regenerate with CENTRAID_UPDATE_FIXTURES=1 and say so in \
             the receipt — the fixture is a cross-language contract, so a change to it is a change \
             every implementation must make (#1020).",
            serde_json::to_string_pretty(&committed).expect("serialise"),
            serde_json::to_string_pretty(&expected).expect("serialise"),
        );
    }
}

/// Every vector's `frameBase64` parses back into its own length prefix and
/// body. Reading the fixture the way another language would is the only way to
/// know the file is usable from another language.
#[test]
fn every_vector_parses_back_through_the_length_prefix() {
    let committed: Json =
        serde_json::from_str(&fs::read_to_string(fixture_path()).expect("read")).expect("JSON");
    let vectors = committed["vectors"].as_array().expect("an array");
    assert!(!vectors.is_empty());
    for vector in vectors {
        let name = vector["name"].as_str().expect("a name");
        let frame = BASE64
            .decode(vector["frameBase64"].as_str().expect("base64"))
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert!(frame.len() > PREFIX_BYTES, "{name}: no body");
        let declared =
            u32::from_be_bytes(frame[..PREFIX_BYTES].try_into().expect("four bytes")) as usize;
        assert_eq!(
            declared,
            frame.len() - PREFIX_BYTES,
            "{name}: the prefix and the body disagree"
        );
        assert_eq!(
            declared,
            vector["bodyBytes"].as_u64().expect("a number") as usize,
            "{name}: bodyBytes does not match the frame"
        );
        assert!(declared <= MAX_FRAME_BYTES, "{name}: over the ceiling");
        Envelope::decode(&frame[PREFIX_BYTES..])
            .unwrap_or_else(|error| panic!("{name}: the body is not an Envelope: {error}"));
    }
}
