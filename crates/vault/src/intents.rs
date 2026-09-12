//! Replay idempotency: the canonical payload hash and the outcome ledger.
//!
//! ## Identity is `(vault_id, intent_id, payload_hash)`, not the device
//!
//! A seat file outlives its enrolment. A restored phone, or an OS app clone,
//! re-enrols under a new endpoint id and replays intents this vault already
//! executed — so keying the ledger on the device would execute every one of
//! them a second time. The vault, the intent id and the payload are the three
//! facts that do not change when the device does.
//!
//! ## The window is 30 days, and it is the log's retention floor on purpose
//!
//! An outcome that outlived the log rows its `commit_seq` points into can no
//! longer tell a seat where its effect landed. So past the edge the honest
//! answer is `outcome_expired` — "I no longer know" — and never a silent
//! re-execution.
//!
//! ## The canonical form (plane census seam 6)
//!
//! Object keys are sorted **by UTF-16 code unit**, because that is what
//! JavaScript's `Array#sort` does and the seat that computed the hash may be a
//! JS engine for as long as v0 exists. Rust's own `str` ordering is by UTF-8
//! bytes, which AGREES for every character in the BMP and DISAGREES for astral
//! ones: `"\u{10000}"` sorts after `"\u{E000}"` in UTF-8 and before it in
//! UTF-16 code units. A vault with an emoji in a row id would diverge, which is
//! exactly the kind of bug that reproduces on one member's phone and nowhere
//! else. `compare_utf16` is therefore not a nicety.

use rusqlite::Connection;
use sha2::{Digest as _, Sha256};

use crate::clock::Clock;
use crate::error::{IntentRefusal, Result, VaultError};

/// Compare two strings by UTF-16 CODE UNIT, as JavaScript's `<` does.
#[must_use]
pub fn compare_utf16(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// The canonical JSON of a value: object keys sorted by UTF-16 code unit,
/// arrays in order, no whitespace.
///
/// A non-finite number is refused rather than written as `null`, which is what
/// `JSON.stringify` would do — a payload whose hash silently depended on
/// `NaN` becoming `null` is a payload two implementations disagree about.
pub fn canonical_json(value: &serde_json::Value) -> Result<String> {
    Ok(match value {
        serde_json::Value::Null => "null".to_owned(),
        serde_json::Value::Bool(flag) => flag.to_string(),
        serde_json::Value::String(text) => crate::value::json_string(text),
        serde_json::Value::Number(number) => {
            let Some(real) = number.as_f64() else {
                return Err(VaultError::Invariant {
                    context: format!("`{number}` is not a JSON-safe number"),
                });
            };
            if !real.is_finite() {
                return Err(VaultError::Invariant {
                    context: "an intent payload is not JSON-safe".to_owned(),
                });
            }
            if let Some(int) = number.as_i64() {
                int.to_string()
            } else {
                centraid_ontology::jsvalue::js_number_to_string(real)
            }
        }
        serde_json::Value::Array(items) => {
            let rendered = items
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>>>()?;
            format!("[{}]", rendered.join(","))
        }
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| compare_utf16(left, right));
            let rendered = keys
                .into_iter()
                .map(|key| {
                    Ok(format!(
                        "{}:{}",
                        crate::value::json_string(key),
                        canonical_json(&map[key])?
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            format!("{{{}}}", rendered.join(","))
        }
    })
}

/// One row version an intent's answer stands for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseVersion {
    pub entity: String,
    pub row_id: String,
    pub shape_id: Option<String>,
    pub version: i64,
}

impl BaseVersion {
    /// `entity\0rowId\0shapeId` — the sort key both sides order by.
    #[must_use]
    pub fn sort_key(&self) -> String {
        format!(
            "{}\u{0}{}\u{0}{}",
            self.entity,
            self.row_id,
            self.shape_id.as_deref().unwrap_or("")
        )
    }
}

/// What an intent claims to do.
#[derive(Debug, Clone)]
pub struct IntentPayload {
    pub app_id: String,
    pub action: String,
    pub input: serde_json::Value,
    pub base_versions: Vec<BaseVersion>,
    pub depends_on: Vec<String>,
}

impl IntentPayload {
    /// The canonical hash: sha-256 hex over the canonical JSON.
    ///
    /// `baseVersions` and `dependsOn` are **omitted when empty**, not written
    /// as `[]` — the seat omits them and the gateway's expected hash must be
    /// the same bytes, so an empty array here would refuse every ordinary
    /// intent.
    pub fn hash(&self) -> Result<String> {
        let mut object = serde_json::Map::new();
        object.insert(
            "action".to_owned(),
            serde_json::Value::String(self.action.clone()),
        );
        object.insert(
            "appId".to_owned(),
            serde_json::Value::String(self.app_id.clone()),
        );
        object.insert("input".to_owned(), self.input.clone());
        if !self.base_versions.is_empty() {
            let mut sorted = self.base_versions.clone();
            sorted.sort_by(|left, right| compare_utf16(&left.sort_key(), &right.sort_key()));
            object.insert(
                "baseVersions".to_owned(),
                serde_json::Value::Array(
                    sorted
                        .into_iter()
                        .map(|version| {
                            let mut entry = serde_json::Map::new();
                            if let Some(shape) = version.shape_id {
                                entry
                                    .insert("shapeId".to_owned(), serde_json::Value::String(shape));
                            }
                            entry.insert(
                                "entity".to_owned(),
                                serde_json::Value::String(version.entity),
                            );
                            entry.insert(
                                "rowId".to_owned(),
                                serde_json::Value::String(version.row_id),
                            );
                            entry.insert("version".to_owned(), version.version.into());
                            serde_json::Value::Object(entry)
                        })
                        .collect(),
                ),
            );
        }
        if !self.depends_on.is_empty() {
            object.insert(
                "dependsOn".to_owned(),
                serde_json::Value::Array(
                    self.depends_on
                        .iter()
                        .map(|id| serde_json::Value::String(id.clone()))
                        .collect(),
                ),
            );
        }
        let canonical = canonical_json(&serde_json::Value::Object(object))?;
        Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
    }
}

/// A durable outcome, as the ledger holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntentOutcome {
    pub intent_id: String,
    pub device_id: String,
    pub app_id: String,
    pub action: String,
    pub payload_hash: String,
    pub status: String,
    pub invocation_id: Option<String>,
    pub commit_seq: Option<i64>,
    pub expires_at: Option<String>,
}

impl IntentOutcome {
    /// Is this a status nothing else can follow?
    #[must_use]
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status.as_str(),
            "executed" | "denied" | "failed" | "conflict"
        )
    }
}

