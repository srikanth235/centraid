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
//! | [`content`] | **stub** | content path minting is wave 3 |

use centraid_api_proto::core_v1 as wire;
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::page::KeysetPage;
use centraid_vault::{Principal, Vault};

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
            // BY WHAT THE GRID HAS: the owner's id (a photograph's, a
            // document's) when it names one, and the blob's hash otherwise.
            let asked = if reference.owner_id.is_empty() {
                &reference.content_id
            } else {
                &reference.owner_id
            };
            let found = vault.content_location(asked)?;
            // THE STORE, THE LIBRARY, OR NOWHERE (#1080 ruling 6). A path is
            // answered for the store only; an original the operating system's
            // library holds is named by the library's identifier, for the
            // shell to resolve.
            let (source, os_ref) = match (&found.path, found.os_ref) {
                (Some(_), _) => (wire::ContentSource::Store, String::new()),
                (None, Some(os_ref)) => (wire::ContentSource::OsLibrary, os_ref),
                (None, None) => (wire::ContentSource::None, String::new()),
            };
            Ok(wire::ContentUrl {
                content_id: reference.content_id.clone(),
                // A PATH AND NOT BYTES. See `centraid_vault::blob`: the
                // platform opens the file, so caching and range requests stay
                // where they belong and the core never buffers a photograph.
                path: found.path.map(|path| path.to_string_lossy().into_owned()),
                media_type: found.media_type,
                byte_size: found.byte_size,
                embeddable: found.embeddable,
                absent_reason: found.absent_reason,
                source: source as i32,
                os_ref,
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

/// **THE TABLES THE WIRE'S PAGE DOOR READS (2026-10-16).** `Request::Page` names
/// a table in `from`, and a door that reads any table by name is wider than any
/// screen needs: it would page the receipts, the provenance log, the Locker's
/// fields and passkeys, the money ledger and every revision snapshot for a
/// shell that asked. So it reads these thirteen and refuses the rest as an
/// invalid request, before the vault is asked.
///
/// The set is every `from` a shell sends today, read off `mobile/shared`'s
/// `PageQuery` builders and the Rust callers of the wire:
///
/// | Screens | Tables |
/// |---|---|
/// | The vault roster | `vault` |
/// | People (Home's tile counts the circle; its trash shelf pages the trashed) | `entity`, `person`, `vault` |
/// | Home's tiles | `entity`, `document`, `person`, `vault` |
/// | Trash (Docs, Photos, Tasks, People, Locker) | `entity` |
/// | Photos (grid, shelves, lightbox, collections, search, picker, places, album choice, editor) | `photo`, `entity`, `edge`, `container`, `place`, `derivative`, `blob` |
/// | Phone sync (Docs follows the phone through `follow.files`, #1127; whether a source was imported is its `origin`, and what a followed file last stated is its `source`) | `origin`, `source` |
/// | `with_minor_units` | `account` |
///
/// `account` has no shell caller: it is the one table whose `currency`
/// the `with_minor_units` arm is specified over, so the arm stays reachable
/// and tested; Home's money tile rides its own arm (`Request.money`).
///
/// A Locker item is an entity (#1135), so Home's count of Locker's items and
/// Locker's trash page `entity` like every kind's, as reads named for Locker
/// (`home.locker`, `locker.*`), which is what the vault serves a Locker item's
/// row to ([`centraid_vault::page::reaches_locker`]): any other page over
/// `entity` or `edge` is given the page without Locker's rows.
///
/// NOT HERE, ON PURPOSE: every Locker table (`locker_item`,
/// `locker_item_field`, `locker_item_passkey`, `locker_item_address`,
/// `locker_item_alias`), the journal and Locker's receipts, the `revision` snapshots, the money
/// tables (`txn`, `budget`, `checkpoint`, `rule`) and Health's (`measurement`,
/// `activity`, `workout`). The apps that read
/// those do it in the core (`Request.app_query`, `Request.money`), through
/// [`crate::app_query::VaultDoor`], which this list does not govern. A screen
/// that starts paging a new table adds it here, in the same change, and the
/// test `a_table_no_screen_pages_is_refused_and_one_a_screen_pages_still_answers`
/// is where that is read.
///
/// The `where` is held to the same list: it is predicate text and could name
/// a subquery on any table, so the vault prepares it under an authorizer that
/// refuses a read outside these thirteen
/// ([`Vault::keyset_page_reading_only`]). The vault's test
/// `a_predicate_that_reads_a_table_outside_the_list_is_refused` is where that
/// is read: the predicates it tries are SQL, which lives in that crate.
pub const PAGE_TABLES: [&str; 13] = [
    "account",
    "blob",
    "container",
    "derivative",
    "document",
    "edge",
    "entity",
    "origin",
    "person",
    "photo",
    "place",
    "source",
    "vault",
];

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
    if !PAGE_TABLES.contains(&query.from.as_str()) {
        return Err(CoreError::InvalidRequest {
            detail: format!("`{}` is not a table any screen pages", query.from),
        });
    }
    let Some(order) = &query.order else {
        return Err(CoreError::InvalidRequest {
            detail: "a page query carries no order; a keyset cursor is read off the row by the \
                     two columns the ORDER BY names"
                .to_owned(),
        });
    };
    // A FLAG SET ON A SELECT WITH NO CURRENCY IS A CALLER'S BUG, and it is
    // refused here rather than answered with a column of 2s: the exponent is
    // OF a row's currency, and a row with none has no exponent to state.
    if query.with_minor_units
        && !query
            .select
            .iter()
            .any(|column| output_name(column) == MINOR_UNITS_CURRENCY_COLUMN)
    {
        return Err(CoreError::InvalidRequest {
            detail: "with_minor_units asks for the exponent of a `currency` column the select \
                     does not name"
                .to_owned(),
        });
    }
    // A LOCAL DAY OF A COLUMN THE SELECT DOES NOT NAME is the same caller's
    // bug, refused the same way; the zone is resolved once, and only when a
    // day is asked for (`query.proto`'s `local_day_columns`).
    if let Some(missing) = query.local_day_columns.iter().find(|wanted| {
        !query
            .select
            .iter()
            .any(|column| output_name(column) == wanted.as_str())
    }) {
        return Err(CoreError::InvalidRequest {
            detail: format!("local_day_columns names `{missing}`, which the select does not name"),
        });
    }
    let day_zone = if query.local_day_columns.is_empty() {
        None
    } else {
        Some(crate::app_query::zone_of(vault, &query.tz)?)
    };
    // THE SHAPE CROSSES THE BOUNDARY; THE SQL DOES NOT. Rendering the statement
    // here would be `crates/core` knowing the query language, which the
    // `sql-confinement` rule catches — and it is right to: the statement's
    // shape is this crate's business and its syntax is the vault's.
    let answer = vault.keyset_page_reading_only(
        &KeysetPage {
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
            document_size: query.with_document_size,
        },
        &PAGE_TABLES,
    )?;

    Ok(wire::Page {
        rows: answer
            .rows
            .into_iter()
            .map(|image| {
                let mut values: Vec<wire::Value> = query
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
                    // AND THE DOCUMENT'S SIZE LAST, when it is asked for at
                    // all (#1029, Home's Docs tile). Same positional contract
                    // as the two above: appended, in a fixed place, so a shell
                    // counts past its own `select` list to reach it. It is
                    // TEXT — the phrase the vault composed — and a caller who
                    // wanted the byte count behind it is a caller the field's
                    // own comment refuses.
                    .chain(
                        query
                            .with_document_size
                            .then(|| centraid_vault::page::DOCUMENT_SIZE_COLUMN.to_owned()),
                    )
                    .map(|column| {
                        image.get(&column).map_or_else(
                            || wire::Value {
                                kind: Some(wire::value::Kind::Null(wire::NullValue {})),
                            },
                            crate::convert::value_to_wire,
                        )
                    })
                    .collect();
                // AND THE CURRENCY'S EXPONENT AFTER EVERYTHING ELSE, when it is
                // asked for. Same positional contract as the three above. It is
                // computed HERE and not by the vault because the one table of
                // minor units is the kit's (`centraid_apps_kit::money`), and
                // `Money.exponent` says where it comes from: "From the kit's
                // table through the core, never guessed and never assumed to be
                // 2" — a shell that kept its own copy would be the second table
                // D-1020-CL3 closed.
                if query.with_minor_units {
                    let exponent = image
                        .get(MINOR_UNITS_CURRENCY_COLUMN)
                        .and_then(|value| match value {
                            centraid_vault::value::Value::Text(code) => Some(code.as_str()),
                            _ => None,
                        })
                        .map_or(0, centraid_apps_kit::money::minor_units);
                    values.push(wire::Value {
                        kind: Some(wire::value::Kind::Integer(i64::from(exponent))),
                    });
                }
                // AND EACH NAMED INSTANT'S LOCAL DAY LAST, in the order the
                // query names them (#1047). Same positional contract.
                if let Some(zone) = &day_zone {
                    for column in &query.local_day_columns {
                        let day = image.get(column.as_str()).and_then(|value| match value {
                            centraid_vault::value::Value::Text(text) => local_day_of(zone, text),
                            _ => None,
                        });
                        values.push(wire::Value {
                            kind: Some(day.map_or(
                                wire::value::Kind::Null(wire::NullValue {}),
                                wire::value::Kind::Text,
                            )),
                        });
                    }
                }
                wire::Row { values }
            })
            .collect(),
        next: answer
            .next
            .map(|(sort_key, pk)| wire::PageCursor { sort_key, pk }),
    })
}

/// The civil day a stored value falls on in `zone`: a date (`2026-10-12`) is
/// its own day, and an instant is read there. Anything else is no day — never
/// its first ten characters, which is the UTC slice this column replaces.
fn local_day_of(zone: &centraid_vault::time::zone::FireZone, text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let is_date = bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        });
    if is_date {
        return Some(text.to_owned());
    }
    centraid_apps_agenda::local::today(zone, text)
}

