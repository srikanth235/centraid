//! The `locker.*` commands — v0's twenty, plus the two the custody change
//! needs (#1020, D-1020-L1…L7).
//!
//! ## The one sentence this whole file follows from
//!
//! *Locker secret cells are end-to-end sealed under a member key `K` the
//! gateway never holds, unwrapped only on the seat that reveals* (#1020 `:33`,
//! open question 8). So every command below is written for a gateway that
//! **cannot read a secret and cannot write one either**, and the shape that
//! falls out is not a detail:
//!
//! ### 1. A secret arrives as CIPHERTEXT, and plaintext is a typed refusal
//!
//! In v0 `locker.add_item` takes a plaintext `password` and the gateway's seal
//! sweep encrypts it. There is no sweep here, because there is no `K` here. So
//! the **seat** encrypts and what crosses the wire is `lk1:<base64>` plus the
//! `key_id` it was sealed under; [`assert_sealed_cell`] refuses anything else
//! **by construction rather than by policy** — a plaintext password reaching
//! this file would be a secret in the gateway's journal, its WAL and its
//! replica log, which is the entire thing wave 4 exists to prevent. The
//! refusal is [`crate::error::VaultError::InvalidInput`] naming the cell, and
//! the value never reaches a message.
//!
//! `assert_live_locker_key_id` is the second half, and it was already written
//! for this in wave 2: a write sealed under a key generation the vault has
//! rotated past is refused with *"re-enter this secret"*, because the gateway
//! **cannot** decrypt the intent in order to re-encrypt it.
//!
//! ### 2. The seat mints the id of any row that carries a secret (D-1020-L9)
//!
//! `AAD = rowId ‖ keyId`. That is what stops a ciphertext being moved between
//! rows — and it means the party that encrypts must already know the row's id.
//! The gateway used to mint ids for new rows; for a secret-bearing row it now
//! cannot, because the seat has to seal against the id before the row exists.
//!
//! Three options were weighed (D-1020-L9):
//!
//! - **(a) two commands**: the gateway mints the row, the seat fills the secret
//!   with a second call. Rejected: an interrupted duplicate leaves a copy of a
//!   login with no password, which is a locker item that looks complete and is
//!   not.
//! - **(b) the gateway mints the id and returns it, the seat seals, the
//!   gateway rewrites.** Same window, one more round trip.
//! - **(c) the seat mints the id** and sends it with the ciphertext. Adopted.
//!   Ids are UUIDv7 off the clock on every seat already (lane X3's `ClockIds`),
//!   the outbox has always carried seat-minted intent ids, and
//!   [`assert_fresh_id`] refuses one that is taken or malformed — so the
//!   gateway keeps the property that matters (no id collision, no id reuse
//!   across kinds, which `locker_item_entity_insert` also enforces) without
//!   keeping the one it cannot have.
//!
//! ### 3. A derivation over secrets moves to the seat; its RECEIPT does not
//!
//! `locker.watchtower` and `locker.totp_code` unsealed inside the gateway.
//! They now answer with the **addresses** to derive over and write the receipt
//! that says a mass reveal happened; the derivation runs in
//! `crates/apps/locker::{watchtower, totp}` on the seat (D-1020-L6). Their
//! output shapes therefore change, which is stated rather than hidden: a
//! caller that got `{items: [{item_id, weak, reused}]}` now gets
//! `{rows: [{item_id, type, has_password}], receipt_id}` and derives.
//!
//! `locker.export` moves the same way and for the same reason — and keeps
//! `confirm: true` and `risk: high`, because what it authorises is still the
//! mass unseal of everything the locker holds.
//!
//! ### 4. Two commands are new, and both exist because custody moved
//!
//! - [`reveal_receipt`]: a reveal on the seat still owes an `access.receipt`
//!   row, and the shell's own door cannot write one. This is the door that
//!   does, under `object_type = 'locker.item'` so the app's access history sees
//!   it (D-1020-L3).
//! - [`rotate_key`]: rotation's step 2. v0 re-encrypted every secret inside one
//!   gateway transaction; the re-encryption is now the seat's and this command
//!   **applies the whole batch atomically** under `locker_key_live_idx`
//!   (D-1020-L4).
//!
//! ## What did NOT change, and is worth saying
//!
//! Every plain column, every lifecycle rule, every precondition. Trash is
//! reversible with a 30-day `purge_at` and `restore_item` refuses a **lapsed**
//! window (#916 review 1.5). Archive is *keep forever, hide from lists* and the
//! schema's CHECK makes archived-and-trashed unrepresentable. A star is a
//! flags-scheme tag and not a column (#274). `purge_item` deletes the sidecars
//! **explicitly** rather than trusting `ON DELETE CASCADE`, because a cascade
//! fires no `AFTER DELETE` trigger unless `recursive_triggers` is on — so an
//! offline phone would keep rows whose item is gone. A Locker tag lives in
//! Locker's **own** SKOS scheme (#310): labels are as private as the item, and
//! they never appear in another app's tag rail.

use std::collections::BTreeSet;

use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::custody::locker_key::{assert_live_locker_key_id, is_locker_ciphertext};
use crate::error::{Result, VaultError};

/// The logical name of a Locker item.
pub const ITEM_TYPE: &str = "locker.item";
/// The logical name of a custom field.
pub const FIELD_TYPE: &str = "locker.item_field";
/// The logical name of the passkey slot.
pub const PASSKEY_TYPE: &str = "locker.item_passkey";
/// The logical name of an additional address.
pub const ADDRESS_TYPE: &str = "locker.item_address";
/// What an unlock is receipted under, beside `locker.item`.
pub const AUTH_TYPE: &str = "locker.auth";

/// Locker's own SKOS tag scheme (#310). `https`, not `urn:` — a tag SQL
/// fragment interpolates into condition SQL, where `:locker-tags` would read as
/// a named parameter (#258).
pub const LOCKER_TAGS_SCHEME_URI: &str = "https://centraid.dev/schemes/locker-tags";
/// The flags scheme the star lives in (#274).
pub const FLAGS_SCHEME_URI: &str = "https://centraid.dev/schemes/flags";
/// The star's notation.
pub const STARRED_NOTATION: &str = "starred";

/// ~30 days of trash before the sweep purges — mirrors Docs and Tally.
const PURGE_WINDOW_DAYS: i64 = 30;

/// The five `locker_item` cells that hold ciphertext under `K`.
pub const SEALED_ITEM_CELLS: [&str; 5] = ["password", "otp_seed", "card_number", "cvv", "content"];

/// The vault's placeholder. Round-tripped, it means **leave the secret
/// alone** — which is what lets an edit form exist without ever holding the
/// password (#293).
pub const SEALED_PLACEHOLDER: &str = "«sealed»";

/// The fifteen item types, the CHECK constraint's own order.
///
/// Public because it is the SCHEMA's list and three doors have to agree with
/// it: this catalogue's `add_item` enum, `locker_item`'s CHECK, and the app
/// crate's own degradation list. `the_type_list_is_the_check_constraints_and_the_doors`
/// is the leg of that tripwire an app crate cannot hold.
pub const ITEM_TYPES: [&str; 15] = [
    "login",
    "card",
    "note",
    "identity",
    "wifi",
    "password",
    "ssh_key",
    "api_credential",
    "passport",
    "bank_account",
    "driving_licence",
    "software_licence",
    "crypto_wallet",
    "membership",
    "document",
];

/// The one plain column every template-backed type owns.
const TEMPLATE_TYPE_FIELDS: &[&str] = &["notes"];

/// Which columns each type owns; everything else is nulled on write.
///
/// The nine types #872 added own exactly ONE column — the plaintext memo every
/// item can carry — because their real fields are template rows in
/// `locker_item_field`. That is *"a type is a set of sections and fields"* made
/// structural: **adding a type never adds a column.**
fn type_fields(item_type: &str) -> &'static [&'static str] {
    match item_type {
        "login" => &["username", "password", "url", "otp_seed", "notes"],
        "card" => &["cardholder", "card_number", "expiry", "cvv", "brand"],
        "note" => &["content"],
        "identity" => &["fullname", "email", "phone", "address"],
        "wifi" => &["network", "password"],
        "password" => &["password"],
        _ => TEMPLATE_TYPE_FIELDS,
    }
}

/// Every column a `fieldValues` pass may name — the union of every type's
/// own columns, so a type claiming one outside it is a red rather than a
/// silently dropped field.
pub const ALL_FIELDS: [&str; 16] = [
    "username",
    "password",
    "url",
    "otp_seed",
    "notes",
    "cardholder",
    "card_number",
    "expiry",
    "cvv",
    "brand",
    "content",
    "fullname",
    "email",
    "phone",
    "address",
    "network",
];

/// One template field: its section, its label, its kind.
type TemplateField = (&'static str, &'static str, &'static str);

/// The nine expansion types' templates (`locker-types.ts`).
///
/// **Sealed where the value alone is the credential**; a name, an issuer or an
/// expiry is metadata, and sealing it costs the browsable half for nothing.
fn template_for(item_type: &str) -> &'static [TemplateField] {
    match item_type {
        "ssh_key" => &[
            ("Key", "Private key", "sealed"),
            ("Key", "Key passphrase", "sealed"),
            ("Key", "Public key", "text"),
            ("Key", "Fingerprint", "text"),
            ("Host", "Host", "text"),
            ("Host", "User", "text"),
        ],
        "api_credential" => &[
            ("Credential", "Key id", "text"),
            ("Credential", "Secret", "sealed"),
            ("Service", "Endpoint", "url"),
            ("Service", "Environment", "text"),
            ("Service", "Expires", "date"),
        ],
        "passport" => &[
            ("Document", "Passport number", "sealed"),
            ("Holder", "Full name", "text"),
            ("Holder", "Nationality", "text"),
            ("Holder", "Date of birth", "date"),
            ("Document", "Issued", "date"),
            ("Document", "Expires", "date"),
            ("Document", "Place of issue", "text"),
        ],
        "bank_account" => &[
            ("Account", "Account holder", "text"),
            ("Account", "Account number", "sealed"),
            ("Account", "Sort code or routing number", "sealed"),
            ("Account", "IBAN", "sealed"),
            ("Bank", "BIC or SWIFT", "text"),
            ("Bank", "Bank", "text"),
        ],
        "driving_licence" => &[
            ("Licence", "Licence number", "sealed"),
            ("Holder", "Full name", "text"),
            ("Holder", "Date of birth", "date"),
            ("Licence", "Issued", "date"),
            ("Licence", "Expires", "date"),
            ("Licence", "Issuing authority", "text"),
            ("Licence", "Classes", "text"),
        ],
        "software_licence" => &[
            ("Licence", "Licence key", "sealed"),
            ("Product", "Product", "text"),
            ("Product", "Version", "text"),
            ("Licence", "Registered to", "text"),
            ("Purchase", "Purchased", "date"),
            ("Licence", "Expires", "date"),
            ("Purchase", "Order reference", "text"),
        ],
        "crypto_wallet" => &[
            ("Recovery", "Recovery phrase", "sealed"),
            ("Keys", "Private key", "sealed"),
            ("Keys", "Wallet passphrase", "sealed"),
            ("Wallet", "Public address", "text"),
            ("Wallet", "Network", "text"),
            ("Wallet", "Wallet software", "text"),
        ],
        "membership" => &[
            ("Membership", "Member number", "text"),
            ("Membership", "Organisation", "text"),
            ("Membership", "Tier", "text"),
            ("Membership", "Member since", "date"),
            ("Membership", "Expires", "date"),
            ("Access", "PIN", "sealed"),
            ("Access", "Website", "url"),
        ],
        "document" => &[
            ("Document", "Reference", "text"),
            ("Document", "Issued by", "text"),
            ("Document", "Issued", "date"),
            ("Document", "Expires", "date"),
        ],
        _ => &[],
    }
}

// ---------------------------------------------------------------------------
// The custody guards. These three are why this file exists in this shape.
// ---------------------------------------------------------------------------

fn invalid(name: &str, detail: impl Into<String>) -> VaultError {
    VaultError::InvalidInput {
        name: name.to_owned(),
        detail: detail.into(),
    }
}

/// A CELL THE GATEWAY MAY STORE — ciphertext, or the placeholder, or nothing.
///
/// The member-facing sentence names the cell and **never quotes the value**,
/// because the one value this refusal is most likely to be handed is a
/// password. `MemberKeyPlaintext` in the census's vocabulary; the vault's own
/// error taxonomy calls it invalid input, which is what it is: a gateway that
/// accepted it would be a gateway holding a secret.
fn assert_sealed_cell(column: &str, value: Option<&str>) -> Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.is_empty() || value == SEALED_PLACEHOLDER || is_locker_ciphertext(value) {
        return Ok(());
    }
    Err(invalid(
        column,
        format!(
            "`{column}` is a Locker secret and must arrive sealed under the member key — this \
             gateway holds no key and cannot seal one. Seal it on the seat that unlocked \
             (#1020, open question 8)."
        ),
    ))
}

/// Every sealed cell of an input, checked together, so a caller cannot pass
/// four of five.
fn assert_sealed_cells(ctx: &CommandCtx<'_, '_>, columns: &[&str]) -> Result<()> {
    for column in columns {
        assert_sealed_cell(column, ctx.optional_str(column))?;
    }
    Ok(())
}

