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
//! | [`reveal`] | live, by ROLE | the gateway reveals a sealed COLUMN and cannot reveal a Locker cell at all; a seat unwraps `K` itself (D-1020-L2) |
//! | [`content`] | **stub** | content path minting is wave 3 |

use centraid_api_proto::core_v1 as wire;
use centraid_vault::Vault;
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::page::KeysetPage;

use crate::config::Role;
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
    let Some(order) = &query.order else {
        return Err(CoreError::InvalidRequest {
            detail: "a page query carries no order; a keyset cursor is read off the row by the \
                     two columns the ORDER BY names"
                .to_owned(),
        });
    };
    // THE SHAPE CROSSES THE BOUNDARY; THE SQL DOES NOT. Rendering the statement
    // here would be `crates/core` knowing the query language, which the
    // `sql-confinement` rule catches — and it is right to: the statement's
    // shape is this crate's business and its syntax is the vault's.
    let answer = vault.keyset_page(&KeysetPage {
        name: query.name.clone(),
        select: query.select.clone(),
        from: query.from.clone(),
        predicate: query.r#where.clone(),
        binds: query
            .bind
            .iter()
            .map(value_from_wire)
            .collect::<Result<Vec<_>>>()?,
        sort_column: order.sort_column.clone(),
        pk_column: order.pk_column.clone(),
        descending: order.descending,
        // Required and validated by the vault, not defaulted here: proto3
        // cannot say "required", so the validation is the contract.
        limit: i64::from(request.limit),
        after: request
            .after
            .as_ref()
            .map(|cursor| (cursor.sort_key.clone(), cursor.pk.clone())),
    })?;

    Ok(wire::Page {
        rows: answer
            .rows
            .into_iter()
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
        next: answer
            .next
            .map(|(sort_key, pk)| wire::PageCursor { sort_key, pk }),
    })
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
        // THE NUMBER A SEAT SETTLES AGAINST. `None` when the handler wrote
        // nothing a session saw, which is an honest absence: there is no commit
        // to wait for, and the seat's version-set path takes over.
        commit_seq: outcome.commit_seq.map(i64::unsigned_abs),
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

/// Reveal a sealed value — **answered by ROLE**, and the `locker` schema is
/// not answerable on the gateway at all (#1020, D-1020-L2, D-1020-L3).
///
/// Three answers, and the split is the trust premise:
///
/// | Role | Schema | Answer |
/// |---|---|---|
/// | [`Role::Gateway`] | `locker` | **refused**, structurally: the value the
///   judgement needs cannot be built (`centraid_vault::SealedSubject::new`) |
/// | [`Role::Gateway`] | anything else | judged and revealed — a connector
///   token is host-readable **by design** (W6-D1) |
/// | `Role::Seat` | `locker` | unwrapped **locally**, by
///   `centraid_seat::locker`, behind the member's unlock |
///
/// A reveal is still **online-only** on a seat for the reason it always was: a
/// mass reveal must never be queued, replayed, or answered from a durable
/// store, and the receipt the gateway owes has to land before the plaintext
/// exists. `export` carries nothing in and its result is every secret, which
/// is why that refusal is structural rather than a policy somebody can relax.
pub fn reveal(
    role: &Role,
    schema: &str,
    table: &str,
    app_id: &str,
    action: &str,
) -> Result<RevealRoute> {
    match role {
        Role::Gateway => {
            // THE KEY DOOR'S DELETION, AT THIS LAYER. The subject is what the
            // authority plane judges, and it has no representation for
            // Locker — so this arm cannot be written to succeed.
            let subject = centraid_vault::SealedSubject::new(schema, table).map_err(|refusal| {
                CoreError::InvalidRequest {
                    detail: refusal.to_string(),
                }
            })?;
            Ok(RevealRoute::Gateway { subject })
        }
        Role::Seat { .. } => {
            if schema == centraid_vault::BLIND_SCHEMA {
                // A SEAT UNWRAPS LOCALLY — and it still needs the gateway,
                // for the receipt and for nothing else.
                return Ok(RevealRoute::Seat {
                    schema: schema.to_owned(),
                    table: table.to_owned(),
                });
            }
            // The sealed-column class lives on the host, so a seat asking for
            // one is asking the gateway.
            Err(CoreError::OnlineOnly {
                app_id: app_id.to_owned(),
                action: action.to_owned(),
            })
        }
    }
}

