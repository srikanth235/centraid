//! The six `phone.*` commands — the write surface of the phone link (#1127).
//!
//! People, Agenda and Docs follow what the phone holds (R-1127-1: one way, phone → vault). A
//! followed person, event or document is an ordinary row; `phone_link`, rung two, is the one
//! place that says which phone record it came from. The shell's sync engine is the only caller,
//! and it decides everything: this module stores what it is told and refuses what the schema or
//! the rulings forbid.
//!
//! ## What each command is for
//!
//! - `phone.origin` — an account, calendar or picked folder was seen on the phone. Registers it,
//!   or refreshes its label, and returns the `origin_id` a link names (R-1127-9). The label is
//!   written only here and only while the origin is present, so it survives the origin leaving
//!   the phone: the question "Keep its 214 events?" is asked after that.
//! - `phone.retire_origin` — an origin no link names any more is dropped. Refused while any link
//!   (attached or detached) still names it: a detached link is the tombstone that keeps a phone
//!   record the member took over from arriving a second time.
//! - `phone.link` — a record arrived or a followed record was seen again. Inserts the link, or
//!   refreshes the one for `(source, phone_id)` with the origin it came from and the fingerprint
//!   of what sync just wrote.
//! - `phone.touch` — a followed record was seen again and nothing changed. A batch, because an
//!   unchanged pass over a few thousand contacts through `phone.link` would be a few thousand
//!   commits and a few thousand receipts to say "still there".
//! - `phone.detach` — the member edited the row (the engine saw the vault row stop matching the
//!   fingerprint, R-1127-2), so it stops following. Sets `detached_at` once.
//! - `phone.forget` — the link has done its job: the phone record is gone and the row went to
//!   trash (R-1127-3), or the member stopped following the source. Deletes the link row, and
//!   nothing else: the engine trashes the row itself, so forgetting is the same command whether
//!   the row is kept, trashed or already purged (a purge deletes the link with it).
//!
//! ## What a refusal looks like
//!
//! A value, never a panic: a precondition's sentence and its stable predicate name come back
//! as a `Failed` outcome, and nothing is written. The predicates a shell switches on are
//! `link_entity_is_live_and_of_the_sources_kind`, `link_is_attached`,
//! `link_entity_is_followed_once`, `link_origin_is_of_the_source`, `link_exists` and
//! `origin_has_no_links`.
//!
//! ## Three rules, each a bug if dropped
//!
//! 1. **A detached link is never re-attached.** `phone.link` on a detached link is refused
//!    rather than quietly ignored: the engine would otherwise write the phone's version over
//!    the member's edit (R-1127-2). The schema backs it (`phone_link_detach_is_one_way`).
//! 2. **A link points at a live row of the kind its source implies**: contacts → party,
//!    calendar → event, files → document, and not in the trash. The schema holds the kind
//!    (`phone_link_kind_matches_source`); liveness is the command's, because a trashed row may
//!    keep its link (R-1127-3) but a fresh link to one is a mistake.
//! 3. **One vault row, one link.** A row already followed from another phone record is refused,
//!    not stolen.

use rusqlite::OptionalExtension;

use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};

/// The sources a link may name, and the statement that says whether the row each one becomes is
/// LIVE: present, and not in the trash. `?1` is the entity id.
///
/// An ALLOW-LIST, not a lookup: the table name goes into SQL, so it comes from here and never
/// from an input. The same three words are the table's own `CHECK`.
///
/// **A person is trashed on its PROFILE, not on `core_party`** (`people.trash_person` stamps
/// `people_profile.deleted_at`; `core_party.deleted_at` is not what People writes), so the
/// contacts statement looks there. A party with no profile is live: a followed contact has one
/// once People has added it, and a party the engine adopted before that is still a person.
const SOURCES: &[(&str, &str)] = &[
    (
        "contacts",
        "SELECT COUNT(*) FROM core_party p
          WHERE p.party_id = ?1 AND p.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM people_profile f
                             WHERE f.party_id = p.party_id AND f.deleted_at IS NOT NULL)",
    ),
    (
        "calendar",
        "SELECT COUNT(*) FROM core_event WHERE event_id = ?1 AND deleted_at IS NULL",
    ),
    (
        "files",
        "SELECT COUNT(*) FROM core_document WHERE document_id = ?1 AND deleted_at IS NULL",
    ),
];

/// The most phone ids one `phone.touch` may name; the schema's `maxItems`. A contact book of
/// this size is far beyond any phone's, and a bound is how an unbounded statement is refused.
pub const TOUCH_IDS_MAX: usize = 20_000;