/// The key generation a sealed write names must be the live one.
///
/// Absent when the input carries no sealed cell at all — a retag is not a
/// secret write and must not need the key plane to exist.
fn assert_key_generation(ctx: &CommandCtx<'_, '_>, carries_secret: bool) -> Result<()> {
    if !carries_secret {
        return Ok(());
    }
    let key_id = ctx.optional_str("key_id").ok_or_else(|| {
        invalid(
            "key_id",
            "a sealed cell must name the member key generation it was sealed under, so a \
             write from a seat that has not caught up with a rotation is refused rather than \
             stored unopenable",
        )
    })?;
    assert_live_locker_key_id(ctx.connection(), key_id).map_err(|error| {
        // A vault with no key plane is `MemberKeyAbsent` in the census's words
        // (D-1020-L1): a vault with zero seats holds no `K` and therefore holds
        // no secrets, and a write is refused rather than silently stored in the
        // clear.
        invalid("key_id", error.to_string())
    })
}

/// Whether this input carries any sealed cell at all.
fn carries_secret(ctx: &CommandCtx<'_, '_>, columns: &[&str]) -> bool {
    columns.iter().any(|column| {
        ctx.optional_str(column)
            .is_some_and(|value| !value.is_empty() && value != SEALED_PLACEHOLDER)
    })
}

/// A SEAT-MINTED ID THE GATEWAY WILL ACCEPT (D-1020-L9).
///
/// Two refusals, and they are different: a malformed id is a caller bug, and a
/// taken id is a collision. Neither is allowed to become a silent overwrite of
/// somebody's login.
fn assert_fresh_id(ctx: &CommandCtx<'_, '_>, name: &str, id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(invalid(
            name,
            "an id is 1–64 characters of letters, digits, `-` or `_`",
        ));
    }
    let taken: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM core_entity WHERE entity_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    if taken > 0 {
        return Err(invalid(
            name,
            "that id is already in this vault; mint a fresh one",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Small helpers over the file.
// ---------------------------------------------------------------------------

fn plus_days(iso: &str, days: i64) -> Result<String> {
    let millis = crate::clock::parse_iso_ms(iso).ok_or_else(|| VaultError::Invariant {
        context: format!("`{iso}` is not an instant this vault writes"),
    })?;
    Ok(crate::clock::format_iso_ms(millis + days * 86_400_000))
}

fn count(ctx: &CommandCtx<'_, '_>, sql: &str, params: &[&str]) -> Result<i64> {
    let values: Vec<&dyn rusqlite::ToSql> = params
        .iter()
        .map(|value| value as &dyn rusqlite::ToSql)
        .collect();
    Ok(ctx
        .connection()
        .query_row(sql, values.as_slice(), |row| row.get(0))?)
}

/// The vault's owner party, for an attribution column.
fn owner_party_id(ctx: &CommandCtx<'_, '_>) -> Option<String> {
    ctx.connection()
        .query_row(
            "SELECT self_party_id FROM core_vault WHERE self_party_id IS NOT NULL LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok()
}

fn item_type_of(ctx: &CommandCtx<'_, '_>, item_id: &str) -> Result<String> {
    ctx.connection()
        .query_row(
            "SELECT type FROM locker_item WHERE item_id = ?1",
            [item_id],
            |row| row.get(0),
        )
        .map_err(|_| invalid("item_id", "there is no locker item with that id"))
}

/// A scheme id, created on first use.
fn scheme_id(ctx: &CommandCtx<'_, '_>, uri: &str, title: &str) -> Result<String> {
    let existing: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT scheme_id FROM core_concept_scheme WHERE uri = ?1",
            [uri],
            |row| row.get(0),
        )
        .ok();
    if let Some(scheme_id) = existing {
        return Ok(scheme_id);
    }
    let scheme_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version, created_at)
         VALUES (?1, ?2, ?3, 'centraid', '1', ?4)",
        rusqlite::params![scheme_id, uri, title, ctx.now],
    )?;
    Ok(scheme_id)
}

/// A concept in a scheme, by notation, created on first use.
fn concept_id(
    ctx: &CommandCtx<'_, '_>,
    scheme: &str,
    notation: &str,
    label: &str,
) -> Result<String> {
    let existing: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT concept_id FROM core_concept WHERE scheme_id = ?1 AND notation = ?2",
            rusqlite::params![scheme, notation],
            |row| row.get(0),
        )
        .ok();
    if let Some(concept_id) = existing {
        return Ok(concept_id);
    }
    let concept_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_concept
           (concept_id, scheme_id, notation, pref_label, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        rusqlite::params![concept_id, scheme, notation, label, ctx.now],
    )?;
    Ok(concept_id)
}

/// A STAR IS A TAG, NOT A COLUMN (#274). One flags-scheme tag on the canonical
/// entity, so who starred it and when survive — a boolean column discards both.
fn set_starred(ctx: &CommandCtx<'_, '_>, item_id: &str, on: bool) -> Result<()> {
    let scheme = scheme_id(ctx, FLAGS_SCHEME_URI, "Flags")?;
    let concept = concept_id(ctx, &scheme, STARRED_NOTATION, "Starred")?;
    if !on {
        ctx.connection().execute(
            "DELETE FROM core_tag
              WHERE target_type = ?1 AND target_id = ?2 AND concept_id = ?3",
            rusqlite::params![ITEM_TYPE, item_id, concept],
        )?;
        return Ok(());
    }
    let present = count(
        ctx,
        "SELECT COUNT(*) FROM core_tag
          WHERE target_type = ?1 AND target_id = ?2 AND concept_id = ?3",
        &[ITEM_TYPE, item_id, &concept],
    )?;
    if present > 0 {
        return Ok(());
    }
    let tag_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_tag
           (tag_id, target_type, target_id, concept_id, tagged_by_party_id, tagged_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            tag_id,
            ITEM_TYPE,
            item_id,
            concept,
            owner_party_id(ctx),
            ctx.now
        ],
    )?;
    Ok(())
}

