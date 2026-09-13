//! THE `people` SCHEMA: twenty-eight commands, the personal-CRM write surface.
//!
//! A person is a canonical `core.party` (`kind = 'person'`) plus a **1:1**
//! `people_profile` holding the keep-in-touch facts — role, nickname, avatar
//! hue, cadence, last-contacted, how you met. `add_person` mints the party and
//! the profile in one stroke; everything else hangs off the party id
//! (`packages/vault/src/commands/people.ts:1`-`:17`).
//!
//! ### The gestures the ontology already models are REUSED, never re-invented
//!
//! (#274, and it is the reason People has no tables of its own beyond the
//! profile and the important date.)
//!
//! | Gesture | Where it actually lives |
//! |---|---|
//! | a note on a person | `knowledge_annotation` on the party |
//! | the favourite | the flags-scheme `starred` tag on the PARTY, shared vault-wide |
//! | a list | a SKOS concept in the owner's `lists` scheme, membership one `core_tag` — the same mechanism Docs' folders use |
//! | a task, a gift idea | `schedule_task` plus a `core_link` to the party (`about`, `gift-for`) |
//! | a logged interaction | `core_activity` plus an `about` link, annotated with its text |
//! | an IOU | `tally_obligation` — **Tally's table**, written here and read by both |
//! | a journal entry | `knowledge_note` tagged with the People-journal marker |
//!
//! **Do not name the classification "circles"** (#441): that name collides with
//! `social_circle`, the AUDIENCE mechanism shares and Tally groups target. It
//! is "lists" end to end.
//!
//! **Logging an interaction is what clears "overdue"**: it stamps
//! `profile.last_contacted_at = now` in the same command, which is why the
//! postcondition checks the activity, the link and the stamp together.
//!
//! ### D-1020-PE8 — a command's NAME and its OWNER SCHEMA must agree
//!
//! v0 names three commands `people.save_contact_channel`,
//! `people.delete_contact_channel` and `people.undo_contact_channel` and
//! declares `ownerSchema: "social"` on all three
//! (`packages/vault/src/commands/people-organize.ts:50`, `:176`, `:252`). The
//! gateway authorises by `ownerSchema` and the caller types the NAME, so the
//! two halves of one command answer to two different schemas — and People's
//! manifest grants BOTH (`{schema: "people", verbs: "read+act"}` and three
//! narrow `{schema: "social", table: "…_contact_channel", verbs: "act"}`
//! entries), which is why nothing has ever failed.
//!
//! This registry refuses the split by construction: `Registry::register`
//! requires `name` to start with `owner_schema.` (`commands/mod.rs`), because
//! "two definitions under one name means whichever registered last runs". The
//! options were (a) rename the three to `social.*`, which breaks every caller
//! and every recorded command name in the parity fixture; (b) own them in
//! `people`, which is what the name, the action files and the census all say;
//! (c) relax the registry rule, which is weakening a gate to go green.
//! **(b) is adopted**: the three are `owner_schema: "people"` here. The member's
//! consent sentence does not change, because People's whole-schema `people`
//! grant already covers them; what changes is that a caller holding ONLY the
//! three `social` act scopes can no longer write a contact channel, and those
//! three scopes are now dead weight in the manifest — a finding, not a fix to
//! make from this lane's chair.
//!
//! ### D-1020-PE9 — the recurrence rollover is not People's to own
//!
//! `people.complete_task` delegates to `operations/task-lifecycle.ts` in v0,
//! and the reason is written down (#996 R21, drift ONT-27): People's own
//! `toggle_task` flipped the status with its own `CASE`, so a second tap
//! reopened a task Tasks had just closed and **a repeating task completed from
//! People never got its next occurrence**. Reproducing that rollover here would
//! be re-introducing exactly the drift the operation exists to prevent, and the
//! `schedule` schema is slot 4d's.
//!
//! So this port implements the whole non-recurring path and **refuses a task
//! carrying an `rrule`**, as a precondition with its own predicate and a
//! sentence naming the operation. The refusal is a `pending: schedule` marker
//! with a test holding it (`the_recurring_rollover_is_the_schedule_slots`), not
//! a silent no-op and not a second implementation.
//!
//! ### What every command here shares
//!
//! `PERSON_EXISTS` is the precondition fourteen definitions carry: a CRM person
//! is a `person` party with a LIVE profile, so a trashed person is frozen —
//! restore first, then edit, star, log or file them. Conditions read
//! `ctx.now`, never SQLite's clock, so the restore window is fixturable at any
//! instant (lane V's rule).

use crate::access::Principal;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};

/// An `https` URI, not a `urn:` — the literal is interpolated into condition
/// SQL, where `:lists` would read as a NAMED PARAMETER (#258, the
/// colon-literal trap) and no parameter name can start with a slash.
pub const LIST_SCHEME_URI: &str = "https://centraid.dev/schemes/lists";
const FLAGS_SCHEME_URI: &str = "https://centraid.dev/schemes/flags";
const STARRED_NOTATION: &str = "starred";
const RELATIONS_SCHEME_URI: &str = "urn:duaility:relations";
const ACTIVITY_KIND_SCHEME_URI: &str = "urn:duaility:activity-kinds";
const JOURNAL_SCHEME_URI: &str = "https://centraid.dev/schemes/people-journal";
const JOURNAL_ENTRY_NOTATION: &str = "entry";
const PARTY_TARGET_TYPE: &str = "core.party";
const ACTIVITY_TARGET_TYPE: &str = "core.activity";
const TASK_TARGET_TYPE: &str = "schedule.task";
const NOTE_TARGET_TYPE: &str = "knowledge.note";
/// The entity type People's own revisions are recorded under. The manifest's
/// `core.entity_revision` scope row-filters on exactly this value.
const PERSON_ENTITY_TYPE: &str = "people.person";
/// A contact channel's revisions. A different entity type from the person's,
/// because undoing a deleted phone number must not restore a whole profile.
const CHANNEL_ENTITY_TYPE: &str = "people.channel";

/// The trash window a person gets (`people.ts:198`).
const PEOPLE_PURGE_DAYS: i64 = 30;

/// How long an undo stays available (`entity-revisions.ts:9`).
const UNDO_WINDOW_MS: i64 = 10_000;

/// The title prefix a journal entry's note carries.
const JOURNAL_TITLE_PREFIX: &str = "People journal · ";

/// Every `people.*` command this build carries — **all twenty-eight of v0's**,
/// in v0's own file order so the registry's `agent_command` record reads like
/// the source it was ported from.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        add_person(),
        edit_person(),
        set_cadence(),
        trash_person(),
        restore_person(),
        undo_person(),
        log_interaction(),
        star_person(),
        unstar_person(),
        move_person(),
        add_note(),
        add_task(),
        complete_task(),
        reopen_task(),
        add_important_date(),
        toggle_reminder(),
        add_relationship(),
        add_gift(),
        toggle_gift(),
        add_debt(),
        settle_debt(),
        create_list(),
        rename_list(),
        delete_list(),
        add_journal_entry(),
        save_contact_channel(),
        delete_contact_channel(),
        undo_contact_channel(),
    ]
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/// The vault owner's party id.
fn owner_party_id(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    let owner: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT self_party_id FROM core_vault WHERE self_party_id IS NOT NULL LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();
    owner.ok_or_else(|| VaultError::Invariant {
        context: "this vault has no owner yet; enrol one before writing People rows".to_owned(),
    })
}

/// The acting party. The principal carries a device or an agent id rather than
/// a party, so this is the owner's — as v0's falls back to the owner for an app
/// (`people.ts:47`-`:50`).
fn actor_party_id(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    owner_party_id(ctx)
}

/// The vault's base currency, for debts stored as minor units.
///
/// Defaults to `USD` as v0 does (`people.ts:66`). **A default currency is a
/// real risk** — an obligation minted in the wrong currency is an arithmetic
/// error nobody sees — and it is kept because the column is `NOT NULL` with a
/// three-character CHECK, so a vault with no row would otherwise refuse the
/// write with a constraint message rather than a sentence.
fn base_currency(ctx: &CommandCtx<'_, '_>) -> String {
    ctx.connection()
        .query_row("SELECT base_currency FROM core_vault LIMIT 1", [], |row| {
            row.get::<_, String>(0)
        })
        .unwrap_or_else(|_| "USD".to_owned())
}

/// Who asserted a link. v0 reads the identity kind (`people.ts:143`-`:145`).
fn asserted_by(ctx: &CommandCtx<'_, '_>) -> &'static str {
    match ctx.principal {
        Principal::Agent { .. } => "agent",
        Principal::OwnerDevice { .. } | Principal::Automation { .. } => "owner",
    }
}

/// A concept scheme's id, created on first use.
fn find_or_create_scheme(ctx: &CommandCtx<'_, '_>, uri: &str, title: &str) -> Result<String> {
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

/// Resolve or mint one controlled-vocabulary concept a People gesture uses.
fn concept_id(
    ctx: &CommandCtx<'_, '_>,
    scheme_uri: &str,
    scheme_title: &str,
    notation: &str,
    label: &str,
) -> Result<String> {
    let scheme_id = find_or_create_scheme(ctx, scheme_uri, scheme_title)?;
    let existing: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT concept_id FROM core_concept WHERE scheme_id = ?1 AND notation = ?2",
            rusqlite::params![scheme_id, notation],
            |row| row.get(0),
        )
        .ok();
    if let Some(concept_id) = existing {
        return Ok(concept_id);
    }
    let concept_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_concept
           (concept_id, scheme_id, notation, pref_label, alt_labels_json,
            broader_concept_id, definition, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, ?5, ?5)",
        rusqlite::params![concept_id, scheme_id, notation, label, ctx.now],
    )?;
    Ok(concept_id)
}

/// The `starred` concept id, created on first use. "Favorite" rides along as a
/// SKOS altLabel, so the star is one row in one place for every surface (#274).
fn starred_concept_id(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    let scheme_id = find_or_create_scheme(ctx, FLAGS_SCHEME_URI, "Flags")?;
    let existing: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT concept_id FROM core_concept WHERE scheme_id = ?1 AND notation = ?2",
            rusqlite::params![scheme_id, STARRED_NOTATION],
            |row| row.get(0),
        )
        .ok();
    if let Some(concept_id) = existing {
        return Ok(concept_id);
    }
    let concept_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_concept
           (concept_id, scheme_id, notation, pref_label, alt_labels_json,
            broader_concept_id, definition, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'Starred', '[\"Favorite\"]', NULL,
                 'Owner attention: one star across every surface', ?4, ?4)",
        rusqlite::params![concept_id, scheme_id, STARRED_NOTATION, ctx.now],
    )?;
    Ok(concept_id)
}

/// Set or clear the star on a PARTY. Delete-then-insert keeps it idempotent
/// and refreshes who-starred-when on a re-star (`flags.ts:74`-`:75`).
fn set_starred(ctx: &CommandCtx<'_, '_>, party_id: &str, starred: bool) -> Result<()> {
    let concept_id = starred_concept_id(ctx)?;
    ctx.connection().execute(
        "DELETE FROM core_tag WHERE target_type = ?1 AND target_id = ?2 AND concept_id = ?3",
        rusqlite::params![PARTY_TARGET_TYPE, party_id, concept_id],
    )?;
    if !starred {
        return Ok(());
    }
    let tag_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_tag
           (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
            confidence, tagged_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)",
        rusqlite::params![
            tag_id,
            PARTY_TARGET_TYPE,
            party_id,
            concept_id,
            actor_party_id(ctx)?,
            ctx.now
        ],
    )?;
    Ok(())
}

/// Whether a live `starred` tag stands on this party.
fn is_starred(ctx: &CommandCtx<'_, '_>, party_id: &str) -> Result<bool> {
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = ?1 AND t.target_id = ?2
            AND s.uri = ?3 AND c.notation = ?4",
        rusqlite::params![
            PARTY_TARGET_TYPE,
            party_id,
            FLAGS_SCHEME_URI,
            STARRED_NOTATION
        ],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// File a person into EXACTLY ONE list, or none. Delete-then-insert, which is
/// what makes `move_person` a refile rather than a second filing.
fn file_into_list(
    ctx: &CommandCtx<'_, '_>,
    party_id: &str,
    list_concept_id: Option<&str>,
) -> Result<()> {
    ctx.connection().execute(
        "DELETE FROM core_tag
          WHERE target_type = ?1 AND target_id = ?2
            AND concept_id IN (SELECT c.concept_id FROM core_concept c
                                 JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                                WHERE s.uri = ?3)",
        rusqlite::params![PARTY_TARGET_TYPE, party_id, LIST_SCHEME_URI],
    )?;
    let Some(list_concept_id) = list_concept_id else {
        return Ok(());
    };
    let tag_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_tag
           (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
            confidence, tagged_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)",
        rusqlite::params![
            tag_id,
            PARTY_TARGET_TYPE,
            party_id,
            list_concept_id,
            actor_party_id(ctx)?,
            ctx.now
        ],
    )?;
    Ok(())
}