/// The six, in the order a pass uses them.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        origin(),
        link(),
        touch(),
        detach(),
        forget(),
        retire_origin(),
    ]
}

fn definition(
    name: &'static str,
    input_schema: &'static str,
    idempotency: Idempotency,
    preconditions: &'static [CommandCondition],
    handler: crate::commands::CommandHandler,
) -> CommandDefinition {
    CommandDefinition {
        name,
        owner_schema: "phone",
        input_schema,
        idempotency,
        risk: Risk::Low,
        confirm: false,
        preconditions,
        postconditions: &[],
        handler,
        sealed_input: &[],
    }
}

fn invalid(name: &str, detail: impl Into<String>) -> VaultError {
    VaultError::InvalidInput {
        name: name.to_owned(),
        detail: detail.into(),
    }
}

fn live_statement(source: &str) -> Option<&'static str> {
    SOURCES
        .iter()
        .find(|(name, _)| *name == source)
        .map(|(_, statement)| *statement)
}

fn str_of<'a>(ctx: &'a CommandCtx<'_, '_>, key: &str) -> Option<&'a str> {
    ctx.input.get(key).and_then(serde_json::Value::as_str)
}

/// The link a `(source, phone_id)` pair holds, with whether it is detached and the row it follows.
fn link_of(
    ctx: &CommandCtx<'_, '_>,
    source: &str,
    phone_id: &str,
) -> Result<Option<(String, String, bool)>> {
    Ok(ctx
        .connection()
        .query_row(
            "SELECT link_id, entity_id, detached_at IS NOT NULL
               FROM phone_link WHERE source = ?1 AND phone_id = ?2",
            [source, phone_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?)
}

// ---------------------------------------------------------------------------
// phone.origin
// ---------------------------------------------------------------------------

fn origin() -> CommandDefinition {
    definition(
        "phone.origin",
        r#"{
          "type": "object",
          "required": ["source", "phone_origin", "label"],
          "additionalProperties": false,
          "properties": {
            "source": { "enum": ["contacts", "calendar", "files"] },
            "phone_origin": { "type": "string", "minLength": 1, "maxLength": 512, "pattern": "\\S" },
            "label": { "type": "string", "minLength": 1, "maxLength": 200, "pattern": "\\S" }
          }
        }"#,
        // The same input lands the same state: a known origin with this label is not written
        // again, so `row_version` stands still.
        Idempotency::Idempotent,
        &[],
        |ctx| {
            let source = ctx.required_str("source")?.to_owned();
            let phone_origin = ctx.required_str("phone_origin")?.to_owned();
            let label = ctx.required_str("label")?.trim().to_owned();
            let known = ctx
                .connection()
                .query_row(
                    "SELECT origin_id FROM phone_origin WHERE source = ?1 AND phone_origin = ?2",
                    [&source, &phone_origin],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if let Some(origin_id) = known {
                let changed = ctx.connection().execute(
                    "UPDATE phone_origin SET label = ?2 WHERE origin_id = ?1 AND label IS NOT ?2",
                    rusqlite::params![origin_id, label],
                )? > 0;
                return Ok(serde_json::json!({
                    "origin_id": origin_id, "created": false, "changed": changed,
                }));
            }
            let origin_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO phone_origin (origin_id, source, phone_origin, label, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![origin_id, source, phone_origin, label, ctx.now],
            )?;
            Ok(serde_json::json!({ "origin_id": origin_id, "created": true, "changed": true }))
        },
    )
}

// ---------------------------------------------------------------------------
// phone.retire_origin
// ---------------------------------------------------------------------------

fn retire_origin() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "origin_has_no_links",
        check: |ctx| {
            let Some(origin_id) = str_of(ctx, "origin_id") else {
                return Ok(None);
            };
            let named: i64 = ctx.connection().query_row(
                "SELECT COUNT(*) FROM phone_link WHERE origin_id = ?1",
                [origin_id],
                |row| row.get(0),
            )?;
            Ok((named != 0).then(|| {
                "Records from that account, calendar or folder still follow, or once followed, \
                 the phone, so it is kept."
                    .to_owned()
            }))
        },
    }];
    definition(
        "phone.retire_origin",
        r#"{
          "type": "object",
          "required": ["origin_id"],
          "additionalProperties": false,
          "properties": { "origin_id": { "type": "string", "minLength": 1 } }
        }"#,
        Idempotency::Idempotent,
        PRE,
        |ctx| {
            // Retiring what is not there is the same end state as retiring it.
            let retired = ctx.connection().execute(
                "DELETE FROM phone_origin WHERE origin_id = ?1",
                [ctx.required_str("origin_id")?],
            )? > 0;
            Ok(serde_json::json!({ "retired": retired }))
        },
    )
}