/// Replace the item's Locker tags. **Locker's own scheme**, so a star (flags)
/// and another app's label (`centraid:tags:v1`) are both untouched.
fn set_tags(ctx: &CommandCtx<'_, '_>, item_id: &str, tags: &[String]) -> Result<()> {
    let scheme = scheme_id(ctx, LOCKER_TAGS_SCHEME_URI, "Locker tags")?;
    ctx.connection().execute(
        "DELETE FROM core_tag
          WHERE target_type = ?1 AND target_id = ?2
            AND concept_id IN (SELECT concept_id FROM core_concept WHERE scheme_id = ?3)",
        rusqlite::params![ITEM_TYPE, item_id, scheme],
    )?;
    let owner = owner_party_id(ctx);
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for raw in tags {
        let tag = raw.trim();
        if tag.is_empty() || !seen.insert(tag.to_owned()) {
            continue;
        }
        let concept = concept_id(ctx, &scheme, tag, tag)?;
        let tag_id = ctx.next_id();
        ctx.connection().execute(
            "INSERT INTO core_tag
               (tag_id, target_type, target_id, concept_id, tagged_by_party_id, tagged_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![tag_id, ITEM_TYPE, item_id, concept, owner, ctx.now],
        )?;
    }
    Ok(())
}

/// Every Locker tag label on an item, sorted — what a duplicate copies.
fn tag_labels(ctx: &CommandCtx<'_, '_>, item_id: &str) -> Result<Vec<String>> {
    let mut statement = ctx.connection().prepare(
        "SELECT c.pref_label FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = ?1 AND t.target_id = ?2 AND s.uri = ?3
          ORDER BY c.pref_label",
    )?;
    let rows = statement.query_map(
        rusqlite::params![ITEM_TYPE, item_id, LOCKER_TAGS_SCHEME_URI],
        |row| row.get::<_, String>(0),
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
}

/// Set or clear (`''`) the connector alias (#298).
///
/// Unique among **live** items; a trashed holder yields it. The mapping is a
/// registered table, so an app reads back what this writes.
fn set_alias(ctx: &CommandCtx<'_, '_>, item_id: &str, alias: &str) -> Result<()> {
    ctx.connection().execute(
        "DELETE FROM locker_item_alias WHERE item_id = ?1",
        [item_id],
    )?;
    let trimmed = alias.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let clash = count(
        ctx,
        "SELECT COUNT(*) FROM locker_item_alias a
           JOIN locker_item i ON i.item_id = a.item_id
          WHERE a.alias = ?1 AND i.deleted_at IS NULL AND a.item_id <> ?2",
        &[trimmed, item_id],
    )?;
    if clash > 0 {
        return Err(invalid(
            "alias",
            format!("the alias \"{trimmed}\" is already used by another live item"),
        ));
    }
    ctx.connection().execute(
        "INSERT OR REPLACE INTO locker_item_alias (alias, item_id, created_at)
         VALUES (?1, ?2, ?3)",
        rusqlite::params![trimmed, item_id, ctx.now],
    )?;
    Ok(())
}

/// Set or clear (`''`) the service anchor (#310). **Validated live** — never an
/// opaque pointer.
fn set_connection(ctx: &CommandCtx<'_, '_>, item_id: &str, connection_id: &str) -> Result<()> {
    let trimmed = connection_id.trim();
    if trimmed.is_empty() {
        ctx.connection().execute(
            "UPDATE locker_item SET connection_id = NULL WHERE item_id = ?1",
            [item_id],
        )?;
        return Ok(());
    }
    let live = count(
        ctx,
        "SELECT COUNT(*) FROM sync_connection WHERE connection_id = ?1",
        &[trimmed],
    )?;
    if live == 0 {
        return Err(invalid(
            "connection_id",
            format!("there is no connection with the id {trimmed}"),
        ));
    }
    ctx.connection().execute(
        "UPDATE locker_item SET connection_id = ?1 WHERE item_id = ?2",
        rusqlite::params![trimmed, item_id],
    )?;
    Ok(())
}

/// One custom field, created or rewritten.
///
/// A rewrite keeps its `field_id`, which is what lets the round-tripped
/// placeholder mean *unchanged*: the ciphertext's AAD is bound to that id.
struct FieldWrite<'a> {
    /// The id to write under. A rewrite keeps it; a **new** field carries the
    /// seat's, because a sealed value's AAD is bound to it (D-1020-L9). `None`
    /// asks the gateway to mint one, which is allowed only for a field that
    /// holds no secret.
    field_id: Option<&'a str>,
    section: &'a str,
    label: &'a str,
    kind: &'a str,
    /// Ciphertext for a `sealed` kind, plaintext otherwise, or the placeholder.
    value: Option<&'a str>,
    position: i64,
}

fn write_field(ctx: &CommandCtx<'_, '_>, item_id: &str, write: &FieldWrite<'_>) -> Result<String> {
    // "Does this id already name a row on this item" is a LOOKUP, not a
    // precondition: the same call creates and rewrites, and which one it did
    // is the answer to this query rather than a mode the caller declares.
    let existing: Option<(Option<String>, Option<String>, String)> =
        write.field_id.and_then(|field_id| {
            ctx.connection()
                .query_row(
                    "SELECT value_sealed, value_text, created_at
                       FROM locker_item_field WHERE field_id = ?1 AND item_id = ?2",
                    rusqlite::params![field_id, item_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .ok()
        });
    let field_id = match write.field_id {
        Some(field_id) => field_id.to_owned(),
        None => ctx.next_id(),
    };
    let sealed = write.kind == "sealed";
    let supplied = write.value.filter(|value| !value.is_empty());
    let unchanged = supplied == Some(SEALED_PLACEHOLDER);
    let value_sealed: Option<String> = if sealed {
        if unchanged {
            existing
                .as_ref()
                .and_then(|(value_sealed, _, _)| value_sealed.clone())
        } else {
            supplied.map(str::to_owned)
        }
    } else {
        None
    };
    let value_text: Option<String> = if sealed {
        None
    } else if unchanged {
        existing
            .as_ref()
            .and_then(|(_, value_text, _)| value_text.clone())
    } else {
        supplied.map(str::to_owned)
    };
    let created_at = existing
        .as_ref()
        .map_or_else(|| ctx.now.clone(), |(_, _, created_at)| created_at.clone());
    ctx.connection().execute(
        "INSERT INTO locker_item_field
           (field_id, item_id, section, label, kind, value_text, value_sealed,
            position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(field_id) DO UPDATE SET
           section = excluded.section,
           label = excluded.label,
           kind = excluded.kind,
           value_text = excluded.value_text,
           value_sealed = excluded.value_sealed,
           position = excluded.position,
           updated_at = excluded.updated_at",
        rusqlite::params![
            field_id,
            item_id,
            write.section,
            write.label,
            write.kind,
            value_text,
            value_sealed,
            write.position,
            created_at,
            ctx.now
        ],
    )?;
    Ok(field_id)
}

/// The template rows a type arrives with, as **empty** fields the member fills.
///
/// Empty is the point: a template field carries no value, so minting one needs
/// no key and a vault with no `K` can still create a passport item and list it.
fn mint_template_fields(ctx: &CommandCtx<'_, '_>, item_id: &str, item_type: &str) -> Result<usize> {
    let template = template_for(item_type);
    for (index, (section, label, kind)) in template.iter().enumerate() {
        write_field(
            ctx,
            item_id,
            &FieldWrite {
                field_id: None,
                section,
                label,
                kind,
                value: None,
                position: i64::try_from(index).unwrap_or(0),
            },
        )?;
    }
    Ok(template.len())
}

/// Replace the item's ADDITIONAL addresses; the primary stays on the item.
fn set_addresses(
    ctx: &CommandCtx<'_, '_>,
    item_id: &str,
    addresses: &[(String, String)],
) -> Result<i64> {
    ctx.connection().execute(
        "DELETE FROM locker_item_address WHERE item_id = ?1",
        [item_id],
    )?;
    let mut position = 0_i64;
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for (url, policy) in addresses {
        let url = url.trim();
        if url.is_empty() || !seen.insert(url.to_owned()) {
            continue;
        }
        let address_id = ctx.next_id();
        ctx.connection().execute(
            "INSERT INTO locker_item_address
               (address_id, item_id, url, match_policy, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                address_id,
                item_id,
                url,
                if policy == "exact-host" {
                    "exact-host"
                } else {
                    "registrable-domain"
                },
                position,
                ctx.now
            ],
        )?;
        position += 1;
    }
    Ok(position)
}

/// Replace the owner's plaintext memo — `knowledge.annotation` (#310).
///
/// Plaintext on purpose: a secret goes in a **sealed field**, which stays out
/// of every index. A memo is the thing a member wants to find by searching.
fn replace_memo(ctx: &CommandCtx<'_, '_>, item_id: &str, note: &str) -> Result<()> {
    ctx.connection().execute(
        "DELETE FROM knowledge_annotation WHERE target_type = ?1 AND target_id = ?2",
        rusqlite::params![ITEM_TYPE, item_id],
    )?;
    let body = note.trim();
    if body.is_empty() {
        return Ok(());
    }
    let author = owner_party_id(ctx).ok_or_else(|| VaultError::Invariant {
        context: "this vault has no owner; a memo has no author to attribute".to_owned(),
    })?;
    let annotation_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO knowledge_annotation
           (annotation_id, author_party_id, target_type, target_id, body_text,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        rusqlite::params![annotation_id, author, ITEM_TYPE, item_id, body, ctx.now],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The preconditions, shared.
// ---------------------------------------------------------------------------

const ITEM_EXISTS_SQL: &str = "SELECT COUNT(*) FROM locker_item WHERE item_id = ?1";
const ITEM_LIVE_SQL: &str =
    "SELECT COUNT(*) FROM locker_item WHERE item_id = ?1 AND deleted_at IS NULL";

const ITEM_LIVE_CHECK: CommandCondition = CommandCondition {
    predicate: "item_live",
    check: |ctx| {
        let item_id = ctx.required_str("item_id")?;
        let found = count(ctx, ITEM_LIVE_SQL, &[item_id])?;
        Ok((found != 1).then(|| "that item is not in your locker".to_owned()))
    },
};

static ITEM_LIVE: &[CommandCondition] = &[ITEM_LIVE_CHECK];

static ITEM_EXISTS: &[CommandCondition] = &[CommandCondition {
    predicate: "item_exists",
    check: |ctx| {
        let item_id = ctx.required_str("item_id")?;
        let found = count(ctx, ITEM_EXISTS_SQL, &[item_id])?;
        Ok((found != 1).then(|| "that item is not in your locker".to_owned()))
    },
}];

/// RESTORE REFUSES A LAPSED WINDOW (#916, review 1.5): a restore past `purge_at`
/// resurrects what the member was told had been deleted.
static ITEM_TRASHED: &[CommandCondition] = &[CommandCondition {
    predicate: "item_trashed_within_window",
    check: |ctx| {
        let item_id = ctx.required_str("item_id")?;
        let found = count(
            ctx,
            "SELECT COUNT(*) FROM locker_item
              WHERE item_id = ?1 AND deleted_at IS NOT NULL
                AND (purge_at IS NULL OR purge_at > ?2)",
            &[item_id, &ctx.now],
        )?;
        Ok((found != 1)
            .then(|| "that item is not in the trash, or its 30 days have run out".to_owned()))
    },
}];

static NONE: &[CommandCondition] = &[];
// ---------------------------------------------------------------------------
// THE CUSTODY PRECONDITIONS — a refusal is an OUTCOME, never an exception.
//
// These are preconditions and not handler checks, and the reason is the
// authority plane's own doctrine (`crates/vault/src/access.rs`): *an answer
// that arrives as a panic cannot be receipted.* A refused Locker write is the
// single most audit-worthy refusal this product has — somebody tried to put a
// plaintext secret on the host — so it lands as a `pre` check row with its
// predicate's name, denies with the member's sentence, and is receipted like
// every other deny. The handlers call the same guards a second time, which is
// unreachable and stays: a precondition somebody forgets to wire is then a
// hard error rather than a stored secret.
// ---------------------------------------------------------------------------

/// Every sealed cell of an item write is ciphertext, the placeholder, or
/// nothing.
const SEALED_CELLS_ARE_CIPHERTEXT: CommandCondition = CommandCondition {
    predicate: "sealed_cells_are_ciphertext",
    check: |ctx| {
        Ok(assert_sealed_cells(ctx, &SEALED_ITEM_CELLS)
            .err()
            .map(sentence_of))
    },
};

/// The key generation a sealed write names is the live one.
const KEY_GENERATION_IS_LIVE: CommandCondition = CommandCondition {
    predicate: "key_generation_is_live",
    check: |ctx| {
        Ok(
            assert_key_generation(ctx, carries_secret(ctx, &SEALED_ITEM_CELLS))
                .err()
                .map(sentence_of),
        )
    },
};

/// A password write says whether the value changed.
const PASSWORD_ROTATION_IS_DECLARED: CommandCondition = CommandCondition {
    predicate: "password_rotation_is_declared",
    check: |ctx| Ok(password_rotated(ctx).err().map(sentence_of)),
};

/// The seat-minted `item_id` is fresh and well formed.
const ITEM_ID_IS_FRESH: CommandCondition = CommandCondition {
    predicate: "item_id_is_fresh",
    check: |ctx| {
        let item_id = ctx.required_str("item_id")?;
        Ok(assert_fresh_id(ctx, "item_id", item_id)
            .err()
            .map(sentence_of))
    },
};

/// The seat-minted `new_item_id` of a duplicate is fresh and well formed.
const NEW_ITEM_ID_IS_FRESH: CommandCondition = CommandCondition {
    predicate: "new_item_id_is_fresh",
    check: |ctx| {
        let item_id = ctx.required_str("new_item_id")?;
        Ok(assert_fresh_id(ctx, "new_item_id", item_id)
            .err()
            .map(sentence_of))
    },
};

/// An alias the caller asks for is not held by another live item.
const ALIAS_IS_FREE: CommandCondition = CommandCondition {
    predicate: "alias_is_free",
    check: |ctx| {
        let Some(alias) = ctx.optional_str("alias") else {
            return Ok(None);
        };
        let trimmed = alias.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let item_id = ctx.optional_str("item_id").unwrap_or_default();
        let clash = count(
            ctx,
            "SELECT COUNT(*) FROM locker_item_alias a
               JOIN locker_item i ON i.item_id = a.item_id
              WHERE a.alias = ?1 AND i.deleted_at IS NULL AND a.item_id <> ?2",
            &[trimmed, item_id],
        )?;
        Ok((clash > 0)
            .then(|| format!("the alias \"{trimmed}\" is already used by another live item")))
    },
};

/// A named `connection_id` is a live connection.
const CONNECTION_IS_LIVE: CommandCondition = CommandCondition {
    predicate: "connection_is_live",
    check: |ctx| {
        let Some(connection_id) = ctx.optional_str("connection_id") else {
            return Ok(None);
        };
        let trimmed = connection_id.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let live = count(
            ctx,
            "SELECT COUNT(*) FROM sync_connection WHERE connection_id = ?1",
            &[trimmed],
        )?;
        Ok((live == 0).then(|| format!("there is no connection with the id {trimmed}")))
    },
};

/// A custom field's sealed value is ciphertext, and a NEW sealed field carries
/// the id it was sealed against.
const FIELD_VALUE_IS_SEALED: CommandCondition = CommandCondition {
    predicate: "field_value_is_sealed",
    check: |ctx| {
        if ctx.optional_str("kind") != Some("sealed") {
            return Ok(None);
        }
        let value = ctx.optional_str("value");
        if let Err(error) = assert_sealed_cell("value", value) {
            return Ok(Some(sentence_of(error)));
        }
        let sealed_value =
            value.is_some_and(|value| !value.is_empty() && value != SEALED_PLACEHOLDER);
        if let Err(error) = assert_key_generation(ctx, sealed_value) {
            return Ok(Some(sentence_of(error)));
        }
        let item_id = ctx.required_str("item_id")?;
        match ctx.optional_str("field_id") {
            None if sealed_value => Ok(Some(
                "a new sealed custom field must carry the id it was sealed against, because \
                 the ciphertext's additional data binds it to that id (#1020, D-1020-L9)"
                    .to_owned(),
            )),
            None => Ok(None),
            Some(field_id) => {
                let existing = count(
                    ctx,
                    "SELECT COUNT(*) FROM locker_item_field
                      WHERE field_id = ?1 AND item_id = ?2",
                    &[field_id, item_id],
                )?;
                if existing > 0 {
                    return Ok(None);
                }
                Ok(assert_fresh_id(ctx, "field_id", field_id)
                    .err()
                    .map(sentence_of))
            }
        }
    },
};

/// A passkey's `private_key` is ciphertext under the live generation.
const PASSKEY_IS_SEALED: CommandCondition = CommandCondition {
    predicate: "passkey_is_sealed",
    check: |ctx| {
        let private_key = ctx.optional_str("private_key");
        if let Err(error) = assert_sealed_cell("private_key", private_key) {
            return Ok(Some(sentence_of(error)));
        }
        let sealed =
            private_key.is_some_and(|value| !value.is_empty() && value != SEALED_PLACEHOLDER);
        Ok(assert_key_generation(ctx, sealed).err().map(sentence_of))
    },
};

/// Any sealed cell whose row still names a key other than `key_id`.
///
/// `(table, count)` of the first table that has one, or `None`. Used twice: as
/// the **precondition** that refuses an incomplete batch before anything moves,
/// and as the **postcondition** that says the batch did what it claimed.
fn cells_under_another_key(
    ctx: &CommandCtx<'_, '_>,
    key_id: &str,
) -> Result<Option<(&'static str, i64)>> {
    for (table, _, columns) in crate::custody::locker_key::LOCKER_ENCRYPTED_COLUMNS {
        let predicate = columns
            .iter()
            .map(|column| format!("{column} IS NOT NULL"))
            .collect::<Vec<_>>()
            .join(" OR ");
        let stragglers: i64 = ctx.connection().query_row(
            &format!(
                "SELECT COUNT(*) FROM {table}
                  WHERE key_id IS NOT NULL AND key_id <> ?1 AND ({predicate})"
            ),
            [key_id],
            |row| row.get(0),
        )?;
        if stragglers > 0 {
            return Ok(Some((table, stragglers)));
        }
    }
    Ok(None)
}

/// THE BATCH IS THE WHOLE VAULT OR IT IS NOTHING (D-1020-L4).
///
/// Checked BEFORE the writes, over the rows as they stand: every row that
/// carries a sealed cell under the outgoing key must appear in the batch for
/// each such cell. A batch that misses one would leave a secret under a key
/// generation the database no longer names — which is the one outcome the
/// order-not-transaction argument exists to prevent, and which no sweep can
/// repair because the gateway cannot read the cell to re-encrypt it.
const ROTATION_COVERS_EVERY_CELL: CommandCondition = CommandCondition {
    predicate: "rotation_covers_every_cell",
    check: |ctx| {
        let previous = ctx.required_str("previous_key_id")?;
        let batch: BTreeSet<(String, String, String)> = ctx
            .input
            .get("cells")
            .and_then(serde_json::Value::as_array)
            .map(|cells| {
                cells
                    .iter()
                    .filter_map(|cell| {
                        Some((
                            cell.get("table")?.as_str()?.to_owned(),
                            cell.get("row_id")?.as_str()?.to_owned(),
                            cell.get("column")?.as_str()?.to_owned(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        for (table, pk, columns) in crate::custody::locker_key::LOCKER_ENCRYPTED_COLUMNS {
            for column in *columns {
                let mut statement = ctx.connection().prepare(&format!(
                    "SELECT {pk} FROM {table}
                      WHERE {column} IS NOT NULL AND COALESCE(key_id, ?1) = ?1"
                ))?;
                let rows: Vec<String> = statement
                    .query_map([previous], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                for row_id in rows {
                    if !batch.contains(&((*table).to_owned(), row_id.clone(), (*column).to_owned()))
                    {
                        return Ok(Some(format!(
                            "the batch does not re-encrypt `{table}.{column}` for the row \
                             {row_id}; a rotation is the whole vault or it is nothing \
                             (#1020, D-1020-L4)"
                        )));
                    }
                }
            }
        }
        Ok(None)
    },
};

/// The rotation's `previous_key_id` is the key the vault actually names live.
const ROTATION_TARGETS_THE_LIVE_KEY: CommandCondition = CommandCondition {
    predicate: "rotation_targets_the_live_key",
    check: |ctx| {
        let key_id = ctx.required_str("key_id")?;
        let previous = ctx.required_str("previous_key_id")?;
        if key_id == previous {
            return Ok(Some(
                "a rotation moves to a NEW key generation; the ids are the same".to_owned(),
            ));
        }
        let live: Option<String> = ctx
            .connection()
            .query_row(
                "SELECT key_id FROM locker_key WHERE retired_at IS NULL LIMIT 1",
                [],
                |row| row.get(0),
            )
            .ok();
        Ok(match live.as_deref() {
            None => Some("this vault has no live Locker key to rotate; found one first".to_owned()),
            // A ROTATION FROM A KEY THAT IS NOT LIVE IS TWO SEATS ROTATING AT
            // ONCE, and the loser must be told rather than allowed to
            // overwrite the winner's cells under a key nothing names.
            Some(live) if live != previous => Some(format!(
                "this vault's live Locker key is {live}, not {previous} — another seat \
                 rotated first; re-read the live key and rotate again"
            )),
            Some(_) => None,
        })
    },
};

/// Every cell of a rotation batch is ciphertext, in the registry, and on a row
/// that exists.
const ROTATION_CELLS_ARE_SEALED: CommandCondition = CommandCondition {
    predicate: "rotation_cells_are_sealed",
    check: |ctx| {
        let Some(cells) = ctx.input.get("cells").and_then(serde_json::Value::as_array) else {
            return Ok(None);
        };
        for cell in cells {
            let table = cell
                .get("table")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let column = cell
                .get("column")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let value = cell
                .get("value")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let row_id = cell
                .get("row_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            // THE REGISTRY IS THE ALLOW-LIST, and it is the same registry
            // encryption and the sweep read. A rotation that could name any
            // column would be a rotation that could write ciphertext into
            // `title`.
            let Some((_, pk, columns)) = crate::custody::locker_key::LOCKER_ENCRYPTED_COLUMNS
                .iter()
                .find(|(known, _, _)| *known == table)
            else {
                return Ok(Some(format!("`{table}` holds no cell sealed under K")));
            };
            if !columns.contains(&column) {
                return Ok(Some(format!(
                    "`{table}.{column}` is not a cell sealed under K"
                )));
            }
            if !is_locker_ciphertext(value) {
                return Ok(Some(format!(
                    "the rotated value for `{table}.{column}` is not sealed; a rotation \
                     re-encrypts on the seat and the gateway stores what it is given"
                )));
            }
            let found = count(
                ctx,
                &format!("SELECT COUNT(*) FROM {table} WHERE {pk} = ?1"),
                &[row_id],
            )?;
            if found != 1 {
                return Ok(Some(format!(
                    "there is no `{table}` row with the id the batch names"
                )));
            }
        }
        Ok(None)
    },
};

/// A reveal receipt names a sealed column, matches its subject to its object
/// type, and a fill names the page it happened on.
const RECEIPT_IS_WELL_FORMED: CommandCondition = CommandCondition {
    predicate: "receipt_is_well_formed",
    check: |ctx| {
        let object_type = ctx.required_str("object_type")?;
        let item_id = ctx.optional_str("item_id");
        if object_type == ITEM_TYPE && item_id.is_none() {
            return Ok(Some(
                "a reveal of a locker item names the item it opened".to_owned(),
            ));
        }
        if object_type == AUTH_TYPE && item_id.is_some() {
            return Ok(Some(
                "an unlock is about the vault, not about one item".to_owned(),
            ));
        }
        // A REVEAL RECEIPT THAT NAMES A PLAIN COLUMN IS A LIE about what was
        // revealed, so the column set is checked against the sealed registry —
        // except for an unlock, which reveals no column at all.
        if object_type == ITEM_TYPE {
            let columns = ctx
                .input
                .get("columns")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            for column in &columns {
                let column = column.as_str().unwrap_or_default();
                if !SEALED_ITEM_CELLS.contains(&column)
                    && column != "value_sealed"
                    && column != "private_key"
                {
                    return Ok(Some(format!(
                        "`{column}` is not a sealed Locker cell; a reveal receipt names what \
                         was unsealed"
                    )));
                }
            }
        }
        if ctx.optional_str("kind") == Some("fill") && ctx.optional_str("origin").is_none() {
            return Ok(Some(
                "a fill happened on a page, and the receipt names which one".to_owned(),
            ));
        }
        Ok(None)
    },
};

/// The member-facing half of a refusal, for a precondition's sentence.
fn sentence_of(error: VaultError) -> String {
    match error {
        VaultError::InvalidInput { detail, .. } => detail,
        other => other.to_string(),
    }
}

static ADD_ITEM_PRE: &[CommandCondition] = &[
    ITEM_ID_IS_FRESH,
    SEALED_CELLS_ARE_CIPHERTEXT,
    KEY_GENERATION_IS_LIVE,
    PASSWORD_ROTATION_IS_DECLARED,
    ALIAS_IS_FREE,
    CONNECTION_IS_LIVE,
];

static EDIT_ITEM_PRE: &[CommandCondition] = &[
    ITEM_LIVE_CHECK,
    SEALED_CELLS_ARE_CIPHERTEXT,
    KEY_GENERATION_IS_LIVE,
    PASSWORD_ROTATION_IS_DECLARED,
    ALIAS_IS_FREE,
    CONNECTION_IS_LIVE,
];

static DUPLICATE_ITEM_PRE: &[CommandCondition] = &[
    ITEM_LIVE_CHECK,
    NEW_ITEM_ID_IS_FRESH,
    SEALED_CELLS_ARE_CIPHERTEXT,
    KEY_GENERATION_IS_LIVE,
];

static SET_FIELD_PRE: &[CommandCondition] = &[ITEM_LIVE_CHECK, FIELD_VALUE_IS_SEALED];

static SET_PASSKEY_PRE: &[CommandCondition] = &[ITEM_LIVE_CHECK, PASSKEY_IS_SEALED];

static ROTATE_KEY_PRE: &[CommandCondition] = &[
    ROTATION_TARGETS_THE_LIVE_KEY,
    ROTATION_CELLS_ARE_SEALED,
    ROTATION_COVERS_EVERY_CELL,
];

static REVEAL_RECEIPT_PRE: &[CommandCondition] = &[RECEIPT_IS_WELL_FORMED];

// ---------------------------------------------------------------------------
// The catalogue.
// ---------------------------------------------------------------------------

/// Every `locker.*` command this build carries: v0's twenty, plus the two the
/// custody change needs.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        add_item(),
        edit_item(),
        trash_item(),
        restore_item(),
        purge_item(),
        star_item(),
        unstar_item(),
        totp_code(),
        watchtower(),
        set_memo(),
        archive_item(),
        unarchive_item(),
        duplicate_item(),
        set_field(),
        remove_field(),
        set_addresses_command(),
        set_passkey(),
        clear_passkey(),
        counts(),
        export(),
        // The two wave 4 adds.
        reveal_receipt(),
        rotate_key(),
    ]
}

fn definition(
    name: &'static str,
    input_schema: &'static str,
    idempotency: Idempotency,
    preconditions: &'static [CommandCondition],
    postconditions: &'static [CommandCondition],
    handler: crate::commands::CommandHandler,
) -> CommandDefinition {
    CommandDefinition {
        name,
        owner_schema: "locker",
        input_schema,
        idempotency,
        risk: Risk::Low,
        confirm: false,
        preconditions,
        postconditions,
        handler,
        sealed_input: &[],
        online_only: false,
    }
}

/// The plain half of a type's columns, with a `None` for an absent or empty
/// value — v0's `fieldValues`.
fn field_values(ctx: &CommandCtx<'_, '_>, item_type: &str) -> Vec<(&'static str, Option<String>)> {
    type_fields(item_type)
        .iter()
        .map(|column| {
            let value = ctx
                .optional_str(column)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            (*column, value)
        })
        .collect()
}

/// The sixteen type columns plus the key generation, as JSON-schema text.
///
/// A macro rather than a constant because the registry compiles each command's
/// schema **once, from a `&'static str`**, and `concat!` takes literals only.
macro_rules! field_schema {
    () => {
        r#"
            "username": { "type": "string" },
            "password": { "type": "string" },
            "url": { "type": "string" },
            "otp_seed": { "type": "string" },
            "notes": { "type": "string" },
            "cardholder": { "type": "string" },
            "card_number": { "type": "string" },
            "expiry": { "type": "string" },
            "cvv": { "type": "string" },
            "brand": { "type": "string" },
            "content": { "type": "string" },
            "fullname": { "type": "string" },
            "email": { "type": "string" },
            "phone": { "type": "string" },
            "address": { "type": "string" },
            "network": { "type": "string" },
            "key_id": { "type": "string", "minLength": 1 },
            "password_rotated": { "type": "boolean" }
        "#
    };
}

/// The fifteen types, as a JSON-schema enum.
macro_rules! type_enum {
    () => {
        r#""type": { "type": "string", "enum": [
              "login", "card", "note", "identity", "wifi", "password",
              "ssh_key", "api_credential", "passport", "bank_account",
              "driving_licence", "software_licence", "crypto_wallet",
              "membership", "document"
            ] },"#
    };
}

/// Just `{item_id}`, which nine commands take and nothing else.
macro_rules! item_id_only {
    () => {
        r#"{
          "type": "object",
          "required": ["item_id"],
          "additionalProperties": false,
          "properties": { "item_id": { "type": "string", "minLength": 1 } }
        }"#
    };
}

fn item_id_output(item_id: &str) -> serde_json::Value {
    serde_json::json!({ "item_id": item_id })
}

/// Whether the caller declared the password a real rotation (D-1020-L10b).
///
/// The gateway cannot compare two ciphertexts for equality — AES-GCM with a
/// fresh nonce per value means the same plaintext encrypts differently every
/// time — so *"only a real change re-stamps the age"* (v0's `rotated`) is a
/// fact only the seat holding `K` can establish. It is therefore an explicit,
/// **required** claim whenever a password cell arrives, and it lands on the
/// invocation's receipt like any other input.
///
/// The alternative — re-stamp whenever a password cell arrives — was rejected
/// because it errs in the *permissive* direction: re-stamping makes a password
/// look fresh, so Review would stop warning about one a member only re-typed.
fn password_rotated(ctx: &CommandCtx<'_, '_>) -> Result<bool> {
    let password = ctx
        .optional_str("password")
        .filter(|value| !value.is_empty() && *value != SEALED_PLACEHOLDER);
    if password.is_none() {
        return Ok(false);
    }
    ctx.input
        .get("password_rotated")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| {
            invalid(
                "password_rotated",
                "a write that carries a password must say whether the value CHANGED: the \
                 gateway cannot compare two ciphertexts, and only a real change re-stamps \
                 the password's age (#1020, D-1020-L10b)",
            )
        })
}

fn add_item() -> CommandDefinition {
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "item_created",
        check: |ctx| {
            let item_id = ctx.required_str("item_id")?;
            let found = count(ctx, ITEM_EXISTS_SQL, &[item_id])?;
            Ok((found != 1).then(|| "the item was not saved".to_owned()))
        },
    }];
    let mut definition = definition(
        "locker.add_item",
        concat!(
            r#"{
          "type": "object",
          "required": ["item_id", "type", "title"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1, "maxLength": 64 },
            "#,
            type_enum!(),
            r#"
            "title": { "type": "string", "minLength": 1 },
            "tags": { "type": "array", "items": { "type": "string" } },
            "compromised": { "type": "boolean" },
            "alias": { "type": "string", "pattern": "^[A-Za-z0-9._-]{1,64}$" },
            "connection_id": { "type": "string" },
            "url_match_policy": { "type": "string",
              "enum": ["registrable-domain", "exact-host"] },
            "#,
            field_schema!(),
            r#"
          }
        }"#
        ),
        Idempotency::Once,
        ADD_ITEM_PRE,
        POST,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            let item_type = ctx.required_str("type")?.to_owned();
            let title = ctx.required_str("title")?.to_owned();
            assert_fresh_id(ctx, "item_id", &item_id)?;
            assert_sealed_cells(ctx, &SEALED_ITEM_CELLS)?;
            let secret = carries_secret(ctx, &SEALED_ITEM_CELLS);
            assert_key_generation(ctx, secret)?;
            let key_id = ctx.optional_str("key_id").map(str::to_owned);

            let values = field_values(ctx, &item_type);
            let password = values
                .iter()
                .find(|(column, _)| *column == "password")
                .and_then(|(_, value)| value.clone());
            let policy = if ctx.optional_str("url_match_policy") == Some("exact-host") {
                "exact-host"
            } else {
                "registrable-domain"
            };

            // Only the type's own columns are written; everything else stays
            // NULL, so a member who filled a login and switched to Wi-Fi never
            // stores the login's fields.
            let mut columns: Vec<&str> = vec!["item_id", "type", "title", "url_match_policy"];
            let mut binds: Vec<Box<dyn rusqlite::ToSql>> = vec![
                Box::new(item_id.clone()),
                Box::new(item_type.clone()),
                Box::new(title),
                Box::new(policy),
            ];
            for (column, value) in &values {
                columns.push(column);
                binds.push(Box::new(value.clone()));
            }
            columns.push("compromised");
            binds.push(Box::new(i64::from(
                ctx.input
                    .get("compromised")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            )));
            // PASSWORD AGE IS SET-TIME, NEVER `updated_at`: a retag must not
            // make a three-year-old password look fresh (GAPS §3.3 #6d).
            columns.push("password_set_at");
            binds.push(Box::new(password.as_ref().map(|_| ctx.now.clone())));
            columns.push("key_id");
            binds.push(Box::new(key_id));
            columns.push("created_at");
            binds.push(Box::new(ctx.now.clone()));
            columns.push("updated_at");
            binds.push(Box::new(ctx.now.clone()));

            let placeholders: Vec<String> = (1..=columns.len())
                .map(|index| format!("?{index}"))
                .collect();
            let sql = format!(
                "INSERT INTO locker_item ({}) VALUES ({})",
                columns.join(", "),
                placeholders.join(", ")
            );
            let params: Vec<&dyn rusqlite::ToSql> =
                binds.iter().map(std::convert::AsRef::as_ref).collect();
            ctx.connection().execute(&sql, params.as_slice())?;

            if let Some(alias) = ctx.optional_str("alias") {
                set_alias(ctx, &item_id, alias)?;
            }
            if let Some(connection_id) = ctx.optional_str("connection_id") {
                set_connection(ctx, &item_id, connection_id)?;
            }
            if let Some(tags) = tag_list(ctx) {
                set_tags(ctx, &item_id, &tags)?;
            }
            // A type is a set of sections and fields: the nine expansion types
            // arrive as EMPTY template rows the member fills in, which is also
            // what lets an unknown type degrade to a note that still carries
            // them. Empty needs no key, so a vault with no `K` can still make
            // a passport item and list it.
            let minted = mint_template_fields(ctx, &item_id, &item_type)?;
            Ok(serde_json::json!({ "item_id": item_id, "template_fields": minted }))
        },
    );
    definition.sealed_input = &SEALED_ITEM_CELLS;
    definition.online_only = true;
    definition
}

/// The `tags` array, when the caller sent one. `None` means *leave the tags
/// alone*, which is not the same as `[]` — that clears them.
fn tag_list(ctx: &CommandCtx<'_, '_>) -> Option<Vec<String>> {
    Some(
        ctx.input
            .get("tags")?
            .as_array()?
            .iter()
            .filter_map(|tag| tag.as_str().map(str::to_owned))
            .collect(),
    )
}

fn edit_item() -> CommandDefinition {
    let mut definition = definition(
        "locker.edit_item",
        concat!(
            r#"{
          "type": "object",
          "required": ["item_id"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "title": { "type": "string", "minLength": 1 },
            "tags": { "type": "array", "items": { "type": "string" } },
            "compromised": { "type": "boolean" },
            "alias": { "type": "string", "pattern": "^[A-Za-z0-9._-]{0,64}$" },
            "connection_id": { "type": "string" },
            "url_match_policy": { "type": "string",
              "enum": ["registrable-domain", "exact-host"] },
            "#,
            field_schema!(),
            r#"
          }
        }"#
        ),
        Idempotency::Idempotent,
        EDIT_ITEM_PRE,
        NONE,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            let item_type = item_type_of(ctx, &item_id)?;
            assert_sealed_cells(ctx, &SEALED_ITEM_CELLS)?;
            let secret = carries_secret(ctx, &SEALED_ITEM_CELLS);
            assert_key_generation(ctx, secret)?;
            let rotated = password_rotated(ctx)?;

            let mut sets: Vec<String> = vec!["updated_at = ?1".to_owned()];
            let mut binds: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(ctx.now.clone())];
            let push = |sets: &mut Vec<String>,
                        binds: &mut Vec<Box<dyn rusqlite::ToSql>>,
                        column: &str,
                        value: Box<dyn rusqlite::ToSql>| {
                binds.push(value);
                sets.push(format!("{column} = ?{}", binds.len()));
            };

            if let Some(title) = ctx.optional_str("title") {
                push(&mut sets, &mut binds, "title", Box::new(title.to_owned()));
            }
            if let Some(compromised) = ctx
                .input
                .get("compromised")
                .and_then(serde_json::Value::as_bool)
            {
                push(
                    &mut sets,
                    &mut binds,
                    "compromised",
                    Box::new(i64::from(compromised)),
                );
            }
            if let Some(policy) = ctx.optional_str("url_match_policy") {
                // Login-only: the match policy is about an address, and only a
                // login has one the Companion fills against.
                if item_type != "login" {
                    return Err(invalid(
                        "url_match_policy",
                        "only a login has an address match policy",
                    ));
                }
                push(
                    &mut sets,
                    &mut binds,
                    "url_match_policy",
                    Box::new(policy.to_owned()),
                );
            }

            // Only the type's own columns, and a round-tripped placeholder is
            // SKIPPED rather than written: that is what "unchanged" means.
            let mut changed: Vec<&str> = Vec::new();
            for (column, value) in field_values(ctx, &item_type) {
                if ctx.optional_str(column) == Some(SEALED_PLACEHOLDER) {
                    continue;
                }
                if ctx.input.get(column).is_none() {
                    continue;
                }
                push(&mut sets, &mut binds, column, Box::new(value.clone()));
                changed.push(column);
            }
            // A ROTATION, distinguished from any other edit. The seat says so
            // (see `password_rotated`); only a real change re-stamps the age.
            if rotated {
                let stamp = ctx
                    .optional_str("password")
                    .filter(|value| !value.is_empty())
                    .map(|_| ctx.now.clone());
                push(&mut sets, &mut binds, "password_set_at", Box::new(stamp));
            }
            if secret {
                let key_id = ctx.optional_str("key_id").map(str::to_owned);
                push(&mut sets, &mut binds, "key_id", Box::new(key_id));
            }

            binds.push(Box::new(item_id.clone()));
            let sql = format!(
                "UPDATE locker_item SET {} WHERE item_id = ?{}",
                sets.join(", "),
                binds.len()
            );
            let params: Vec<&dyn rusqlite::ToSql> =
                binds.iter().map(std::convert::AsRef::as_ref).collect();
            ctx.connection().execute(&sql, params.as_slice())?;

            if let Some(alias) = ctx.optional_str("alias") {
                // An EMPTY alias clears the binding, which is the paper cut
                // README-Locker §8 names: a member could set one and never
                // take it back.
                set_alias(ctx, &item_id, alias)?;
            }
            if let Some(connection_id) = ctx.optional_str("connection_id") {
                set_connection(ctx, &item_id, connection_id)?;
            }
            if let Some(tags) = tag_list(ctx) {
                set_tags(ctx, &item_id, &tags)?;
            }
            Ok(serde_json::json!({
                "item_id": item_id,
                "rotated": rotated,
                "columns": changed
            }))
        },
    );
    definition.sealed_input = &SEALED_ITEM_CELLS;
    definition.online_only = true;
    definition
}

fn trash_item() -> CommandDefinition {
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "item_trashed",
        check: |ctx| {
            let item_id = ctx.required_str("item_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM locker_item
                  WHERE item_id = ?1 AND deleted_at IS NOT NULL AND purge_at IS NOT NULL",
                &[item_id],
            )?;
            Ok((found != 1).then(|| "the item was not moved to the trash".to_owned()))
        },
    }];
    definition(
        "locker.trash_item",
        item_id_only!(),
        Idempotency::Idempotent,
        ITEM_LIVE,
        POST,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            let purge_at = plus_days(&ctx.now, PURGE_WINDOW_DAYS)?;
            ctx.connection().execute(
                "UPDATE locker_item
                    SET deleted_at = ?1, purge_at = ?2, updated_at = ?1
                  WHERE item_id = ?3",
                rusqlite::params![ctx.now, purge_at, item_id],
            )?;
            Ok(item_id_output(&item_id))
        },
    )
}

