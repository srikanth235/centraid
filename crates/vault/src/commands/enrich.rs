//! **ONE COMMAND ONLY: `enrich.request_enrichment`.**
//!
//! The `enrich` schema is the automations lane's for wave 4 slot 4b — nine
//! commands, eight of them `retry-safe`, and every one of them a writer of the
//! recognition plane. This file holds exactly the one an APP invokes, because
//! `request-enrichment` is the only action in any of the eight apps that writes
//! to `enrich` (census §A2) and Photos' lane could not land its action table
//! without it. **Adding a second definition here belongs to the automations
//! lane**, in `crates/vault/src/commands/enrich.rs` — this file — so the two
//! halves meet in one place rather than in two files under one schema.
//!
//! ## `enrich_request` is a PRIORITY HINT, never a gate
//!
//! `docs/recognition-automations.md:37`: a recipe with an empty queue still
//! walks the library behind its cursor. A port that treated the queue as the
//! work list would stop recognition for every vault that had never pressed the
//! button. So this command writes one row and moves nothing else; the walk is
//! the automations lane's, and `a_hint_is_a_row_and_nothing_else` is the test.
//!
//! ## The capability is the CONSENT SCOPE and `manual` requires it
//!
//! Before `enrich_request` carried a capability, the owner's on-demand ask was
//! untagged, so one face-detection consent handed the same queue row to every
//! enabled enricher and each read the member's "detect faces" as its own
//! permission. The column's own CHECK enforces the vocabulary; refusing here
//! buys the caller a sentence instead of a constraint name.
//!
//! ## What this command deliberately does NOT do, and who owns it
//!
//! v0's handler also RE-KEYS A CONSENT ANSWER (#807): a `manual` request is the
//! member's answer to a consent moment, so v0 records `capability × on-device`
//! as granted in the consent plane and stamps `share.authority`
//! (`packages/vault/src/commands/enrich.ts:489-506`). That plane has no Rust
//! home yet and it is the automations lane's, not this one's: writing half of
//! it — a consent row with no reader — would be worse than writing none.
//! Named as a coordination point for slot 4b in the Photos lane's receipt, and
//! the manifest's `writes` for `request-enrichment` still declares
//! `share.authority`, which is how the gap stays visible.

use rusqlite::OptionalExtension;

use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::VaultError;

/// The reasons an owner-facing caller may give. `projected` is minted by the
/// vault itself during share ingest and is deliberately absent here.
const CALLER_REASONS: &[&str] = &["search-miss", "on-view", "manual"];

/// Every `enrich.*` command this build carries: nine, eight of them
/// `retry-safe`, and `record_consent` the one that asks.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    all_definitions()
}