/// Who performs a reveal. There is no arm in which the gateway performs a
/// Locker one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevealRoute {
    /// The gateway unseals a sealed **column** — a connector token — under its
    /// own DEK, for a principal the authority plane allowed.
    Gateway {
        subject: centraid_vault::SealedSubject,
    },
    /// The seat unwraps `K` and opens the cell itself; the gateway's only part
    /// is the receipt (`locker.reveal_receipt`).
    Seat { schema: String, table: String },
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

    /// The refusal arrives with the code a shell branches on.
    ///
    /// The *variant* is now the vault's (`InvalidInput`, because the vault is
    /// what validates a page's shape since the SQL moved there), and what
    /// matters is that it still reaches a shell as `INVALID_REQUEST` rather
    /// than as an internal error the shell would restart the core over.
    #[test]
    fn a_zero_limit_and_a_missing_order_column_reach_the_shell_as_invalid_request() {
        let scratch = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("the directory is made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");

        let zero = page(
            &vault,
            &wire::PageRequest {
                query: Some(query(&["party_id", "created_at"], "created_at", "party_id")),
                limit: 0,
                after: None,
            },
        )
        .expect_err("a zero limit is refused");
        assert_eq!(zero.code(), wire::ErrorCode::InvalidRequest);

        // `created_at` orders and is NOT selected: the cursor could not exist.
        let unprojected = page(
            &vault,
            &wire::PageRequest {
                query: Some(query(&["party_id"], "created_at", "party_id")),
                limit: 10,
                after: None,
            },
        )
        .expect_err("an unprojected order column is refused");
        assert_eq!(unprojected.code(), wire::ErrorCode::InvalidRequest);
        assert!(unprojected.to_string().contains("created_at"));
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
        // Refused HERE rather than by the vault: a `KeysetPage` has no way to
        // express "no order", so the absence has to be caught at the wire
        // boundary where it is representable.
        let error = page(
            &vault,
            &wire::PageRequest {
                query: Some(unordered),
                limit: 10,
                after: None,
            },
        )
        .expect_err("a query with no order is refused");
        assert!(matches!(error, CoreError::InvalidRequest { .. }));
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

    /// THE KEY DOOR IS DELETED AT THIS LAYER TOO (#1020, D-1020-L2).
    ///
    /// A gateway asked for a Locker cell cannot be written to succeed: the
    /// subject the authority plane judges has no Locker representation, so
    /// this is the refusal rather than a policy check. A gateway asked for a
    /// **sealed column** still answers, because a connector token is
    /// host-readable by design (W6-D1) — and that asymmetry is the premise.
    #[test]
    fn a_gateway_cannot_route_a_locker_reveal_and_can_route_a_connector_token() {
        let refusal = reveal(&Role::Gateway, "locker", "item", "locker", "reveal")
            .expect_err("a gateway has no Locker reveal");
        assert_eq!(refusal.code(), wire::ErrorCode::InvalidRequest);
        assert!(
            refusal.to_string().contains("unwrapped only on the seat"),
            "{refusal}"
        );

        let route = reveal(
            &Role::Gateway,
            "sync",
            "connection_credential",
            "connectors",
            "refresh",
        )
        .expect("a connector token is the gateway's to open");
        assert!(matches!(route, RevealRoute::Gateway { .. }));
    }

    /// A SEAT UNWRAPS A LOCKER CELL ITSELF, and asks the gateway for a sealed
    /// column — which is online-only, exactly as it was.
    #[test]
    fn a_seat_unwraps_a_locker_cell_and_forwards_a_sealed_column() {
        let seat = Role::Seat {
            kind: crate::config::SeatKind::Replicated,
            gateway: Vec::new(),
        };
        assert_eq!(
            reveal(&seat, "locker", "item", "locker", "reveal").expect("routed"),
            RevealRoute::Seat {
                schema: "locker".to_owned(),
                table: "item".to_owned()
            }
        );
        let refusal = reveal(
            &seat,
            "sync",
            "connection_credential",
            "connectors",
            "refresh",
        )
        .expect_err("a sealed column is the gateway's");
        assert!(matches!(refusal, CoreError::OnlineOnly { .. }));
    }
}