fn restore_item() -> CommandDefinition {
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "item_live",
        check: |ctx| {
            let item_id = ctx.required_str("item_id")?;
            let found = count(ctx, ITEM_LIVE_SQL, &[item_id])?;
            Ok((found != 1).then(|| "the item was not restored".to_owned()))
        },
    }];
    definition(
        "locker.restore_item",
        item_id_only!(),
        Idempotency::Idempotent,
        ITEM_TRASHED,
        POST,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            ctx.connection().execute(
                "UPDATE locker_item
                    SET deleted_at = NULL, purge_at = NULL, updated_at = ?1
                  WHERE item_id = ?2",
                rusqlite::params![ctx.now, item_id],
            )?;
            Ok(item_id_output(&item_id))
        },
    )
}

fn purge_item() -> CommandDefinition {
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "item_gone",
        check: |ctx| {
            let item_id = ctx.required_str("item_id")?;
            let found = count(ctx, ITEM_EXISTS_SQL, &[item_id])?;
            Ok((found != 0).then(|| "the item is still in the locker".to_owned()))
        },
    }];
    let mut definition = definition(
        "locker.purge_item",
        item_id_only!(),
        Idempotency::Once,
        ITEM_EXISTS,
        POST,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            set_starred(ctx, &item_id, false)?;
            // `core_tag` is POLYMORPHIC — no CASCADE reaches it.
            set_tags(ctx, &item_id, &[])?;
            replace_memo(ctx, &item_id, "")?;
            // The sidecars declare ON DELETE CASCADE, and a cascade fires no
            // AFTER DELETE trigger unless `recursive_triggers` is on — so an
            // offline phone would keep rows whose item is gone. Deleted
            // explicitly, in the same transaction, so the replica change log
            // carries every one of them.
            for table in [
                "locker_item_field",
                "locker_item_address",
                "locker_item_passkey",
                "locker_item_alias",
            ] {
                ctx.connection().execute(
                    &format!("DELETE FROM {table} WHERE item_id = ?1"),
                    [&item_id],
                )?;
            }
            ctx.connection()
                .execute("DELETE FROM locker_item WHERE item_id = ?1", [&item_id])?;
            Ok(item_id_output(&item_id))
        },
    );
    definition.risk = Risk::Medium;
    // Destructive (#306 d2): park for owner confirm on every non-owner-device
    // invocation. Without this the manifest's `confirmation: "required"` is
    // cosmetic.
    definition.confirm = true;
    definition
}

