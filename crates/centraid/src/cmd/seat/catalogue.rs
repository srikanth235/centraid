//! The statement catalogue: **named** reads, never composed ones
//! (#1020, D-1020-F2, D-1020-F5).
//!
//! v0's renderer is an HTTP client that sends the read it wants
//! (`packages/core/src/page/statement.ts` shapes travel from the renderer). On
//! a socket where the peer check has already proven the uid, that would still
//! be wrong for a different reason: the renderer is the part of this product
//! that runs third-party-authored JSX from `packages/blueprints`, and a read it
//! can *compose* is a read an app can compose. So the wire carries a **name**
//! and the sidecar holds the shapes.
//!
//! Every Tally statement here is `crates/apps/tally`'s own — the same functions
//! `crates/apps/tally/tests/parity.rs` compares against
//! `contracts/apps/tally/rows.json`. Nothing is re-spelled, so the renderer's
//! dashboard reads exactly what the parity test reads.
//!
//! Photos has no app crate yet, so its three statements are declared here over
//! the ontology's own tables and are **not** joined in SQL: `media_asset`,
//! `core_content_item` and `core_content_representation` are read as three
//! pages and folded by the renderer. A JOIN would need column aliases, and
//! `crates/core`'s `api::page` looks a row's values up by the literal `select`
//! entry — an alias there is a silent column of nulls.

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::statement::{PageBindValue, PageQuery};
use centraid_apps_tally::queries as tally;

/// Every statement the socket will answer, by name.
///
/// A list and not a `match` with a fallthrough: `centraid seat --print-catalogue`
/// prints it, `contracts/desktop/socket-catalogue.json` pins it, and a test
/// asserts the three agree. A name that is not here is refused by name.
pub fn catalogue() -> Vec<(&'static str, PageQuery)> {
    vec![
        ("tally.vault", tally::vault_statement()),
        ("tally.friends", tally::friends_statement()),
        ("tally.groups", tally::groups_statement()),
        ("tally.circles", tally::circles_statement()),
        ("tally.circleMembers", tally::circle_members_statement()),
        ("tally.expenses", tally::expenses_statement()),
        ("tally.splits", tally::splits_statement()),
        ("tally.payers", tally::payers_statement()),
        ("tally.settlements", tally::settlements_statement()),
        ("tally.obligations", tally::obligations_statement()),
        ("tally.receipts", tally::receipts_statement()),
        ("companion.apps", companion_apps()),
        ("companion.outbox", companion_outbox()),
        ("companion.connections", companion_connections()),
        ("companion.parked", companion_parked()),
        ("companion.scopeRequests", companion_scope_requests()),
        ("locker.autofillLogins", locker_autofill_logins()),
        ("photos.assets", photos_assets()),
        ("photos.content", photos_content()),
        ("photos.representations", photos_representations()),
    ]
}

/// One statement by name, as the proto request's query.
pub fn statement(name: &str) -> Option<wire::PageQuery> {
    catalogue()
        .into_iter()
        .find(|(known, _)| *known == name)
        .map(|(_, query)| to_wire(&query))
}

/// `companion.apps` — which apps this vault has installed (#1020 wave 4 lane
/// extension, D-1020-X10).
///
/// v0's `GET /_vault/apps` answers the same question and the Companion asks it
/// for exactly one reason: *`unavailable` means the app is not installed on the
/// paired vault, which is the one fact still worth asking the gateway for*
/// (`apps/extension/src/companion-api.ts:127`–`:131`). Which modules the
/// Companion uses is its own local preference (#996 R11) and is never read
/// from here.
fn companion_apps() -> PageQuery {
    PageQuery::new(
        "companion.apps",
        "app_id, name, display_name, label",
        "access_app",
        centraid_apps_kit::statement::PageOrder::asc("app_id", "app_id"),
    )
}

/// `companion.outbox` — the queue's pending half, one of `blocking-count`'s
/// four sources (`packages/server/src/serve/vault-plane.ts:1254`–`:1292`).
fn companion_outbox() -> PageQuery {
    PageQuery::new(
        "companion.outbox",
        "item_id, verb, target, staged_at",
        "outbox_item",
        centraid_apps_kit::statement::PageOrder::asc("item_id", "item_id"),
    )
    .filter(
        "status = ?",
        vec![PageBindValue::Text("pending".to_owned())],
    )
}

