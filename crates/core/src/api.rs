//! The v1 twin of v0's `VaultApi` — the surface a handler sees.
//!
//! Eight verbs, and the honest state of each. A stub here is a **typed
//! refusal**, never an empty answer: an empty page reads as "no data" and the
//! truth is "this build cannot answer yet", and those produce different
//! screens (#1020, D-1020-C11).
//!
//! | Verb | State | Why |
//! |---|---|---|
//! | [`page`] | live | D1's `page_raw` plus the access plane's filters and mask |
//! | [`invoke`] | live | D1's command plane, gate order and all |
//! | [`describe`] | live | the registered definition, so a shell can render a form |
//! | [`parked`] | live | the outcomes waiting on somebody's decision |
//! | [`search`] | **stub** | the FTS plane is wave 4 |
//! | [`resolve`] | **stub** | entity resolution is wave 4 |
//! | [`reveal`] | **online-only** | a sealed reveal is Locker's permit and never a queued write |
//! | [`content`] | **stub** | content path minting is wave 3 |

use centraid_api_proto::core_v1 as wire;
use centraid_vault::Vault;
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::page::{MAX_PAGE_ROWS, RawPage};

use crate::convert::value_from_wire;
use crate::error::{CoreError, Result};

/// One page of rows, as the wire spells it.
///
/// `limit` is **required and validated**, not defaulted. Proto3 cannot say
/// "required", so the validation is the contract: a zero is a request for an
/// unbounded read, and defaulting it would serve one.
pub fn page(vault: &Vault, request: &wire::PageRequest) -> Result<wire::Page> {
    let Some(query) = &request.query else {
        return Err(CoreError::InvalidRequest {
            detail: "a page request carries no query".to_owned(),
        });
    };
    if request.limit == 0 {
        return Err(CoreError::InvalidRequest {
            detail: "a page limit is required and must be > 0; a default is how an unbounded \
                     read gets written by accident"
                .to_owned(),
        });
    }
    let Some(order) = &query.order else {
        return Err(CoreError::InvalidRequest {
            detail: "a page query carries no order; a keyset cursor is read off the row by the \
                     two columns the ORDER BY names"
                .to_owned(),
        });
    };
    if query.select.is_empty() {
        return Err(CoreError::InvalidRequest {
            detail: "a page query selects nothing".to_owned(),
        });
    }
    // BOTH ORDER COLUMNS must be in the projection. There is no `key_of`
    // callback: the cursor IS the two columns' values, read off the row, so a
    // projection missing one is a page whose `next` cannot exist.
    for column in [&order.sort_column, &order.pk_column] {
        if !query.select.iter().any(|selected| selected == column) {
            return Err(CoreError::InvalidRequest {
                detail: format!(
                    "`{column}` is an order column and is not in the projection; the cursor is \
                     read off the row by those two columns"
                ),
            });
        }
    }

    let direction = if order.descending { "DESC" } else { "ASC" };
    let mut binds: Vec<centraid_vault::Value> = query
        .bind
        .iter()
        .map(value_from_wire)
        .collect::<Result<Vec<_>>>()?;
    let mut clauses: Vec<String> = query
        .r#where
        .as_ref()
        .map(|text| vec![format!("({text})")])
        .unwrap_or_default();
    if let Some(after) = &request.after {
        // The keyset predicate, as a tuple comparison on the two order
        // columns. A `>` on the sort column alone would skip every row that
        // ties with the cursor's sort value, and ties are the normal case for
        // a date.
        let comparison = if order.descending { "<" } else { ">" };
        clauses.push(format!(
            "({sort}, {pk}) {comparison} (?, ?)",
            sort = centraid_vault::log::quoted(&order.sort_column),
            pk = centraid_vault::log::quoted(&order.pk_column),
        ));
        binds.push(centraid_vault::Value::Text(after.sort_key.clone()));
        binds.push(centraid_vault::Value::Text(after.pk.clone()));
    }
    let predicate = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    let projection = query
        .select
        .iter()
        .map(|column| centraid_vault::log::quoted(column))
        .collect::<Vec<_>>()
        .join(", ");
    let limit = i64::from(request.limit).min(MAX_PAGE_ROWS);
    let sql = format!(
        "SELECT {projection} FROM {from}{predicate} ORDER BY {sort} {direction}, {pk} {direction} \
         LIMIT {probe}",
        from = centraid_vault::log::quoted(&query.from),
        sort = centraid_vault::log::quoted(&order.sort_column),
        pk = centraid_vault::log::quoted(&order.pk_column),
        // The `+1` PROBE: it is what separates "the window filled" from "the
        // rows ended", and without it `next` would point past the end.
        probe = limit + 1,
    );

    let rows = vault.page_raw(&RawPage {
        sql,
        binds,
        limit: limit + 1,
    })?;
    let filled = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
    let next = if filled {
        rows.get(usize::try_from(limit).unwrap_or(0).saturating_sub(1))
            .map(|row| wire::PageCursor {
                sort_key: cursor_text(row, &order.sort_column),
                pk: cursor_text(row, &order.pk_column),
            })
    } else {
        // ABSENT when the rows ended. Never a `truncated` flag and never a
        // cursor that points past the end.
        None
    };
    Ok(wire::Page {
        rows: rows
            .into_iter()
            .take(usize::try_from(limit).unwrap_or(0))
            .map(|image| wire::Row {
                values: query
                    .select
                    .iter()
                    .map(|column| {
                        image.get(column).map_or_else(
                            || wire::Value {
                                kind: Some(wire::value::Kind::Null(wire::NullValue {})),
                            },
                            crate::convert::value_to_wire,
                        )
                    })
                    .collect(),
            })
            .collect(),
        next,
    })
}