fn star_item() -> CommandDefinition {
    definition(
        "locker.star_item",
        item_id_only!(),
        Idempotency::Idempotent,
        ITEM_LIVE,
        NONE,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            set_starred(ctx, &item_id, true)?;
            Ok(item_id_output(&item_id))
        },
    )
}

fn unstar_item() -> CommandDefinition {
    definition(
        "locker.unstar_item",
        item_id_only!(),
        Idempotency::Idempotent,
        ITEM_LIVE,
        NONE,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            set_starred(ctx, &item_id, false)?;
            Ok(item_id_output(&item_id))
        },
    )
}

fn archive_item() -> CommandDefinition {
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "item_archived",
        check: |ctx| {
            let item_id = ctx.required_str("item_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM locker_item
                  WHERE item_id = ?1 AND deleted_at IS NULL AND archived_at IS NOT NULL",
                &[item_id],
            )?;
            Ok((found != 1).then(|| "the item was not archived".to_owned()))
        },
    }];
    definition(
        "locker.archive_item",
        item_id_only!(),
        Idempotency::Idempotent,
        ITEM_LIVE,
        POST,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            // Archive is "keep forever, hide from lists". NOT trash: no purge
            // date is set and none is ever set, which is the whole
            // distinction, and the schema's CHECK makes archived-and-trashed
            // unrepresentable.
            ctx.connection().execute(
                "UPDATE locker_item SET archived_at = ?1, updated_at = ?1 WHERE item_id = ?2",
                rusqlite::params![ctx.now, item_id],
            )?;
            Ok(item_id_output(&item_id))
        },
    )
}

fn unarchive_item() -> CommandDefinition {
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "item_unarchived",
        check: |ctx| {
            let item_id = ctx.required_str("item_id")?;
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM locker_item
                  WHERE item_id = ?1 AND deleted_at IS NULL AND archived_at IS NULL",
                &[item_id],
            )?;
            Ok((found != 1).then(|| "the item was not taken out of the archive".to_owned()))
        },
    }];
    definition(
        "locker.unarchive_item",
        item_id_only!(),
        Idempotency::Idempotent,
        ITEM_LIVE,
        POST,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            ctx.connection().execute(
                "UPDATE locker_item SET archived_at = NULL, updated_at = ?1 WHERE item_id = ?2",
                rusqlite::params![ctx.now, item_id],
            )?;
            Ok(item_id_output(&item_id))
        },
    )
}

/// Every column a duplicate copies verbatim, minus the sealed ones.
const PLAIN_COPY_COLUMNS: [&str; 15] = [
    "type",
    "username",
    "url",
    "url_match_policy",
    "notes",
    "cardholder",
    "expiry",
    "brand",
    "fullname",
    "email",
    "phone",
    "address",
    "network",
    "connection_id",
    "compromised",
];