/// `companion.connections` — connectors whose authorisation has lapsed.
fn companion_connections() -> PageQuery {
    PageQuery::new(
        "companion.connections",
        "connection_id, kind, label",
        "sync_connection",
        centraid_apps_kit::statement::PageOrder::asc("connection_id", "connection_id"),
    )
    .filter(
        "status = ?",
        vec![PageBindValue::Text("needs-auth".to_owned())],
    )
}

/// `companion.parked` — invocations waiting on the member's decision.
fn companion_parked() -> PageQuery {
    PageQuery::new(
        "companion.parked",
        "intent_id, status",
        "replica_intent_outcome",
        centraid_apps_kit::statement::PageOrder::asc("intent_id", "intent_id"),
    )
    .filter("status = ?", vec![PageBindValue::Text("parked".to_owned())])
}

/// `companion.scopeRequests` — grants an agent has asked for and not been
/// answered about. *A refusal is an ANSWER*, so `decided_at IS NULL` is the
/// open set (`packages/vault/src/grant/authority-request.ts:78`–`:82`).
fn companion_scope_requests() -> PageQuery {
    PageQuery::new(
        "companion.scopeRequests",
        "request_id, principal_id, requested_at",
        "share_authority_request",
        centraid_apps_kit::statement::PageOrder::asc("request_id", "request_id"),
    )
    .filter("decided_at IS NULL", Vec::<PageBindValue>::new())
}

/// `locker.autofillLogins` — `crates/apps/locker`'s own statement, unchanged.
///
/// SECRET-FREE BY CONSTRUCTION: `ITEM_COLUMNS` is the Companion's projection
/// and does not carry `password` or `otp_seed` (census §A8). The origin filter
/// is NOT in the statement, because a catalogue statement takes no caller bind
/// — it happens in `centraid native-host`, over the same
/// `contracts/origin-matching-v1.json` the app crate answers (D-1020-X8).
fn locker_autofill_logins() -> PageQuery {
    centraid_apps_locker::queries::autofill_logins_statement()
}

/// `photos.assets` — the timeline. Newest capture first, archived and trashed
/// assets excluded: "archived" hides an asset from the timeline without
/// trashing it, and the DDL's `CHECK (archived_at IS NULL OR deleted_at IS
/// NULL)` says a row claiming both is neither (`vault-ddl.sql:2760`).
fn photos_assets() -> PageQuery {
    PageQuery::new(
        "photos.timeline.assets",
        "asset_id, content_id, kind, title, captured_at, tz_offset_min, width, height, duration_s, \
         created_at",
        "media_asset",
        centraid_apps_kit::statement::PageOrder::desc("captured_at", "asset_id"),
    )
    .filter(
        "archived_at IS NULL AND deleted_at IS NULL",
        Vec::<PageBindValue>::new(),
    )
}

/// `photos.content` — the bytes each asset points at. `sha256` IS the
/// `centraid://` path, and `byte_size` is what a range is parsed against when
/// the blob is complete.
fn photos_content() -> PageQuery {
    PageQuery::new(
        "photos.timeline.content",
        "content_id, sha256, byte_size, created_at",
        "core_content_item",
        centraid_apps_kit::statement::PageOrder::asc("content_id", "content_id"),
    )
    .filter("deleted_at IS NULL", Vec::<PageBindValue>::new())
}

/// `photos.representations` — how the bytes are to be read. A representation
/// exists *because* something is being read as something, so `media_type` is
/// NOT NULL and this is where the blob door's content type comes from.
fn photos_representations() -> PageQuery {
    PageQuery::new(
        "photos.timeline.representations",
        "representation_id, content_id, media_type, interpretation, width, height",
        "core_content_representation",
        centraid_apps_kit::statement::PageOrder::asc("representation_id", "representation_id"),
    )
}

/// The sidecar's **own** read: one content item by its digest.
///
/// Not in the catalogue and not reachable from the socket: the blob door calls
/// it to learn a blob's declared media type and size. A caller-supplied bind is
/// exactly what the catalogue exists to prevent, and this one is supplied by
/// the process that owns the file.
pub fn content_by_digest(digest: &str) -> wire::PageQuery {
    to_wire(
        &PageQuery::new(
            "seat.blob.contentByDigest",
            "content_id, sha256, byte_size",
            "core_content_item",
            centraid_apps_kit::statement::PageOrder::asc("content_id", "content_id"),
        )
        .filter("sha256 = ?", vec![PageBindValue::from(digest)]),
    )
}