/// Assert one temporal `core_link` onto a party, and return its id.
fn link_to_party(
    ctx: &CommandCtx<'_, '_>,
    from_type: &str,
    from_id: &str,
    party_id: &str,
    relation_concept_id: &str,
) -> Result<String> {
    let link_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_link
           (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
            valid_from, valid_to, asserted_by, provenance_id, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, NULL, ?7)",
        rusqlite::params![
            link_id,
            from_type,
            from_id,
            PARTY_TARGET_TYPE,
            party_id,
            relation_concept_id,
            ctx.now,
            asserted_by(ctx)
        ],
    )?;
    Ok(link_id)
}

/// One owner memo on an entity (`annotations.ts:14`).
fn annotate(
    ctx: &CommandCtx<'_, '_>,
    target_type: &str,
    target_id: &str,
    body: &str,
) -> Result<String> {
    let annotation_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO knowledge_annotation
           (annotation_id, author_party_id, target_type, target_id, selector_json,
            body_text, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?6)",
        rusqlite::params![
            annotation_id,
            actor_party_id(ctx)?,
            target_type,
            target_id,
            body,
            ctx.now
        ],
    )?;
    Ok(annotation_id)
}

/// `slug` (`people.ts:175`-`:183`): lower-cased, non-alphanumerics collapsed to
/// hyphens, trimmed — and `related` for anything that collapses to nothing.
#[must_use]
pub fn slug(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_hyphen = false;
    for character in text.trim().chars() {
        if character.is_ascii_alphanumeric() {
            if pending_hyphen && !out.is_empty() {
                out.push('-');
            }
            pending_hyphen = false;
            out.push(character.to_ascii_lowercase());
        } else {
            pending_hyphen = true;
        }
    }
    if out.is_empty() {
        "related".to_owned()
    } else {
        out
    }
}

/// `encodeURIComponent`, for a journal entry's inline body.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A `text/plain` content item for a body, deduped on its sha
/// (`knowledge.ts:67`-`:99`).
fn content_item_for(ctx: &CommandCtx<'_, '_>, body_text: &str) -> Result<String> {
    let sha = centraid_media::format::sha256_hex(body_text.as_bytes());
    let existing: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT content_id FROM core_content_item WHERE sha256 = ?1",
            [&sha],
            |row| row.get(0),
        )
        .ok();
    if let Some(content_id) = existing {
        return Ok(content_id);
    }
    let content_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_content_item
           (content_id, content_uri, sha256, byte_size, language, creator_party_id,
            origin_device_id, deleted_at, purge_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, NULL, NULL, ?6, ?6)",
        rusqlite::params![
            content_id,
            format!(
                "data:text/plain;charset=utf-8,{}",
                encode_uri_component(body_text)
            ),
            sha,
            i64::try_from(body_text.len()).unwrap_or(i64::MAX),
            actor_party_id(ctx)?,
            ctx.now
        ],
    )?;
    Ok(content_id)
}

/// The note's representation, plus the decoded text the FTS trigger reads.
fn set_note_representation(
    ctx: &CommandCtx<'_, '_>,
    note_id: &str,
    content_id: &str,
    body_text: &str,
) -> Result<()> {
    // The text row is written BEFORE the representation, because the
    // representation's own FTS trigger reads `core_content_text`
    // (`schema/representation.ts:120`-`:124`).
    ctx.connection().execute(
        "INSERT INTO core_content_text
           (content_id, body_text, decoder, byte_size, created_at, updated_at)
         VALUES (?1, ?2, 'data-uri/v1', ?3, ?4, ?4)
         ON CONFLICT (content_id) DO UPDATE SET
           body_text = excluded.body_text,
           byte_size = excluded.byte_size,
           updated_at = excluded.updated_at",
        rusqlite::params![
            content_id,
            body_text,
            i64::try_from(body_text.len()).unwrap_or(i64::MAX),
            ctx.now
        ],
    )?;
    let representation_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO core_content_representation
           (representation_id, content_id, owner_type, owner_id, media_type,
            charset, interpretation, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'text/plain', 'utf-8', 'body', ?5, ?5)
         ON CONFLICT (owner_type, owner_id) DO UPDATE SET
           content_id = excluded.content_id,
           media_type = excluded.media_type,
           updated_at = excluded.updated_at",
        rusqlite::params![
            representation_id,
            content_id,
            NOTE_TARGET_TYPE,
            note_id,
            ctx.now
        ],
    )?;
    Ok(())
}

/// The instant a person trashed at `now` purges at.
fn purge_at(now: &str) -> Result<String> {
    let millis = crate::clock::parse_iso_ms(now).ok_or_else(|| VaultError::Invariant {
        context: format!("`{now}` is not an instant this vault can date a purge from"),
    })?;
    Ok(crate::clock::format_iso_ms(
        millis + PEOPLE_PURGE_DAYS * 86_400_000,
    ))
}

/// A person's whole snapshot, as the undo rail restores it.
///
/// **A row snapshot would not be enough for every entity** — the generic
/// capture handles the single-row cases and this stays for the composite ones
/// (`entity-revisions.ts:33`-`:44`) — and a person's is composite because the
/// display name lives on `core_party` and everything else on `people_profile`.
fn person_snapshot(ctx: &CommandCtx<'_, '_>, party_id: &str) -> Result<serde_json::Value> {
    ctx.connection()
        .query_row(
            "SELECT pr.profile_id, p.display_name, pr.role, pr.nickname, pr.avatar_color,
                    pr.cadence_days, pr.last_contacted_at, pr.met, pr.deleted_at, pr.purge_at
               FROM people_profile pr
               JOIN core_party p ON p.party_id = pr.party_id
              WHERE pr.party_id = ?1",
            [party_id],
            |row| {
                Ok(serde_json::json!({
                    "profile_id": row.get::<_, String>(0)?,
                    "display_name": row.get::<_, String>(1)?,
                    "role": row.get::<_, Option<String>>(2)?,
                    "nickname": row.get::<_, Option<String>>(3)?,
                    "avatar_color": row.get::<_, Option<String>>(4)?,
                    "cadence_days": row.get::<_, i64>(5)?,
                    "last_contacted_at": row.get::<_, Option<String>>(6)?,
                    "met": row.get::<_, Option<String>>(7)?,
                    "deleted_at": row.get::<_, Option<String>>(8)?,
                    "purge_at": row.get::<_, Option<String>>(9)?,
                }))
            },
        )
        .map_err(|_| VaultError::InvalidInput {
            name: "party_id".to_owned(),
            detail: "there is no person with that id".to_owned(),
        })
}

/// Append a pre-mutation snapshot, and return `(revision_id, undo_until)`.
fn record_revision(
    ctx: &CommandCtx<'_, '_>,
    entity_type: &str,
    entity_id: &str,
    operation: &str,
    snapshot: &serde_json::Value,
) -> Result<(String, String)> {
    let revision_id = ctx.next_id();
    let undo_until = crate::clock::format_iso_ms(
        crate::clock::parse_iso_ms(&ctx.now).ok_or_else(|| VaultError::Invariant {
            context: format!(
                "`{}` is not an instant an undo window can start at",
                ctx.now
            ),
        })? + UNDO_WINDOW_MS,
    );
    ctx.connection().execute(
        "INSERT INTO core_entity_revision
           (revision_id, entity_type, entity_id, operation, snapshot_json,
            recorded_at, undo_until, undone_at, actor_party_id, invocation_id, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?6)",
        rusqlite::params![
            revision_id,
            entity_type,
            entity_id,
            operation,
            serde_json::to_string(snapshot).unwrap_or_else(|_| "{}".to_owned()),
            ctx.now,
            undo_until,
            owner_party_id(ctx).ok(),
            ctx.invocation_id,
        ],
    )?;
    Ok((revision_id, undo_until))
}

/// The newest live revision of an entity, or the named one.
///
/// **Expired and already-undone revisions are refused**, because a snapshot
/// applies ONCE (`entity-revisions.ts:120`).
fn load_revision(
    ctx: &CommandCtx<'_, '_>,
    entity_type: &str,
    entity_id: &str,
    revision_id: Option<&str>,
) -> Result<(String, serde_json::Value)> {
    let found: Option<(String, String)> = ctx
        .connection()
        .query_row(
            "SELECT revision_id, snapshot_json FROM core_entity_revision
              WHERE entity_type = ?1 AND entity_id = ?2
                AND (?3 IS NULL OR revision_id = ?3)
                AND undone_at IS NULL
                AND undo_until >= ?4
              ORDER BY recorded_at DESC, revision_id DESC
              LIMIT 1",
            rusqlite::params![entity_type, entity_id, revision_id, ctx.now],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    let (revision_id, snapshot_json) = found.ok_or_else(|| VaultError::InvalidInput {
        name: "revision_id".to_owned(),
        detail: "that change is no longer undoable — the window has passed, or it has already been undone".to_owned(),
    })?;
    let snapshot = serde_json::from_str(&snapshot_json).map_err(|source| VaultError::Json {
        context: format!("revision {revision_id} carries a snapshot that is not JSON"),
        source,
    })?;
    Ok((revision_id, snapshot))
}

/// Mark a one-shot undo applied, in the applying transaction.
fn mark_revision_undone(ctx: &CommandCtx<'_, '_>, revision_id: &str) -> Result<()> {
    let changed = ctx.connection().execute(
        "UPDATE core_entity_revision SET undone_at = ?1
          WHERE revision_id = ?2 AND undone_at IS NULL",
        rusqlite::params![ctx.now, revision_id],
    )?;
    if changed != 1 {
        return Err(VaultError::Invariant {
            context: format!("revision {revision_id} was already undone"),
        });
    }
    Ok(())
}

/// Whether an undoable revision stands for an entity — live, not yet applied,
/// and inside its window.
///
/// **A REFUSAL INSIDE A HANDLER IS AN `Err`, AND ONLY A PRECONDITION IS
/// RECEIPTED.** The gate order writes a check row and an owner-facing sentence
/// for every precondition and receipts the deny (`commands/mod.rs`, gates 4 and
/// 8); a handler that returns an error propagates out of `Vault::execute`
/// instead, and a surface has nothing to render. v0 throws from its handlers and
/// its gateway catches; the port asks the question up front, so every
/// member-facing refusal in this schema is a receipted DENY rather than an
/// error — which is also what makes it fixturable.
fn revision_is_undoable(
    ctx: &CommandCtx<'_, '_>,
    entity_type: &str,
    entity_id: &str,
    revision_id: Option<&str>,
) -> Result<bool> {
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM core_entity_revision
          WHERE entity_type = ?1 AND entity_id = ?2
            AND (?3 IS NULL OR revision_id = ?3)
            AND undone_at IS NULL AND undo_until >= ?4",
        rusqlite::params![entity_type, entity_id, revision_id, ctx.now],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

const UNDOABLE_SENTENCE: &str =
    "that change is no longer undoable — the window has passed, or it has already been undone";

fn snapshot_str<'a>(snapshot: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    snapshot.get(key).and_then(serde_json::Value::as_str)
}

// ---------------------------------------------------------------------------
// Shared conditions.
// ---------------------------------------------------------------------------

/// A live CRM person: a `person` party with an undeleted profile.
fn person_is_live(ctx: &CommandCtx<'_, '_>, party_id: &str) -> Result<bool> {
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM people_profile pr
           JOIN core_party p ON p.party_id = pr.party_id
          WHERE pr.party_id = ?1 AND p.kind = 'person' AND pr.deleted_at IS NULL",
        [party_id],
        |row| row.get(0),
    )?;
    Ok(count == 1)
}

fn pre_person_exists(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let party_id = ctx.required_str("party_id")?;
    Ok(
        (!person_is_live(ctx, party_id)?)
            .then(|| "there is no live person with that id".to_owned()),
    )
}

const LIVE_PERSON: [CommandCondition; 1] = [CommandCondition {
    predicate: "person_exists",
    check: pre_person_exists,
}];