fn request_enrichment() -> CommandDefinition {
    CommandDefinition {
        name: "enrich.request_enrichment",
        owner_schema: "enrich",
        input_schema: r#"{
          "type": "object",
          "required": ["entity_type", "reason"],
          "additionalProperties": false,
          "properties": {
            "entity_type": { "type": "string", "minLength": 1 },
            "entity_id": { "type": "string", "minLength": 1 },
            "reason": { "type": "string", "enum": ["search-miss", "on-view", "manual"] },
            "detail": { "type": "string" },
            "capability": { "type": "string", "minLength": 1, "maxLength": 64 }
          }
        }"#,
        // RETRY-SAFE: a hint written twice is one queue that moved sooner
        // twice, which is the same queue.
        idempotency: Idempotency::RetrySafe,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "manual_names_its_capability",
            check: |ctx| {
                if ctx.required_str("reason")? != "manual" {
                    return Ok(None);
                }
                Ok(ctx.optional_str("capability").is_none().then(|| {
                    "an owner's \"do this now\" must name the capability it is asking for — an \
                     untagged ask would read as consent for every enricher, not the one the \
                     member chose"
                        .to_owned()
                }))
            },
        }],
        postconditions: &[CommandCondition {
            predicate: "request_recorded",
            check: |ctx| {
                let request_id = ctx
                    .produced_ids
                    .borrow()
                    .first()
                    .cloned()
                    .unwrap_or_default();
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM enrich_request WHERE request_id = ?1",
                    [&request_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the request was not recorded".to_owned()))
            },
        }],
        handler: |ctx| {
            let entity_type = ctx.required_str("entity_type")?.to_owned();
            let reason = ctx.required_str("reason")?.to_owned();
            if !CALLER_REASONS.contains(&reason.as_str()) {
                return Err(VaultError::InvalidInput {
                    name: "reason".to_owned(),
                    detail: format!("`{reason}` is not a reason a caller may give"),
                });
            }
            let request_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO enrich_request
                   (request_id, target_type, target_id, reason, detail, capability,
                    requested_at, drained_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
                rusqlite::params![
                    request_id,
                    entity_type,
                    ctx.optional_str("entity_id"),
                    reason,
                    ctx.optional_str("detail"),
                    ctx.optional_str("capability"),
                    ctx.now
                ],
            )?;
            Ok(serde_json::json!({ "request_id": request_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schema_is_nine_commands_eight_retry_safe_and_one_that_asks() {
        let definitions = definitions();
        assert_eq!(definitions.len(), 9);
        for definition in &definitions {
            assert_eq!(definition.owner_schema, "enrich");
            assert!(
                definition.name.starts_with("enrich."),
                "{}",
                definition.name
            );
            serde_json::from_str::<serde_json::Value>(definition.input_schema)
                .unwrap_or_else(|error| panic!("{}: {error}", definition.name));
        }
        let retry_safe = definitions
            .iter()
            .filter(|definition| definition.idempotency == Idempotency::RetrySafe)
            .count();
        assert_eq!(retry_safe, 8);
        // The ONE that asks, and it is the one a MEMBER performs rather than a
        // recipe: an answer about where their data may travel.
        let asking: Vec<&str> = definitions
            .iter()
            .filter(|definition| definition.confirm)
            .map(|definition| definition.name)
            .collect();
        assert_eq!(asking, ["enrich.record_consent"]);
        let consent = definitions
            .iter()
            .find(|definition| definition.name == "enrich.record_consent")
            .expect("present");
        assert_eq!(consent.idempotency, Idempotency::Idempotent);
        assert_eq!(consent.risk, Risk::High);
        // NOTHING HERE IS ONLINE-ONLY: every one of these is local work over
        // the member's own bytes, and a seat that refused to queue them
        // offline would stop recognition on a train.
        assert!(definitions.iter().all(|definition| !definition.online_only));
        // And none of them takes a secret.
        assert!(
            definitions
                .iter()
                .all(|definition| definition.sealed_input.is_empty())
        );
    }

    #[test]
    fn the_one_an_app_invokes_is_named_under_its_owner_schema() {
        let definitions = definitions();
        let request = &definitions[0];
        assert_eq!(request.name, "enrich.request_enrichment");
        assert_eq!(request.idempotency, Idempotency::RetrySafe);
        assert!(!request.confirm, "a priority hint is not a consent moment");
    }

    /// The caller's vocabulary is three reasons. `projected` is the vault's own
    /// and always carries a NULL capability, so a caller that could send it
    /// would be minting a row the device lane must not lease.
    #[test]
    fn projected_is_not_a_reason_a_caller_may_give() {
        let schema: serde_json::Value =
            serde_json::from_str(definitions()[0].input_schema).expect("JSON");
        let reasons = schema["properties"]["reason"]["enum"]
            .as_array()
            .expect("an enum");
        assert_eq!(reasons.len(), 3);
        assert!(!reasons.iter().any(|value| value == "projected"));
        assert_eq!(CALLER_REASONS.len(), 3);
    }

    /// THE VECTOR FORMAT. Little-endian `f32`, and a round trip that a v0
    /// reader would agree with byte for byte.
    #[test]
    fn a_vector_is_little_endian_f32_and_round_trips() {
        let encoded = encode_vector(&[1.0, -0.5, 0.0]);
        assert_eq!(encoded.len(), 12);
        assert_eq!(&encoded[..4], &1.0f32.to_le_bytes());
        assert_eq!(&encoded[4..8], &(-0.5f32).to_le_bytes());
        assert_eq!(decode_vector(&encoded), vec![1.0, -0.5, 0.0]);
        // A blob a foreign build wrote at another width is unreadable, not
        // fatal: the trailing bytes are floored off, exactly as v0 floors them.
        assert_eq!(decode_vector(&[0, 0, 0, 0, 7]).len(), 1);
        assert!(decode_vector(&[]).is_empty());
    }

    /// A NaN in an embedding is the worst of the three answers: it compares
    /// false with everything including itself.
    #[test]
    fn a_non_finite_value_is_refused_before_anything_is_written() {
        let input = serde_json::json!({ "vector": [1.0, f64::NAN] });
        // `serde_json` cannot hold a NaN, so the shape a caller can actually
        // send is a string or a null in the array.
        assert!(finite_vector(&input, "vector").is_err());
        for bad in [
            serde_json::json!({ "vector": [] }),
            serde_json::json!({ "vector": ["1.0"] }),
            serde_json::json!({ "vector": [null] }),
            serde_json::json!({ "vector": 3 }),
            serde_json::json!({}),
        ] {
            assert!(finite_vector(&bad, "vector").is_err(), "{bad}");
        }
        assert_eq!(
            finite_vector(&serde_json::json!({ "vector": [1, 2] }), "vector")
                .expect("integers are numbers"),
            vec![1.0, 2.0]
        );
    }

    #[test]
    fn every_bundled_recipe_that_can_be_regenerated_is_named() {
        assert_eq!(CAPABILITY_RECIPES.len(), 5);
        for (capability, automation_ref, keys) in CAPABILITY_RECIPES {
            assert!(recipe_for(capability).is_some(), "{capability}");
            assert!(automation_ref.contains('/'), "{automation_ref}");
            assert!(keys.contains(&"cursor"), "{capability}");
        }
        // `faces` keeps TWO cursors: the ambient walk and the prior-stamp
        // sweep. Resetting one without the other would make the sweep walk a
        // range whose stamps were just deleted.
        assert_eq!(
            recipe_for("faces").expect("present").1,
            ["cursor", "consentCursor"]
        );
        // `place-names` cannot be regenerated in bulk: it derives from a
        // coordinate rather than from a model, so there is no walk to reset.
        assert!(recipe_for("place-names").is_none());
        assert!(recipe_for("nonsense").is_none());
    }

    /// The face-grouping thresholds, and the prohibition that keeps them
    /// meaningful.
    #[test]
    fn the_face_thresholds_are_stricter_for_a_stranger_than_for_a_confirmation() {
        assert!(faces::CLUSTER_MAX_DISTANCE < faces::PARTY_MAX_DISTANCE);
        assert_eq!(faces::MIN_CLUSTER_SIZE, 2);
    }

    #[test]
    fn faces_of_different_widths_are_never_compared() {
        let rows = [
            FaceRow {
                region_id: "r1".to_owned(),
                party_id: None,
                confirmed: false,
                model: "arcface@1".to_owned(),
                vector: vec![1.0, 0.0, 0.0, 0.0],
            },
            FaceRow {
                region_id: "r2".to_owned(),
                party_id: None,
                confirmed: false,
                // A DIFFERENT MODEL: never in the same comparison, whatever the
                // vectors say.
                model: "sface@1".to_owned(),
                vector: vec![1.0, 0.0, 0.0, 0.0],
            },
        ];
        let outcome = faces::regroup(&rows);
        assert!(
            outcome.clusters.is_empty(),
            "two identical vectors under two models are two strangers"
        );
        assert!(outcome.offers.is_empty());
    }

    #[test]
    fn identical_faces_under_one_model_cluster_under_the_lowest_id() {
        let rows = [
            FaceRow {
                region_id: "r2".to_owned(),
                party_id: None,
                confirmed: false,
                model: "arcface@1".to_owned(),
                vector: vec![1.0, 0.0, 0.0, 0.0],
            },
            FaceRow {
                region_id: "r1".to_owned(),
                party_id: None,
                confirmed: false,
                model: "arcface@1".to_owned(),
                vector: vec![0.99, 0.01, 0.0, 0.0],
            },
        ];
        let outcome = faces::regroup(&rows);
        assert_eq!(
            outcome.clusters,
            [
                ("r1".to_owned(), "r1".to_owned()),
                ("r2".to_owned(), "r1".to_owned())
            ],
            "the lowest id is the identity, so an unchanged group never renames"
        );
    }

    /// A lone stranger is NOT a cluster: they are named from their own
    /// photograph.
    #[test]
    fn a_singleton_is_not_a_stranger_group() {
        let rows = [FaceRow {
            region_id: "r1".to_owned(),
            party_id: None,
            confirmed: false,
            model: "arcface@1".to_owned(),
            vector: vec![1.0, 0.0],
        }];
        assert!(faces::regroup(&rows).clusters.is_empty());
    }

    /// A confirmed party's centroid offers a candidate — and only when exactly
    /// one party is near.
    #[test]
    fn exactly_one_nearby_party_is_offered_and_ambiguity_stays_unnamed() {
        let near = |id: &str, party: Option<&str>, confirmed: bool, vector: Vec<f32>| FaceRow {
            region_id: id.to_owned(),
            party_id: party.map(str::to_owned),
            confirmed,
            model: "arcface@1".to_owned(),
            vector,
        };
        let one = [
            near("r1", Some("party-a"), true, vec![1.0, 0.0]),
            near("r2", None, false, vec![1.0, 0.01]),
        ];
        assert_eq!(
            faces::regroup(&one).offers,
            [("r2".to_owned(), "party-a".to_owned())]
        );
        // TWO parties equally near: unnamed, because a guess is something a
        // member has to undo.
        let two = [
            near("r1", Some("party-a"), true, vec![1.0, 0.0]),
            near("r2", Some("party-b"), true, vec![1.0, 0.0]),
            near("r3", None, false, vec![1.0, 0.0]),
        ];
        let outcome = faces::regroup(&two);
        assert!(outcome.offers.is_empty(), "{:?}", outcome.offers);
        // A zero vector has no direction, and none is invented for it.
        let zero = [
            near("r1", Some("party-a"), true, vec![1.0, 0.0]),
            near("r2", None, false, vec![0.0, 0.0]),
        ];
        assert!(faces::regroup(&zero).offers.is_empty());
        // A region that already carries a candidate is not moved.
        let carried = [
            near("r1", Some("party-a"), true, vec![1.0, 0.0]),
            near("r2", Some("party-z"), false, vec![1.0, 0.0]),
        ];
        assert!(faces::regroup(&carried).offers.is_empty());
    }

    /// NO CHAINING. Three faces in a line, each within the threshold of its
    /// neighbour but the ends far apart, must not become one group.
    #[test]
    fn a_chain_of_near_neighbours_does_not_walk_two_strangers_together() {
        let along = |id: &str, angle: f64| FaceRow {
            region_id: id.to_owned(),
            party_id: None,
            confirmed: false,
            model: "arcface@1".to_owned(),
            #[allow(clippy::cast_possible_truncation)]
            vector: vec![angle.cos() as f32, angle.sin() as f32],
        };
        // Each step is a cosine distance just inside 0.22; the ends are well
        // outside it.
        let step = 0.6;
        let rows = [along("r1", 0.0), along("r2", step), along("r3", 2.0 * step)];
        let outcome = faces::regroup(&rows);
        let groups: std::collections::BTreeSet<&String> =
            outcome.clusters.iter().map(|(_, id)| id).collect();
        assert!(
            groups.len() != 1 || outcome.clusters.len() < 3,
            "centroid linkage must not chain: {:?}",
            outcome.clusters
        );
    }
}

// ===========================================================================
// The other eight `enrich.*` commands (#1020, wave 4 lane automations).
//
// The schema is nine commands: `request_enrichment` above — the one an APP
// invokes — and the eight below, which are the recognition plane's own
// writers. **Eight are `retry-safe` and one asks for confirmation**:
// `record_consent` is `idempotent` + `high` risk + `confirm`, because an
// answer about where a member's data may travel is the one act here a member
// makes rather than a recipe.
//
// ## What each one is for, in one line
//
// | Command | Why it exists |
// |---|---|
// | `record_consent` | the member's answer about an egress class, recorded in the consent plane |
// | `upsert_embedding` | a vector, plus its stamp — the result command for `embed-image` and `embed-text` |
// | `upsert_faces` | a photograph's face regions and their embeddings, in one act |
// | `rebuild_face_clusters` | regroup strangers and offer confirmed parties; stateless and idempotent |
// | `mark_requests_drained` | the priority queue's own bookkeeping |
// | `record_target_failure` | the third answer beside derived and skipped: COUNTED |
// | `regenerate` | do this one target again, at the same model |
// | `regenerate_all` | do the whole library again, at the same model |
//
// ## Two rules that shape the file
//
// **A derivation stamp is what makes a handler skip a target it has already
// done**, so "do this again" is exactly two acts: drop the stamp, and put the
// target back in front of the handler. Nothing here touches the derived VALUE
// — the handler overwrites it when it re-derives, and deleting it early would
// blank a working search index for the length of a backlog walk.
//
// **Producing the value is the proof the poison is gone** (#1014, B2). Every
// stamp clears the target's failure record, so a target that failed twice and
// then succeeded does not stay on the register health reads. That is why
// [`stamp_derivation`] does both and nothing calls the insert alone.
// ===========================================================================

/// The widest vector this build stores. CLIP is 512, ArcFace 512; the ceiling
/// is a bound on one row rather than a claim about any model.
pub const MAX_EMBEDDING_DIM: usize = 4_096;

/// `enrich_derivation.profile`'s default: the identity of the bundled
/// deterministic engines, so a call site that names no profile keeps writing
/// exactly the row it wrote before.
pub const BUILT_IN_PROFILE: &str = "built-in";

/// The subject type every enrichment consent answer is recorded under.
const ENRICH_SUBJECT_TYPE: &str = "enrich.scope";

/// The egress classes a consent answer may be about.
const EGRESS_CLASSES: &[&str] = &["on-device", "gateway", "provider"];

/// Which bundled recipe owns a capability, and the `automation_state` keys its
/// ambient walk keeps.
///
/// `faces` keeps TWO: `cursor` is the ambient library walk and `consentCursor`
/// is the prior-stamp sweep. Both must go back to the start, or the sweep would
/// walk a range whose stamps `regenerate_all` just deleted and find nothing.
const CAPABILITY_RECIPES: &[(&str, &str, &[&str])] = &[
    ("faces", "faces/faces", &["cursor", "consentCursor"]),
    ("ocr", "photo-ocr/photo-ocr", &["cursor"]),
    ("embed-image", "embed-image/embed-image", &["cursor"]),
    ("embed-text", "embed-text/embed-text", &["cursor"]),
    ("transcript", "transcript/transcript", &["cursor"]),
];

/// Every `enrich.*` command, in registration order.
#[must_use]
pub fn all_definitions() -> Vec<CommandDefinition> {
    vec![
        request_enrichment(),
        record_consent(),
        upsert_embedding(),
        mark_requests_drained(),
        record_target_failure(),
        upsert_faces(),
        rebuild_face_clusters(),
        regenerate(),
        regenerate_all(),
    ]
}

/// A vector as it is stored: little-endian `f32`, one per value.
///
/// The FORMAT, not a convenience: `enrich_embedding.vector` is compared by
/// readers in two languages while v0 exists, and a big-endian or `f64` port
/// would silently make every stored vector unreadable rather than loudly
/// failing.
#[must_use]
pub fn encode_vector(values: &[f64]) -> Vec<u8> {
    let mut out = Vec::with_capacity(values.len() * 4);
    for value in values {
        #[allow(clippy::cast_possible_truncation)]
        out.extend_from_slice(&(*value as f32).to_le_bytes());
    }
    out
}

/// The inverse. A blob whose length is not a multiple of four is truncated
/// rather than refused, exactly as v0's `decodeVector` floors it: a foreign
/// build's row is unreadable, not fatal.
#[must_use]
pub fn decode_vector(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

/// Stamp one derivation, and clear the target's failure record.
///
/// Re-running the SAME profile REPLACES its stamp: the row always names the
/// model whose output is on disk now. Another profile is another row (#807).
fn stamp_derivation(
    ctx: &CommandCtx<'_, '_>,
    target_type: &str,
    target_id: &str,
    variant: &str,
    capability: &str,
    model: &str,
    payload: Option<&serde_json::Value>,
) -> crate::error::Result<()> {
    ctx.connection().execute(
        "INSERT INTO enrich_derivation
           (derivation_id, target_type, target_id, variant, capability, profile,
            model, payload_json, produced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (target_type, target_id, variant, profile) DO UPDATE SET
           capability = excluded.capability,
           model = excluded.model,
           payload_json = excluded.payload_json,
           produced_at = excluded.produced_at",
        rusqlite::params![
            ctx.next_id(),
            target_type,
            target_id,
            variant,
            capability,
            BUILT_IN_PROFILE,
            model,
            payload.map(ToString::to_string),
            ctx.now,
        ],
    )?;
    // PRODUCING THE VALUE IS THE PROOF THE POISON IS GONE.
    ctx.connection().execute(
        "DELETE FROM enrich_target_failure WHERE capability = ?1 AND target_id = ?2",
        rusqlite::params![capability, target_id],
    )?;
    Ok(())
}

fn record_consent() -> CommandDefinition {
    CommandDefinition {
        name: "enrich.record_consent",
        owner_schema: "enrich",
        input_schema: r#"{
          "type": "object",
          "required": ["capability", "egress", "decision"],
          "additionalProperties": false,
          "properties": {
            "capability": { "type": "string", "minLength": 1, "maxLength": 64 },
            "egress": { "type": "string", "enum": ["on-device", "gateway", "provider"] },
            "scope_ref": { "type": "string", "maxLength": 128 },
            "decision": { "type": "string", "enum": ["granted", "declined"] }
          }
        }"#,
        // IDEMPOTENT, not retry-safe: the same answer given twice is one
        // answer, and the row keeps the id it was first recorded under so
        // provenance chains per ANSWER rather than per press.
        idempotency: Idempotency::Idempotent,
        // Salience, not a gate: an answer about where a member's data may
        // travel is the first thing their review feed should surface.
        risk: Risk::High,
        confirm: true,
        preconditions: &[],
        postconditions: &[CommandCondition {
            predicate: "answer_recorded",
            check: |ctx| {
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM share_authority
                      WHERE principal_kind = 'harness' AND subject_type = ?1
                        AND verb = ?2 AND principal_id = ?3 AND subject_id = ?4
                        AND decision = ?5 AND revoked_at IS NULL",
                    rusqlite::params![
                        ENRICH_SUBJECT_TYPE,
                        ctx.required_str("capability")?,
                        ctx.required_str("egress")?,
                        ctx.optional_str("scope_ref").unwrap_or_default(),
                        ctx.required_str("decision")?,
                    ],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the answer was not recorded".to_owned()))
            },
        }],
        handler: |ctx| {
            let capability = ctx.required_str("capability")?.to_owned();
            let egress = ctx.required_str("egress")?.to_owned();
            if !EGRESS_CLASSES.contains(&egress.as_str()) {
                return Err(VaultError::InvalidInput {
                    name: "egress".to_owned(),
                    detail: format!("`{egress}` is not an egress class"),
                });
            }
            let decision = ctx.required_str("decision")?.to_owned();
            let scope_ref = ctx.optional_str("scope_ref").unwrap_or_default().to_owned();
            // An authority row is IMMUTABLE except `revoked_at`, so a CHANGED
            // answer revokes and re-writes rather than editing in place, which
            // could not be audited; an IDENTICAL one is left alone (#883).
            let standing: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT decision FROM share_authority
                      WHERE principal_kind = 'harness' AND principal_id = ?1
                        AND subject_type = ?2 AND subject_id = ?3 AND verb = ?4
                        AND revoked_at IS NULL
                        AND (expires_at IS NULL OR expires_at > ?5)",
                    rusqlite::params![egress, ENRICH_SUBJECT_TYPE, scope_ref, capability, ctx.now],
                    |row| row.get(0),
                )
                .optional()?;
            if standing.as_deref() == Some(decision.as_str()) {
                return Ok(serde_json::json!({
                    "capability": capability,
                    "egress": egress,
                    "scope_ref": scope_ref,
                    "decision": decision,
                    "changed": false,
                }));
            }
            ctx.connection().execute(
                "UPDATE share_authority SET revoked_at = ?1
                  WHERE principal_kind = 'harness' AND principal_id = ?2
                    AND subject_type = ?3 AND subject_id = ?4 AND verb = ?5
                    AND revoked_at IS NULL",
                rusqlite::params![ctx.now, egress, ENRICH_SUBJECT_TYPE, scope_ref, capability],
            )?;
            ctx.connection().execute(
                "INSERT INTO share_authority
                   (authority_id, principal_kind, principal_id, subject_type, subject_id,
                    verb, duration, expires_at, decision, granted_at, granted_by,
                    revoked_at, receipt_id)
                 VALUES (?1, 'harness', ?2, ?3, ?4, ?5, 'standing', NULL, ?6, ?7, NULL, NULL, NULL)",
                rusqlite::params![
                    ctx.next_id(),
                    egress,
                    ENRICH_SUBJECT_TYPE,
                    scope_ref,
                    capability,
                    decision,
                    ctx.now
                ],
            )?;
            Ok(serde_json::json!({
                "capability": capability,
                "egress": egress,
                "scope_ref": scope_ref,
                "decision": decision,
                "changed": true,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn upsert_embedding() -> CommandDefinition {
    CommandDefinition {
        name: "enrich.upsert_embedding",
        owner_schema: "enrich",
        input_schema: r#"{
          "type": "object",
          "required": ["entity_type", "entity_id", "model", "vector"],
          "additionalProperties": false,
          "properties": {
            "entity_type": { "type": "string", "minLength": 1 },
            "entity_id": { "type": "string", "minLength": 1 },
            "model": { "type": "string", "minLength": 1 },
            "vector": {
              "type": "array", "minItems": 1, "maxItems": 4096,
              "items": { "type": "number" }
            },
            "capability": { "type": "string", "enum": ["embed-image", "embed-text"] },
            "source_version": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::RetrySafe,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[],
        postconditions: &[CommandCondition {
            predicate: "embedding_present",
            check: |ctx| {
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM enrich_embedding
                      WHERE target_type = ?1 AND target_id = ?2 AND model = ?3",
                    rusqlite::params![
                        ctx.required_str("entity_type")?,
                        ctx.required_str("entity_id")?,
                        ctx.required_str("model")?,
                    ],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the embedding was not stored".to_owned()))
            },
        }],
        handler: |ctx| {
            let entity_type = ctx.required_str("entity_type")?.to_owned();
            let entity_id = ctx.required_str("entity_id")?.to_owned();
            let model = ctx.required_str("model")?.to_owned();
            let vector = finite_vector(&ctx.input, "vector")?;
            // ONE ROW PER (target, model). A model swap is a new row, never an
            // overwrite of another model's answer — which is what keeps 128-d
            // and 512-d face vectors from ever meeting.
            let existing: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT embedding_id FROM enrich_embedding
                      WHERE target_type = ?1 AND target_id = ?2 AND model = ?3",
                    rusqlite::params![entity_type, entity_id, model],
                    |row| row.get(0),
                )
                .optional()?;
            let bytes = encode_vector(&vector);
            let dim = i64::try_from(vector.len()).unwrap_or(i64::MAX);
            let embedding_id = match existing {
                Some(id) => {
                    ctx.connection().execute(
                        "UPDATE enrich_embedding SET dim = ?1, vector = ?2, created_at = ?3
                          WHERE embedding_id = ?4",
                        rusqlite::params![dim, bytes, ctx.now, id],
                    )?;
                    id
                }
                None => {
                    let id = ctx.next_id();
                    ctx.connection().execute(
                        "INSERT INTO enrich_embedding
                           (embedding_id, target_type, target_id, model, dim, vector, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        rusqlite::params![id, entity_type, entity_id, model, dim, bytes, ctx.now],
                    )?;
                    id
                }
            };
            // The stamp is written only when the caller says which capability
            // produced this: an embedding written by a migration is a value,
            // not a derivation, and stamping it would make the walk skip a
            // target no recipe has looked at.
            if let Some(capability) = ctx.optional_str("capability") {
                let payload = ctx
                    .optional_str("source_version")
                    .map(|version| serde_json::json!({ "source_version": version }));
                stamp_derivation(
                    ctx,
                    &entity_type,
                    &entity_id,
                    "embedding",
                    capability,
                    &model,
                    payload.as_ref(),
                )?;
            }
            Ok(serde_json::json!({ "embedding_id": embedding_id, "dim": dim }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn mark_requests_drained() -> CommandDefinition {
    CommandDefinition {
        name: "enrich.mark_requests_drained",
        owner_schema: "enrich",
        input_schema: r#"{
          "type": "object",
          "required": ["request_ids"],
          "additionalProperties": false,
          "properties": {
            "request_ids": {
              "type": "array", "minItems": 1, "maxItems": 100,
              "items": { "type": "string", "minLength": 1 }
            }
          }
        }"#,
        idempotency: Idempotency::RetrySafe,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[],
        postconditions: &[],
        handler: |ctx| {
            let ids = ctx
                .input
                .get("request_ids")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| VaultError::InvalidInput {
                    name: "request_ids".to_owned(),
                    detail: "an array of request ids".to_owned(),
                })?;
            let mut drained = 0usize;
            for id in ids {
                let id = id.as_str().unwrap_or_default();
                // A LEASED REQUEST IS NOT DRAINABLE until its lease expires:
                // the device that took it may still be working, and draining
                // it here would drop the member's ask on the floor.
                drained += ctx.connection().execute(
                    "UPDATE enrich_request SET drained_at = ?1
                      WHERE request_id = ?2 AND drained_at IS NULL
                        AND (lease_expires_at IS NULL OR lease_expires_at <= ?1)",
                    rusqlite::params![ctx.now, id],
                )?;
            }
            Ok(serde_json::json!({ "drained": drained }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn record_target_failure() -> CommandDefinition {
    CommandDefinition {
        name: "enrich.record_target_failure",
        owner_schema: "enrich",
        input_schema: r#"{
          "type": "object",
          "required": ["capability", "target_type", "target_id"],
          "additionalProperties": false,
          "properties": {
            "capability": { "type": "string", "minLength": 1 },
            "target_type": { "type": "string", "minLength": 1 },
            "target_id": { "type": "string", "minLength": 1 },
            "error": { "type": "string", "maxLength": 2000 },
            "reason": { "type": "string", "minLength": 1, "maxLength": 64 },
            "permanent": { "type": "boolean" },
            "max_failures": { "type": "integer", "minimum": 1, "maximum": 1000 }
          }
        }"#,
        idempotency: Idempotency::RetrySafe,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[],
        postconditions: &[],
        handler: |ctx| {
            let capability = ctx.required_str("capability")?.to_owned();
            let target_type = ctx.required_str("target_type")?.to_owned();
            let target_id = ctx.required_str("target_id")?.to_owned();
            // A capability may declare its OWN cap: "this preview has not
            // landed yet" is worth many more ticks than "the detector threw",
            // and one constant for both would either declare a slow rung dead
            // or leave a crash-looping one running for an hour.
            let cap = ctx
                .input
                .get("max_failures")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(3)
                .max(1);
            let permanent = ctx
                .input
                .get("permanent")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let error = ctx
                .optional_str("error")
                .map(|text| text.chars().take(500).collect::<String>());
            let (failures, declined): (i64, i64) = ctx.connection().query_row(
                "INSERT INTO enrich_target_failure
                   (capability, target_type, target_id, failures, declined, reason,
                    last_error, first_failed_at, last_failed_at)
                 VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT (capability, target_type, target_id) DO UPDATE SET
                   failures = enrich_target_failure.failures + 1,
                   declined = CASE
                     WHEN excluded.declined = 1 THEN 1
                     WHEN enrich_target_failure.failures + 1 >= ?8 THEN 1
                     ELSE 0 END,
                   reason = COALESCE(excluded.reason, enrich_target_failure.reason),
                   last_error = excluded.last_error,
                   last_failed_at = excluded.last_failed_at
                 RETURNING failures, declined",
                rusqlite::params![
                    capability,
                    target_type,
                    target_id,
                    i64::from(permanent || cap <= 1),
                    ctx.optional_str("reason"),
                    error,
                    ctx.now,
                    cap,
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            Ok(serde_json::json!({
                "failures": failures,
                "declined": declined == 1,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn upsert_faces() -> CommandDefinition {
    CommandDefinition {
        name: "enrich.upsert_faces",
        owner_schema: "enrich",
        input_schema: r#"{
          "type": "object",
          "required": ["asset_id", "model", "faces"],
          "additionalProperties": false,
          "properties": {
            "asset_id": { "type": "string", "minLength": 1 },
            "model": { "type": "string", "minLength": 1 },
            "faces": {
              "type": "array", "maxItems": 100,
              "items": {
                "type": "object",
                "required": ["box", "confidence", "embedding"],
                "additionalProperties": false,
                "properties": {
                  "box": {
                    "type": "array", "minItems": 4, "maxItems": 4,
                    "items": { "type": "integer", "minimum": 0 }
                  },
                  "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                  "embedding": {
                    "type": "array", "minItems": 1, "maxItems": 4096,
                    "items": { "type": "number" }
                  }
                }
              }
            }
          }
        }"#,
        idempotency: Idempotency::RetrySafe,
        risk: Risk::Medium,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "asset_live",
                check: |ctx| {
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM media_asset
                          WHERE asset_id = ?1 AND deleted_at IS NULL",
                        [ctx.required_str("asset_id")?],
                        |row| row.get(0),
                    )?;
                    Ok((count != 1).then(|| {
                        "this photograph is no longer in the library, so nothing can be \
                         recognised in it"
                            .to_owned()
                    }))
                },
            },
            // A DENIAL IS A VALUE, NEVER AN `Err`. A box outside the
            // photograph is a bad detector, not a broken vault, so it is
            // refused here with a sentence — and refused for the WHOLE batch
            // before any row is written, because a partial recognition would
            // stamp the asset as done with half its faces.
            CommandCondition {
                predicate: "every_box_is_inside_the_photograph",
                check: |ctx| {
                    let asset_id = ctx.required_str("asset_id")?;
                    // EVERY precondition is evaluated before the first failure
                    // denies (gate order 4), so this one must answer for an
                    // asset `asset_live` has already refused rather than
                    // erroring on a missing row.
                    let Some((width, height)) = ctx
                        .connection()
                        .query_row(
                            "SELECT width, height FROM media_asset WHERE asset_id = ?1",
                            [asset_id],
                            |row| {
                                Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?))
                            },
                        )
                        .optional()?
                    else {
                        return Ok(None);
                    };
                    let faces = ctx
                        .input
                        .get("faces")
                        .and_then(serde_json::Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    for (index, face) in faces.iter().enumerate() {
                        let boxed: Vec<i64> = face
                            .get("box")
                            .and_then(serde_json::Value::as_array)
                            .map(|values| {
                                values
                                    .iter()
                                    .filter_map(serde_json::Value::as_i64)
                                    .collect()
                            })
                            .unwrap_or_default();
                        if boxed.len() != 4 {
                            return Ok(Some(format!(
                                "face {} has no [x, y, width, height] box",
                                index + 1
                            )));
                        }
                        let (x, y, w, h) = (boxed[0], boxed[1], boxed[2], boxed[3]);
                        if w <= 0
                            || h <= 0
                            || width.is_some_and(|limit| x + w > limit)
                            || height.is_some_and(|limit| y + h > limit)
                        {
                            return Ok(Some(format!(
                                "face {} lies outside the photograph, so this recognition is \
                                 not about this photograph",
                                index + 1
                            )));
                        }
                        if !face
                            .get("embedding")
                            .and_then(serde_json::Value::as_array)
                            .is_some_and(|values| {
                                !values.is_empty()
                                    && values
                                        .iter()
                                        .all(|value| value.as_f64().is_some_and(f64::is_finite))
                            })
                        {
                            return Ok(Some(format!(
                                "face {}'s embedding is not a vector of finite numbers — a NaN \
                                 would make it neither match nor fail to match",
                                index + 1
                            )));
                        }
                    }
                    Ok(None)
                },
            },
        ],
        postconditions: &[],
        handler: |ctx| {
            let asset_id = ctx.required_str("asset_id")?.to_owned();
            let model = ctx.required_str("model")?.to_owned();
            let faces = ctx
                .input
                .get("faces")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| VaultError::InvalidInput {
                    name: "faces".to_owned(),
                    detail: "an array of faces".to_owned(),
                })?
                .clone();
            // The geometry and the vectors are already settled by
            // `every_box_is_inside_the_photograph`; this parse is the same
            // read done once more so the handler works from values rather
            // than from JSON.
            let mut checked = Vec::with_capacity(faces.len());
            for (index, face) in faces.iter().enumerate() {
                let boxed: Vec<i64> = face
                    .get("box")
                    .and_then(serde_json::Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(serde_json::Value::as_i64)
                            .collect()
                    })
                    .unwrap_or_default();
                if boxed.len() != 4 {
                    return Err(VaultError::Invariant {
                        context: format!(
                            "faces[{index}] passed the box precondition without a box"
                        ),
                    });
                }
                let embedding = finite_vector(face, "embedding")?;
                let confidence = face
                    .get("confidence")
                    .and_then(serde_json::Value::as_f64)
                    .filter(|value| (0.0..=1.0).contains(value))
                    .ok_or_else(|| VaultError::InvalidInput {
                        name: format!("faces[{index}].confidence"),
                        detail: "a confidence between 0 and 1".to_owned(),
                    })?;
                checked.push((boxed, confidence, embedding));
            }
            // A RE-RUN REPLACES ONLY THE PROPOSALS. A region the owner
            // confirmed or rejected is their answer, and a detector re-run is
            // not an argument against it (#712).
            let proposed: Vec<String> = {
                let mut statement = ctx.connection().prepare(
                    "SELECT region_id FROM media_face_region
                      WHERE asset_id = ?1 AND review_state = 'proposed'",
                )?;
                let rows = statement.query_map([&asset_id], |row| row.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<String>>>()?
            };
            for region_id in &proposed {
                ctx.connection().execute(
                    "DELETE FROM enrich_embedding
                      WHERE target_type = 'media.face_region' AND target_id = ?1",
                    [region_id],
                )?;
                ctx.connection().execute(
                    "DELETE FROM media_face_region WHERE region_id = ?1",
                    [region_id],
                )?;
            }
            for (boxed, confidence, embedding) in &checked {
                let region_id = ctx.next_id();
                ctx.connection().execute(
                    "INSERT INTO media_face_region (region_id, asset_id, bbox_json, confidence)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![
                        region_id,
                        asset_id,
                        serde_json::to_string(boxed).unwrap_or_else(|_| "[]".to_owned()),
                        confidence
                    ],
                )?;
                ctx.connection().execute(
                    "INSERT INTO enrich_embedding
                       (embedding_id, target_type, target_id, model, dim, vector, created_at)
                     VALUES (?1, 'media.face_region', ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![
                        ctx.next_id(),
                        region_id,
                        model,
                        i64::try_from(embedding.len()).unwrap_or(i64::MAX),
                        encode_vector(embedding),
                        ctx.now
                    ],
                )?;
            }
            // The stamp carries the COUNT, including zero: a photograph with
            // no faces in it is a finished photograph, and without the stamp
            // the walk would look at it again on every lap.
            stamp_derivation(
                ctx,
                "media.asset",
                &asset_id,
                "faces",
                "faces",
                &model,
                Some(&serde_json::json!({ "count": checked.len() })),
            )?;
            Ok(serde_json::json!({ "regions": checked.len() }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn rebuild_face_clusters() -> CommandDefinition {
    CommandDefinition {
        name: "enrich.rebuild_face_clusters",
        owner_schema: "enrich",
        input_schema: r#"{ "type": "object", "additionalProperties": false, "properties": {} }"#,
        idempotency: Idempotency::RetrySafe,
        risk: Risk::Medium,
        confirm: false,
        preconditions: &[],
        postconditions: &[],
        handler: |ctx| {
            let regions = read_face_regions(ctx)?;
            let outcome = faces::regroup(&regions);
            let mut matched = 0usize;
            for (region_id, party_id) in &outcome.offers {
                // `review_state` is UNTOUCHED: only `media.answer_face_proposal`
                // leaves `proposed`. This writes a CANDIDATE, not an identity.
                matched += ctx.connection().execute(
                    "UPDATE media_face_region SET party_id = ?1
                      WHERE region_id = ?2 AND review_state = 'proposed'",
                    rusqlite::params![party_id, region_id],
                )?;
            }
            // COMPARE THEN WRITE: unchanged data writes nothing, dirties no
            // WAL page and wakes no replica.
            let before: Vec<(String, String)> = {
                let mut statement = ctx
                    .connection()
                    .prepare("SELECT region_id, cluster_id FROM media_face_cluster")?;
                let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
                rows.collect::<rusqlite::Result<Vec<(String, String)>>>()?
            };
            let mut updated = 0usize;
            if before != outcome.clusters {
                ctx.connection()
                    .execute("DELETE FROM media_face_cluster", [])?;
                for (region_id, cluster_id) in &outcome.clusters {
                    ctx.connection().execute(
                        "INSERT INTO media_face_cluster (region_id, cluster_id, computed_at)
                         VALUES (?1, ?2, ?3)",
                        rusqlite::params![region_id, cluster_id, ctx.now],
                    )?;
                }
                updated = before.len() + outcome.clusters.len();
            }
            let distinct: std::collections::BTreeSet<&String> =
                outcome.clusters.iter().map(|(_, id)| id).collect();
            Ok(serde_json::json!({
                "matched": matched,
                "clusters": distinct.len(),
                "clustered": outcome.clusters.len(),
                "updated": updated,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn regenerate() -> CommandDefinition {
    CommandDefinition {
        name: "enrich.regenerate",
        owner_schema: "enrich",
        input_schema: r#"{
          "type": "object",
          "required": ["capability"],
          "additionalProperties": false,
          "properties": {
            "capability": { "type": "string", "minLength": 1, "maxLength": 64 },
            "content_id": { "type": "string", "minLength": 1 },
            "asset_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::RetrySafe,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "exactly_one_target_named",
            check: |ctx| {
                let content = ctx.optional_str("content_id").is_some();
                let asset = ctx.optional_str("asset_id").is_some();
                Ok((content == asset).then(|| {
                    "name exactly one of the photograph or the document — a photograph is both a \
                     media asset and a content item, and the two capabilities stamp different \
                     halves of it"
                        .to_owned()
                }))
            },
        }],
        postconditions: &[],
        handler: |ctx| {
            let capability = ctx.required_str("capability")?.to_owned();
            // Resolve the PAIR. A stamp for this capability may sit on either
            // half, so both are cleared — regenerating "this photograph's OCR"
            // must not depend on the member having named the id the stamp
            // happens to use.
            let (asset_id, content_id) =
                match (ctx.optional_str("asset_id"), ctx.optional_str("content_id")) {
                    (Some(asset), _) => {
                        let content: Option<String> = ctx
                            .connection()
                            .query_row(
                                "SELECT content_id FROM media_asset
                              WHERE asset_id = ?1 AND deleted_at IS NULL",
                                [asset],
                                |row| row.get(0),
                            )
                            .optional()?;
                        let content = content.ok_or_else(|| VaultError::InvalidInput {
                            name: "asset_id".to_owned(),
                            detail: "this photograph is not in the library".to_owned(),
                        })?;
                        (Some(asset.to_owned()), Some(content))
                    }
                    (None, Some(content)) => {
                        // A content item may have no asset at all (a document),
                        // which is fine: the stamp is on the content item.
                        let asset: Option<String> = ctx
                            .connection()
                            .query_row(
                                "SELECT asset_id FROM media_asset
                              WHERE content_id = ?1 AND deleted_at IS NULL",
                                [content],
                                |row| row.get(0),
                            )
                            .optional()?;
                        (asset, Some(content.to_owned()))
                    }
                    (None, None) => {
                        return Err(VaultError::InvalidInput {
                            name: "asset_id".to_owned(),
                            detail: "name the photograph or the document".to_owned(),
                        });
                    }
                };
            let mut deleted = 0usize;
            for target in [asset_id.as_deref(), content_id.as_deref()]
                .into_iter()
                .flatten()
            {
                deleted += ctx.connection().execute(
                    "DELETE FROM enrich_derivation WHERE capability = ?1 AND target_id = ?2",
                    rusqlite::params![capability, target],
                )?;
            }
            // The priority lane, NOT a gate: a recipe with an empty queue still
            // walks its library, but a target behind the ambient cursor would
            // otherwise wait for a full lap.
            let request_id = ctx.next_id();
            let (target_type, target_id) = match &asset_id {
                Some(asset) => ("media.asset", asset.clone()),
                None => ("core.content_item", content_id.clone().unwrap_or_default()),
            };
            ctx.connection().execute(
                "INSERT INTO enrich_request
                   (request_id, target_type, target_id, reason, detail, capability,
                    requested_at, drained_at)
                 VALUES (?1, ?2, ?3, 'manual', ?4, ?5, ?6, NULL)",
                rusqlite::params![
                    request_id,
                    target_type,
                    target_id,
                    format!("regenerate {capability}"),
                    capability,
                    ctx.now
                ],
            )?;
            Ok(serde_json::json!({ "deleted": deleted, "request_id": request_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn regenerate_all() -> CommandDefinition {
    CommandDefinition {
        name: "enrich.regenerate_all",
        owner_schema: "enrich",
        input_schema: r#"{
          "type": "object",
          "required": ["capability"],
          "additionalProperties": false,
          "properties": {
            "capability": { "type": "string", "minLength": 1, "maxLength": 64 }
          }
        }"#,
        idempotency: Idempotency::RetrySafe,
        // The whole library re-derives behind a bounded cursor: cheap per fire,
        // long in aggregate, and the member should be told which they asked for.
        risk: Risk::Medium,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "a_bundled_recipe_owns_this_capability",
            check: |ctx| {
                let capability = ctx.required_str("capability")?;
                Ok(recipe_for(capability).is_none().then(|| {
                    format!(
                        "no bundled recipe owns \"{capability}\", so there is no walk to send back \
                         to the beginning — known: {}",
                        CAPABILITY_RECIPES
                            .iter()
                            .map(|(name, _, _)| *name)
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                }))
            },
        }],
        postconditions: &[CommandCondition {
            predicate: "no_stamps_remain",
            check: |ctx| {
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM enrich_derivation WHERE capability = ?1",
                    [ctx.required_str("capability")?],
                    |row| row.get(0),
                )?;
                Ok((count != 0).then(|| "some derivation stamps survived".to_owned()))
            },
        }],
        handler: |ctx| {
            let capability = ctx.required_str("capability")?.to_owned();
            let (automation_ref, cursor_keys) =
                recipe_for(&capability).ok_or_else(|| VaultError::InvalidInput {
                    name: "capability".to_owned(),
                    detail: format!("no bundled recipe owns \"{capability}\""),
                })?;
            let deleted = ctx.connection().execute(
                "DELETE FROM enrich_derivation WHERE capability = ?1",
                [&capability],
            )?;
            // BACK TO THE BEGINNING OF THE LIBRARY. A handler reads a missing
            // and an empty cursor identically, so writing `""` is the reset —
            // and it does NOT disturb the recipe's model/selection key, which
            // is what would otherwise re-seed the cursor past everything on the
            // very next fire.
            let updated_at = crate::clock::parse_iso_ms(&ctx.now).unwrap_or_default();
            for key in cursor_keys {
                ctx.connection().execute(
                    "INSERT INTO automation_state (automation_id, key, value_json, updated_at)
                     VALUES (?1, ?2, '\"\"', ?3)
                     ON CONFLICT (automation_id, key) DO UPDATE SET
                       value_json = excluded.value_json, updated_at = excluded.updated_at",
                    rusqlite::params![automation_ref, key, updated_at],
                )?;
            }
            Ok(serde_json::json!({
                "deleted": deleted,
                "automation_ref": automation_ref,
                "cursors_reset": cursor_keys.len(),
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn recipe_for(capability: &str) -> Option<(&'static str, &'static [&'static str])> {
    CAPABILITY_RECIPES
        .iter()
        .find(|(name, _, _)| *name == capability)
        .map(|(_, automation_ref, keys)| (*automation_ref, *keys))
}

/// A vector of finite numbers, or a refusal naming the field.
///
/// A NaN in an embedding is not a value: it compares false with everything
/// including itself, so a single one would make a face neither match nor fail
/// to match — the worst of the three answers.
fn finite_vector(source: &serde_json::Value, key: &str) -> crate::error::Result<Vec<f64>> {
    let values = source
        .get(key)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| VaultError::InvalidInput {
            name: key.to_owned(),
            detail: "an array of numbers".to_owned(),
        })?;
    if values.is_empty() || values.len() > MAX_EMBEDDING_DIM {
        return Err(VaultError::InvalidInput {
            name: key.to_owned(),
            detail: format!("between 1 and {MAX_EMBEDDING_DIM} values"),
        });
    }
    values
        .iter()
        .map(|value| {
            value
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| VaultError::InvalidInput {
                    name: key.to_owned(),
                    detail: "every value must be a finite number".to_owned(),
                })
        })
        .collect()
}

/// One face region plus the vector that was computed for it.
struct FaceRow {
    region_id: String,
    party_id: Option<String>,
    confirmed: bool,
    model: String,
    vector: Vec<f32>,
}

fn read_face_regions(ctx: &CommandCtx<'_, '_>) -> crate::error::Result<Vec<FaceRow>> {
    let mut statement = ctx.connection().prepare(
        "SELECT r.region_id, r.party_id, r.review_state, e.model, e.vector
           FROM media_face_region r
           JOIN media_asset a ON a.asset_id = r.asset_id
           JOIN enrich_embedding e
             ON e.target_type = 'media.face_region' AND e.target_id = r.region_id
          WHERE a.deleted_at IS NULL
            AND r.review_state IN ('proposed', 'confirmed')
          ORDER BY e.model, r.region_id",
    )?;
    let rows = statement.query_map([], |row| {
        let state: String = row.get(2)?;
        let blob: Vec<u8> = row.get(4)?;
        Ok(FaceRow {
            region_id: row.get(0)?,
            party_id: row.get(1)?,
            confirmed: state == "confirmed",
            model: row.get(3)?,
            vector: decode_vector(&blob),
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<FaceRow>>>()
        .map_err(Into::into)
}

/// Face grouping's arithmetic: no SQL, no rows, no clock.
///
/// **Prohibitions carried from `enrich/face-clusters.ts:1`–`:11`**, each of
/// which is a decision rather than a tuning: answered regions are read for
/// nothing; comparisons stay within ONE `enrich_embedding.model`; the
/// thresholds are deliberately stricter than the literature, because *a false
/// merge destroys trust late and a false split costs one gesture*; and there is
/// **no chaining** — centroid linkage only, never single-link union-find, so a
/// chain of near-neighbours cannot walk two strangers into one group.
mod faces {
    use std::collections::BTreeMap;

    use super::FaceRow;

    /// Offer-as-party ceiling. Read the module header before relaxing it.
    pub const PARTY_MAX_DISTANCE: f64 = 0.3;
    /// Stricter still: a stranger group is named in ONE gesture.
    pub const CLUSTER_MAX_DISTANCE: f64 = 0.22;
    /// A lone face is named from its own photograph; no singleton strangers.
    pub const MIN_CLUSTER_SIZE: usize = 2;

    pub struct Outcome {
        /// `(region_id, party_id)` candidates to offer on proposed regions.
        pub offers: Vec<(String, String)>,
        /// `(region_id, cluster_id)`, sorted, so a rebuild is byte-stable.
        pub clusters: Vec<(String, String)>,
    }

    /// L2-normalise. `None` for a zero vector: never invent a direction.
    fn unit(values: &[f32]) -> Option<Vec<f64>> {
        let norm: f64 = values.iter().map(|value| f64::from(*value).powi(2)).sum();
        if !norm.is_finite() || norm <= 0.0 {
            return None;
        }
        let scale = norm.sqrt().recip();
        Some(
            values
                .iter()
                .map(|value| f64::from(*value) * scale)
                .collect(),
        )
    }

    /// Cosine distance between two unit vectors. Differing lengths are
    /// INFINITELY far apart rather than compared over a prefix — a 128-d and a
    /// 512-d vector are different spaces.
    fn distance(left: &[f64], right: &[f64]) -> f64 {
        if left.len() != right.len() {
            return f64::INFINITY;
        }
        let dot: f64 = left.iter().zip(right).map(|(a, b)| a * b).sum();
        1.0 - dot.clamp(-1.0, 1.0)
    }

    fn centroid(members: &[Vec<f64>]) -> Option<Vec<f64>> {
        let first = members.first()?;
        let mut sum = vec![0.0; first.len()];
        for member in members {
            if member.len() != sum.len() {
                return None;
            }
            for (slot, value) in sum.iter_mut().zip(member) {
                *slot += value;
            }
        }
        let norm: f64 = sum.iter().map(|value| value.powi(2)).sum();
        if !norm.is_finite() || norm <= 0.0 {
            return None;
        }
        let scale = norm.sqrt().recip();
        Some(sum.into_iter().map(|value| value * scale).collect())
    }

    /// Centroid-linkage agglomeration: merge the closest pair under the
    /// threshold, recompute the centroid, repeat. Ascending distance with an
    /// id tiebreak, so a rebuild over unchanged data produces the same groups
    /// in the same order.
    fn agglomerate(candidates: &[(String, Vec<f64>)], threshold: f64) -> Vec<Vec<String>> {
        let mut groups: BTreeMap<String, (Vec<String>, Vec<f64>)> = candidates
            .iter()
            .map(|(id, unit)| (id.clone(), (vec![id.clone()], unit.clone())))
            .collect();
        let mut units: BTreeMap<String, Vec<f64>> = candidates.iter().cloned().collect();
        loop {
            let keys: Vec<&String> = groups.keys().collect();
            let mut best: Option<(f64, String, String)> = None;
            for (index, left) in keys.iter().enumerate() {
                for right in keys.iter().skip(index + 1) {
                    let gap = distance(&groups[*left].1, &groups[*right].1);
                    if gap > threshold {
                        continue;
                    }
                    let better = best
                        .as_ref()
                        .is_none_or(|(previous, _, _)| gap < *previous - f64::EPSILON);
                    if better {
                        best = Some((gap, (*left).clone(), (*right).clone()));
                    }
                }
            }
            let Some((_, left, right)) = best else { break };
            let (mut members, _) = groups.remove(&left).expect("present");
            let (right_members, _) = groups.remove(&right).expect("present");
            members.extend(right_members);
            members.sort();
            let vectors: Vec<Vec<f64>> = members
                .iter()
                .filter_map(|id| units.get(id).cloned())
                .collect();
            let Some(middle) = centroid(&vectors) else {
                break;
            };
            // LOWEST ID IS THE IDENTITY, so an unchanged group never renames.
            let survivor = members[0].clone();
            units.insert(survivor.clone(), middle.clone());
            groups.insert(survivor, (members, middle));
        }
        groups
            .into_values()
            .map(|(members, _)| members)
            .filter(|members| members.len() >= MIN_CLUSTER_SIZE)
            .collect()
    }

    /// Group one vault's face regions.
    #[must_use]
    pub fn regroup(rows: &[FaceRow]) -> Outcome {
        let mut offers = Vec::new();
        let mut clusters = Vec::new();
        let mut models: BTreeMap<&str, Vec<&FaceRow>> = BTreeMap::new();
        for row in rows {
            models.entry(row.model.as_str()).or_default().push(row);
        }
        for group in models.into_values() {
            // Centroids come from OWNER CONFIRMATIONS only.
            let mut by_party: BTreeMap<&str, Vec<Vec<f64>>> = BTreeMap::new();
            for row in &group {
                if !row.confirmed {
                    continue;
                }
                let Some(party) = row.party_id.as_deref() else {
                    continue;
                };
                if let Some(unit) = unit(&row.vector) {
                    by_party.entry(party).or_default().push(unit);
                }
            }
            let centroids: Vec<(&str, Vec<f64>)> = by_party
                .into_iter()
                .filter_map(|(party, members)| centroid(&members).map(|middle| (party, middle)))
                .collect();
            let mut leftovers = Vec::new();
            for row in &group {
                if row.confirmed {
                    continue;
                }
                // A region that already carries a candidate is not ours to
                // move: somebody offered it and nobody has answered yet.
                if row.party_id.is_some() {
                    continue;
                }
                let Some(unit) = unit(&row.vector) else {
                    continue;
                };
                let near: Vec<&str> = centroids
                    .iter()
                    .filter(|(_, middle)| distance(&unit, middle) <= PARTY_MAX_DISTANCE)
                    .map(|(party, _)| *party)
                    .collect();
                // EXACTLY ONE, or the region stays unnamed: ambiguity is not a
                // guess a member should have to undo.
                if near.len() == 1 {
                    offers.push((row.region_id.clone(), near[0].to_owned()));
                    continue;
                }
                leftovers.push((row.region_id.clone(), unit));
            }
            for members in agglomerate(&leftovers, CLUSTER_MAX_DISTANCE) {
                let cluster_id = members[0].clone();
                for region_id in members {
                    clusters.push((region_id, cluster_id.clone()));
                }
            }
        }
        offers.sort();
        clusters.sort();
        Outcome { offers, clusters }
    }
}