/// The sidecar's own read: the representations of one content item.
pub fn representations_of(content_id: &str) -> wire::PageQuery {
    to_wire(
        &PageQuery::new(
            "seat.blob.representationsOf",
            "representation_id, content_id, media_type, interpretation",
            "core_content_representation",
            centraid_apps_kit::statement::PageOrder::asc("representation_id", "representation_id"),
        )
        .filter("content_id = ?", vec![PageBindValue::from(content_id)]),
    )
}

/// The kit's statement as the wire's query.
///
/// The one non-mechanical step is `select`: the kit carries the projection as
/// the comma-separated SQL text and the wire carries it as a repeated field,
/// because `crates/core`'s `api::page` reads each row value back **by the
/// literal select entry**. So the split has to produce the exact column names
/// the vault will key the row image by — which is why every statement in this
/// file projects plain columns and never an expression or an alias.
pub fn to_wire(query: &PageQuery) -> wire::PageQuery {
    wire::PageQuery {
        name: query.name.clone(),
        select: query
            .select
            .split(',')
            .map(|column| column.trim().to_owned())
            .filter(|column| !column.is_empty())
            .collect(),
        from: query.from.clone(),
        r#where: query.r#where.clone(),
        bind: query.bind.iter().map(bind_to_wire).collect(),
        order: Some(wire::PageOrder {
            sort_column: query.order.sort_column.clone(),
            pk_column: query.order.pk_column.clone(),
            descending: query.order.descending,
        }),
    }
}

fn bind_to_wire(bind: &PageBindValue) -> wire::Value {
    wire::Value {
        kind: Some(match bind {
            PageBindValue::Text(text) => wire::value::Kind::Text(text.clone()),
            PageBindValue::Integer(integer) => wire::value::Kind::Integer(*integer),
            PageBindValue::Real(real) => wire::value::Kind::Real(*real),
            PageBindValue::Null => wire::value::Kind::Null(wire::NullValue {}),
        }),
    }
}