/// A trashed person whose window has NOT lapsed.
///
/// **RESTORE REFUSES A LAPSED WINDOW** (#916, review 1.5): the trash window is
/// a PROMISE that the row goes, and a restore after it lapsed resurrects data
/// the member was told had been deleted — and races the sweep for it. The
/// comparison is against `ctx.now`, never SQLite's clock.
fn person_is_restorable(ctx: &CommandCtx<'_, '_>, party_id: &str) -> Result<bool> {
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM people_profile pr
           JOIN core_party p ON p.party_id = pr.party_id
          WHERE pr.party_id = ?1 AND p.kind = 'person'
            AND pr.deleted_at IS NOT NULL
            AND (pr.purge_at IS NULL OR pr.purge_at > ?2)",
        rusqlite::params![party_id, ctx.now],
        |row| row.get(0),
    )?;
    Ok(count == 1)
}

fn pre_person_trashed(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let party_id = ctx.required_str("party_id")?;
    Ok((!person_is_restorable(ctx, party_id)?)
        .then(|| "that person is not in the trash, or their restore window has passed".to_owned()))
}

/// The person exists at all — trashed or not. `undo_person` restores a
/// snapshot that may itself be a trashed state, so it cannot ask for a live one.
fn pre_person_exists_including_trash(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let party_id = ctx.required_str("party_id")?;
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM people_profile pr
           JOIN core_party p ON p.party_id = pr.party_id
          WHERE pr.party_id = ?1 AND p.kind = 'person'",
        [party_id],
        |row| row.get(0),
    )?;
    Ok((count != 1).then(|| "there is no person with that id".to_owned()))
}

/// Is this concept a list in the owner's lists scheme?
fn list_exists(ctx: &CommandCtx<'_, '_>, list_id: &str) -> Result<bool> {
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM core_concept c
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE c.concept_id = ?1 AND s.uri = ?2",
        rusqlite::params![list_id, LIST_SCHEME_URI],
        |row| row.get(0),
    )?;
    Ok(count == 1)
}

fn pre_list_exists_if_given(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let Some(list_id) = ctx.optional_str("list_id") else {
        return Ok(None);
    };
    Ok((!list_exists(ctx, list_id)?).then(|| "there is no list with that id".to_owned()))
}

fn pre_list_exists(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let list_id = ctx.required_str("list_id")?;
    Ok((!list_exists(ctx, list_id)?).then(|| "there is no list with that id".to_owned()))
}

/// A task this person's sheet can act on: a task linked to a CRM person.
fn person_task_exists(ctx: &CommandCtx<'_, '_>, task_id: &str) -> Result<bool> {
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM schedule_task t
           JOIN core_link l ON l.from_type = ?1 AND l.from_id = t.task_id
           JOIN people_profile p ON p.party_id = l.to_id
          WHERE t.task_id = ?2 AND l.to_type = ?3 AND l.valid_to IS NULL",
        rusqlite::params![TASK_TARGET_TYPE, task_id, PARTY_TARGET_TYPE],
        |row| row.get(0),
    )?;
    Ok(count >= 1)
}

fn pre_person_task_exists(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let task_id = ctx.required_str("task_id")?;
    Ok((!person_task_exists(ctx, task_id)?)
        .then(|| "that task is not one of this person's".to_owned()))
}

/// D-1020-PE9: a repeating task's rollover belongs to `schedule`.
fn pre_task_is_not_a_series(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let task_id = ctx.required_str("task_id")?;
    let rrule: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT rrule FROM schedule_task WHERE task_id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    Ok(rrule.map(|_| {
        "that task repeats, and completing a repeating task spawns its next occurrence — \
         which is `schedule.organize_task`'s to do, not People's. Complete it from Tasks."
            .to_owned()
    }))
}

// ---------------------------------------------------------------------------
// Person.
// ---------------------------------------------------------------------------