// ---------------------------------------------------------------------------
// phone.link
// ---------------------------------------------------------------------------

fn link() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "link_entity_is_live_and_of_the_sources_kind",
            check: |ctx| {
                let (Some(source), Some(entity)) =
                    (str_of(ctx, "source"), str_of(ctx, "entity_id"))
                else {
                    return Ok(None);
                };
                let Some(statement) = live_statement(source) else {
                    return Ok(None);
                };
                let live: i64 = ctx
                    .connection()
                    .query_row(statement, [entity], |row| row.get(0))?;
                Ok((live != 1).then(|| {
                    "That row is not in the vault, or it is in the trash, so it cannot follow \
                     the phone."
                        .to_owned()
                }))
            },
        },
        CommandCondition {
            predicate: "link_origin_is_of_the_source",
            check: |ctx| {
                let (Some(source), Some(origin)) =
                    (str_of(ctx, "source"), str_of(ctx, "origin_id"))
                else {
                    return Ok(None);
                };
                let found: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM phone_origin WHERE origin_id = ?1 AND source = ?2",
                    [origin, source],
                    |row| row.get(0),
                )?;
                Ok((found != 1).then(|| {
                    "That account, calendar or folder is not known for this source.".to_owned()
                }))
            },
        },
        CommandCondition {
            predicate: "link_is_attached",
            check: |ctx| {
                let (Some(source), Some(phone_id)) =
                    (str_of(ctx, "source"), str_of(ctx, "phone_id"))
                else {
                    return Ok(None);
                };
                Ok(link_of(ctx, source, phone_id)?
                    .is_some_and(|(_, _, detached)| detached)
                    .then(|| {
                        "That record stopped following the phone when it was edited here, and \
                         it does not start again."
                            .to_owned()
                    }))
            },
        },
        CommandCondition {
            predicate: "link_entity_is_followed_once",
            check: |ctx| {
                let (Some(source), Some(phone_id), Some(entity)) = (
                    str_of(ctx, "source"),
                    str_of(ctx, "phone_id"),
                    str_of(ctx, "entity_id"),
                ) else {
                    return Ok(None);
                };
                // The row may be followed from THIS phone record and no other.
                let elsewhere: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM phone_link
                      WHERE entity_id = ?1 AND NOT (source = ?2 AND phone_id = ?3)",
                    [entity, source, phone_id],
                    |row| row.get(0),
                )?;
                Ok((elsewhere != 0)
                    .then(|| "That row already follows a different phone record.".to_owned()))
            },
        },
    ];
    definition(
        "phone.link",
        r#"{
          "type": "object",
          "required": ["source", "phone_id", "origin_id", "entity_id", "fingerprint"],
          "additionalProperties": false,
          "properties": {
            "source": { "enum": ["contacts", "calendar", "files"] },
            "phone_id": { "type": "string", "minLength": 1, "maxLength": 512, "pattern": "\\S" },
            "origin_id": { "type": "string", "minLength": 1 },
            "entity_id": { "type": "string", "minLength": 1 },
            "fingerprint": { "type": "string", "minLength": 1, "maxLength": 512 }
          }
        }"#,
        // The same input lands the same state: a link that already holds this fingerprint, row
        // and sighting is not written again, so `row_version` stands still.
        Idempotency::Idempotent,
        PRE,
        |ctx| {
            let source = ctx.required_str("source")?.to_owned();
            let phone_id = ctx.required_str("phone_id")?.to_owned();
            let origin_id = ctx.required_str("origin_id")?.to_owned();
            let entity_id = ctx.required_str("entity_id")?.to_owned();
            let fingerprint = ctx.required_str("fingerprint")?.to_owned();
            if let Some((link_id, _, _)) = link_of(ctx, &source, &phone_id)? {
                // Re-point and refresh. `detached_at` is not touched: a detached link was
                // refused above, so this one is attached and stays so. A record that moved to
                // another account or calendar on the phone changes its origin here.
                let changed = ctx.connection().execute(
                    "UPDATE phone_link
                        SET entity_id = ?2, fingerprint = ?3, last_seen_at = ?4, origin_id = ?5
                      WHERE link_id = ?1
                        AND (entity_id IS NOT ?2 OR fingerprint IS NOT ?3
                             OR last_seen_at IS NOT ?4 OR origin_id IS NOT ?5)",
                    rusqlite::params![link_id, entity_id, fingerprint, ctx.now, origin_id],
                )? > 0;
                return Ok(serde_json::json!({
                    "link_id": link_id, "created": false, "changed": changed,
                }));
            }
            let link_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO phone_link
                   (link_id, source, phone_id, origin_id, entity_id, fingerprint, last_seen_at,
                    created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                rusqlite::params![
                    link_id,
                    source,
                    phone_id,
                    origin_id,
                    entity_id,
                    fingerprint,
                    ctx.now
                ],
            )?;
            Ok(serde_json::json!({ "link_id": link_id, "created": true, "changed": true }))
        },
    )
}