fn duplicate_item() -> CommandDefinition {
    let mut definition = definition(
        "locker.duplicate_item",
        concat!(
            r#"{
          "type": "object",
          "required": ["item_id", "new_item_id"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "new_item_id": { "type": "string", "minLength": 1, "maxLength": 64 },
            "fields": { "type": "array", "items": {
              "type": "object",
              "required": ["field_id", "section", "label", "kind"],
              "additionalProperties": false,
              "properties": {
                "field_id": { "type": "string", "minLength": 1, "maxLength": 64 },
                "section": { "type": "string" },
                "label": { "type": "string", "minLength": 1 },
                "kind": { "type": "string",
                  "enum": ["text", "sealed", "url", "date", "otp"] },
                "value": { "type": "string" },
                "position": { "type": "integer", "minimum": 0 }
              }
            } },
            "#,
            field_schema!(),
            r#"
          }
        }"#
        ),
        Idempotency::Once,
        DUPLICATE_ITEM_PRE,
        NONE,
        |ctx| {
            let source_id = ctx.required_str("item_id")?.to_owned();
            let item_id = ctx.required_str("new_item_id")?.to_owned();
            assert_fresh_id(ctx, "new_item_id", &item_id)?;
            assert_sealed_cells(ctx, &SEALED_ITEM_CELLS)?;
            let secret = carries_secret(ctx, &SEALED_ITEM_CELLS);
            assert_key_generation(ctx, secret)?;

            // CLONE-AND-EDIT FOR SIBLING ACCOUNTS (GAPS §3.3 #10), and the one
            // v0 rule that could not survive the custody change: v0 unsealed
            // each secret here and wrote it back as plaintext for the seal
            // sweep to re-seal under the NEW row's id, "so no secret
            // round-trips through the client". The ciphertext's AAD binds it to
            // the old row, and this gateway cannot re-seal — so the seat
            // re-encrypts under the new id and sends the cells, which is why
            // the new id is the seat's (D-1020-L9). The promise that changes
            // is "no secret round-trips through the client"; the promise that
            // survives, and is the stronger one, is that no secret is ever
            // readable by the host.
            let mut columns: Vec<String> = vec!["item_id".to_owned(), "title".to_owned()];
            let source_title: String = ctx.connection().query_row(
                "SELECT title FROM locker_item WHERE item_id = ?1",
                [&source_id],
                |row| row.get(0),
            )?;
            let title = format!("{source_title} copy");
            let mut binds: Vec<Box<dyn rusqlite::ToSql>> =
                vec![Box::new(item_id.clone()), Box::new(title.clone())];
            for column in PLAIN_COPY_COLUMNS {
                // AS A VALUE, NOT AS A STRING. `compromised` is an INTEGER and
                // `NOT NULL`; reading it into an `Option<String>` fails, and a
                // `.ok().flatten()` around that failure turns the flag into a
                // NULL the column's own constraint then refuses. Found by
                // `a_duplicate_takes_the_re_sealed_cells_and_leaves_the_alias_behind`.
                let value: rusqlite::types::Value = ctx.connection().query_row(
                    &format!("SELECT {column} FROM locker_item WHERE item_id = ?1"),
                    [&source_id],
                    |row| row.get(0),
                )?;
                columns.push(column.to_owned());
                binds.push(Box::new(value));
            }
            for column in SEALED_ITEM_CELLS {
                let value = ctx
                    .optional_str(column)
                    .filter(|value| !value.is_empty() && *value != SEALED_PLACEHOLDER)
                    .map(str::to_owned);
                columns.push(column.to_owned());
                binds.push(Box::new(value));
            }
            let password_set_at: Option<String> = ctx.connection().query_row(
                "SELECT password_set_at FROM locker_item WHERE item_id = ?1",
                [&source_id],
                |row| row.get(0),
            )?;
            columns.push("password_set_at".to_owned());
            binds.push(Box::new(password_set_at));
            columns.push("key_id".to_owned());
            binds.push(Box::new(ctx.optional_str("key_id").map(str::to_owned)));
            columns.push("created_at".to_owned());
            binds.push(Box::new(ctx.now.clone()));
            columns.push("updated_at".to_owned());
            binds.push(Box::new(ctx.now.clone()));

            let placeholders: Vec<String> = (1..=columns.len())
                .map(|index| format!("?{index}"))
                .collect();
            let params: Vec<&dyn rusqlite::ToSql> =
                binds.iter().map(std::convert::AsRef::as_ref).collect();
            ctx.connection().execute(
                &format!(
                    "INSERT INTO locker_item ({}) VALUES ({})",
                    columns.join(", "),
                    placeholders.join(", ")
                ),
                params.as_slice(),
            )?;

            // The custom fields, re-sealed by the seat against their own new
            // ids for the same AAD reason.
            let mut copied = 0_usize;
            if let Some(fields) = ctx
                .input
                .get("fields")
                .and_then(serde_json::Value::as_array)
            {
                for field in fields {
                    let field_id = field
                        .get("field_id")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| invalid("fields", "every field names a `field_id`"))?;
                    let kind = field
                        .get("kind")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("text");
                    let value = field.get("value").and_then(serde_json::Value::as_str);
                    if kind == "sealed" {
                        assert_sealed_cell("fields[].value", value)?;
                    }
                    assert_fresh_id(ctx, "fields[].field_id", field_id)?;
                    write_field(
                        ctx,
                        &item_id,
                        &FieldWrite {
                            field_id: Some(field_id),
                            section: field
                                .get("section")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or(""),
                            label: field
                                .get("label")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or_default(),
                            kind,
                            value,
                            position: field
                                .get("position")
                                .and_then(serde_json::Value::as_i64)
                                .unwrap_or(0),
                        },
                    )?;
                    copied += 1;
                }
            }

            // The addresses copy as they are — no secret is involved.
            let addresses = {
                let mut statement = ctx.connection().prepare(
                    "SELECT url, match_policy FROM locker_item_address
                      WHERE item_id = ?1 ORDER BY position, address_id",
                )?;
                let rows = statement.query_map([&source_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            set_addresses(ctx, &item_id, &addresses)?;
            set_tags(ctx, &item_id, &tag_labels(ctx, &source_id)?)?;
            // NOT starred, NOT archived, and the alias is NOT copied: an alias
            // is unique among live items, so a copy carrying it would steal
            // the connector binding.
            Ok(serde_json::json!({
                "item_id": item_id,
                "title": title,
                "fields": copied
            }))
        },
    );
    definition.sealed_input = &SEALED_ITEM_CELLS;
    definition
}

fn set_field() -> CommandDefinition {
    let mut definition = definition(
        "locker.set_field",
        r#"{
          "type": "object",
          "required": ["item_id", "label", "kind"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "field_id": { "type": "string", "minLength": 1, "maxLength": 64 },
            "section": { "type": "string" },
            "label": { "type": "string", "minLength": 1 },
            "kind": { "type": "string", "enum": ["text", "sealed", "url", "date", "otp"] },
            "value": { "type": "string" },
            "position": { "type": "integer", "minimum": 0 },
            "key_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        SET_FIELD_PRE,
        NONE,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            let kind = ctx.required_str("kind")?.to_owned();
            let label = ctx.required_str("label")?.to_owned();
            let value = ctx.optional_str("value").map(str::to_owned);
            let field_id = ctx.optional_str("field_id").map(str::to_owned);
            let sealed_value = kind == "sealed"
                && value
                    .as_deref()
                    .is_some_and(|value| !value.is_empty() && value != SEALED_PLACEHOLDER);
            if kind == "sealed" {
                assert_sealed_cell("value", value.as_deref())?;
            }
            assert_key_generation(ctx, sealed_value)?;
            // A NEW sealed field needs the seat's id, for the AAD reason.
            if sealed_value && field_id.is_none() {
                return Err(invalid(
                    "field_id",
                    "a new sealed custom field must carry the id it was sealed against, \
                     because the ciphertext's additional data binds it to that id \
                     (#1020, D-1020-L9)",
                ));
            }
            let written = write_field(
                ctx,
                &item_id,
                &FieldWrite {
                    field_id: field_id.as_deref(),
                    section: ctx.optional_str("section").unwrap_or(""),
                    label: &label,
                    kind: &kind,
                    value: value.as_deref(),
                    position: ctx
                        .input
                        .get("position")
                        .and_then(serde_json::Value::as_i64)
                        .unwrap_or(0),
                },
            )?;
            // A sealed field's `key_id` is stamped on the field row, so a
            // rotation can find it.
            if sealed_value {
                ctx.connection().execute(
                    "UPDATE locker_item_field SET key_id = ?1 WHERE field_id = ?2",
                    rusqlite::params![ctx.optional_str("key_id"), written],
                )?;
            }
            ctx.connection().execute(
                "UPDATE locker_item SET updated_at = ?1 WHERE item_id = ?2",
                rusqlite::params![ctx.now, item_id],
            )?;
            Ok(serde_json::json!({ "field_id": written, "item_id": item_id }))
        },
    );
    definition.sealed_input = &["value"];
    definition.online_only = true;
    definition
}

fn remove_field() -> CommandDefinition {
    definition(
        "locker.remove_field",
        r#"{
          "type": "object",
          "required": ["item_id", "field_id"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "field_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        ITEM_LIVE,
        NONE,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            let field_id = ctx.required_str("field_id")?.to_owned();
            ctx.connection().execute(
                "DELETE FROM locker_item_field WHERE field_id = ?1 AND item_id = ?2",
                rusqlite::params![field_id, item_id],
            )?;
            ctx.connection().execute(
                "UPDATE locker_item SET updated_at = ?1 WHERE item_id = ?2",
                rusqlite::params![ctx.now, item_id],
            )?;
            Ok(serde_json::json!({ "field_id": field_id, "item_id": item_id }))
        },
    )
}

fn set_addresses_command() -> CommandDefinition {
    definition(
        "locker.set_addresses",
        r#"{
          "type": "object",
          "required": ["item_id", "addresses"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "addresses": { "type": "array", "items": {
              "type": "object",
              "required": ["url"],
              "additionalProperties": false,
              "properties": {
                "url": { "type": "string", "minLength": 1 },
                "match_policy": { "type": "string",
                  "enum": ["registrable-domain", "exact-host"] }
              }
            } }
          }
        }"#,
        Idempotency::Idempotent,
        ITEM_LIVE,
        NONE,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            let addresses: Vec<(String, String)> = ctx
                .input
                .get("addresses")
                .and_then(serde_json::Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|address| {
                            Some((
                                address.get("url")?.as_str()?.to_owned(),
                                address
                                    .get("match_policy")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("registrable-domain")
                                    .to_owned(),
                            ))
                        })
                        .collect()
                })
                .unwrap_or_default();
            // `locker_item.url` stays the PRIMARY, so Companion candidates,
            // the connector binding and Review's unsecured-address check keep
            // working. No secret is involved, which is why this one takes the
            // whole list.
            let written = set_addresses(ctx, &item_id, &addresses)?;
            ctx.connection().execute(
                "UPDATE locker_item SET updated_at = ?1 WHERE item_id = ?2",
                rusqlite::params![ctx.now, item_id],
            )?;
            Ok(serde_json::json!({ "item_id": item_id, "count": written }))
        },
    )
}

fn set_passkey() -> CommandDefinition {
    let mut definition = definition(
        "locker.set_passkey",
        r#"{
          "type": "object",
          "required": ["item_id", "rp_id"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "rp_id": { "type": "string", "minLength": 1 },
            "user_handle": { "type": "string" },
            "display_name": { "type": "string" },
            "credential_id": { "type": "string" },
            "algorithm": { "type": "string" },
            "private_key": { "type": "string" },
            "key_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        SET_PASSKEY_PRE,
        NONE,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            let private_key = ctx.optional_str("private_key").map(str::to_owned);
            assert_sealed_cell("private_key", private_key.as_deref())?;
            let sealed = private_key
                .as_deref()
                .is_some_and(|value| !value.is_empty() && value != SEALED_PLACEHOLDER);
            assert_key_generation(ctx, sealed)?;

            // STORAGE ONLY: this mints no challenge, signs nothing and speaks
            // no WebAuthn. The slot's `item_id` is its own primary key, so the
            // seat already knows the id it seals against — no new id is needed.
            let existing: Option<(Option<String>, String)> = ctx
                .connection()
                .query_row(
                    "SELECT private_key, created_at FROM locker_item_passkey WHERE item_id = ?1",
                    [&item_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok();
            let stored = if private_key.as_deref() == Some(SEALED_PLACEHOLDER) {
                existing.as_ref().and_then(|(key, _)| key.clone())
            } else {
                private_key.filter(|value| !value.is_empty())
            };
            let created_at = existing
                .as_ref()
                .map_or_else(|| ctx.now.clone(), |(_, created)| created.clone());
            ctx.connection().execute(
                "INSERT INTO locker_item_passkey
                   (item_id, rp_id, user_handle, display_name, credential_id, algorithm,
                    private_key, key_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(item_id) DO UPDATE SET
                   rp_id = excluded.rp_id,
                   user_handle = excluded.user_handle,
                   display_name = excluded.display_name,
                   credential_id = excluded.credential_id,
                   algorithm = excluded.algorithm,
                   private_key = excluded.private_key,
                   key_id = excluded.key_id,
                   updated_at = excluded.updated_at",
                rusqlite::params![
                    item_id,
                    ctx.required_str("rp_id")?,
                    ctx.optional_str("user_handle"),
                    ctx.optional_str("display_name"),
                    ctx.optional_str("credential_id"),
                    ctx.optional_str("algorithm"),
                    stored,
                    ctx.optional_str("key_id"),
                    created_at,
                    ctx.now
                ],
            )?;
            ctx.connection().execute(
                "UPDATE locker_item SET updated_at = ?1 WHERE item_id = ?2",
                rusqlite::params![ctx.now, item_id],
            )?;
            Ok(item_id_output(&item_id))
        },
    );
    definition.sealed_input = &["private_key"];
    definition.online_only = true;
    definition
}

fn clear_passkey() -> CommandDefinition {
    definition(
        "locker.clear_passkey",
        item_id_only!(),
        Idempotency::Idempotent,
        ITEM_LIVE,
        NONE,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            ctx.connection().execute(
                "DELETE FROM locker_item_passkey WHERE item_id = ?1",
                [&item_id],
            )?;
            ctx.connection().execute(
                "UPDATE locker_item SET updated_at = ?1 WHERE item_id = ?2",
                rusqlite::params![ctx.now, item_id],
            )?;
            Ok(item_id_output(&item_id))
        },
    )
}

fn set_memo() -> CommandDefinition {
    definition(
        "locker.set_memo",
        r#"{
          "type": "object",
          "required": ["item_id", "note"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "note": { "type": "string" }
          }
        }"#,
        Idempotency::Idempotent,
        ITEM_LIVE,
        NONE,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            // An owner remark is a `knowledge.annotation` (#310) and is
            // PLAINTEXT. Secrets go in sealed fields, which stay out of every
            // index — and this one is deliberately IN one, because a memo is
            // the thing a member wants to find by searching. An empty note
            // clears it.
            replace_memo(ctx, &item_id, ctx.required_str("note")?)?;
            ctx.connection().execute(
                "UPDATE locker_item SET updated_at = ?1 WHERE item_id = ?2",
                rusqlite::params![ctx.now, item_id],
            )?;
            Ok(item_id_output(&item_id))
        },
    )
}