fn add_person() -> CommandDefinition {
    CommandDefinition {
        name: "people.add_person",
        owner_schema: "people",
        input_schema: r#"{
          "type": "object",
          "required": ["display_name", "cadence_days"],
          "additionalProperties": false,
          "properties": {
            "party_id": { "type": "string", "minLength": 1 },
            "display_name": { "type": "string", "minLength": 1 },
            "role": { "type": "string" },
            "nickname": { "type": "string" },
            "avatar_color": { "type": "string" },
            "cadence_days": { "type": "integer", "minimum": 0 },
            "list_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "minted_id_is_free",
                check: |ctx| {
                    let Some(party_id) = ctx.optional_str("party_id") else {
                        return Ok(None);
                    };
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_party WHERE party_id = ?1",
                        [party_id],
                        |row| row.get(0),
                    )?;
                    Ok((count > 0)
                        .then(|| "a person already holds the id this write minted".to_owned()))
                },
            },
            CommandCondition {
                predicate: "list_exists_if_given",
                check: pre_list_exists_if_given,
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "person_created",
            check: |ctx| {
                let party_id = minted_party_id(ctx);
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM people_profile WHERE party_id = ?1",
                    [&party_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the person was not created".to_owned()))
            },
        }],
        handler: |ctx| {
            let display_name = ctx.required_str("display_name")?.to_owned();
            let cadence_days = ctx
                .input
                .get("cadence_days")
                .and_then(serde_json::Value::as_i64)
                .ok_or_else(|| VaultError::InvalidInput {
                    name: "cadence_days".to_owned(),
                    detail: "a cadence in whole days is required; 0 means no cadence".to_owned(),
                })?;
            let role = ctx.optional_str("role").map(str::to_owned);
            let nickname = ctx.optional_str("nickname").map(str::to_owned);
            let avatar_color = ctx.optional_str("avatar_color").map(str::to_owned);
            let list_id = ctx.optional_str("list_id").map(str::to_owned);
            // A SEAT-MINTED ID IS HONOURED, so an offline compose keeps the row
            // it already showed (#922 G2). Checked free above.
            let party_id = ctx
                .optional_str("party_id")
                .map_or_else(|| ctx.next_id(), str::to_owned);

            ctx.connection().execute(
                "INSERT INTO core_party
                   (party_id, kind, display_name, sort_name, birth_date,
                    avatar_content_id, created_at, updated_at)
                 VALUES (?1, 'person', ?2, NULL, NULL, NULL, ?3, ?3)",
                rusqlite::params![party_id, display_name, ctx.now],
            )?;
            let profile_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO people_profile
                   (profile_id, party_id, role, nickname, avatar_color, cadence_days,
                    last_contacted_at, met, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, ?7)",
                rusqlite::params![
                    profile_id,
                    party_id,
                    role,
                    nickname,
                    avatar_color,
                    cadence_days,
                    ctx.now
                ],
            )?;
            if let Some(list_id) = list_id.as_deref() {
                file_into_list(ctx, &party_id, Some(list_id))?;
            }
            Ok(serde_json::json!({ "party_id": party_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

/// The party id `add_person` used: the caller's, or the first id it minted.
fn minted_party_id(ctx: &CommandCtx<'_, '_>) -> String {
    ctx.optional_str("party_id").map_or_else(
        || {
            ctx.produced_ids
                .borrow()
                .first()
                .cloned()
                .unwrap_or_default()
        },
        str::to_owned,
    )
}

fn edit_person() -> CommandDefinition {
    CommandDefinition {
        name: "people.edit_person",
        owner_schema: "people",
        input_schema: r#"{
          "type": "object",
          "required": ["party_id"],
          "additionalProperties": false,
          "properties": {
            "party_id": { "type": "string", "minLength": 1 },
            "display_name": { "type": "string", "minLength": 1 },
            "role": { "type": "string" },
            "nickname": { "type": "string" },
            "avatar_color": { "type": "string" },
            "met": { "type": "string" }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &LIVE_PERSON,
        postconditions: &[CommandCondition {
            predicate: "name_applied",
            check: |ctx| {
                let Some(display_name) = ctx.optional_str("display_name") else {
                    return Ok(None);
                };
                let party_id = ctx.required_str("party_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_party WHERE party_id = ?1 AND display_name = ?2",
                    rusqlite::params![party_id, display_name],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the new name did not reach the party".to_owned()))
            },
        }],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            let snapshot = person_snapshot(ctx, &party_id)?;
            let (revision_id, undo_until) =
                record_revision(ctx, PERSON_ENTITY_TYPE, &party_id, "edit", &snapshot)?;
            if let Some(display_name) = ctx.optional_str("display_name") {
                ctx.connection().execute(
                    "UPDATE core_party SET display_name = ?1, updated_at = ?2 WHERE party_id = ?3",
                    rusqlite::params![display_name, ctx.now, party_id],
                )?;
            }
            // FOUR OPTIONAL COLUMNS, one statement per present key. An absent
            // key is not a NULL: `edit-person` sends the fields the form holds
            // and a blanket UPDATE would erase the rest.
            for (key, column) in [
                ("role", "role"),
                ("nickname", "nickname"),
                ("avatar_color", "avatar_color"),
                ("met", "met"),
            ] {
                if let Some(value) = ctx.optional_str(key) {
                    ctx.connection().execute(
                        &format!("UPDATE people_profile SET {column} = ?1, updated_at = ?2 WHERE party_id = ?3"),
                        rusqlite::params![value, ctx.now, party_id],
                    )?;
                }
            }
            Ok(serde_json::json!({
                "party_id": party_id,
                "revision_id": revision_id,
                "undo_until": undo_until,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn set_cadence() -> CommandDefinition {
    CommandDefinition {
        name: "people.set_cadence",
        owner_schema: "people",
        input_schema: r#"{
          "type": "object",
          "required": ["party_id", "cadence_days"],
          "additionalProperties": false,
          "properties": {
            "party_id": { "type": "string", "minLength": 1 },
            "cadence_days": { "type": "integer", "minimum": 0 }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &LIVE_PERSON,
        postconditions: &[CommandCondition {
            predicate: "cadence_applied",
            check: |ctx| {
                let party_id = ctx.required_str("party_id")?;
                let cadence = ctx
                    .input
                    .get("cadence_days")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(-1);
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM people_profile WHERE party_id = ?1 AND cadence_days = ?2",
                    rusqlite::params![party_id, cadence],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the cadence did not apply".to_owned()))
            },
        }],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            let cadence = ctx
                .input
                .get("cadence_days")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or_default();
            let snapshot = person_snapshot(ctx, &party_id)?;
            let (revision_id, undo_until) =
                record_revision(ctx, PERSON_ENTITY_TYPE, &party_id, "cadence", &snapshot)?;
            ctx.connection().execute(
                "UPDATE people_profile SET cadence_days = ?1, updated_at = ?2 WHERE party_id = ?3",
                rusqlite::params![cadence, ctx.now, party_id],
            )?;
            Ok(serde_json::json!({
                "party_id": party_id,
                "revision_id": revision_id,
                "undo_until": undo_until,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn trash_person() -> CommandDefinition {
    CommandDefinition {
        name: "people.trash_person",
        owner_schema: "people",
        input_schema: PARTY_ID_ONLY,
        idempotency: Idempotency::Once,
        // MEDIUM, and it is the only `people.*` command above `low`. Risk is
        // salience and never an approval trigger; the dialog in front of this
        // is the manifest's `confirmation: "required"`, which is a different
        // gate (census §A0).
        risk: Risk::Medium,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "person_live",
            check: pre_person_exists,
        }],
        postconditions: &[CommandCondition {
            predicate: "person_trashed",
            check: |ctx| {
                let party_id = ctx.required_str("party_id")?;
                Ok((!person_is_restorable(ctx, party_id)?)
                    .then(|| "the person was not moved to the trash".to_owned()))
            },
        }],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            let snapshot = person_snapshot(ctx, &party_id)?;
            let (revision_id, undo_until) =
                record_revision(ctx, PERSON_ENTITY_TYPE, &party_id, "trash", &snapshot)?;
            // THE CANONICAL PARTY SURVIVES (`actions/trash-person.ts:3`): only
            // the profile is dated shut, so every link, tag and obligation
            // naming this person still resolves.
            ctx.connection().execute(
                "UPDATE people_profile SET deleted_at = ?1, purge_at = ?2, updated_at = ?1
                  WHERE party_id = ?3",
                rusqlite::params![ctx.now, purge_at(&ctx.now)?, party_id],
            )?;
            Ok(serde_json::json!({
                "party_id": party_id,
                "revision_id": revision_id,
                "undo_until": undo_until,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn restore_person() -> CommandDefinition {
    CommandDefinition {
        name: "people.restore_person",
        owner_schema: "people",
        input_schema: PARTY_ID_ONLY,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "person_trashed",
            check: pre_person_trashed,
        }],
        postconditions: &[CommandCondition {
            predicate: "person_live",
            check: |ctx| {
                let party_id = ctx.required_str("party_id")?;
                Ok((!person_is_live(ctx, party_id)?)
                    .then(|| "the person did not come back".to_owned()))
            },
        }],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            let snapshot = person_snapshot(ctx, &party_id)?;
            record_revision(ctx, PERSON_ENTITY_TYPE, &party_id, "restore", &snapshot)?;
            ctx.connection().execute(
                "UPDATE people_profile SET deleted_at = NULL, purge_at = NULL, updated_at = ?1
                  WHERE party_id = ?2",
                rusqlite::params![ctx.now, party_id],
            )?;
            Ok(serde_json::json!({ "party_id": party_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn undo_person() -> CommandDefinition {
    CommandDefinition {
        name: "people.undo_person",
        owner_schema: "people",
        input_schema: r#"{
          "type": "object",
          "required": ["party_id", "revision_id"],
          "additionalProperties": false,
          "properties": {
            "party_id": { "type": "string", "minLength": 1 },
            "revision_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "person_exists_including_trash",
                check: pre_person_exists_including_trash,
            },
            CommandCondition {
                predicate: "revision_is_undoable",
                check: |ctx| {
                    let party_id = ctx.required_str("party_id")?;
                    let revision_id = ctx.required_str("revision_id")?;
                    Ok((!revision_is_undoable(
                        ctx,
                        PERSON_ENTITY_TYPE,
                        party_id,
                        Some(revision_id),
                    )?)
                    .then(|| UNDOABLE_SENTENCE.to_owned()))
                },
            },
        ],
        postconditions: &[],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            let revision_id = ctx.required_str("revision_id")?.to_owned();
            let (revision_id, snapshot) =
                load_revision(ctx, PERSON_ENTITY_TYPE, &party_id, Some(&revision_id))?;
            ctx.connection().execute(
                "UPDATE core_party SET display_name = ?1, updated_at = ?2 WHERE party_id = ?3",
                rusqlite::params![
                    snapshot_str(&snapshot, "display_name").unwrap_or_default(),
                    ctx.now,
                    party_id
                ],
            )?;
            ctx.connection().execute(
                "UPDATE people_profile
                    SET role = ?1, nickname = ?2, avatar_color = ?3, cadence_days = ?4,
                        last_contacted_at = ?5, met = ?6, deleted_at = ?7, purge_at = ?8,
                        updated_at = ?9
                  WHERE party_id = ?10",
                rusqlite::params![
                    snapshot_str(&snapshot, "role"),
                    snapshot_str(&snapshot, "nickname"),
                    snapshot_str(&snapshot, "avatar_color"),
                    snapshot
                        .get("cadence_days")
                        .and_then(serde_json::Value::as_i64)
                        .unwrap_or_default(),
                    snapshot_str(&snapshot, "last_contacted_at"),
                    snapshot_str(&snapshot, "met"),
                    snapshot_str(&snapshot, "deleted_at"),
                    snapshot_str(&snapshot, "purge_at"),
                    ctx.now,
                    party_id
                ],
            )?;
            // A SNAPSHOT APPLIES ONCE.
            mark_revision_undone(ctx, &revision_id)?;
            Ok(serde_json::json!({ "party_id": party_id, "revision_id": revision_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

const PARTY_ID_ONLY: &str = r#"{
  "type": "object",
  "required": ["party_id"],
  "additionalProperties": false,
  "properties": { "party_id": { "type": "string", "minLength": 1 } }
}"#;

fn log_interaction() -> CommandDefinition {
    CommandDefinition {
        name: "people.log_interaction",
        owner_schema: "people",
        input_schema: r#"{
          "type": "object",
          "required": ["party_id", "kind"],
          "additionalProperties": false,
          "properties": {
            "party_id": { "type": "string", "minLength": 1 },
            "kind": { "type": "string", "minLength": 1 },
            "text": { "type": "string" }
          }
        }"#,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &LIVE_PERSON,
        postconditions: &[CommandCondition {
            // LOGGED AND LAST-CONTACTED STAMPED IN ONE STROKE — this is what
            // clears "overdue", so the check is all three or none.
            predicate: "interaction_logged",
            check: |ctx| {
                let party_id = ctx.required_str("party_id")?;
                let activity_id = ctx
                    .produced_ids
                    .borrow()
                    .first()
                    .cloned()
                    .unwrap_or_default();
                let complete: i64 = ctx.connection().query_row(
                    "SELECT (EXISTS(SELECT 1 FROM core_activity WHERE activity_id = ?1)
                          AND EXISTS(SELECT 1 FROM core_link
                                      WHERE from_type = ?2 AND from_id = ?1
                                        AND to_type = ?3 AND to_id = ?4 AND valid_to IS NULL)
                          AND EXISTS(SELECT 1 FROM people_profile
                                      WHERE party_id = ?4 AND last_contacted_at IS NOT NULL))",
                    rusqlite::params![
                        activity_id,
                        ACTIVITY_TARGET_TYPE,
                        PARTY_TARGET_TYPE,
                        party_id
                    ],
                    |row| row.get(0),
                )?;
                Ok((complete != 1)
                    .then(|| "the touch was not logged against this person".to_owned()))
            },
        }],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            let kind = ctx.required_str("kind")?.to_owned();
            let text = ctx.optional_str("text").map(str::to_owned);
            // The activity id is minted FIRST so the postcondition can find it
            // as the invocation's first produced id.
            let interaction_id = ctx.next_id();
            let kind_concept_id = concept_id(
                ctx,
                ACTIVITY_KIND_SCHEME_URI,
                "Activity kinds",
                &slug(&kind),
                &kind,
            )?;
            ctx.connection().execute(
                "INSERT INTO core_activity
                   (activity_id, actor_party_id, kind_concept_id, started_at, ended_at,
                    location_place_id, source_app_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, ?4)",
                rusqlite::params![
                    interaction_id,
                    owner_party_id(ctx)?,
                    kind_concept_id,
                    ctx.now
                ],
            )?;
            let about = concept_id(
                ctx,
                RELATIONS_SCHEME_URI,
                "Link relation types",
                "about",
                "About",
            )?;
            link_to_party(
                ctx,
                ACTIVITY_TARGET_TYPE,
                &interaction_id,
                &party_id,
                &about,
            )?;
            if let Some(text) = text.as_deref().filter(|text| !text.is_empty()) {
                annotate(ctx, ACTIVITY_TARGET_TYPE, &interaction_id, text)?;
            }
            ctx.connection().execute(
                "UPDATE people_profile SET last_contacted_at = ?1, updated_at = ?1
                  WHERE party_id = ?2",
                rusqlite::params![ctx.now, party_id],
            )?;
            Ok(serde_json::json!({ "interaction_id": interaction_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

// ---------------------------------------------------------------------------
// The favourite — the canonical flags-scheme star, on the PARTY.
// ---------------------------------------------------------------------------

fn star_person() -> CommandDefinition {
    CommandDefinition {
        name: "people.star_person",
        owner_schema: "people",
        input_schema: PARTY_ID_ONLY,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &LIVE_PERSON,
        postconditions: &[CommandCondition {
            predicate: "person_starred",
            check: |ctx| {
                let party_id = ctx.required_str("party_id")?;
                Ok((!is_starred(ctx, party_id)?).then(|| "the star did not land".to_owned()))
            },
        }],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            set_starred(ctx, &party_id, true)?;
            Ok(serde_json::json!({ "party_id": party_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn unstar_person() -> CommandDefinition {
    CommandDefinition {
        name: "people.unstar_person",
        owner_schema: "people",
        input_schema: PARTY_ID_ONLY,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &LIVE_PERSON,
        postconditions: &[CommandCondition {
            predicate: "person_unstarred",
            check: |ctx| {
                let party_id = ctx.required_str("party_id")?;
                Ok(is_starred(ctx, party_id)?.then(|| "the star is still there".to_owned()))
            },
        }],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            set_starred(ctx, &party_id, false)?;
            Ok(serde_json::json!({ "party_id": party_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn move_person() -> CommandDefinition {
    CommandDefinition {
        name: "people.move_person",
        owner_schema: "people",
        input_schema: r#"{
          "type": "object",
          "required": ["party_id"],
          "additionalProperties": false,
          "properties": {
            "party_id": { "type": "string", "minLength": 1 },
            "list_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "person_exists",
                check: pre_person_exists,
            },
            CommandCondition {
                predicate: "list_exists_if_given",
                check: pre_list_exists_if_given,
            },
        ],
        postconditions: &[CommandCondition {
            // FILED EXACTLY WHERE ASKED. An omitted `list_id` un-lists: no
            // lists-scheme tag at all. A given one: that list, and ONLY it.
            predicate: "list_applied",
            check: |ctx| {
                let party_id = ctx.required_str("party_id")?;
                let in_scheme: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_tag t
                       JOIN core_concept c ON c.concept_id = t.concept_id
                       JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                      WHERE t.target_type = ?1 AND t.target_id = ?2 AND s.uri = ?3",
                    rusqlite::params![PARTY_TARGET_TYPE, party_id, LIST_SCHEME_URI],
                    |row| row.get(0),
                )?;
                let Some(list_id) = ctx.optional_str("list_id") else {
                    return Ok(
                        (in_scheme != 0).then(|| "the person is still filed in a list".to_owned())
                    );
                };
                let on_list: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_tag
                      WHERE target_type = ?1 AND target_id = ?2 AND concept_id = ?3",
                    rusqlite::params![PARTY_TARGET_TYPE, party_id, list_id],
                    |row| row.get(0),
                )?;
                Ok((on_list != 1 || in_scheme != 1)
                    .then(|| "the person is not filed in exactly that one list".to_owned()))
            },
        }],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            let list_id = ctx.optional_str("list_id").map(str::to_owned);
            file_into_list(ctx, &party_id, list_id.as_deref())?;
            Ok(serde_json::json!({ "party_id": party_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

// ---------------------------------------------------------------------------
// Notes, tasks and gift ideas.
// ---------------------------------------------------------------------------

fn add_note() -> CommandDefinition {
    CommandDefinition {
        name: "people.add_note",
        owner_schema: "people",
        input_schema: PARTY_AND_TEXT,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &LIVE_PERSON,
        postconditions: &[],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            let text = ctx.required_str("text")?.to_owned();
            annotate(ctx, PARTY_TARGET_TYPE, &party_id, &text)?;
            Ok(serde_json::json!({ "party_id": party_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

const PARTY_AND_TEXT: &str = r#"{
  "type": "object",
  "required": ["party_id", "text"],
  "additionalProperties": false,
  "properties": {
    "party_id": { "type": "string", "minLength": 1 },
    "text": { "type": "string", "minLength": 1 }
  }
}"#;

/// A `schedule_task` for a person, under one relation. The task and the gift
/// idea are the same row shape told apart by the link's relation.
fn task_for_person(
    ctx: &CommandCtx<'_, '_>,
    party_id: &str,
    title: &str,
    relation_notation: &str,
    relation_label: &str,
) -> Result<String> {
    let task_id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO schedule_task
           (task_id, owner_party_id, title, description, status, priority, due_at,
            completed_at, effort_min, parent_task_id, rrule, remind_before_min,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, NULL, 'needs-action', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?4, ?4)",
        rusqlite::params![task_id, owner_party_id(ctx)?, title, ctx.now],
    )?;
    let relation = concept_id(
        ctx,
        RELATIONS_SCHEME_URI,
        "Link relation types",
        relation_notation,
        relation_label,
    )?;
    link_to_party(ctx, TASK_TARGET_TYPE, &task_id, party_id, &relation)?;
    Ok(task_id)
}

/// Whether a task is linked to a party under a relation of the given notation.
fn task_is_linked_to(ctx: &CommandCtx<'_, '_>, task_id: &str, party_id: &str) -> Result<bool> {
    let count: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM schedule_task t
           JOIN core_link l ON l.from_type = ?1 AND l.from_id = t.task_id
          WHERE t.task_id = ?2 AND l.to_type = ?3 AND l.to_id = ?4 AND l.valid_to IS NULL",
        rusqlite::params![TASK_TARGET_TYPE, task_id, PARTY_TARGET_TYPE, party_id],
        |row| row.get(0),
    )?;
    Ok(count == 1)
}

fn add_task() -> CommandDefinition {
    CommandDefinition {
        name: "people.add_task",
        owner_schema: "people",
        input_schema: PARTY_AND_TEXT,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &LIVE_PERSON,
        postconditions: &[CommandCondition {
            predicate: "task_added",
            check: |ctx| {
                let party_id = ctx.required_str("party_id")?;
                let task_id = ctx
                    .produced_ids
                    .borrow()
                    .first()
                    .cloned()
                    .unwrap_or_default();
                Ok((!task_is_linked_to(ctx, &task_id, party_id)?)
                    .then(|| "the task is not linked to this person".to_owned()))
            },
        }],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            let text = ctx.required_str("text")?.to_owned();
            let task_id = task_for_person(ctx, &party_id, &text, "about", "About")?;
            Ok(serde_json::json!({ "task_id": task_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

const TASK_ID_ONLY: &str = r#"{
  "type": "object",
  "required": ["task_id"],
  "additionalProperties": false,
  "properties": { "task_id": { "type": "string", "minLength": 1 } }
}"#;

fn complete_task() -> CommandDefinition {
    CommandDefinition {
        name: "people.complete_task",
        owner_schema: "people",
        input_schema: TASK_ID_ONLY,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "task_exists",
                check: pre_person_task_exists,
            },
            // D-1020-PE9: the rollover is `schedule`'s.
            CommandCondition {
                predicate: "task_is_not_a_series",
                check: pre_task_is_not_a_series,
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "task_is_completed_and_stamped",
            check: |ctx| {
                let task_id = ctx.required_str("task_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM schedule_task
                      WHERE task_id = ?1 AND status = 'completed' AND completed_at IS NOT NULL",
                    [task_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the task is not completed and stamped".to_owned()))
            },
        }],
        handler: |ctx| {
            let task_id = ctx.required_str("task_id")?.to_owned();
            // ALREADY COMPLETED IS NOT A SECOND COMPLETION: the stamp stays
            // the first one (`task-lifecycle.ts:176`-`:182`), which is what
            // makes the command idempotent rather than merely repeatable.
            let status: String = ctx.connection().query_row(
                "SELECT status FROM schedule_task WHERE task_id = ?1",
                [&task_id],
                |row| row.get(0),
            )?;
            if status != "completed" {
                ctx.connection().execute(
                    "UPDATE schedule_task SET status = 'completed', completed_at = ?1,
                        updated_at = ?1 WHERE task_id = ?2",
                    rusqlite::params![ctx.now, task_id],
                )?;
            }
            let series_id: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT series_id FROM schedule_task WHERE task_id = ?1",
                    [&task_id],
                    |row| row.get(0),
                )
                .ok()
                .flatten();
            Ok(serde_json::json!({
                "task_id": task_id,
                "status": "completed",
                "series_id": series_id,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn reopen_task() -> CommandDefinition {
    CommandDefinition {
        name: "people.reopen_task",
        owner_schema: "people",
        input_schema: TASK_ID_ONLY,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "task_exists",
            check: pre_person_task_exists,
        }],
        postconditions: &[CommandCondition {
            predicate: "task_is_open_and_unstamped",
            check: |ctx| {
                let task_id = ctx.required_str("task_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM schedule_task
                      WHERE task_id = ?1 AND status <> 'completed' AND completed_at IS NULL",
                    [task_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the task did not reopen".to_owned()))
            },
        }],
        handler: |ctx| {
            let task_id = ctx.required_str("task_id")?.to_owned();
            ctx.connection().execute(
                "UPDATE schedule_task SET status = 'needs-action', completed_at = NULL,
                    updated_at = ?1 WHERE task_id = ?2",
                rusqlite::params![ctx.now, task_id],
            )?;
            let series_id: Option<String> = ctx
                .connection()
                .query_row(
                    "SELECT series_id FROM schedule_task WHERE task_id = ?1",
                    [&task_id],
                    |row| row.get(0),
                )
                .ok()
                .flatten();
            Ok(serde_json::json!({
                "task_id": task_id,
                "status": "needs-action",
                "series_id": series_id,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

// ---------------------------------------------------------------------------
// Important dates — a birthday auto-reminds, and is ONE logical fact.
// ---------------------------------------------------------------------------

fn add_important_date() -> CommandDefinition {
    CommandDefinition {
        name: "people.add_important_date",
        owner_schema: "people",
        // SHAPE HERE, CALENDAR IN THE COLUMN (#996 R21, drift ONT-26). This
        // pattern used to spell out the length of every month — one writer's
        // private copy of the calendar, which is exactly why Atlas could write
        // February 31 while this command refused it. The schema says only
        // "two digits, a hyphen, two digits"; whether that day exists is the
        // `people_important_date` CHECK's question, asked of every writer.
        input_schema: r#"{
          "type": "object",
          "required": ["party_id", "label", "month_day"],
          "additionalProperties": false,
          "properties": {
            "party_id": { "type": "string", "minLength": 1 },
            "label": { "type": "string", "minLength": 1 },
            "month_day": { "type": "string", "pattern": "^(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])$" },
            "reminder_on": { "type": "boolean" }
          }
        }"#,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "person_exists",
                check: pre_person_exists,
            },
            CommandCondition {
                // February 31 was refused by the input pattern and written by
                // Atlas (#996 R21 / ONT-26). Both meet the same condition now,
                // and here that condition is the DDL's own — asked before the
                // insert so the answer is a sentence rather than a constraint
                // message.
                predicate: "month_day_is_a_real_day",
                check: |ctx| {
                    let month_day = ctx.required_str("month_day")?;
                    let real: i64 = ctx.connection().query_row(
                        "SELECT date('2000-' || ?1) = '2000-' || ?1",
                        [month_day],
                        |row| row.get(0),
                    )?;
                    Ok((real != 1).then(|| format!("{month_day} is not a day of any year")))
                },
            },
        ],
        postconditions: &[
            CommandCondition {
                predicate: "date_added",
                check: |ctx| {
                    let date_id = ctx
                        .produced_ids
                        .borrow()
                        .first()
                        .cloned()
                        .unwrap_or_default();
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM people_important_date WHERE date_id = ?1",
                        [&date_id],
                        |row| row.get(0),
                    )?;
                    Ok((count != 1).then(|| "the date was not added".to_owned()))
                },
            },
            CommandCondition {
                // A BIRTHDAY IS ONE LOGICAL FACT (#441): the label must leave
                // `core_party.birth_date`'s MM-DD agreeing with this row. A
                // no-op for every other date.
                predicate: "birthday_reconciled",
                check: |ctx| {
                    let label = ctx.required_str("label")?;
                    if !is_birthday(label) {
                        return Ok(None);
                    }
                    let party_id = ctx.required_str("party_id")?;
                    let month_day = ctx.required_str("month_day")?;
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_party
                          WHERE party_id = ?1 AND substr(birth_date, -5) = ?2",
                        rusqlite::params![party_id, month_day],
                        |row| row.get(0),
                    )?;
                    Ok((count != 1)
                        .then(|| "the party's birth date disagrees with this row".to_owned()))
                },
            },
        ],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            let label = ctx.required_str("label")?.to_owned();
            let month_day = ctx.required_str("month_day")?.to_owned();
            let asked = ctx
                .input
                .get("reminder_on")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            // A BIRTHDAY AUTO-CREATES ITS REMINDER.
            let birthday = is_birthday(&label);
            let reminder = i64::from(birthday || asked);
            let date_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO people_important_date
                   (date_id, party_id, label, month_day, reminder_on, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                rusqlite::params![date_id, party_id, label, month_day, reminder, ctx.now],
            )?;
            if birthday {
                reconcile_birthday(ctx, &party_id, &date_id, &month_day)?;
            }
            Ok(serde_json::json!({ "date_id": date_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

/// v0's `/birthday/iu` test, which is case-insensitive and matches anywhere.
fn is_birthday(label: &str) -> bool {
    label.to_lowercase().contains("birthday")
}

/// Write a birthday through to the canonical party spine, and keep any other
/// "Birthday" row for this party in step.
///
/// **A birthday's YEAR is genuinely unknown here**, so an existing full date
/// keeps its year and anything else stores the year-less ISO 8601 form
/// (`--MM-DD`). `core.update_party` reconciles the reverse.
fn reconcile_birthday(
    ctx: &CommandCtx<'_, '_>,
    party_id: &str,
    date_id: &str,
    month_day: &str,
) -> Result<()> {
    let existing: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT birth_date FROM core_party WHERE party_id = ?1",
            [party_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    let year_prefix = existing
        .as_deref()
        .filter(|text| text.len() == 10 && text.as_bytes()[4] == b'-' && text.as_bytes()[7] == b'-')
        .and_then(|text| text.get(0..4))
        .unwrap_or("-");
    let birth_date = format!("{year_prefix}-{month_day}");
    if existing.as_deref() != Some(birth_date.as_str()) {
        ctx.connection().execute(
            "UPDATE core_party SET birth_date = ?1, updated_at = ?2 WHERE party_id = ?3",
            rusqlite::params![birth_date, ctx.now, party_id],
        )?;
    }
    // BIRTHDAY IS SINGLE-VALUED: no two surfaces may disagree on the MM-DD.
    ctx.connection().execute(
        "UPDATE people_important_date SET month_day = ?1, updated_at = ?2
          WHERE party_id = ?3 AND lower(label) LIKE '%birthday%'
            AND date_id <> ?4 AND month_day <> ?1 AND deleted_at IS NULL",
        rusqlite::params![month_day, ctx.now, party_id, date_id],
    )?;
    Ok(())
}

fn toggle_reminder() -> CommandDefinition {
    CommandDefinition {
        name: "people.toggle_reminder",
        owner_schema: "people",
        input_schema: r#"{
          "type": "object",
          "required": ["date_id"],
          "additionalProperties": false,
          "properties": { "date_id": { "type": "string", "minLength": 1 } }
        }"#,
        // IDEMPOTENT IS WHAT v0 DECLARES, and a toggle is not: running it twice
        // lands the state it started in, not the state the first run reached.
        // The declaration is kept because the flag is what a seat replays
        // against, and the honest fix is a `set_reminder(on: bool)` — filed as
        // a finding rather than renamed under a lane that cannot move the app's
        // callers with it.
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "date_exists",
            check: |ctx| {
                let date_id = ctx.required_str("date_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM people_important_date WHERE date_id = ?1",
                    [date_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "there is no important date with that id".to_owned()))
            },
        }],
        postconditions: &[],
        handler: |ctx| {
            let date_id = ctx.required_str("date_id")?.to_owned();
            ctx.connection().execute(
                "UPDATE people_important_date SET reminder_on = 1 - reminder_on, updated_at = ?1
                  WHERE date_id = ?2",
                rusqlite::params![ctx.now, date_id],
            )?;
            Ok(serde_json::json!({ "date_id": date_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

// ---------------------------------------------------------------------------
// Relationships.
// ---------------------------------------------------------------------------

fn add_relationship() -> CommandDefinition {
    CommandDefinition {
        name: "people.add_relationship",
        owner_schema: "people",
        input_schema: r#"{
          "type": "object",
          "required": ["party_id", "name", "kind"],
          "additionalProperties": false,
          "properties": {
            "party_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1 },
            "kind": { "type": "string", "minLength": 1 },
            "pet": { "type": "string" },
            "related_party_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "person_exists",
                check: pre_person_exists,
            },
            CommandCondition {
                predicate: "related_party_exists_if_given",
                check: |ctx| {
                    let Some(related) = ctx.optional_str("related_party_id") else {
                        return Ok(None);
                    };
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_party WHERE party_id = ?1",
                        [related],
                        |row| row.get(0),
                    )?;
                    Ok((count != 1).then(|| format!("there is no party {related}")))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "relationship_added",
            check: |ctx| {
                let party_id = ctx.required_str("party_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_link
                      WHERE from_type = ?1 AND from_id = ?2 AND to_type = ?1
                        AND valid_to IS NULL",
                    rusqlite::params![PARTY_TARGET_TYPE, party_id],
                    |row| row.get(0),
                )?;
                Ok((count < 1).then(|| "the relationship was not asserted".to_owned()))
            },
        }],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            let name = ctx.required_str("name")?.to_owned();
            let kind = ctx.required_str("kind")?.to_owned();
            let pet = ctx.optional_str("pet").map(str::to_owned);
            // A PET IS AN `animal` PARTY, not a string on the relation: the
            // person sheet reads the related party's own `kind` to decide
            // whether the notation's last token is a species.
            let target_kind = if pet.is_some() { "animal" } else { "person" };
            let target_id = match ctx.optional_str("related_party_id") {
                // Asked as a condition above, so the handler takes it.
                Some(related) => related.to_owned(),
                None => {
                    // AN EXISTING PARTY OF THAT NAME AND KIND IS REUSED. Two
                    // "Mum"s is how a vault grows a duplicate nobody meant.
                    let existing: Option<String> = ctx
                        .connection()
                        .query_row(
                            "SELECT party_id FROM core_party
                              WHERE kind = ?1 AND display_name = ?2 COLLATE NOCASE
                              ORDER BY party_id LIMIT 1",
                            rusqlite::params![target_kind, name],
                            |row| row.get(0),
                        )
                        .ok();
                    match existing {
                        Some(party_id) => party_id,
                        None => {
                            let minted = ctx.next_id();
                            ctx.connection().execute(
                                "INSERT INTO core_party
                                   (party_id, kind, display_name, sort_name, birth_date,
                                    avatar_content_id, created_at, updated_at)
                                 VALUES (?1, ?2, ?3, NULL, NULL, NULL, ?4, ?4)",
                                rusqlite::params![minted, target_kind, name, ctx.now],
                            )?;
                            minted
                        }
                    }
                }
            };
            let notation = match pet.as_deref() {
                Some(pet) => format!("people-{}-{}", slug(&kind), slug(pet)),
                None => format!("people-{}", slug(&kind)),
            };
            let relation = concept_id(
                ctx,
                RELATIONS_SCHEME_URI,
                "Link relation types",
                &notation,
                &kind,
            )?;
            let relationship_id =
                link_to_party(ctx, PARTY_TARGET_TYPE, &party_id, &target_id, &relation)?;
            Ok(serde_json::json!({ "relationship_id": relationship_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

// ---------------------------------------------------------------------------
// Gift ideas.
// ---------------------------------------------------------------------------

fn add_gift() -> CommandDefinition {
    CommandDefinition {
        name: "people.add_gift",
        owner_schema: "people",
        input_schema: PARTY_AND_TEXT,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &LIVE_PERSON,
        postconditions: &[CommandCondition {
            predicate: "gift_added",
            check: |ctx| {
                let party_id = ctx.required_str("party_id")?;
                let gift_id = ctx
                    .produced_ids
                    .borrow()
                    .first()
                    .cloned()
                    .unwrap_or_default();
                Ok((!task_is_linked_to(ctx, &gift_id, party_id)?)
                    .then(|| "the gift idea is not linked to this person".to_owned()))
            },
        }],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            let text = ctx.required_str("text")?.to_owned();
            let gift_id = task_for_person(ctx, &party_id, &text, "gift-for", "Gift for")?;
            Ok(serde_json::json!({ "gift_id": gift_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn toggle_gift() -> CommandDefinition {
    CommandDefinition {
        name: "people.toggle_gift",
        owner_schema: "people",
        input_schema: r#"{
          "type": "object",
          "required": ["gift_id"],
          "additionalProperties": false,
          "properties": { "gift_id": { "type": "string", "minLength": 1 } }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            // A GIFT IS A TASK UNDER THE `gift-for` RELATION, and the scheme is
            // part of the test: a like-named concept from another vocabulary
            // does not make a task a gift.
            predicate: "gift_exists",
            check: |ctx| {
                let gift_id = ctx.required_str("gift_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM schedule_task t
                       JOIN core_link l ON l.from_type = ?1 AND l.from_id = t.task_id
                       JOIN core_concept c ON c.concept_id = l.relation_concept_id
                       JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                      WHERE t.task_id = ?2 AND l.to_type = ?3 AND l.valid_to IS NULL
                        AND s.uri = ?4 AND c.notation = 'gift-for'",
                    rusqlite::params![
                        TASK_TARGET_TYPE,
                        gift_id,
                        PARTY_TARGET_TYPE,
                        RELATIONS_SCHEME_URI
                    ],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "there is no gift idea with that id".to_owned()))
            },
        }],
        postconditions: &[],
        handler: |ctx| {
            let gift_id = ctx.required_str("gift_id")?.to_owned();
            ctx.connection().execute(
                "UPDATE schedule_task
                    SET completed_at = CASE status WHEN 'completed' THEN NULL ELSE ?1 END,
                        status = CASE status WHEN 'completed' THEN 'needs-action' ELSE 'completed' END,
                        updated_at = ?1
                  WHERE task_id = ?2",
                rusqlite::params![ctx.now, gift_id],
            )?;
            Ok(serde_json::json!({ "gift_id": gift_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

// ---------------------------------------------------------------------------
// Debts — TALLY'S TABLE, written from here.
// ---------------------------------------------------------------------------

fn add_debt() -> CommandDefinition {
    CommandDefinition {
        name: "people.add_debt",
        owner_schema: "people",
        input_schema: r#"{
          "type": "object",
          "required": ["party_id", "direction", "amount_minor"],
          "additionalProperties": false,
          "properties": {
            "party_id": { "type": "string", "minLength": 1 },
            "direction": { "type": "string", "enum": ["owe", "owed"] },
            "amount_minor": { "type": "integer", "minimum": 1 },
            "reason": { "type": "string" }
          }
        }"#,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "person_exists",
                check: pre_person_exists,
            },
            CommandCondition {
                // THE OWNER CANNOT OWE THEMSELVES. `tally_obligation` carries
                // `CHECK (from_party <> to_party)`, and asking here turns a
                // constraint message into a sentence.
                predicate: "not_the_owner_themselves",
                check: |ctx| {
                    let party_id = ctx.required_str("party_id")?;
                    let owner = owner_party_id(ctx)?;
                    Ok((owner == party_id)
                        .then(|| "a debt needs two people; this is you".to_owned()))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "debt_added",
            check: |ctx| {
                let debt_id = ctx
                    .produced_ids
                    .borrow()
                    .first()
                    .cloned()
                    .unwrap_or_default();
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM tally_obligation WHERE obligation_id = ?1",
                    [&debt_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the debt was not recorded".to_owned()))
            },
        }],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            let direction = ctx.required_str("direction")?.to_owned();
            let amount_minor = ctx
                .input
                .get("amount_minor")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or_default();
            let reason = ctx.optional_str("reason").map(str::to_owned);
            let debt_id = ctx.next_id();
            let owner = owner_party_id(ctx)?;
            let (from_party, to_party) = if direction == "owe" {
                (owner.clone(), party_id.clone())
            } else {
                (party_id.clone(), owner.clone())
            };
            // A DEBT MAKES THEM A TALLY FRIEND. The row is what lets Tally's
            // own surfaces see the person at all, and it is unique per party.
            let known: i64 = ctx.connection().query_row(
                "SELECT COUNT(*) FROM tally_friend WHERE party_id = ?1",
                [&party_id],
                |row| row.get(0),
            )?;
            if known == 0 {
                let friend_id = ctx.next_id();
                ctx.connection().execute(
                    "INSERT INTO tally_friend (friend_id, party_id, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?3)",
                    rusqlite::params![friend_id, party_id, ctx.now],
                )?;
            }
            ctx.connection().execute(
                "INSERT INTO tally_obligation
                   (obligation_id, from_party, to_party, amount_minor, currency, reason,
                    incurred_on, settled_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)",
                rusqlite::params![
                    debt_id,
                    from_party,
                    to_party,
                    amount_minor,
                    base_currency(ctx),
                    reason,
                    ctx.now.get(0..10).unwrap_or_default(),
                    ctx.now
                ],
            )?;
            Ok(serde_json::json!({ "debt_id": debt_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn settle_debt() -> CommandDefinition {
    CommandDefinition {
        name: "people.settle_debt",
        owner_schema: "people",
        input_schema: r#"{
          "type": "object",
          "required": ["debt_id"],
          "additionalProperties": false,
          "properties": { "debt_id": { "type": "string", "minLength": 1 } }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "debt_open",
            check: |ctx| {
                let debt_id = ctx.required_str("debt_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM tally_obligation
                      WHERE obligation_id = ?1 AND settled_at IS NULL",
                    [debt_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "that debt is not open".to_owned()))
            },
        }],
        postconditions: &[CommandCondition {
            predicate: "debt_settled",
            check: |ctx| {
                let debt_id = ctx.required_str("debt_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM tally_obligation
                      WHERE obligation_id = ?1 AND settled_at IS NOT NULL",
                    [debt_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the debt did not settle".to_owned()))
            },
        }],
        handler: |ctx| {
            let debt_id = ctx.required_str("debt_id")?.to_owned();
            // CLOSED, NOT DELETED: a settled debt stays as history
            // (`actions/settle-debt.ts:3`).
            ctx.connection().execute(
                "UPDATE tally_obligation SET settled_at = ?1, updated_at = ?1
                  WHERE obligation_id = ?2",
                rusqlite::params![ctx.now, debt_id],
            )?;
            Ok(serde_json::json!({ "debt_id": debt_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

// ---------------------------------------------------------------------------
// Lists — SKOS concepts, like Docs' folders.
// ---------------------------------------------------------------------------

fn create_list() -> CommandDefinition {
    CommandDefinition {
        name: "people.create_list",
        owner_schema: "people",
        input_schema: r#"{
          "type": "object",
          "required": ["name"],
          "additionalProperties": false,
          "properties": {
            "list_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "minted_id_is_free",
                check: |ctx| {
                    let Some(list_id) = ctx.optional_str("list_id") else {
                        return Ok(None);
                    };
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_concept WHERE concept_id = ?1",
                        [list_id],
                        |row| row.get(0),
                    )?;
                    Ok((count > 0)
                        .then(|| "a concept already holds the id this write minted".to_owned()))
                },
            },
            CommandCondition {
                // LISTS KEEP DISTINCT NAMES — a receipted refusal beats two
                // "Work"s.
                predicate: "name_unused",
                check: |ctx| {
                    let name = ctx.required_str("name")?;
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_concept c
                           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                          WHERE s.uri = ?1 AND c.pref_label = ?2",
                        rusqlite::params![LIST_SCHEME_URI, name],
                        |row| row.get(0),
                    )?;
                    Ok((count != 0).then(|| format!("there is already a list called \"{name}\"")))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "list_created",
            check: |ctx| {
                let name = ctx.required_str("name")?;
                let list_id = ctx.optional_str("list_id").map_or_else(
                    || {
                        ctx.produced_ids
                            .borrow()
                            .last()
                            .cloned()
                            .unwrap_or_default()
                    },
                    str::to_owned,
                );
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_concept WHERE concept_id = ?1 AND pref_label = ?2",
                    rusqlite::params![list_id, name],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the list was not created".to_owned()))
            },
        }],
        handler: |ctx| {
            let name = ctx.required_str("name")?.to_owned();
            let scheme_id = find_or_create_scheme(ctx, LIST_SCHEME_URI, "Lists")?;
            let list_id = ctx
                .optional_str("list_id")
                .map_or_else(|| ctx.next_id(), str::to_owned);
            // THE NOTATION IS THE ID. A list has no stable code of its own, and
            // `UNIQUE (scheme_id, notation)` needs one.
            ctx.connection().execute(
                "INSERT INTO core_concept
                   (concept_id, scheme_id, notation, pref_label, alt_labels_json,
                    broader_concept_id, definition, created_at, updated_at)
                 VALUES (?1, ?2, ?1, ?3, NULL, NULL, NULL, ?4, ?4)",
                rusqlite::params![list_id, scheme_id, name, ctx.now],
            )?;
            Ok(serde_json::json!({ "list_id": list_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn rename_list() -> CommandDefinition {
    CommandDefinition {
        name: "people.rename_list",
        owner_schema: "people",
        input_schema: r#"{
          "type": "object",
          "required": ["list_id", "name"],
          "additionalProperties": false,
          "properties": {
            "list_id": { "type": "string", "minLength": 1 },
            "name": { "type": "string", "minLength": 1 }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "list_exists",
            check: pre_list_exists,
        }],
        postconditions: &[CommandCondition {
            predicate: "name_applied",
            check: |ctx| {
                let list_id = ctx.required_str("list_id")?;
                let name = ctx.required_str("name")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_concept WHERE concept_id = ?1 AND pref_label = ?2",
                    rusqlite::params![list_id, name],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the new name did not reach the list".to_owned()))
            },
        }],
        handler: |ctx| {
            let list_id = ctx.required_str("list_id")?.to_owned();
            let name = ctx.required_str("name")?.to_owned();
            ctx.connection().execute(
                "UPDATE core_concept SET pref_label = ?1, updated_at = ?2 WHERE concept_id = ?3",
                rusqlite::params![name, ctx.now, list_id],
            )?;
            Ok(serde_json::json!({ "list_id": list_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn delete_list() -> CommandDefinition {
    CommandDefinition {
        name: "people.delete_list",
        owner_schema: "people",
        input_schema: r#"{
          "type": "object",
          "required": ["list_id"],
          "additionalProperties": false,
          "properties": { "list_id": { "type": "string", "minLength": 1 } }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "list_exists",
                check: pre_list_exists,
            },
            CommandCondition {
                // ONLY EMPTY LISTS DELETE — move the people out first. The
                // sentence is v0's own, word for word, because a member reads it.
                predicate: "list_is_empty",
                check: |ctx| {
                    let list_id = ctx.required_str("list_id")?;
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_tag
                          WHERE target_type = ?1 AND concept_id = ?2",
                        rusqlite::params![PARTY_TARGET_TYPE, list_id],
                        |row| row.get(0),
                    )?;
                    Ok((count != 0).then(|| {
                        "This list still has people in it — move them out first.".to_owned()
                    }))
                },
            },
        ],
        postconditions: &[CommandCondition {
            predicate: "list_removed",
            check: |ctx| {
                let list_id = ctx.required_str("list_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM core_concept WHERE concept_id = ?1",
                    [list_id],
                    |row| row.get(0),
                )?;
                Ok((count != 0).then(|| "the list is still there".to_owned()))
            },
        }],
        handler: |ctx| {
            let list_id = ctx.required_str("list_id")?.to_owned();
            ctx.connection()
                .execute("DELETE FROM core_concept WHERE concept_id = ?1", [&list_id])?;
            Ok(serde_json::json!({ "list_id": list_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

// ---------------------------------------------------------------------------
// The journal — owner-level, not per-person.
// ---------------------------------------------------------------------------

fn add_journal_entry() -> CommandDefinition {
    CommandDefinition {
        name: "people.add_journal_entry",
        owner_schema: "people",
        input_schema: r#"{
          "type": "object",
          "required": ["mood", "text"],
          "additionalProperties": false,
          "properties": {
            "mood": { "type": "string", "minLength": 1 },
            "text": { "type": "string", "minLength": 1 },
            "entry_date": { "type": "string" }
          }
        }"#,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[],
        postconditions: &[CommandCondition {
            // THE MARKER IS WHAT MAKES IT A JOURNAL ENTRY. Without the tag the
            // note is an ordinary note, and Notes' library — which excludes
            // People-journal entries — would start showing it.
            predicate: "entry_added",
            check: |ctx| {
                let entry_id = ctx
                    .produced_ids
                    .borrow()
                    .first()
                    .cloned()
                    .unwrap_or_default();
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM knowledge_note n
                       JOIN core_tag t ON t.target_type = ?1 AND t.target_id = n.note_id
                       JOIN core_concept c ON c.concept_id = t.concept_id
                       JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                      WHERE n.note_id = ?2 AND s.uri = ?3 AND c.notation = ?4",
                    rusqlite::params![
                        NOTE_TARGET_TYPE,
                        entry_id,
                        JOURNAL_SCHEME_URI,
                        JOURNAL_ENTRY_NOTATION
                    ],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "the entry carries no journal marker".to_owned()))
            },
        }],
        handler: |ctx| {
            let mood = ctx.required_str("mood")?.to_owned();
            let text = ctx.required_str("text")?.to_owned();
            let entry_date = ctx.optional_str("entry_date").map_or_else(
                || ctx.now.get(0..10).unwrap_or_default().to_owned(),
                str::to_owned,
            );
            // Minted first so the postcondition finds it as the first produced
            // id — before the content item, which may be deduped away.
            let entry_id = ctx.next_id();
            let content_id = content_item_for(ctx, &text)?;
            ctx.connection().execute(
                "INSERT INTO knowledge_note
                   (note_id, author_party_id, title, body_content_id, format, pinned,
                    created_at, updated_at, deleted_at, purge_at)
                 VALUES (?1, ?2, ?3, ?4, 'plain', 0, ?5, ?6, NULL, NULL)",
                rusqlite::params![
                    entry_id,
                    owner_party_id(ctx)?,
                    format!("{JOURNAL_TITLE_PREFIX}{mood}"),
                    content_id,
                    // THE ENTRY'S OWN DAY, at noon, so an entry dated
                    // yesterday sorts where the member put it rather than where
                    // they typed it.
                    format!("{entry_date}T12:00:00.000Z"),
                    ctx.now
                ],
            )?;
            set_note_representation(ctx, &entry_id, &content_id, &text)?;
            let marker = concept_id(
                ctx,
                JOURNAL_SCHEME_URI,
                "People journal",
                JOURNAL_ENTRY_NOTATION,
                "Journal entry",
            )?;
            let tag_id = ctx.next_id();
            ctx.connection().execute(
                "INSERT INTO core_tag
                   (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
                    confidence, tagged_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)",
                rusqlite::params![
                    tag_id,
                    NOTE_TARGET_TYPE,
                    entry_id,
                    marker,
                    actor_party_id(ctx)?,
                    ctx.now
                ],
            )?;
            Ok(serde_json::json!({ "entry_id": entry_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

// ---------------------------------------------------------------------------
// Contact channels — see D-1020-PE8 for why these are `people`-owned here.
// ---------------------------------------------------------------------------

/// `contactReachKey` (`contact-reach.ts:25`-`:40`): the ONE normalization every
/// reader agrees on.
///
/// **Rung seven's SQL carries the phone rule verbatim**, so a migrated
/// identifier and a typed number land on one key.
#[must_use]
pub fn contact_reach_key(kind: &str, raw_value: &str) -> String {
    let value = raw_value.trim();
    match kind {
        "email" => value.to_lowercase(),
        "phone" => {
            let stripped: String = value
                .chars()
                .filter(|character| !matches!(character, ' ' | '(' | ')' | '.' | '-'))
                .collect();
            let plus = if value.starts_with('+') { "+" } else { "" };
            format!("{plus}{}", stripped.trim_start_matches('+'))
        }
        "handle" => value.trim_start_matches('@').to_lowercase(),
        // The address arm folds runs of whitespace to one space. v0 also
        // normalises to NFKC, which this port does not: Unicode normalisation
        // is a dependency, and the divergence is named in the receipt rather
        // than hidden behind a nearly-right hand-rolled table.
        _ => {
            let mut folded = String::with_capacity(value.len());
            let mut in_space = false;
            for character in value.chars() {
                if character.is_whitespace() {
                    in_space = true;
                } else {
                    if in_space && !folded.is_empty() {
                        folded.push(' ');
                    }
                    in_space = false;
                    folded.extend(character.to_lowercase());
                }
            }
            folded
        }
    }
}

/// `normalizeContactChannel`: the key, plus the member-facing validation.
fn normalize_contact_channel(kind: &str, raw_value: &str) -> Result<String> {
    let normalized = contact_reach_key(kind, raw_value);
    let refuse = |detail: &str| VaultError::InvalidInput {
        name: "value".to_owned(),
        detail: detail.to_owned(),
    };
    match kind {
        "email" => {
            let at = normalized.find('@');
            let valid = at.is_some_and(|at| {
                at > 0
                    && normalized[at + 1..].contains('.')
                    && !normalized[at + 1..].starts_with('.')
                    && !normalized[at + 1..].ends_with('.')
                    && !normalized.contains(char::is_whitespace)
                    && normalized[at + 1..].find('@').is_none()
            }) && normalized.len() <= 320;
            if !valid {
                return Err(refuse("enter a valid email address"));
            }
        }
        "phone" => {
            let digits = normalized.trim_start_matches('+');
            if !(7..=15).contains(&digits.len()) || !digits.chars().all(|c| c.is_ascii_digit()) {
                return Err(refuse("enter a phone number with 7 to 15 digits"));
            }
        }
        "handle" => {
            let valid = (2..=100).contains(&normalized.chars().count())
                && normalized.chars().all(|character| {
                    character.is_alphanumeric()
                        || matches!(character, '.' | '_' | ':' | '@' | '/' | '-')
                });
            if !valid {
                return Err(refuse("enter a valid handle"));
            }
        }
        _ => {
            if !(3..=500).contains(&normalized.len()) {
                return Err(refuse("enter a complete address"));
            }
        }
    }
    Ok(normalized)
}

/// Which OTHER parties hold this same value, reached the same way.
fn duplicate_party_ids(
    ctx: &CommandCtx<'_, '_>,
    party_id: &str,
    kind: &str,
    normalized: &str,
) -> Result<Vec<String>> {
    let mut prepared = ctx.connection().prepare(
        "SELECT DISTINCT party_id FROM social_contact_channel
          WHERE kind = ?1 AND normalized_value = ?2 AND party_id <> ?3
          ORDER BY party_id",
    )?;
    let rows = prepared.query_map(rusqlite::params![kind, normalized, party_id], |row| {
        row.get::<_, String>(0)
    })?;
    Ok(rows.collect::<std::result::Result<Vec<String>, _>>()?)
}

/// One channel's whole row, as the undo rail restores it.
fn channel_snapshot(ctx: &CommandCtx<'_, '_>, channel_id: &str) -> Result<serde_json::Value> {
    ctx.connection()
        .query_row(
            "SELECT channel_id, party_id, kind, label, value, normalized_value,
                    is_preferred, provenance_json, created_at
               FROM social_contact_channel WHERE channel_id = ?1",
            [channel_id],
            |row| {
                Ok(serde_json::json!({
                    "channel_id": row.get::<_, String>(0)?,
                    "party_id": row.get::<_, String>(1)?,
                    "kind": row.get::<_, String>(2)?,
                    "label": row.get::<_, Option<String>>(3)?,
                    "value": row.get::<_, String>(4)?,
                    "normalized_value": row.get::<_, String>(5)?,
                    "is_preferred": row.get::<_, i64>(6)?,
                    "provenance_json": row.get::<_, Option<String>>(7)?,
                    "created_at": row.get::<_, String>(8)?,
                }))
            },
        )
        .map_err(|_| VaultError::InvalidInput {
            name: "channel_id".to_owned(),
            detail: "there is no contact channel with that id".to_owned(),
        })
}

fn save_contact_channel() -> CommandDefinition {
    CommandDefinition {
        name: "people.save_contact_channel",
        // D-1020-PE8: v0 says `social` here and `people` in the name.
        owner_schema: "people",
        input_schema: r#"{
          "type": "object",
          "required": ["party_id", "kind", "value"],
          "additionalProperties": false,
          "properties": {
            "channel_id": { "type": "string", "minLength": 1 },
            "party_id": { "type": "string", "minLength": 1 },
            "kind": { "type": "string", "enum": ["phone", "email", "address", "handle"] },
            "label": { "type": "string", "maxLength": 100 },
            "value": { "type": "string", "minLength": 1, "maxLength": 500 },
            "preferred": { "type": "boolean" },
            "provenance": { "type": "object" }
          }
        }"#,
        idempotency: Idempotency::Idempotent,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[
            CommandCondition {
                predicate: "person_live",
                check: |ctx| {
                    let party_id = ctx.required_str("party_id")?;
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM people_profile
                          WHERE party_id = ?1 AND deleted_at IS NULL",
                        [party_id],
                        |row| row.get(0),
                    )?;
                    Ok((count != 1).then(|| "there is no live person with that id".to_owned()))
                },
            },
            CommandCondition {
                // THE VALUE IS VALIDATED BEFORE ANYTHING IS WRITTEN, so a
                // malformed address is a receipted deny with the sentence a
                // member reads rather than an error out of the handler.
                predicate: "value_is_a_reachable_address",
                check: |ctx| {
                    let kind = ctx.required_str("kind")?;
                    let value = ctx.required_str("value")?;
                    Ok(match normalize_contact_channel(kind, value) {
                        Ok(_) => None,
                        Err(VaultError::InvalidInput { detail, .. }) => Some(detail),
                        Err(other) => return Err(other),
                    })
                },
            },
            CommandCondition {
                predicate: "channel_belongs_to_this_person",
                check: |ctx| {
                    let Some(channel_id) = ctx.optional_str("channel_id") else {
                        return Ok(None);
                    };
                    let party_id = ctx.required_str("party_id")?;
                    let owner: Option<String> = ctx
                        .connection()
                        .query_row(
                            "SELECT party_id FROM social_contact_channel WHERE channel_id = ?1",
                            [channel_id],
                            |row| row.get(0),
                        )
                        .ok();
                    Ok(match owner {
                        None => Some("there is no contact channel with that id".to_owned()),
                        Some(owner) if owner != party_id => {
                            Some("that contact channel belongs to another person".to_owned())
                        }
                        Some(_) => None,
                    })
                },
            },
            CommandCondition {
                predicate: "value_not_already_saved",
                check: |ctx| {
                    let kind = ctx.required_str("kind")?;
                    let value = ctx.required_str("value")?;
                    let Ok(normalized) = normalize_contact_channel(kind, value) else {
                        // The malformed case is the condition above's to say.
                        return Ok(None);
                    };
                    let party_id = ctx.required_str("party_id")?;
                    let count: i64 = ctx.connection().query_row(
                        "SELECT COUNT(*) FROM social_contact_channel
                          WHERE party_id = ?1 AND kind = ?2 AND normalized_value = ?3
                            AND channel_id <> ?4",
                        rusqlite::params![
                            party_id,
                            kind,
                            normalized,
                            ctx.optional_str("channel_id").unwrap_or_default()
                        ],
                        |row| row.get(0),
                    )?;
                    Ok((count > 0).then(|| "this contact channel is already saved".to_owned()))
                },
            },
        ],
        postconditions: &[],
        handler: |ctx| {
            let party_id = ctx.required_str("party_id")?.to_owned();
            let kind = ctx.required_str("kind")?.to_owned();
            let value = ctx.required_str("value")?.to_owned();
            let label = ctx.optional_str("label").map(str::to_owned);
            let preferred = ctx
                .input
                .get("preferred")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let provenance = ctx
                .input
                .get("provenance")
                .filter(|value| value.is_object())
                .map(serde_json::Value::to_string);
            let normalized = normalize_contact_channel(&kind, &value)?;

            let existing = match ctx.optional_str("channel_id") {
                Some(channel_id) => Some(channel_snapshot(ctx, channel_id)?),
                None => None,
            };
            // Both the ownership and the collision were asked as conditions,
            // so the handler holds no second copy of either question.
            let revision = match existing.as_ref() {
                Some(existing) => Some(record_revision(
                    ctx,
                    CHANNEL_ENTITY_TYPE,
                    snapshot_str(existing, "channel_id").unwrap_or_default(),
                    "edit",
                    existing,
                )?),
                None => None,
            };
            if preferred {
                // ONE PREFERRED PER KIND. Demoted first, so the insert below
                // cannot leave two.
                ctx.connection().execute(
                    "UPDATE social_contact_channel SET is_preferred = 0, updated_at = ?1
                      WHERE party_id = ?2 AND kind = ?3",
                    rusqlite::params![ctx.now, party_id, kind],
                )?;
            }
            let channel_id = ctx
                .optional_str("channel_id")
                .map_or_else(|| ctx.next_id(), str::to_owned);
            let created_at = existing
                .as_ref()
                .and_then(|existing| snapshot_str(existing, "created_at"))
                .map_or_else(|| ctx.now.clone(), str::to_owned);
            ctx.connection().execute(
                "INSERT INTO social_contact_channel
                   (channel_id, party_id, kind, label, value, normalized_value,
                    is_preferred, provenance_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT (channel_id) DO UPDATE SET
                   kind = excluded.kind, label = excluded.label, value = excluded.value,
                   normalized_value = excluded.normalized_value,
                   is_preferred = excluded.is_preferred,
                   provenance_json = excluded.provenance_json,
                   updated_at = excluded.updated_at",
                rusqlite::params![
                    channel_id,
                    party_id,
                    kind,
                    label,
                    value.trim(),
                    normalized,
                    i64::from(preferred),
                    provenance,
                    created_at,
                    ctx.now
                ],
            )?;
            let duplicates = duplicate_party_ids(ctx, &party_id, &kind, &normalized)?;
            let mut output = serde_json::json!({
                "channel_id": channel_id,
                "normalized_value": normalized,
                "duplicate_party_ids": duplicates,
            });
            if let Some((revision_id, undo_until)) = revision {
                output["revision_id"] = serde_json::Value::String(revision_id);
                output["undo_until"] = serde_json::Value::String(undo_until);
            }
            Ok(output)
        },
        sealed_input: &[],
        online_only: false,
    }
}

fn delete_contact_channel() -> CommandDefinition {
    CommandDefinition {
        name: "people.delete_contact_channel",
        owner_schema: "people",
        input_schema: CHANNEL_ID_ONLY,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            // v0 declares NO preconditions here and throws inside the handler
            // when the row is absent (`people-organize.ts:192`, `:198`). A
            // throw is a receipted failure with a stack-shaped message; a
            // precondition is a receipted DENY with a sentence, which is what
            // the surface renders — and the gate order writes both either way.
            predicate: "channel_exists",
            check: |ctx| {
                let channel_id = ctx.required_str("channel_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM social_contact_channel WHERE channel_id = ?1",
                    [channel_id],
                    |row| row.get(0),
                )?;
                Ok((count != 1).then(|| "there is no contact channel with that id".to_owned()))
            },
        }],
        postconditions: &[CommandCondition {
            predicate: "channel_removed",
            check: |ctx| {
                let channel_id = ctx.required_str("channel_id")?;
                let count: i64 = ctx.connection().query_row(
                    "SELECT COUNT(*) FROM social_contact_channel WHERE channel_id = ?1",
                    [channel_id],
                    |row| row.get(0),
                )?;
                Ok((count != 0).then(|| "the contact channel is still there".to_owned()))
            },
        }],
        handler: |ctx| {
            let channel_id = ctx.required_str("channel_id")?.to_owned();
            let snapshot = channel_snapshot(ctx, &channel_id)?;
            let (revision_id, undo_until) =
                record_revision(ctx, CHANNEL_ENTITY_TYPE, &channel_id, "delete", &snapshot)?;
            ctx.connection().execute(
                "DELETE FROM social_contact_channel WHERE channel_id = ?1",
                [&channel_id],
            )?;
            Ok(serde_json::json!({
                "channel_id": channel_id,
                "revision_id": revision_id,
                "undo_until": undo_until,
            }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

const CHANNEL_ID_ONLY: &str = r#"{
  "type": "object",
  "required": ["channel_id"],
  "additionalProperties": false,
  "properties": {
    "channel_id": { "type": "string", "minLength": 1 },
    "revision_id": { "type": "string", "minLength": 1 }
  }
}"#;

fn undo_contact_channel() -> CommandDefinition {
    CommandDefinition {
        name: "people.undo_contact_channel",
        owner_schema: "people",
        input_schema: CHANNEL_ID_ONLY,
        idempotency: Idempotency::Once,
        risk: Risk::Low,
        confirm: false,
        preconditions: &[CommandCondition {
            predicate: "revision_is_undoable",
            check: |ctx| {
                let channel_id = ctx.required_str("channel_id")?;
                let revision_id = ctx.optional_str("revision_id");
                Ok(
                    (!revision_is_undoable(ctx, CHANNEL_ENTITY_TYPE, channel_id, revision_id)?)
                        .then(|| UNDOABLE_SENTENCE.to_owned()),
                )
            },
        }],
        postconditions: &[],
        handler: |ctx| {
            let channel_id = ctx.required_str("channel_id")?.to_owned();
            let named = ctx.optional_str("revision_id").map(str::to_owned);
            let (revision_id, snapshot) =
                load_revision(ctx, CHANNEL_ENTITY_TYPE, &channel_id, named.as_deref())?;
            ctx.connection().execute(
                "INSERT OR REPLACE INTO social_contact_channel
                   (channel_id, party_id, kind, label, value, normalized_value,
                    is_preferred, provenance_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    snapshot_str(&snapshot, "channel_id").unwrap_or(&channel_id),
                    snapshot_str(&snapshot, "party_id").unwrap_or_default(),
                    snapshot_str(&snapshot, "kind").unwrap_or_default(),
                    snapshot_str(&snapshot, "label"),
                    snapshot_str(&snapshot, "value").unwrap_or_default(),
                    snapshot_str(&snapshot, "normalized_value").unwrap_or_default(),
                    snapshot
                        .get("is_preferred")
                        .and_then(serde_json::Value::as_i64)
                        .unwrap_or_default(),
                    snapshot_str(&snapshot, "provenance_json"),
                    snapshot_str(&snapshot, "created_at").unwrap_or(&ctx.now),
                    ctx.now
                ],
            )?;
            mark_revision_undone(ctx, &revision_id)?;
            Ok(serde_json::json!({ "channel_id": channel_id }))
        },
        sealed_input: &[],
        online_only: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_definition_is_a_people_command_with_a_valid_schema() {
        for definition in definitions() {
            assert!(
                definition.name.starts_with("people."),
                "{} is not a people command",
                definition.name
            );
            assert_eq!(definition.owner_schema, "people");
            let schema = serde_json::from_str::<serde_json::Value>(definition.input_schema)
                .unwrap_or_else(|error| panic!("{}: {error}", definition.name));
            jsonschema::validator_for(&schema)
                .unwrap_or_else(|error| panic!("{}: {error}", definition.name));
        }
    }

    /// THE WHOLE SCHEMA, and the split the census states: 28 commands,
    /// **14 idempotent / 14 once**, no retry-safe.
    #[test]
    fn the_schema_carries_all_twenty_eight_of_v0s() {
        assert_eq!(definitions().len(), 28);
        let mut idempotent = 0;
        let mut once = 0;
        let mut retry_safe = 0;
        for definition in definitions() {
            match definition.idempotency {
                Idempotency::Idempotent => idempotent += 1,
                Idempotency::Once => once += 1,
                Idempotency::RetrySafe => retry_safe += 1,
            }
        }
        assert_eq!((idempotent, once, retry_safe), (14, 14, 0));
    }

    /// **NO `people.*` COMMAND PARKS A NON-OWNER** (census §A0's per-command
    /// `confirm` tally, which lists none for `people`). The three manifest
    /// confirmations are the DISPATCHING surface's gate and live in the app.
    #[test]
    fn no_people_command_carries_the_non_owner_park() {
        for definition in definitions() {
            assert!(
                !definition.confirm,
                "{} carries confirm: true; no people command does in v0",
                definition.name
            );
            assert!(
                !definition.online_only,
                "{} is not online-only",
                definition.name
            );
            assert!(
                definition.sealed_input.is_empty(),
                "{} declares a sealed input; People holds no secrets",
                definition.name
            );
        }
    }

    /// Only `trash_person` is above `low` — the one destructive gesture.
    #[test]
    fn trash_person_is_the_only_command_above_low_risk() {
        let loud: Vec<&str> = definitions()
            .iter()
            .filter(|definition| definition.risk != Risk::Low)
            .map(|definition| definition.name)
            .collect();
        assert_eq!(loud, ["people.trash_person"]);
    }

    /// D-1020-PE8, as an assertion: the three contact-channel commands are
    /// named and owned by ONE schema here, where v0 splits them.
    #[test]
    fn the_contact_channel_commands_are_named_and_owned_by_one_schema() {
        for name in [
            "people.save_contact_channel",
            "people.delete_contact_channel",
            "people.undo_contact_channel",
        ] {
            let definition = definitions()
                .into_iter()
                .find(|definition| definition.name == name)
                .unwrap_or_else(|| panic!("{name} is not registered"));
            assert_eq!(
                definition.owner_schema, "people",
                "{name} must be owned by the schema its name declares"
            );
        }
    }

    #[test]
    fn a_slug_collapses_punctuation_and_never_answers_empty() {
        assert_eq!(slug("College Friend"), "college-friend");
        assert_eq!(slug("  Met up!  "), "met-up");
        assert_eq!(slug("co-worker"), "co-worker");
        // ANYTHING THAT COLLAPSES TO NOTHING IS `related`, never "".
        assert_eq!(slug("!!!"), "related");
        assert_eq!(slug(""), "related");
    }

    #[test]
    fn a_birthday_label_is_matched_anywhere_and_case_insensitively() {
        assert!(is_birthday("Birthday"));
        assert!(is_birthday("her birthday"));
        assert!(is_birthday("BIRTHDAY (approx)"));
        assert!(!is_birthday("Anniversary"));
    }

    /// The one normalization every reader agrees on.
    #[test]
    fn contact_reach_keys_fold_the_way_rung_sevens_sql_does() {
        assert_eq!(
            contact_reach_key("email", "  Maya@Example.COM "),
            "maya@example.com"
        );
        assert_eq!(
            contact_reach_key("phone", "+1 (415) 555-0100"),
            "+14155550100"
        );
        assert_eq!(contact_reach_key("phone", "415.555.0100"), "4155550100");
        assert_eq!(contact_reach_key("handle", "@Maya"), "maya");
        assert_eq!(
            contact_reach_key("address", "  12   Bridge   Street "),
            "12 bridge street"
        );
    }

    #[test]
    fn a_malformed_channel_is_refused_with_a_sentence_a_member_can_act_on() {
        assert!(normalize_contact_channel("email", "maya@example.com").is_ok());
        assert!(normalize_contact_channel("email", "maya@example").is_err());
        assert!(normalize_contact_channel("phone", "+14155550100").is_ok());
        assert!(normalize_contact_channel("phone", "12345").is_err());
        assert!(normalize_contact_channel("handle", "@maya").is_ok());
        assert!(normalize_contact_channel("handle", "a").is_err());
        assert!(normalize_contact_channel("address", "12 Bridge Street").is_ok());
        assert!(normalize_contact_channel("address", "12").is_err());
    }
}