/// One cell as cursor text.
///
/// A cursor is text on the wire whatever the column's storage class, because it
/// is an opaque token a caller hands back. The comparison is then text against
/// text, which is why the sort column must be one whose lexical order is its
/// real order — an ISO timestamp, an id. That is a constraint on the query's
/// author and not something this function can check.
fn cursor_text(row: &centraid_vault::RowImage, column: &str) -> String {
    match row.get(column) {
        Some(centraid_vault::Value::Text(text)) => text.clone(),
        Some(centraid_vault::Value::Integer(int)) => int.to_string(),
        Some(other) => other.to_wire_json(),
        None => String::new(),
    }
}

/// Run a command through D1's gate order.
pub fn invoke(
    vault: &Vault,
    registry: &Registry,
    request: &wire::Command,
) -> Result<wire::CommandOutcome> {
    let principal = crate::convert::principal_from_wire(request.principal.as_ref())?;
    if request.invoke_key.is_empty() {
        // REQUIRED, unlike v0, where the fallback was the call's ORDINAL and
        // only stable for a handler making the same call sequence every time.
        // Without it a replayed intent can re-execute a command that already
        // committed.
        return Err(CoreError::InvalidRequest {
            detail: "a command carries no invoke_key; an ordinal fallback is only stable for a \
                     handler that makes the same calls every time"
                .to_owned(),
        });
    }
    let input: serde_json::Value = if request.input.is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_slice(&request.input).map_err(|error| CoreError::InvalidRequest {
            detail: format!("a command's input is canonical JSON in bytes: {error}"),
        })?
    };

    let outcome = vault.execute(registry, &principal, &Command::new(&request.name, input))?;
    Ok(wire::CommandOutcome {
        status: match outcome.status {
            CommandStatus::Executed => wire::CommandStatus::Executed,
            CommandStatus::Failed => wire::CommandStatus::Failed,
        } as i32,
        output: serde_json::to_vec(&outcome.output).map_err(|error| CoreError::Invariant {
            context: format!("a handler's own output is not JSON: {error}"),
        })?,
        // THE AUTHOR'S SENTENCE, never the raw predicate. The predicate reaches
        // the audit trail and never a member.
        reason: outcome.reason.unwrap_or_default(),
        invocation_id: outcome.invocation_id,
        receipt_id: outcome.receipt_id,
        revoked_at: None,
    })
}

/// The registered definition, so a shell can render a form for it.
pub fn describe(registry: &Registry, name: &str) -> Result<serde_json::Value> {
    let entry = registry.get(name).ok_or_else(|| {
        CoreError::Vault(centraid_vault::VaultError::UnknownCommand {
            name: name.to_owned(),
        })
    })?;
    Ok(serde_json::json!({
        "name": entry.definition.name,
        "ownerSchema": entry.definition.owner_schema,
        "inputSchema": entry.schema(),
        "idempotency": entry.definition.idempotency.as_str(),
        "risk": entry.definition.risk.as_str(),
        "confirm": entry.definition.confirm,
        // THE FLAG A SEAT READS to refuse a queue. It lives on the definition
        // (D1's `CommandDefinition`) rather than in a list of action names,
        // because a list is a second place to forget.
        "onlineOnly": entry.definition.online_only,
        "sealedInput": entry.definition.sealed_input,
    }))
}