fn counts() -> CommandDefinition {
    definition(
        "locker.counts",
        r#"{ "type": "object", "additionalProperties": false, "properties": {} }"#,
        Idempotency::RetrySafe,
        NONE,
        NONE,
        |ctx| {
            // A COUNT runs INSIDE the vault so the answer is exact without
            // shipping every row to get it — the alternative was reading the
            // 2,000-row ceiling back just to take its length, which is what
            // makes the foot line ("300 of 312") circular.
            let one = |sql: &str| -> Result<i64> {
                Ok(ctx.connection().query_row(sql, [], |row| row.get(0))?)
            };
            let mut statement = ctx.connection().prepare(
                "SELECT type, COUNT(*) FROM locker_item
                  WHERE deleted_at IS NULL AND archived_at IS NULL
                  GROUP BY type ORDER BY type",
            )?;
            let by_type: Vec<serde_json::Value> = statement
                .query_map([], |row| {
                    Ok(serde_json::json!({
                        "type": row.get::<_, String>(0)?,
                        "n": row.get::<_, i64>(1)?
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(serde_json::json!({
                "live": one(
                    "SELECT COUNT(*) FROM locker_item
                      WHERE deleted_at IS NULL AND archived_at IS NULL",
                )?,
                "archived": one(
                    "SELECT COUNT(*) FROM locker_item
                      WHERE deleted_at IS NULL AND archived_at IS NOT NULL",
                )?,
                "trashed": one(
                    "SELECT COUNT(*) FROM locker_item WHERE deleted_at IS NOT NULL",
                )?,
                "by_type": by_type,
            }))
        },
    )
}

// ---------------------------------------------------------------------------
// The three derivations that moved to the seat, and their receipts.
// ---------------------------------------------------------------------------

fn totp_code() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "item_has_seed",
        check: |ctx| {
            let item_id = ctx.required_str("item_id")?;
            // THE PRESENCE OF A SEALED CELL IS STILL A FACT THE GATEWAY KNOWS.
            // `otp_seed IS NOT NULL` reads a column without reading a value,
            // which is exactly the line the trust premise draws: the gateway
            // serves ciphertext and knows it is there.
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM locker_item
                  WHERE item_id = ?1 AND deleted_at IS NULL AND otp_seed IS NOT NULL",
                &[item_id],
            )?;
            Ok((found != 1).then(|| "that item carries no one-time-code seed".to_owned()))
        },
    }];
    let mut definition = definition(
        "locker.totp_code",
        item_id_only!(),
        Idempotency::RetrySafe,
        PRE,
        NONE,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            // WHAT THIS COMMAND IS, AFTER THE CUSTODY CHANGE (D-1020-L6).
            //
            // v0 unsealed the seed here and returned six digits. This gateway
            // cannot unseal, so what it does is the half that is still its
            // own and that the seat cannot do for itself: it RECEIPTS the
            // reveal. A member's access history must record that a one-time
            // code was derived from a seed, and a seat writing its own
            // receipts would be a seat auditing itself.
            //
            // The digits are computed by `crates/apps/locker::totp` over the
            // replica's own `otp_seed` cell, unwrapped by
            // `crates/seat::locker` inside the reveal window.
            let receipt_id = ctx.write_subject_receipt(
                "reveal locker.totp_code",
                ITEM_TYPE,
                Some(&item_id),
                "allow",
                serde_json::json!({
                    "columns": ["otp_seed"],
                    "context": { "kind": "reveal", "derivation": "totp" }
                }),
            )?;
            Ok(serde_json::json!({
                "item_id": item_id,
                "period": 30,
                "receipt_id": receipt_id,
                "derived_on": "seat"
            }))
        },
    );
    definition.online_only = true;
    definition
}