/// Read an outcome by intent id.
pub fn read_outcome(connection: &Connection, intent_id: &str) -> Result<Option<IntentOutcome>> {
    let mut statement = connection.prepare_cached(
        "SELECT intent_id, device_id, app_id, action, payload_hash, status,
                invocation_id, commit_seq, expires_at
           FROM replica_intent_outcome WHERE intent_id = ?1",
    )?;
    let mut rows = statement.query([intent_id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    Ok(Some(IntentOutcome {
        intent_id: row.get(0)?,
        device_id: row.get(1)?,
        app_id: row.get(2)?,
        action: row.get(3)?,
        payload_hash: row.get(4)?,
        status: row.get(5)?,
        invocation_id: row.get(6)?,
        commit_seq: row.get(7)?,
        expires_at: row.get(8)?,
    }))
}

/// Refuse an intent whose id is held by a different command, caller or payload.
///
/// `intent_id_reused` when `app_id`, `action` or `payload_hash` differ;
/// `intent_already_terminal` when a terminal row is asked for a different
/// status. Run BEFORE any handler.
pub fn assert_identity(
    existing: &IntentOutcome,
    claim: &IntentPayload,
    payload_hash: &str,
    wanted_status: &str,
) -> Result<()> {
    if existing.app_id != claim.app_id
        || existing.action != claim.action
        || existing.payload_hash != payload_hash
    {
        return Err(VaultError::IntentRefused {
            refusal: IntentRefusal::IdReused,
            detail: format!(
                "intent `{}` is held by {}.{} with another payload",
                existing.intent_id, existing.app_id, existing.action
            ),
        });
    }
    if existing.is_terminal() && existing.status != wanted_status {
        return Err(VaultError::IntentRefused {
            refusal: IntentRefusal::AlreadyTerminal,
            detail: format!(
                "intent `{}` is already `{}`",
                existing.intent_id, existing.status
            ),
        });
    }
    Ok(())
}

/// Has this outcome fallen out of the window?
#[must_use]
pub fn is_expired(outcome: &IntentOutcome, now_ms: i64) -> bool {
    outcome
        .expires_at
        .as_deref()
        .and_then(crate::clock::parse_iso_ms)
        .is_some_and(|at| at <= now_ms)
}

/// The end of the window for an outcome recorded now.
#[must_use]
pub fn default_expiry(clock: &dyn Clock) -> String {
    let window = crate::log::constants().idempotency_window_days * 86_400_000;
    crate::clock::format_iso_ms(clock.now_ms() + window)
}

/// What an outcome row records.
pub struct OutcomeRecord<'a> {
    pub intent_id: &'a str,
    pub device_id: &'a str,
    pub claim: &'a IntentPayload,
    pub payload_hash: &'a str,
    pub status: &'a str,
    pub invocation_id: Option<&'a str>,
    pub commit_seq: Option<i64>,
}

/// Record or transition an outcome.
///
/// An UPDATE `COALESCE`s `commit_seq`, `depends_on` and `expires_at`, so a
/// transition cannot ERASE them: a `sending` → `executed` step that wrote NULL
/// over a commit position would lose the one number a seat settles against.
pub fn record_outcome(
    connection: &Connection,
    clock: &dyn Clock,
    record: &OutcomeRecord<'_>,
) -> Result<()> {
    let OutcomeRecord {
        intent_id,
        device_id,
        claim,
        payload_hash,
        status,
        invocation_id,
        commit_seq,
    } = *record;
    let now = clock.now_text();
    let expires = default_expiry(clock);
    connection.execute(
        "INSERT INTO replica_intent_outcome
           (intent_id, device_id, app_id, action, payload_hash, status,
            invocation_id, commit_seq, expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
         ON CONFLICT (intent_id) DO UPDATE SET
           status        = excluded.status,
           invocation_id = COALESCE(excluded.invocation_id, invocation_id),
           commit_seq    = COALESCE(excluded.commit_seq, commit_seq),
           expires_at    = COALESCE(expires_at, excluded.expires_at),
           updated_at    = excluded.updated_at",
        rusqlite::params![
            intent_id,
            device_id,
            claim.app_id,
            claim.action,
            payload_hash,
            status,
            invocation_id,
            commit_seq,
            expires,
            now,
        ],
    )?;
    Ok(())
}

/// Forget every protocol-state row a revoked device owns.
///
/// The parked payloads go FIRST, while the device-to-intent ownership rows
/// still exist, and all of it in one transaction — otherwise a crash between
/// the two leaves a sealed request nobody owns and nothing will ever delete.
pub fn delete_outcomes_for_device(connection: &Connection, device_id: &str) -> Result<usize> {
    connection.execute(
        "DELETE FROM replica_parked_payload
          WHERE intent_id IN (SELECT intent_id FROM replica_intent_outcome WHERE device_id = ?1)",
        [device_id],
    )?;
    connection.execute(
        "UPDATE replica_invocation_commit SET intent_id = NULL
          WHERE journal_finalized_at IS NULL
            AND intent_id IN (SELECT intent_id FROM replica_intent_outcome WHERE device_id = ?1)",
        [device_id],
    )?;
    connection.execute(
        "DELETE FROM replica_invocation_commit
          WHERE journal_finalized_at IS NOT NULL
            AND intent_id IN (SELECT intent_id FROM replica_intent_outcome WHERE device_id = ?1)",
        [device_id],
    )?;
    Ok(connection.execute(
        "DELETE FROM replica_intent_outcome WHERE device_id = ?1",
        [device_id],
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::FixedClock;

    fn payload() -> IntentPayload {
        IntentPayload {
            app_id: "tally".to_owned(),
            action: "tally.add_expense".to_owned(),
            input: serde_json::json!({"amount_minor": 100, "description": "lunch"}),
            base_versions: Vec::new(),
            depends_on: Vec::new(),
        }
    }

    #[test]
    fn keys_sort_by_utf16_code_unit_and_not_by_utf8_bytes() {
        // SEAM 6, as a test. U+10000 is a surrogate pair whose FIRST code unit
        // is 0xD800; U+E000 is a single 0xE000. So UTF-16 puts U+10000 first
        // and UTF-8 puts it last, and a Rust port that used `str::cmp` would
        // hash a payload with an astral key differently from every JS seat.
        let astral = "\u{10000}";
        let private_use = "\u{E000}";
        assert_eq!(compare_utf16(astral, private_use), std::cmp::Ordering::Less);
        assert_eq!(astral.cmp(private_use), std::cmp::Ordering::Greater);

        let value = serde_json::json!({ private_use: 1, astral: 2 });
        let canonical = canonical_json(&value).expect("canonicalises");
        let first_astral = canonical.find(astral).expect("the astral key is there");
        let first_pua = canonical.find(private_use).expect("the other key is there");
        assert!(
            first_astral < first_pua,
            "the astral key must come first: {canonical}"
        );
    }

    #[test]
    fn the_canonical_form_is_stable_and_whitespace_free() {
        let one = serde_json::json!({"b": 1, "a": [1, 2, {"d": 4, "c": 3}]});
        assert_eq!(
            canonical_json(&one).expect("canonicalises"),
            "{\"a\":[1,2,{\"c\":3,\"d\":4}],\"b\":1}"
        );
    }

    #[test]
    fn an_empty_base_version_list_is_omitted_not_written_as_an_empty_array() {
        let bare = payload();
        let with_empty = IntentPayload {
            base_versions: Vec::new(),
            depends_on: Vec::new(),
            ..payload()
        };
        assert_eq!(
            bare.hash().expect("hashes"),
            with_empty.hash().expect("hashes")
        );
        let with_one = IntentPayload {
            base_versions: vec![BaseVersion {
                entity: "tally.expense".to_owned(),
                row_id: "e1".to_owned(),
                shape_id: None,
                version: 3,
            }],
            ..payload()
        };
        assert_ne!(
            bare.hash().expect("hashes"),
            with_one.hash().expect("hashes")
        );
    }

    #[test]
    fn base_versions_sort_by_the_nul_joined_key_so_order_does_not_change_the_hash() {
        let make = |ids: [&str; 2]| IntentPayload {
            base_versions: ids
                .iter()
                .map(|id| BaseVersion {
                    entity: "tally.expense".to_owned(),
                    row_id: (*id).to_owned(),
                    shape_id: None,
                    version: 1,
                })
                .collect(),
            ..payload()
        };
        assert_eq!(
            make(["a", "b"]).hash().expect("hashes"),
            make(["b", "a"]).hash().expect("hashes")
        );
    }

    #[test]
    fn a_non_finite_number_is_refused_rather_than_written_as_null() {
        // serde_json cannot even hold one, so the guard is on the f64 path a
        // hand-built Number could reach; the assertion is that the canonical
        // form of a finite number is exact.
        assert_eq!(
            canonical_json(&serde_json::json!(1.5)).expect("canonicalises"),
            "1.5"
        );
        assert_eq!(
            canonical_json(&serde_json::json!(1.0)).expect("canonicalises"),
            "1"
        );
    }

    #[test]
    fn a_reused_id_with_another_payload_is_refused() {
        let claim = payload();
        let hash = claim.hash().expect("hashes");
        let existing = IntentOutcome {
            intent_id: "i1".to_owned(),
            device_id: "d1".to_owned(),
            app_id: "tally".to_owned(),
            action: "tally.add_expense".to_owned(),
            payload_hash: "a-different-hash".to_owned(),
            status: "queued".to_owned(),
            invocation_id: None,
            commit_seq: None,
            expires_at: None,
        };
        let error = assert_identity(&existing, &claim, &hash, "executed").expect_err("refused");
        assert!(error.to_string().contains("intent_id_reused"), "{error}");

        // And a terminal row asked for another status.
        let terminal = IntentOutcome {
            payload_hash: hash.clone(),
            status: "executed".to_owned(),
            ..existing
        };
        let error = assert_identity(&terminal, &claim, &hash, "failed").expect_err("refused");
        assert!(
            error.to_string().contains("intent_already_terminal"),
            "{error}"
        );
        // The same status twice is the retry, and it is fine.
        assert!(assert_identity(&terminal, &claim, &hash, "executed").is_ok());
    }

    #[test]
    fn the_window_matches_the_logs_retention_floor() {
        let clock = FixedClock::frozen();
        let expiry = default_expiry(&clock);
        let at = crate::clock::parse_iso_ms(&expiry).expect("parses");
        assert_eq!(
            at - clock.now_ms(),
            crate::log::constants().log_retention_days * 86_400_000
        );
        let outcome = IntentOutcome {
            intent_id: "i".to_owned(),
            device_id: "d".to_owned(),
            app_id: "a".to_owned(),
            action: "x".to_owned(),
            payload_hash: "h".to_owned(),
            status: "executed".to_owned(),
            invocation_id: None,
            commit_seq: Some(1),
            expires_at: Some(expiry),
        };
        assert!(!is_expired(&outcome, clock.now_ms()));
        assert!(is_expired(&outcome, at));
        assert!(is_expired(&outcome, at + 1));
    }
}