/// The column whose code `PageQuery.with_minor_units` states the exponent of.
const MINOR_UNITS_CURRENCY_COLUMN: &str = "currency";

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
///
/// **`invoke_key` is the shell's correlation key, and nothing remembers it.**
/// The request must carry one — it is how a shell pairs this answer with the
/// write that caused it (`ScreenWrites.settled`) — but it stops here: the vault
/// is handed a name and an input, and there is no replay ledger (#1029 §1,
/// R-1088-12). The same key sent twice runs the command twice
/// (`tests/replay.rs` pins it), so a write a shell may re-offer is idempotent by
/// its own content or by an id the phone minted.
pub fn invoke(
    vault: &Vault,
    registry: &Registry,
    principal: &centraid_vault::Principal,
    request: &wire::Command,
    changes: &crate::events::ChangeFeed,
) -> Result<wire::CommandOutcome> {
    let outcome = invoke_raw(vault, registry, principal, request, changes)?;
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
        // The journal row is the evidence; nothing else is a receipt.
        receipt_id: String::new(),
        revoked_at: None,
    })
}

/// [`invoke`]'s gate order and change feed, answered as the vault's own
/// outcome rather than the wire's: the chat's door (`assist::door`) needs the
/// predicate that failed, which the wire answer deliberately drops, to tell the
/// runtime WHY a write was refused. Same `invoke_key` rule, same
/// after-the-commit change events.
pub(crate) fn invoke_raw(
    vault: &Vault,
    registry: &Registry,
    principal: &centraid_vault::Principal,
    request: &wire::Command,
    changes: &crate::events::ChangeFeed,
) -> Result<centraid_vault::commands::CommandOutcome> {
    if request.invoke_key.is_empty() {
        // REQUIRED, unlike v0, where the fallback was the call's ORDINAL and
        // only stable for a handler making the same call sequence every time.
        // It is the shell's correlation key (an answer is paired with the write
        // that caused it by this string) and it is not used past this check: no
        // ledger answers a repeat of it (#1029 §1, R-1088-12).
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
    Ok(outcome)
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
// ever called this function: a Locker reveal runs in `crate::locker::phone`,
// behind the unlock, after `locker.reveal_receipt` writes its receipt, and
// the SEALED-COLUMN arm served connector tokens, which leave with the
// connectors. The access plane's reveal judgement went with that arm
// (R-1047-D2): `centraid_vault::Verb` is `read` and `act`, so no access path
// can be written that opens a Locker cell even by mistake.

/// MAKE THIS FILE A VAULT (#1029 W5, hand-off 1).
///
/// The door `Core::open` with `create` left missing. `Vault::create` lays the
/// migrations down; `Vault::found` writes the two rows that make those tables a
/// vault — the `vault` row and its owner's person — inside one commit, and
/// until this function existed nothing over the C ABI could reach it. A phone
/// could create a file that could never say which vault it was, which is
/// exactly what `Shelf.FoundRefusal.NOT_FOUNDED` was refusing honestly.
///
/// **A SECOND FOUND IS REFUSED, AND THE VAULT THAT IS HERE IS LEFT ALONE.**
/// `Vault::found` mints a fresh id and inserts unconditionally, so running it
/// twice would write a second self person beside the first — and `vault` holds
/// one row (`CHECK (id = 1)`), so the insert would fail half-way into a file
/// the shell took for founded. The refusal carries `ERROR_CODE_VAULT_ALREADY_HELD` and names the id already
/// here, so a shell that raced itself can tell "I founded it" from "something
/// is wrong".
///
/// **WHAT THE NEW VAULT HOLDS is the request's `content`** (`vault.proto`'s
/// `FoundContent`). `UNSPECIFIED` — a found that names no content — is the
/// found and nothing else. `STARTERS` adds the teaching rows of
/// [`crate::starters`] to the member's own vault through the command plane, and
/// a refused starter leaves the vault founded rather than failing it. A
/// content this build does not know is refused before the file is read.
pub fn found(
    vault: &Vault,
    registry: &Registry,
    principal: &Principal,
    request: &wire::FoundRequest,
) -> Result<wire::FoundResponse> {
    let content =
        wire::FoundContent::try_from(request.content).map_err(|_| CoreError::InvalidRequest {
            detail: format!(
                "found content {} is not one this build knows",
                request.content
            ),
        })?;
    // A vault has a name (`vault.name` is `CHECK (length(trim(name)) > 0)`), so a
    // blank one is refused here, before the file is touched. The shells found
    // with `Shelf.DEFAULT_VAULT_NAME` and the member renames it afterwards.
    if request.display_name.trim().is_empty() {
        return Err(CoreError::InvalidRequest {
            detail: "a vault needs a name".to_owned(),
        });
    }
    if let Some(vault_id) = vault.self_id()? {
        return Err(CoreError::VaultAlreadyHeld { vault_id });
    }
    let founded = vault.found(&request.display_name, &request.owner_name)?;
    if content == wire::FoundContent::Starters {
        let report = crate::starters::write(vault, registry, principal);
        if !report.is_whole() {
            tracing::warn!(refused = ?report.refused, "a starter row was refused");
        }
    }
    Ok(wire::FoundResponse {
        vault_id: founded.self_id.clone(),
        owner_party_id: founded.self_id,
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

    /// [`found`] with the registry and the owner a handle would pass.
    fn found_here(vault: &Vault, request: &wire::FoundRequest) -> Result<wire::FoundResponse> {
        let registry = Registry::with_system_commands().expect("the registry builds");
        found(vault, &registry, &Principal::owner("test-device"), request)
    }

    fn query(select: &[&str], sort: &str, pk: &str) -> wire::PageQuery {
        wire::PageQuery {
            name: "test".to_owned(),
            select: select.iter().map(|c| (*c).to_owned()).collect(),
            from: "entity".to_owned(),
            r#where: None,
            bind: Vec::new(),
            order: Some(wire::PageOrder {
                sort_column: sort.to_owned(),
                pk_column: pk.to_owned(),
                descending: false,
            }),
            with_held_thumbnail: false,
            with_document_size: false,
            with_minor_units: false,
            local_day_columns: Vec::new(),
            tz: String::new(),
        }
    }

    /// EACH NAMED INSTANT'S DAY IN THE STATED ZONE, appended last (#1047): the
    /// trash's "Deleted" day is the member's, never a UTC slice. A column the
    /// select does not name is refused, and so is a day asked with no zone on a
    /// vault that names none.
    #[test]
    fn a_local_day_column_is_each_instants_day_in_the_stated_zone() {
        let scratch = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        let mut asked = query(&["id", "created_at"], "id", "id");
        asked.local_day_columns = vec!["created_at".to_owned()];
        asked.tz = "Pacific/Kiritimati".to_owned();
        let answer = page(
            &vault,
            &wire::PageRequest {
                query: Some(asked.clone()),
                limit: 10,
                after: None,
            },
        )
        .expect("a page");
        let zone =
            centraid_vault::time::zone::FireZone::named("Pacific/Kiritimati").expect("bundled");
        assert!(!answer.rows.is_empty());
        for row in &answer.rows {
            assert_eq!(row.values.len(), 3, "one day column, appended last");
            let Some(wire::value::Kind::Text(created)) = &row.values[1].kind else {
                panic!("created_at is text");
            };
            assert_eq!(
                row.values[2].kind,
                centraid_apps_agenda::local::today(&zone, created).map(wire::value::Kind::Text),
                "the day {created} falls on at UTC+14"
            );
        }
        assert_eq!(
            local_day_of(&zone, "2026-10-12").as_deref(),
            Some("2026-10-12"),
            "a date is its own day"
        );
        assert_eq!(
            local_day_of(&zone, "2026-10-12T20:00:00.000Z").as_deref(),
            Some("2026-10-13"),
            "an instant is read in the zone"
        );

        let mut unnamed = asked.clone();
        unnamed.local_day_columns = vec!["updated_at".to_owned()];
        let refused = page(
            &vault,
            &wire::PageRequest {
                query: Some(unnamed),
                limit: 10,
                after: None,
            },
        )
        .expect_err("a day of a column not selected");
        assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);

        asked.tz = String::new();
        let zoneless = page(
            &vault,
            &wire::PageRequest {
                query: Some(asked),
                limit: 10,
                after: None,
            },
        )
        .expect_err("founding names no zone, so no day can be read");
        assert_eq!(zoneless.code(), wire::ErrorCode::InvalidRequest);
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// The refusal arrives with the code a shell branches on.
    ///
    /// The *variant* is now the vault's (`InvalidInput`, because the vault is
    /// what validates a page's shape since the SQL moved there), and what
    /// matters is that it still reaches a shell as `INVALID_REQUEST` rather
    /// than as an internal error the shell would restart the core over.
    #[test]
    fn a_zero_limit_and_a_missing_order_column_reach_the_shell_as_invalid_request() {
        let scratch = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("the directory is made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");

        let zero = page(
            &vault,
            &wire::PageRequest {
                query: Some(query(&["id", "created_at"], "created_at", "id")),
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
                query: Some(query(&["id"], "created_at", "id")),
                limit: 10,
                after: None,
            },
        )
        .expect_err("an unprojected order column is refused");
        assert_eq!(unprojected.code(), wire::ErrorCode::InvalidRequest);
        assert!(unprojected.to_string().contains("created_at"));
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// The exponent is the KIT's, per row, appended last — and a select with no
    /// `currency` to state it of is refused rather than answered with 2s.
    #[test]
    fn the_minor_units_column_is_the_kits_exponent_of_each_rows_currency() {
        let scratch = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        let registry = Registry::with_system_commands().expect("the registry");
        let owner = centraid_vault::Principal::owner("test-device");
        for (name, currency) in [("Tokyo", "JPY"), ("Kuwait", "KWD")] {
            let outcome = vault
                .execute(
                    &registry,
                    &owner,
                    &Command::new(
                        "account.add",
                        serde_json::json!({
                            "id": name, "title": name, "type": "cash", "currency": currency,
                        }),
                    ),
                )
                .expect("an account");
            assert_eq!(
                outcome.status,
                CommandStatus::Executed,
                "{:?}",
                outcome.reason
            );
        }

        let mut asked = query(&["id", "currency"], "id", "id");
        asked.from = "account".to_owned();
        asked.with_minor_units = true;
        let answer = page(
            &vault,
            &wire::PageRequest {
                query: Some(asked.clone()),
                limit: 10,
                after: None,
            },
        )
        .expect("a page");
        // Ordered by the pk, so the pair is sorted before it is compared: the
        // claim is one exponent per row and each the kit's, not an order.
        let mut exponents: Vec<_> = answer
            .rows
            .iter()
            .map(|row| {
                assert_eq!(row.values.len(), 3, "one computed column, appended last");
                row.values[2].kind.clone()
            })
            .collect();
        exponents.sort_by_key(|kind| format!("{kind:?}"));
        assert_eq!(
            exponents,
            vec![
                Some(wire::value::Kind::Integer(0)),
                Some(wire::value::Kind::Integer(3)),
            ]
        );

        asked.select = vec!["id".to_owned()];
        let refused = page(
            &vault,
            &wire::PageRequest {
                query: Some(asked),
                limit: 10,
                after: None,
            },
        )
        .expect_err("no currency, no exponent");
        assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// THE PAGE DOOR READS ONLY THE TABLES A SCREEN PAGES (2026-10-16).
    ///
    /// A table named in `from` that no screen pages is refused as an invalid
    /// request BEFORE the vault is asked: the door used to read any table by
    /// name, which is wider than any screen needs. The refused set names what a
    /// shell must never be able to walk through a page: the receipts, the
    /// provenance log, the Locker's fields, passkeys and addresses, the money
    /// ledger and the revision snapshots. The paired half is that every table
    /// a screen does page still answers.
    /// Every table a screen pages, with a column that can key its cursor. Spelled
    /// here, not derived from the allowlist, so the allowlist cannot grow without
    /// this list (and the paragraph above it) being read.
    const PAGED_BY_A_SCREEN: [(&str, &str); 13] = [
        ("account", "id"),
        ("blob", "hash"),
        ("container", "id"),
        ("derivative", "blob"),
        ("document", "id"),
        ("edge", "from_id"),
        ("entity", "id"),
        ("origin", "id"),
        ("person", "id"),
        ("photo", "id"),
        ("place", "id"),
        ("source", "id"),
        ("vault", "self_id"),
    ];

    #[test]
    fn a_table_no_screen_pages_is_refused_and_one_a_screen_pages_still_answers() {
        let scratch = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        for (table, pk) in [
            ("journal", "seq"),
            ("receipt", "seq"),
            ("locker_item", "id"),
            ("locker_item_field", "field_id"),
            ("locker_item_passkey", "item_id"),
            ("locker_item_address", "address_id"),
            ("txn", "id"),
            ("measurement", "person_id"),
            ("revision", "entity_id"),
            ("sqlite_master", "name"),
        ] {
            let mut asked = query(&[pk], pk, pk);
            asked.from = table.to_owned();
            let refused = page(
                &vault,
                &wire::PageRequest {
                    query: Some(asked),
                    limit: 10,
                    after: None,
                },
            )
            .expect_err(&format!("`{table}` is not a table a screen pages"));
            assert_eq!(
                refused.code(),
                wire::ErrorCode::InvalidRequest,
                "`{table}`: {refused}"
            );
        }
        // AND THE ONES THEY DO PAGE ANSWER: the allowlist is the screens' own set.
        let mut spelled: Vec<&str> = PAGED_BY_A_SCREEN.iter().map(|(table, _)| *table).collect();
        spelled.sort_unstable();
        assert_eq!(
            spelled, PAGE_TABLES,
            "the allowlist and the screens' list differ"
        );
        for (table, pk) in PAGED_BY_A_SCREEN {
            let mut asked = query(&[pk], pk, pk);
            asked.from = (*table).to_owned();
            page(
                &vault,
                &wire::PageRequest {
                    query: Some(asked),
                    limit: 10,
                    after: None,
                },
            )
            .unwrap_or_else(|error| {
                panic!("`{table}` is paged by a screen and was refused: {error}")
            });
        }
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn a_query_with_no_order_is_refused() {
        let scratch = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        let mut unordered = query(&["id"], "created_at", "id");
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
        let scratch = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("the directory is made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault file");

        // BEFORE: the migrations are laid and there is no vault in them.
        assert_eq!(vault.vault_id().expect("read"), None);

        let answer = found_here(
            &vault,
            &wire::FoundRequest {
                display_name: "Tahoe".to_owned(),
                owner_name: "Me".to_owned(),
                ..wire::FoundRequest::default()
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
        let scratch = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("the directory is made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault file");
        let first = found_here(
            &vault,
            &wire::FoundRequest {
                display_name: "First".to_owned(),
                owner_name: "Me".to_owned(),
                ..wire::FoundRequest::default()
            },
        )
        .expect("the first found is answered");

        let refusal = found_here(
            &vault,
            &wire::FoundRequest {
                display_name: "Second".to_owned(),
                owner_name: "Me".to_owned(),
                ..wire::FoundRequest::default()
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

    /// A vault has a name: a blank one is refused before the file is touched,
    /// and the file stays unfounded so the shell can found it again.
    #[test]
    fn a_blank_display_name_is_refused_and_founds_nothing() {
        let scratch = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("the directory is made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault file");
        for blank in ["", "  \t"] {
            let refused = found_here(
                &vault,
                &wire::FoundRequest {
                    display_name: blank.to_owned(),
                    ..wire::FoundRequest::default()
                },
            )
            .expect_err("a blank name is refused");
            assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest, "{refused}");
        }
        assert_eq!(vault.self_id().expect("read"), None);
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// A LOCKER ITEM IS AN ENTITY, AND THE WIRE'S PAGE SERVES IT ONLY TO A READ
    /// NAMED FOR LOCKER (#1135, L4). A page over `entity` or `edge` under any
    /// other name is given the page without the item's row or its edges; the
    /// kind's own tables are not tables a screen pages at all.
    #[test]
    fn a_page_serves_a_locker_item_only_to_a_read_named_for_locker() {
        let scratch = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&scratch).expect("made");
        let vault = Vault::create(scratch.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        let registry = Registry::with_system_commands().expect("the registry builds");
        let owner = Principal::owner("test-device");
        for (name, input) in [
            (
                "locker.add_item",
                serde_json::json!({"item_id": "lk1", "type": "login", "title": "Bank login"}),
            ),
            (
                "flag.set",
                serde_json::json!({"id": "lk1", "flag": "starred"}),
            ),
        ] {
            let ran = vault
                .execute(
                    &registry,
                    &owner,
                    &centraid_vault::commands::Command::new(name, input),
                )
                .expect("the command is answered");
            assert_eq!(
                ran.status,
                centraid_vault::CommandStatus::Executed,
                "{name}: {:?}",
                ran.reason
            );
        }
        let ask = |name: &str, from: &str, select: &[&str], sort: &str, pk: &str| {
            let mut asked = query(select, sort, pk);
            asked.name = name.to_owned();
            asked.from = from.to_owned();
            page(
                &vault,
                &wire::PageRequest {
                    query: Some(asked),
                    limit: 100,
                    after: None,
                },
            )
        };
        let titles = |answer: &wire::Page| -> Vec<String> {
            answer
                .rows
                .iter()
                .filter_map(|row| match &row.values[1].kind {
                    Some(wire::value::Kind::Text(text)) => Some(text.clone()),
                    _ => None,
                })
                .collect()
        };
        for name in ["test", "home.people", "tasks.trash", "assist.native.entity"] {
            let answer = ask(name, "entity", &["id", "title"], "id", "id").expect("a page");
            assert!(
                !titles(&answer).contains(&"Bank login".to_owned()),
                "{name}"
            );
            let edges =
                ask(name, "edge", &["from_id", "to_id"], "from_id", "to_id").expect("a page");
            assert!(edges.rows.is_empty(), "{name} saw a Locker edge");
        }
        for name in ["home.locker", "locker.trash", "locker.phone.shelves"] {
            let answer = ask(name, "entity", &["id", "title"], "id", "id").expect("a page");
            assert!(titles(&answer).contains(&"Bank login".to_owned()), "{name}");
        }
        let edges = ask(
            "locker.phone.tags",
            "edge",
            &["from_id", "to_id"],
            "from_id",
            "to_id",
        )
        .expect("a page");
        assert_eq!(edges.rows.len(), 1);
        // The kind's own table is not a table any screen pages.
        let refused = ask("locker.phone.rows", "locker_item", &["id"], "id", "id")
            .expect_err("`locker_item` is not a paged table");
        assert_eq!(refused.code(), wire::ErrorCode::InvalidRequest);
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
}