/// The outcomes waiting on somebody's decision.
pub fn parked(vault: &Vault) -> Result<Vec<wire::Outcome>> {
    // THE SELECT IS THE VAULT'S. `sql-confinement` keeps SQL out of this crate,
    // and it is right to: a door that read the ledger itself would be a second
    // reader of a table `crates/vault` owns the shape of.
    let outcomes = vault.read(|connection| {
        centraid_vault::intents::list_outcomes_with_status(connection, "parked")
    })?;
    Ok(outcomes
        .into_iter()
        .map(|outcome| wire::Outcome {
            intent_id: outcome.intent_id,
            status: wire::IntentStatus::Parked as i32,
            commit_seq: outcome.commit_seq.map(i64::unsigned_abs),
            // The waits, the conflicts and the produced rows are columns the
            // ledger carries and this reader does not yet project. EMPTY rather
            // than invented: a `waiting_on` this door guessed would tell a
            // member to chase the wrong person.
            waiting_on: Vec::new(),
            conflicts: Vec::new(),
            produced: Vec::new(),
            answered_versions: Vec::new(),
            reason: String::new(),
        })
        .collect())
}

/// Full-text search. **Stub**: the FTS plane is wave 4.
pub fn search(_query: &str) -> Result<Vec<wire::Row>> {
    Err(CoreError::NotYetAvailable {
        what: "search",
        lands_in: "wave 4 (the FTS plane)",
    })
}

/// Entity resolution. **Stub**: wave 4.
pub fn resolve(_handle: &str) -> Result<serde_json::Value> {
    Err(CoreError::NotYetAvailable {
        what: "resolve",
        lands_in: "wave 4 (entity resolution)",
    })
}

/// Reveal a sealed value. **Online-only, always.**
///
/// Not a stub and not a capability gap: a mass reveal must never be queued,
/// replayed, or answered from a durable store, so a seat with no gateway
/// refuses rather than deferring. `export` carries nothing in and its result is
/// every secret, which is why the refusal is structural rather than a policy
/// somebody can relax.
pub fn reveal(is_gateway: bool, app_id: &str, action: &str) -> Result<serde_json::Value> {
    if !is_gateway {
        return Err(CoreError::OnlineOnly {
            app_id: app_id.to_owned(),
            action: action.to_owned(),
        });
    }
    Err(CoreError::NotYetAvailable {
        what: "reveal",
        lands_in: "wave 3 (the Locker key plane)",
    })
}

/// Mint a path for content. **Stub**: wave 3.
pub fn content(_content_id: &str) -> Result<String> {
    Err(CoreError::NotYetAvailable {
        what: "content",
        lands_in: "wave 3 (content path minting)",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(select: &[&str], sort: &str, pk: &str) -> wire::PageQuery {
        wire::PageQuery {
            name: "test".to_owned(),
            select: select.iter().map(|c| (*c).to_owned()).collect(),
            from: "core_party".to_owned(),
            r#where: None,
            bind: Vec::new(),
            order: Some(wire::PageOrder {
                sort_column: sort.to_owned(),
                pk_column: pk.to_owned(),
                descending: false,
            }),
        }
    }

    #[test]
    fn a_zero_limit_is_refused_rather_than_defaulted() {
        let scratch = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("the directory is made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        let error = page(
            &vault,
            &wire::PageRequest {
                query: Some(query(&["party_id", "created_at"], "created_at", "party_id")),
                limit: 0,
                after: None,
            },
        )
        .expect_err("it refuses");
        assert!(matches!(error, CoreError::InvalidRequest { .. }));
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn a_projection_missing_an_order_column_is_refused() {
        let scratch = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        // `created_at` orders and is NOT selected: the cursor could not exist.
        let error = page(
            &vault,
            &wire::PageRequest {
                query: Some(query(&["party_id"], "created_at", "party_id")),
                limit: 10,
                after: None,
            },
        )
        .expect_err("it refuses");
        assert!(error.to_string().contains("created_at"));
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn a_query_with_no_order_is_refused() {
        let scratch = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        let mut unordered = query(&["party_id"], "created_at", "party_id");
        unordered.order = None;
        assert!(
            page(
                &vault,
                &wire::PageRequest {
                    query: Some(unordered),
                    limit: 10,
                    after: None,
                },
            )
            .is_err()
        );
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn the_stubs_are_typed_refusals_and_never_empty_answers() {
        assert!(matches!(
            search("anything"),
            Err(CoreError::NotYetAvailable { what: "search", .. })
        ));
        assert!(matches!(
            resolve("anything"),
            Err(CoreError::NotYetAvailable {
                what: "resolve",
                ..
            })
        ));
        assert!(matches!(
            content("anything"),
            Err(CoreError::NotYetAvailable {
                what: "content",
                ..
            })
        ));
    }

    /// A reveal on a seat is ONLINE-ONLY, not "not yet available". The two are
    /// different screens: one says "connect to your gateway", the other says
    /// "this build cannot".
    #[test]
    fn a_reveal_off_the_gateway_is_online_only_and_not_a_capability_gap() {
        assert!(matches!(
            reveal(false, "locker", "export"),
            Err(CoreError::OnlineOnly { .. })
        ));
        assert!(matches!(
            reveal(true, "locker", "export"),
            Err(CoreError::NotYetAvailable { what: "reveal", .. })
        ));
    }
}