fn watchtower() -> CommandDefinition {
    let mut definition = definition(
        "locker.watchtower",
        r#"{ "type": "object", "additionalProperties": false, "properties": {} }"#,
        Idempotency::RetrySafe,
        NONE,
        NONE,
        |ctx| {
            // THE ROW SET IS V0'S ROW SET, exactly: logins and cards always,
            // and a wifi or standalone password only when it HAS a password.
            // Archived items are in it, because an archived login's password
            // is still a password somebody reused.
            let mut statement = ctx.connection().prepare(
                "SELECT item_id, type, password IS NOT NULL
                   FROM locker_item
                  WHERE deleted_at IS NULL
                    AND (type IN ('login', 'card')
                      OR (type IN ('wifi', 'password') AND password IS NOT NULL))
                  ORDER BY item_id",
            )?;
            let rows: Vec<serde_json::Value> = statement
                .query_map([], |row| {
                    Ok(serde_json::json!({
                        "item_id": row.get::<_, String>(0)?,
                        "type": row.get::<_, String>(1)?,
                        "has_password": row.get::<_, i64>(2)? == 1
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            // THE OUTPUT SHAPE CHANGES, AND SAYING SO IS THE POINT
            // (D-1020-L6). v0 answered `{items: [{item_id, weak, reused,
            // last4}]}` because it could unseal; this answers the ADDRESSES
            // and `crates/apps/locker::watchtower` folds the scores from
            // plaintext the seat unwrapped. A port that kept the old shape
            // would have to invent the scores, and a security screen that
            // invents an all-clear is the worst failure this app has.
            let receipt_id = ctx.write_subject_receipt(
                "reveal locker.watchtower",
                ITEM_TYPE,
                None,
                "allow",
                serde_json::json!({
                    "columns": ["password", "card_number"],
                    "context": { "kind": "reveal", "derivation": "watchtower" },
                    "rows": rows.len()
                }),
            )?;
            Ok(serde_json::json!({
                "rows": rows,
                "receipt_id": receipt_id,
                "derived_on": "seat"
            }))
        },
    );
    definition.online_only = true;
    definition
}

/// The plain columns an export carries verbatim.
const PLAIN_EXPORT_COLUMNS: [&str; 20] = [
    "type",
    "title",
    "username",
    "url",
    "url_match_policy",
    "notes",
    "cardholder",
    "expiry",
    "brand",
    "fullname",
    "email",
    "phone",
    "address",
    "network",
    "compromised",
    "password_set_at",
    "created_at",
    "updated_at",
    "archived_at",
    "deleted_at",
];

fn export() -> CommandDefinition {
    let mut definition = definition(
        "locker.export",
        r#"{
          "type": "object",
          "required": ["confirm"],
          "additionalProperties": false,
          "properties": {
            "confirm": { "type": "boolean", "const": true },
            "include_trashed": { "type": "boolean" },
            "include_history": { "type": "boolean" }
          }
        }"#,
        Idempotency::RetrySafe,
        // The gate is the schema's `const: true` plus `confirm` below, not a
        // SQL precondition: a precondition binds parameters as strings, so a
        // boolean read back through one would be theatre.
        NONE,
        NONE,
        |ctx| {
            let include_trashed = ctx
                .input
                .get("include_trashed")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let include_history = ctx
                .input
                .get("include_history")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);

            // A MASS UNSEAL IS A COMMAND AND NOT A QUERY, twice over, and both
            // reasons survive the custody change: a query handler is read-only
            // by directive so it cannot write the receipt a mass reveal owes,
            // and a replica read returns sealed columns as placeholders.
            //
            // WHAT CHANGED (D-1020-L7): v0 unsealed every cell here and
            // returned the plaintext. This gateway cannot, so the command
            // answers the PLAIN half plus the ciphertext's addresses, writes
            // the one receipt, and the seat produces the file. The confirm and
            // the `high` risk stay exactly where they were, because what is
            // being authorised is unchanged: every secret the locker holds,
            // in the clear, in a file.
            let projection = PLAIN_EXPORT_COLUMNS.join(", ");
            let predicate = if include_trashed {
                ""
            } else {
                "WHERE deleted_at IS NULL"
            };
            let mut statement = ctx.connection().prepare(&format!(
                "SELECT item_id, key_id, {projection} FROM locker_item
                 {predicate} ORDER BY created_at, item_id"
            ))?;
            let items: Vec<serde_json::Value> = statement
                .query_map([], |row| {
                    let mut item = serde_json::Map::new();
                    item.insert(
                        "item_id".to_owned(),
                        serde_json::Value::String(row.get::<_, String>(0)?),
                    );
                    item.insert(
                        "key_id".to_owned(),
                        row.get::<_, Option<String>>(1)?
                            .map_or(serde_json::Value::Null, serde_json::Value::String),
                    );
                    for (index, column) in PLAIN_EXPORT_COLUMNS.iter().enumerate() {
                        let value: Option<String> =
                            row.get::<_, Option<String>>(index + 2).or_else(|_| {
                                row.get::<_, Option<i64>>(index + 2)
                                    .map(|value| value.map(|value| value.to_string()))
                            })?;
                        item.insert(
                            (*column).to_owned(),
                            value.map_or(serde_json::Value::Null, serde_json::Value::String),
                        );
                    }
                    Ok(serde_json::Value::Object(item))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let receipt_id = ctx.write_subject_receipt(
                "reveal locker.export",
                ITEM_TYPE,
                Some("export"),
                "allow",
                serde_json::json!({
                    "columns": SEALED_ITEM_CELLS,
                    "context": { "kind": "reveal", "derivation": "export" },
                    "items": items.len(),
                    "include_trashed": include_trashed,
                    "include_history": include_history
                }),
            )?;
            Ok(serde_json::json!({
                "exported_at": ctx.now,
                "item_count": items.len(),
                "items": items,
                "receipt_id": receipt_id,
                // A REVISION'S SNAPSHOT IS THE ONE THING ONLY AN EXPORT
                // UNSEALS, and it stays that way: the seat reads
                // `core_entity_revision` off its own replica under the receipt
                // this command wrote. The flag rides the answer so the seat
                // knows whether the member asked for it.
                "unseals_on": "seat"
            }))
        },
    );
    definition.risk = Risk::High;
    definition.confirm = true;
    definition.online_only = true;
    definition
}

fn reveal_receipt() -> CommandDefinition {
    definition(
        "locker.reveal_receipt",
        r#"{
          "type": "object",
          "required": ["object_type", "columns"],
          "additionalProperties": false,
          "properties": {
            "object_type": { "type": "string",
              "enum": ["locker.item", "locker.auth"] },
            "item_id": { "type": "string", "minLength": 1 },
            "columns": { "type": "array", "minItems": 1,
              "items": { "type": "string", "minLength": 1 } },
            "kind": { "type": "string", "enum": ["reveal", "fill", "auth"] },
            "origin": { "type": "string", "minLength": 1 },
            "allowed": { "type": "boolean" },
            "failing": { "type": "string" }
          }
        }"#,
        Idempotency::Once,
        REVEAL_RECEIPT_PRE,
        NONE,
        |ctx| {
            // THE RECEIPT A SEAT-SIDE REVEAL OWES (D-1020-L3).
            //
            // The gateway no longer produces the plaintext, and that is exactly
            // why this door has to exist: the record of *who looked* is the one
            // thing that must stay readable now that the gateway cannot
            // decrypt, and a seat that wrote its own receipts would be a seat
            // auditing itself. `access_receipt` is append-only by trigger and
            // hash-chained by `seq`, so this is a receipt a member can read
            // and nobody can quietly remove.
            //
            // It carries COLUMN NAMES, never values — `columns: ["password"]`
            // is what the access history shows. An `origin` rides only a
            // `fill`, because that is the only kind that happened on a page.
            let object_type = ctx.required_str("object_type")?.to_owned();
            let item_id = ctx.optional_str("item_id").map(str::to_owned);
            if object_type == ITEM_TYPE && item_id.is_none() {
                return Err(invalid(
                    "item_id",
                    "a reveal of a locker item names the item it opened",
                ));
            }
            if object_type == AUTH_TYPE && item_id.is_some() {
                return Err(invalid(
                    "item_id",
                    "an unlock is about the vault, not about one item",
                ));
            }
            let columns: Vec<String> = ctx
                .input
                .get("columns")
                .and_then(serde_json::Value::as_array)
                .map(|columns| {
                    columns
                        .iter()
                        .filter_map(|column| column.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            // A REVEAL RECEIPT THAT NAMES A PLAIN COLUMN IS A LIE about what
            // was revealed, so the column set is checked against the sealed
            // registry — except for an unlock, which reveals no column at all
            // and names the vault.
            if object_type == ITEM_TYPE {
                for column in &columns {
                    if !SEALED_ITEM_CELLS.contains(&column.as_str())
                        && column != "value_sealed"
                        && column != "private_key"
                    {
                        return Err(invalid(
                            "columns",
                            format!(
                                "`{column}` is not a sealed Locker cell; a reveal receipt names \
                                 what was unsealed"
                            ),
                        ));
                    }
                }
            }
            let kind = ctx
                .optional_str("kind")
                .unwrap_or(if object_type == AUTH_TYPE {
                    "auth"
                } else {
                    "reveal"
                });
            let allowed = ctx
                .input
                .get("allowed")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            let mut context = serde_json::Map::new();
            context.insert(
                "kind".to_owned(),
                serde_json::Value::String(kind.to_owned()),
            );
            if kind == "fill" {
                let origin = ctx.optional_str("origin").ok_or_else(|| {
                    invalid(
                        "origin",
                        "a fill happened on a page, and the receipt names which one",
                    )
                })?;
                context.insert(
                    "origin".to_owned(),
                    serde_json::Value::String(origin.to_owned()),
                );
            }
            let mut detail = serde_json::Map::new();
            detail.insert("columns".to_owned(), serde_json::json!(columns));
            detail.insert("context".to_owned(), serde_json::Value::Object(context));
            if let Some(failing) = ctx.optional_str("failing") {
                detail.insert(
                    "failing".to_owned(),
                    serde_json::Value::String(failing.to_owned()),
                );
            }
            let receipt_id = ctx.write_subject_receipt(
                "reveal locker.item",
                &object_type,
                item_id.as_deref(),
                if allowed { "allow" } else { "deny" },
                serde_json::Value::Object(detail),
            )?;
            Ok(serde_json::json!({
                "receipt_id": receipt_id,
                "object_type": object_type,
                "kind": kind
            }))
        },
    )
}

fn rotate_key() -> CommandDefinition {
    static POST: &[CommandCondition] = &[
        CommandCondition {
            predicate: "one_live_key_and_it_is_the_new_one",
            check: |ctx| {
                let key_id = ctx.required_str("key_id")?;
                let live = count(
                    ctx,
                    "SELECT COUNT(*) FROM locker_key WHERE retired_at IS NULL",
                    &[],
                )?;
                if live != 1 {
                    return Ok(Some(format!(
                        "the vault names {live} live Locker keys after a rotation; it must \
                         name one"
                    )));
                }
                let named = count(
                    ctx,
                    "SELECT COUNT(*) FROM locker_key WHERE retired_at IS NULL AND key_id = ?1",
                    &[key_id],
                )?;
                Ok((named != 1).then(|| "the rotation did not make the new key live".to_owned()))
            },
        },
        // THE NEW KEY IS THE ONLY KEY ANY CELL NAMES. The precondition
        // `rotation_covers_every_cell` refuses an incomplete batch before
        // anything moves; this is the same claim asserted after the fact,
        // because a postcondition is what makes the command's own statement
        // about what it did true or rolls the whole commit back.
        CommandCondition {
            predicate: "no_cell_names_a_retired_key",
            check: |ctx| {
                let key_id = ctx.required_str("key_id")?;
                Ok(
                    cells_under_another_key(ctx, key_id)?.map(|(table, stragglers)| {
                        format!(
                            "{stragglers} `{table}` row(s) still name the old Locker key; a \
                         rotation is the whole vault or it is nothing (#1020, D-1020-L4)"
                        )
                    }),
                )
            },
        },
    ];
    let mut definition = definition(
        "locker.rotate_key",
        r#"{
          "type": "object",
          "required": ["key_id", "previous_key_id", "cells"],
          "additionalProperties": false,
          "properties": {
            "key_id": { "type": "string", "minLength": 1, "maxLength": 64 },
            "previous_key_id": { "type": "string", "minLength": 1 },
            "cells": { "type": "array", "items": {
              "type": "object",
              "required": ["table", "row_id", "column", "value"],
              "additionalProperties": false,
              "properties": {
                "table": { "type": "string",
                  "enum": ["locker_item", "locker_item_field", "locker_item_passkey"] },
                "row_id": { "type": "string", "minLength": 1 },
                "column": { "type": "string", "minLength": 1 },
                "value": { "type": "string", "minLength": 1 }
              }
            } }
          }
        }"#,
        Idempotency::Once,
        ROTATE_KEY_PRE,
        POST,
        |ctx| {
            // ROTATION STEP 2, AS ONE BATCH (D-1020-L4).
            //
            // v0's step 2 was one gateway transaction that re-encrypted every
            // secret. The re-encryption is now the SEAT's — the gateway holds
            // no key and cannot read a cell in order to rewrite it — so what
            // arrives is the finished ciphertext and what this command
            // guarantees is the part that was always the transaction's job:
            // **either every cell is under `K′` and every `key_id` says so, or
            // none of it happened.** The whole command runs inside the commit
            // guard, so there is no partial state for a crash to leave.
            //
            // The retire PRECEDES the insert because `locker_key_live_idx` is
            // on the PREDICATE (`retired_at IS NULL`) and is checked per
            // statement, not per transaction — so "two live rows" is
            // unrepresentable even for the instant between the two writes.
            let key_id = ctx.required_str("key_id")?.to_owned();
            let previous_key_id = ctx.required_str("previous_key_id")?.to_owned();
            if key_id == previous_key_id {
                return Err(invalid(
                    "key_id",
                    "a rotation moves to a NEW key generation; the ids are the same",
                ));
            }
            let live: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT key_id FROM locker_key WHERE retired_at IS NULL LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .ok();
            // A ROTATION FROM A KEY THAT IS NOT LIVE IS TWO SEATS ROTATING AT
            // ONCE, and the loser must be told rather than allowed to
            // overwrite the winner's cells under a key nothing names.
            match live.as_deref() {
                None => {
                    return Err(invalid(
                        "previous_key_id",
                        "this vault has no live Locker key to rotate; found it first",
                    ));
                }
                Some(live) if live != previous_key_id => {
                    return Err(invalid(
                        "previous_key_id",
                        format!(
                            "this vault's live Locker key is {live}, not {previous_key_id} — \
                             another seat rotated first; re-read the live key and rotate again"
                        ),
                    ));
                }
                Some(_) => {}
            }

            ctx.connection().execute(
                "UPDATE locker_key SET retired_at = ?1 WHERE key_id = ?2",
                rusqlite::params![ctx.now, previous_key_id],
            )?;
            ctx.connection().execute(
                "INSERT INTO locker_key (key_id, created_at, retired_at) VALUES (?1, ?2, NULL)",
                rusqlite::params![key_id, ctx.now],
            )?;

            let mut rewritten = 0_usize;
            let cells = ctx
                .input
                .get("cells")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            for cell in &cells {
                let table = cell
                    .get("table")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| invalid("cells", "every cell names its `table`"))?;
                let row_id = cell
                    .get("row_id")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| invalid("cells", "every cell names its `row_id`"))?;
                let column = cell
                    .get("column")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| invalid("cells", "every cell names its `column`"))?;
                let value = cell
                    .get("value")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| invalid("cells", "every cell carries its `value`"))?;
                // THE REGISTRY IS THE ALLOW-LIST, and it is the same registry
                // encryption and the sweep read (`LOCKER_ENCRYPTED_COLUMNS`).
                // A rotation that could name any column would be a rotation
                // that could write ciphertext into `title`.
                let (pk, columns) = crate::custody::locker_key::LOCKER_ENCRYPTED_COLUMNS
                    .iter()
                    .find(|(known, _, _)| *known == table)
                    .map(|(_, pk, columns)| (*pk, *columns))
                    .ok_or_else(|| {
                        invalid("cells", format!("`{table}` holds no cell sealed under K"))
                    })?;
                if !columns.contains(&column) {
                    return Err(invalid(
                        "cells",
                        format!("`{table}.{column}` is not a cell sealed under K"),
                    ));
                }
                // And the value must be ciphertext, for the same reason every
                // other write's is.
                if !is_locker_ciphertext(value) {
                    return Err(invalid(
                        "cells",
                        format!(
                            "the rotated value for `{table}.{column}` is not sealed; a rotation \
                             re-encrypts on the seat and the gateway stores what it is given"
                        ),
                    ));
                }
                let changed = ctx.connection().execute(
                    &format!("UPDATE {table} SET {column} = ?1, key_id = ?2 WHERE {pk} = ?3"),
                    rusqlite::params![value, key_id, row_id],
                )?;
                if changed != 1 {
                    return Err(invalid(
                        "cells",
                        format!("there is no `{table}` row with the id the batch names"),
                    ));
                }
                rewritten += 1;
            }

            let receipt_id = ctx.write_subject_receipt(
                "rotate locker.key",
                ITEM_TYPE,
                Some("rotate"),
                "allow",
                serde_json::json!({
                    "context": { "kind": "rotate" },
                    "previous_key_id": previous_key_id,
                    "key_id": key_id,
                    "cells": rewritten
                }),
            )?;
            Ok(serde_json::json!({
                "key_id": key_id,
                "previous_key_id": previous_key_id,
                "cells": rewritten,
                "receipt_id": receipt_id
            }))
        },
    );
    definition.risk = Risk::High;
    definition.confirm = true;
    definition.online_only = true;
    definition
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE THREE LISTS THAT MUST AGREE, and the one that is the schema's.
    ///
    /// `ITEM_TYPES` is the CHECK constraint's list; the `add_item` schema's
    /// enum is the door's; `type_fields` decides which columns each type owns.
    /// This is the leg of the tripwire that `crates/apps/locker` cannot hold,
    /// because reading a DDL statement belongs in the layer that owns one
    /// (`sql-confinement`).
    #[test]
    fn the_type_list_is_the_check_constraints_and_the_doors() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("contracts/schema/vault-ddl.sql");
        let ddl = std::fs::read_to_string(&path).expect("the committed DDL");
        let check = ddl
            .split("locker_item (")
            .nth(1)
            .expect("the DDL declares locker_item")
            .split("CHECK (type IN (")
            .nth(1)
            .expect("locker_item CHECKs its type")
            .split("))")
            .next()
            .expect("the CHECK closes");
        let declared: Vec<String> = check
            .split(',')
            .map(|value| value.trim().trim_matches('\'').trim().to_owned())
            .filter(|value| !value.is_empty())
            .collect();
        assert_eq!(declared, ITEM_TYPES.map(str::to_owned).to_vec());

        // And the door's own enum is the same set.
        let schema: serde_json::Value =
            serde_json::from_str(add_item().input_schema).expect("the schema is JSON");
        let door: Vec<String> = schema["properties"]["type"]["enum"]
            .as_array()
            .expect("an enum")
            .iter()
            .map(|value| value.as_str().expect("a string").to_owned())
            .collect();
        assert_eq!(door, ITEM_TYPES.map(str::to_owned).to_vec());

        // Every type owns only columns that exist, and the nine own exactly
        // the memo.
        for item_type in ITEM_TYPES {
            for column in type_fields(item_type) {
                assert!(
                    ALL_FIELDS.contains(column),
                    "{item_type} claims the column {column}, which is not one"
                );
            }
        }
        for item_type in &ITEM_TYPES[6..] {
            assert_eq!(type_fields(item_type), ["notes"], "{item_type}");
            assert!(
                !template_for(item_type).is_empty(),
                "{item_type} owns no columns and has no template either"
            );
        }
    }

    /// Every command's input schema is valid JSON and refuses an unlisted
    /// property. `additionalProperties: false` is what stops a caller
    /// inventing a column, and a schema that forgot it is a door that takes
    /// anything.
    #[test]
    fn every_input_schema_is_closed() {
        for definition in definitions() {
            let schema: serde_json::Value = serde_json::from_str(definition.input_schema)
                .unwrap_or_else(|error| {
                    panic!("{}'s input schema is not JSON: {error}", definition.name)
                });
            assert_eq!(
                schema["additionalProperties"],
                serde_json::json!(false),
                "{} takes properties it does not declare",
                definition.name
            );
        }
    }

    /// THE STRUCTURAL GUARD, at the boundary. A plaintext that merely begins
    /// `lk1:` is not ciphertext, which is why the predicate is structural and
    /// not a `starts_with`.
    #[test]
    fn only_real_ciphertext_and_the_placeholder_pass_the_cell_guard() {
        assert!(assert_sealed_cell("password", None).is_ok());
        assert!(assert_sealed_cell("password", Some("")).is_ok());
        assert!(assert_sealed_cell("password", Some(SEALED_PLACEHOLDER)).is_ok());
        assert!(assert_sealed_cell("password", Some("correct-horse")).is_err());
        // The bare prefix is the attack the structural predicate exists for: a
        // member password beginning `lk1:` must be SEALED, not stored verbatim
        // as "already sealed".
        assert!(assert_sealed_cell("password", Some("lk1:hunter2")).is_err());

        use base64::Engine as _;
        let body = base64::engine::general_purpose::STANDARD.encode([0_u8; 36]);
        assert!(assert_sealed_cell("password", Some(&format!("lk1:{body}"))).is_ok());
    }

    #[test]
    fn the_template_types_seal_only_the_value_that_is_the_credential() {
        // A passport's number is sealed; the holder's name is not, because
        // sealing metadata costs the browsable half for nothing.
        let passport = template_for("passport");
        let sealed: Vec<&str> = passport
            .iter()
            .filter(|(_, _, kind)| *kind == "sealed")
            .map(|(_, label, _)| *label)
            .collect();
        assert_eq!(sealed, ["Passport number"]);
        // A crypto wallet is the other end: three of six are the credential.
        assert_eq!(
            template_for("crypto_wallet")
                .iter()
                .filter(|(_, _, kind)| *kind == "sealed")
                .count(),
            3
        );
        // A type this build does not know has no template, which is what lets
        // it degrade to a note rather than to nothing.
        assert!(template_for("quantum_key").is_empty());
    }
}
