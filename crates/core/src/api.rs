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

use crate::convert::value_from_wire;
use crate::error::{CoreError, Result};

/// THE BYTE DOOR'S READ HALF, as the wire spells it (D-1020-DC1).
///
/// One answer per ref, in the order they were asked, **including the ones that
/// resolved to nothing** — a caller zipping a short list against its own rows
/// would silently pair a photograph with another photograph's bytes.
///
/// The batch is capped rather than refused-if-large: a grid asking for two
/// screenfuls gets one screenful and asks again, which is what a cursor is for
/// everywhere else in this API.
pub fn content_urls(vault: &Vault, request: &wire::ContentUrlRequest) -> Result<wire::ContentUrls> {
    let urls = request
        .refs
        .iter()
        .take(MAX_CONTENT_URLS)
        .map(|reference| {
            let found = vault.content_location(
                &reference.content_id,
                &reference.owner_type,
                &reference.owner_id,
            )?;
            Ok(wire::ContentUrl {
                content_id: found.content_id,
                // A PATH AND NOT BYTES. See `centraid_vault::content`: the
                // platform opens the file, so caching and range requests stay
                // where they belong and the core never buffers a photograph.
                path: found.path.map(|path| path.to_string_lossy().into_owned()),
                media_type: found.media_type,
                byte_size: found.byte_size,
                embeddable: found.embeddable,
                absent_reason: found.absent_reason,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(wire::ContentUrls { urls })
}

/// How many locations one request may ask for.
///
/// A screenful and then some. Photos' grid draws three columns and a phone
/// shows about thirty rows before a member is scrolling rather than looking, so
/// a hundred covers a page with room, and the cost of one over the cap is one
/// more request rather than a refusal.
pub const MAX_CONTENT_URLS: usize = 100;

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
        held_thumbnail: query.with_held_thumbnail,
        note_body: query.with_note_body,
    })?;

    Ok(wire::Page {
        rows: answer
            .rows
            .into_iter()
            .map(|image| wire::Row {
                values: query
                    .select
                    .iter()
                    .map(|column| output_name(column).to_owned())
                    // THE THUMBNAIL RIDES AFTER THE NAMED COLUMNS, always in
                    // the same position (#1025, D-1025-S7-20). Positional rows
                    // are the door's contract, so a computed column has to have
                    // ONE place — appended — rather than being spliced in
                    // wherever a caller happened to put it in `select`, which
                    // is a list of REAL columns and must stay one.
                    .chain(
                        query
                            .with_held_thumbnail
                            // THREE COMPUTED COLUMNS, IN THIS ORDER, and the
                            // order is the contract (#1025 S5): a positional
                            // row is the door's shape, so a shell counts past
                            // its own `select` list to reach them.
                            // `PhotosReads`' index constants are the other
                            // half of this sentence.
                            .then_some([
                                centraid_vault::page::HELD_THUMBNAIL_COLUMN,
                                centraid_vault::page::HELD_ORIGINAL_HASH_COLUMN,
                                centraid_vault::page::HELD_ORIGINAL_HELD_COLUMN,
                            ])
                            .into_iter()
                            .flatten()
                            .map(ToOwned::to_owned),
                    )
                    // NOTE BODY RIDES AFTER THE THUMBNAIL COLUMNS when both
                    // are asked, and alone after `select` when only it is
                    // (#1025 live-notes, R-NOTES-1). Same positional contract.
                    .chain(
                        query
                            .with_note_body
                            .then(|| centraid_vault::page::NOTE_BODY_COLUMN.to_owned()),
                    )
                    .map(|column| {
                        image.get(&column).map_or_else(
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

/// The name a projected entry answers to in the row image.
///
/// A select entry is either a plain column or `<expression> AS <alias>`
/// (#1020, close pass, D-1020-CL5): the vault renders the whole entry into the
/// SQL, and SQLite names the resulting column after the alias. Keying the image
/// by the entry's own text worked while every entry was a bare column and
/// answered NULL the moment one was not — which is how Locker's `has_totp`
/// would have crossed the wire as "no code" while the vault said otherwise.
fn output_name(entry: &str) -> &str {
    let lower = entry.to_ascii_lowercase();
    lower
        .rfind(" as ")
        .map_or(entry, |at| entry[at + 4..].trim())
}

/// Run a command through D1's gate order, **under the principal the HANDLE
/// holds** (#1029 §1).
///
/// The principal used to be read off `request.principal`, and that was right
/// while a gateway served seats: the gateway resolved an enrolled device at the
/// ALPN boundary, stamped the result on the request, and every authority
/// decision downstream read that field — which also let a thin seat ask "what
/// would this OTHER caller be allowed".
///
/// **There is no other caller.** The phone is the only host that opens a vault
/// (#1029 §6), so the only principal a command can run under is the owner of
/// the device it is running on, and the handle knows that without being told.
/// A field on the request could then only do one of two things: agree with the
/// handle, or be a caller's claim about its own authority — and the second is
/// not a thing a local write is allowed to assert.
/// `changes` IS HOW A SCREEN LEARNS THE WRITE HAPPENED (#1029 §1). The commit
/// guard's `update_hook` says which tables moved, and this is where that
/// answer becomes a change event on the queue a shell drains. Before it, the
/// only producer of change events was the seat's applier — so on a phone with
/// no seat nothing ever pushed one, and every screen was a poll or a lie.
pub fn invoke(
    vault: &Vault,
    registry: &Registry,
    principal: &centraid_vault::Principal,
    request: &wire::Command,
    changes: &crate::events::ChangeFeed,
) -> Result<wire::CommandOutcome> {
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

    let outcome = vault.execute(registry, principal, &Command::new(&request.name, input))?;
    // AFTER THE COMMIT, because that is when the guard reads its census, and a
    // screen redrawn from a transaction that could still roll back is the
    // failure this ordering exists to prevent.
    changes.tables_changed(&outcome.tables);
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

// THE REVEAL ROUTER IS GONE, AND THE RULE IT ENCODED SURVIVES IN THE COMMAND
// (#1029 §1). `reveal` answered "who performs this reveal" — the gateway for a
// sealed column, the seat for a Locker cell — and the answer was the trust
// premise: a Locker key must never be on a host the member does not hold.
// There is one host (#1029 §6), so the question has one answer and nothing
// ever called this function: a Locker reveal runs through `locker.reveal` in
// `crates/vault/src/commands/locker.rs`, behind `crate::locker`'s unlock, and
// the SEALED-COLUMN arm served connector tokens, which leave with the
// connectors. `SealedSubject` still has no Locker representation, so the
// structural half of the rule is where it always was — in `crates/vault`.

/// MAKE THIS FILE A VAULT (#1029 W5, hand-off 1).
///
/// The door `Core::open` with `create` left missing. `Vault::create` lays the
/// migrations down; `Vault::found` writes the two rows that make those tables a
/// vault — `core_vault` and the owner's `core_party` — inside one commit, and
/// until this function existed nothing over the C ABI could reach it. A phone
/// could create a file that could never say which vault it was, which is
/// exactly what `Shelf.FoundRefusal.NOT_FOUNDED` was refusing honestly.
///
/// **A SECOND FOUND IS REFUSED, AND THE VAULT THAT IS HERE IS LEFT ALONE.**
/// `Vault::found` mints a fresh id and inserts unconditionally, so running it
/// twice would leave two `core_vault` rows in one file — and `Vault::vault_id`
/// reads `ORDER BY vault_id LIMIT 1`, so the file would answer whichever id
/// sorted first. That is a vault whose identity depends on a random draw. The
/// refusal carries `ERROR_CODE_VAULT_ALREADY_HELD` and names the id already
/// here, so a shell that raced itself can tell "I founded it" from "something
/// is wrong".
pub fn found(vault: &Vault, request: &wire::FoundRequest) -> Result<wire::FoundResponse> {
    if let Some(vault_id) = vault.vault_id()? {
        return Err(CoreError::VaultAlreadyHeld { vault_id });
    }
    let founded = vault.found(&request.display_name, &request.owner_name)?;
    Ok(wire::FoundResponse {
        vault_id: founded.vault_id,
        owner_party_id: founded.owner_party_id,
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
            with_held_thumbnail: false,
            with_note_body: false,
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

    /// HAND-OFF 1: THE DOOR EXISTS AND IT WRITES THE ROW THE SHELF READS.
    ///
    /// The whole defect in one test: `Vault::create` lays the migrations down
    /// and leaves a file that cannot say which vault it is, and after
    /// [`found`] the same file answers its own id and its own name through the
    /// one statement `VaultRoster.identify` uses.
    #[test]
    fn founding_turns_a_created_file_into_a_vault_that_can_name_itself() {
        let scratch = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("the directory is made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault file");

        // BEFORE: the migrations are laid and there is no vault in them.
        assert_eq!(vault.vault_id().expect("read"), None);

        let answer = found(
            &vault,
            &wire::FoundRequest {
                display_name: "Tahoe".to_owned(),
                owner_name: "Me".to_owned(),
            },
        )
        .expect("the found is answered");
        assert!(!answer.vault_id.is_empty());
        assert!(!answer.owner_party_id.is_empty());

        // AFTER: the file names itself, and the name is the one that was sent.
        assert_eq!(
            vault.vault_id().expect("read"),
            Some(answer.vault_id.clone())
        );
        assert_eq!(
            vault.display_name().expect("read").as_deref(),
            Some("Tahoe")
        );
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// A SECOND FOUND IS REFUSED AND THE FIRST VAULT IS LEFT ALONE.
    ///
    /// `Vault::found` inserts unconditionally, so without this guard one file
    /// would hold two `core_vault` rows and `Vault::vault_id`'s
    /// `ORDER BY vault_id LIMIT 1` would answer whichever id sorted first —
    /// a vault whose identity depends on a random draw.
    #[test]
    fn a_second_found_is_refused_and_the_vault_already_here_is_untouched() {
        let scratch = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("the directory is made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault file");
        let first = found(
            &vault,
            &wire::FoundRequest {
                display_name: "First".to_owned(),
                owner_name: "Me".to_owned(),
            },
        )
        .expect("the first found is answered");

        let refusal = found(
            &vault,
            &wire::FoundRequest {
                display_name: "Second".to_owned(),
                owner_name: "Me".to_owned(),
            },
        )
        .expect_err("a second found is refused");
        assert_eq!(refusal.code(), wire::ErrorCode::VaultAlreadyHeld);
        assert!(refusal.to_string().contains(&first.vault_id), "{refusal}");

        // Nothing moved: the id and the name are the first found's.
        assert_eq!(vault.vault_id().expect("read"), Some(first.vault_id));
        assert_eq!(
            vault.display_name().expect("read").as_deref(),
            Some("First")
        );
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// An empty name is a REAL STATE, not a validation failure: the shell draws
    /// "No vault yet" over it and the member renames the vault from inside it.
    #[test]
    fn an_empty_display_name_founds_a_vault_that_is_simply_unnamed() {
        let scratch = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("the directory is made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault file");
        let answer = found(&vault, &wire::FoundRequest::default()).expect("founded");
        assert!(!answer.vault_id.is_empty());
        assert_eq!(vault.display_name().expect("read").as_deref(), Some(""));
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

    /// THE KEY DOOR IS DELETED AT THE TYPE LEVEL (#1020, D-1020-L2).
    ///
    /// The router that used to ask "gateway or seat" is gone with the roles
    /// (#1029 §1), and the half of the rule that was never about roles is
    /// still enforced by `crates/vault`: `SealedSubject` has no Locker
    /// representation, so no sealed-column path can be written to open a
    /// Locker cell even by mistake.
    #[test]
    fn the_sealed_subject_has_no_locker_representation() {
        let refusal =
            centraid_vault::SealedSubject::new("locker", "item").expect_err("no such subject");
        assert!(
            refusal.to_string().contains("unwrapped only on the seat"),
            "{refusal}"
        );
        assert!(centraid_vault::SealedSubject::new("sync", "connection_credential").is_ok());
    }
}