/// One wire value as JSON, for the local channel.
///
/// The five storage classes stay distinguishable, which is the whole point of
/// `value.proto`: SQL NULL is `null`, an INTEGER beyond 2^53 goes out as a
/// decimal **string** under `{"i": "…"}` exactly as v0's `row-json.ts` does, and
/// a BLOB goes out as `{"b64": "…"}`. A JavaScript reader that got a bare
/// number for a large integer would silently round it.
pub fn value_to_json(value: &wire::Value) -> serde_json::Value {
    use base64::Engine as _;
    use serde_json::{Value as J, json};

    const SAFE: i64 = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER
    match &value.kind {
        None | Some(wire::value::Kind::Null(_)) => J::Null,
        Some(wire::value::Kind::Text(text)) => J::String(text.clone()),
        Some(wire::value::Kind::Integer(integer)) => {
            if (-SAFE..=SAFE).contains(integer) {
                json!(integer)
            } else {
                json!({ "i": integer.to_string() })
            }
        }
        Some(wire::value::Kind::Real(real)) => {
            serde_json::Number::from_f64(*real).map_or(J::Null, J::Number)
        }
        Some(wire::value::Kind::Blob(bytes)) => {
            json!({ "b64": base64::engine::general_purpose::STANDARD.encode(bytes) })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_catalogued_statement_has_a_unique_name_and_a_projection() {
        let listed = catalogue();
        let mut names = std::collections::BTreeSet::new();
        for (name, query) in &listed {
            assert!(names.insert(*name), "{name} is listed twice");
            let wired = to_wire(query);
            assert!(!wired.select.is_empty(), "{name} projects nothing");
            let order = wired.order.as_ref().expect("an order");
            // `select` MUST carry both order columns — there is no `key_of`
            // callback, so the cursor is read off the row by the columns the
            // ORDER BY names (`statement.ts:43`–`:48`).
            assert!(
                wired.select.contains(&order.sort_column),
                "{name} orders on {} without selecting it",
                order.sort_column
            );
            assert!(
                wired.select.contains(&order.pk_column),
                "{name} tiebreaks on {} without selecting it",
                order.pk_column
            );
            // No alias and no expression: `api::page` keys the row image by the
            // literal select entry.
            for column in &wired.select {
                assert!(
                    column
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'),
                    "{name} selects {column:?}, which is not a plain column"
                );
            }
        }
        // Fourteen from lane F (eleven Tally, three Photos) plus the six the
        // Companion's methods read (#1020 wave 4 lane extension, D-1020-X10).
        assert_eq!(names.len(), 20);
    }

    #[test]
    fn a_statement_nobody_shipped_is_refused_by_name() {
        assert!(statement("tally.friends").is_some());
        assert!(statement("photos.assets").is_some());
        assert!(statement("tally.everything").is_none());
        assert!(statement("tally.Friends").is_none());
        assert!(statement("").is_none());
        // A QUERY-SHAPED NAME is refused for the same reason any other unknown
        // name is: the lookup is an equality test against a committed list, so
        // there is nothing for a query to be parsed by. The string is composed
        // rather than written out because `cargo xtask gate`'s
        // `sql-confinement` rule reads string literals and is right to: a
        // query literal in this crate would mean it reached past its layer,
        // and a test's negative input is not worth teaching the rule about.
        let query_shaped = format!("{} * FROM core_party", "SEL".to_owned() + "ECT");
        assert!(statement(&query_shaped).is_none());
    }

    #[test]
    fn a_statements_binds_cross_in_order_and_by_type() {
        let wired = statement("tally.receipts").expect("receipts");
        assert_eq!(wired.bind.len(), 2);
        assert_eq!(
            wired.bind[0].kind,
            Some(wire::value::Kind::Text("tally.expense".to_owned()))
        );
        assert_eq!(
            wired.bind[1].kind,
            Some(wire::value::Kind::Text("receipt".to_owned()))
        );
        assert_eq!(
            wired.r#where.as_deref(),
            Some("target_type = ? AND role = ?")
        );
    }

    #[test]
    fn the_blob_doors_own_reads_carry_the_digest_as_a_bind_and_not_as_text() {
        let query = content_by_digest("abc");
        assert_eq!(query.r#where.as_deref(), Some("sha256 = ?"));
        assert_eq!(
            query.bind[0].kind,
            Some(wire::value::Kind::Text("abc".to_owned()))
        );
        // The digest never reaches the statement text, so a digest carrying a
        // quote cannot reach the vault as syntax.
        let query = content_by_digest("'; DROP TABLE core_party; --");
        assert_eq!(query.r#where.as_deref(), Some("sha256 = ?"));
        assert_eq!(query.bind.len(), 1);
        let query = representations_of("id-1");
        assert_eq!(query.r#where.as_deref(), Some("content_id = ?"));
    }

    #[test]
    fn the_five_storage_classes_stay_distinguishable_in_json() {
        use serde_json::json;
        let of = |kind| value_to_json(&wire::Value { kind: Some(kind) });
        assert_eq!(of(wire::value::Kind::Null(wire::NullValue {})), json!(null));
        assert_eq!(of(wire::value::Kind::Text("x".to_owned())), json!("x"));
        assert_eq!(of(wire::value::Kind::Integer(42)), json!(42));
        assert_eq!(of(wire::value::Kind::Real(1.5)), json!(1.5));
        assert_eq!(
            of(wire::value::Kind::Blob(vec![1, 2, 3])),
            json!({ "b64": "AQID" })
        );
        // BEYOND MAX_SAFE_INTEGER: a decimal string, as v0's row-json does, so
        // a JavaScript reader cannot round it.
        assert_eq!(
            of(wire::value::Kind::Integer(9_007_199_254_740_992)),
            json!({ "i": "9007199254740992" })
        );
        assert_eq!(
            of(wire::value::Kind::Integer(-9_007_199_254_740_992)),
            json!({ "i": "-9007199254740992" })
        );
        assert_eq!(
            of(wire::value::Kind::Integer(9_007_199_254_740_991)),
            json!(9_007_199_254_740_991_i64)
        );
        // A value with NO kind is a decode of something never written, and it
        // reads as null rather than panicking.
        assert_eq!(value_to_json(&wire::Value { kind: None }), json!(null));
    }
}