// ---------------------------------------------------------------------------
// phone.touch
// ---------------------------------------------------------------------------

fn touch() -> CommandDefinition {
    definition(
        "phone.touch",
        r#"{
          "type": "object",
          "required": ["source", "phone_ids"],
          "additionalProperties": false,
          "properties": {
            "source": { "enum": ["contacts", "calendar", "files"] },
            "phone_ids": {
              "type": "array",
              "maxItems": 20000,
              "items": { "type": "string", "minLength": 1, "maxLength": 512 }
            }
          }
        }"#,
        Idempotency::Idempotent,
        &[],
        |ctx| {
            let source = ctx.required_str("source")?.to_owned();
            let ids = ctx
                .input
                .get("phone_ids")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| invalid("phone_ids", "a list of phone ids is required"))?;
            if ids.len() > TOUCH_IDS_MAX {
                return Err(invalid("phone_ids", "too many phone ids for one touch"));
            }
            let mut touched = 0_i64;
            let mut statement = ctx.connection().prepare(
                "UPDATE phone_link SET last_seen_at = ?3
                  WHERE source = ?1 AND phone_id = ?2 AND last_seen_at IS NOT ?3",
            )?;
            for id in ids {
                let id = id
                    .as_str()
                    .ok_or_else(|| invalid("phone_ids", "a phone id is a string"))?;
                touched +=
                    i64::try_from(statement.execute(rusqlite::params![source, id, ctx.now])?)
                        .unwrap_or(0);
            }
            // An id with no link is not an error: the engine touches what it saw, and a
            // record it saw and did not follow (a refused one) has nothing to touch.
            Ok(serde_json::json!({ "touched": touched }))
        },
    )
}

// ---------------------------------------------------------------------------
// phone.detach
// ---------------------------------------------------------------------------

fn detach() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "link_exists",
        check: |ctx| {
            let Some(link_id) = str_of(ctx, "link_id") else {
                return Ok(None);
            };
            let found: i64 = ctx.connection().query_row(
                "SELECT COUNT(*) FROM phone_link WHERE link_id = ?1",
                [link_id],
                |row| row.get(0),
            )?;
            Ok((found != 1).then(|| "There is no such phone link.".to_owned()))
        },
    }];
    definition(
        "phone.detach",
        r#"{
          "type": "object",
          "required": ["link_id"],
          "additionalProperties": false,
          "properties": { "link_id": { "type": "string", "minLength": 1 } }
        }"#,
        Idempotency::Idempotent,
        PRE,
        |ctx| {
            // `detached_at` is set ONCE: a second detach keeps the first one's time, which is
            // also what the schema allows.
            let detached = ctx.connection().execute(
                "UPDATE phone_link SET detached_at = ?2
                  WHERE link_id = ?1 AND detached_at IS NULL",
                rusqlite::params![ctx.required_str("link_id")?, ctx.now],
            )? > 0;
            Ok(serde_json::json!({ "detached": detached }))
        },
    )
}

// ---------------------------------------------------------------------------
// phone.forget
// ---------------------------------------------------------------------------

fn forget() -> CommandDefinition {
    definition(
        "phone.forget",
        r#"{
          "type": "object",
          "required": ["link_id"],
          "additionalProperties": false,
          "properties": { "link_id": { "type": "string", "minLength": 1 } }
        }"#,
        Idempotency::Idempotent,
        &[],
        |ctx| {
            // Forgetting what is not there is the same end state as forgetting it. The row the
            // link followed is not touched: a purge has already taken the link with it, and the
            // engine trashes a row itself.
            let forgotten = ctx.connection().execute(
                "DELETE FROM phone_link WHERE link_id = ?1",
                [ctx.required_str("link_id")?],
            )? > 0;
            Ok(serde_json::json!({ "forgotten": forgotten }))
        },
    )
}
