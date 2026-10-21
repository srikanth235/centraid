//! THE CHAT'S ARM OF THE APP QUERY (R-CHAT-1): the thread list, one thread, and
//! whether a card's row is still there.
//!
//! These read through `Vault::chat_*` — the thread kind's own readers, SQL and all, in
//! `crates/vault/src/chat.rs` — and convert to `chat.proto`. Nothing is written here: a
//! conversation's writers are the `thread.*` commands (#1135).
//!
//! **THE LIST CAN BE SEARCHED** (#1097, R-1097-22, R-1097-24): `chat.threads`
//! with a `term` is the drawer's search. The rows are the FTS door's
//! (kind `thread`, one entry in the named list), ranked, with the owner as
//! principal; a typo is corrected only when the exact words found nothing, by
//! the same helper every other surface uses ([`corrected_search`]), and the
//! words it searched instead ride in `ChatThreads.corrected`. What a thread is
//! found by is its title and the member's own messages: never the assistant's
//! words or a card.

use centraid_api_proto::core_v1 as wire;
use centraid_search::{Answer as Found, Principal, Search, SearchError, SearchRequest};
use centraid_vault::Vault;
use centraid_vault::chat::{StoredAttachment, StoredMessage, ThreadRow};

use super::{RecordingSearch, VaultDoor, corrected_search, settle};
use crate::error::{CoreError, Result};

type Answer = wire::app_query_response::Answer;

/// The most threads one list answers when the request names none.
const DEFAULT_LIMIT: usize = 100;

/// The most threads one list ever answers.
const MAX_LIMIT: usize = 500;

/// The chat thread's kind in the search door.
const THREAD_ENTITY: &str = "thread";

fn row_to_wire(row: ThreadRow) -> wire::ChatThreadRow {
    wire::ChatThreadRow {
        thread_id: row.thread_id,
        title: row.title,
        scope_app: row.scope_app.unwrap_or_default(),
        created_at: row.created_at,
        updated_at: row.updated_at,
        updated_ms: row.updated_ms,
    }
}

/// A stored refusal word as the plane's reason. The words are the schema's
/// CHECK list, so a word this does not know is a build that is older than its
/// file, and it reads as the generic failure rather than as nothing.
pub(crate) fn refusal_of(word: &str) -> wire::AssistRefusalReason {
    use wire::AssistRefusalReason as R;
    match word {
        "no_tool_fits" => R::NoToolFits,
        "query_failed" => R::QueryFailed,
        "unparsable" => R::Unparsable,
        "model_absent" => R::ModelAbsent,
        "model_failed" => R::ModelFailed,
        "vision_absent" => R::VisionAbsent,
        "attachment_unsupported" => R::AttachmentUnsupported,
        "attachment_unreadable" => R::AttachmentUnreadable,
        "attachment_too_large" => R::AttachmentTooLarge,
        _ => R::Unspecified,
    }
}

/// A stored outcome word as the wire's. The words are the schema's CHECK list (a proposal's five
/// beside the three a told answer has), so a word this does not know is a build that is older than its
/// file, and it reads as unspecified rather than as one of the others.
pub(crate) fn outcome_of(word: &str) -> wire::ChatStoredOutcome {
    use wire::ChatStoredOutcome as O;
    match word {
        "sent" => O::Sent,
        "answered" => O::Answered,
        "stopped" => O::Stopped,
        "refused" => O::Refused,
        "proposed" => O::Proposed,
        "applied" => O::Applied,
        "dismissed" => O::Dismissed,
        "stale" => O::Stale,
        "failed" => O::Failed,
        _ => O::Unspecified,
    }
}

fn message_to_wire(message: StoredMessage) -> wire::ChatStoredMessage {
    let outcome = outcome_of(&message.outcome);
    wire::ChatStoredMessage {
        ordinal: u64::try_from(message.ordinal).unwrap_or_default(),
        from_member: message.role == "user",
        text: message.text,
        outcome: outcome as i32,
        refusal: message
            .refusal
            .as_deref()
            .map_or(wire::AssistRefusalReason::Unspecified, refusal_of) as i32,
        notices: message
            .notice
            .iter()
            .filter(|word| word.as_str() == "doc_truncated")
            .map(|_| wire::AssistNotice::DocTruncated as i32)
            .collect(),
        cards: message
            .cards
            .into_iter()
            .map(|card| wire::ChatStoredCard {
                app: card.app,
                entity: card.entity,
                id: card.row_id,
                qualifier: card.qualifier,
                title: card.title,
                subtitle: card.subtitle,
                meta: card.meta,
            })
            .collect(),
        attachments: message
            .attachments
            .into_iter()
            .map(attachment_to_wire)
            .collect(),
    }
}

fn attachment_to_wire(attachment: StoredAttachment) -> wire::ChatStoredAttachment {
    use wire::ChatStoredAttachmentKind as K;
    wire::ChatStoredAttachment {
        kind: match attachment.form.as_str() {
            "photo" => K::Photo,
            "document" => K::Document,
            "image" => K::Image,
            _ => K::Unspecified,
        } as i32,
        label: attachment.label,
        // The wire names the entity by what it is (`asset_id` a photograph, `document_id` a
        // document): the shells already route by those two words.
        asset_id: attachment
            .entity_id
            .clone()
            .filter(|_| attachment.form == "photo")
            .unwrap_or_default(),
        document_id: attachment
            .entity_id
            .filter(|_| attachment.form == "document")
            .unwrap_or_default(),
        thumbnail_path: attachment.thumbnail_path.unwrap_or_default(),
    }
}

/// The most threads one search answers when the request names none, and the
/// most it ever answers: the list's own.
fn limit_of(asked: &wire::ChatThreadsRequest) -> usize {
    if asked.limit == 0 {
        DEFAULT_LIMIT
    } else {
        (asked.limit as usize).min(MAX_LIMIT)
    }
}

/// `chat.threads`: the list, or — with a `term` — the threads the term finds.
pub(super) fn threads(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::ChatThreadsRequest,
) -> Result<Answer> {
    let limit = limit_of(asked);
    if asked.term.trim().is_empty() {
        return Ok(Answer::ChatThreads(wire::ChatThreads {
            threads: vault
                .chat_threads(limit)?
                .into_iter()
                .map(row_to_wire)
                .collect(),
            corrected: String::new(),
        }));
    }
    let found = vault.read(|connection| {
        let index = match centraid_search::SqliteDoor::open(connection) {
            Ok(index) => index,
            Err(error) => {
                return Ok(Err(CoreError::Invariant {
                    context: format!("the search index will not open: {error}"),
                }));
            }
        };
        let search = RecordingSearch {
            inner: &index,
            door,
        };
        Ok(Ok(corrected_search(
            &search,
            &[THREAD_ENTITY],
            &asked.term,
            |rows: &Vec<ThreadRow>| rows.is_empty(),
            |term| {
                let request = SearchRequest::new(THREAD_ENTITY, term, limit);
                let ids: Vec<String> = match search.query(&Principal::Owner, &request) {
                    Ok(Found::Data { page, .. }) => {
                        page.rows.into_iter().map(|target| target.id).collect()
                    }
                    Ok(Found::Denied(denial)) => {
                        return Ok((
                            Vec::new(),
                            Some(centraid_apps_kit::Denial {
                                code: denial.code,
                                message: denial.message,
                                revoked_at: denial.revoked_at,
                            }),
                        ));
                    }
                    // A term with no word in it is an answer with no rows; any
                    // other failure is the recorder's to have kept.
                    Err(SearchError::NoSearchableWords { .. }) => Vec::new(),
                    Err(_) => Vec::new(),
                };
                // The rows in the order the door ranked them. A read that
                // fails is kept the way the door's own failures are.
                match vault.chat_thread_rows(&ids) {
                    Ok(rows) => Ok((rows, None)),
                    Err(error) => {
                        door.keep(error.into());
                        Ok((Vec::new(), None))
                    }
                }
            },
        )))
    })??;
    settle(door, found, |(rows, corrected)| {
        Answer::ChatThreads(wire::ChatThreads {
            threads: rows.into_iter().map(row_to_wire).collect(),
            corrected,
        })
    })
}

/// `chat.thread`.
pub(super) fn thread(vault: &Vault, asked: &wire::ChatThreadRequest) -> Result<Answer> {
    let Some(stored) = vault.chat_thread(&asked.thread_id)? else {
        return Ok(Answer::ChatThread(wire::ChatThread::default()));
    };
    Ok(Answer::ChatThread(wire::ChatThread {
        found: true,
        thread: Some(row_to_wire(stored.thread)),
        messages: stored.messages.into_iter().map(message_to_wire).collect(),
    }))
}

/// `chat.card`.
pub(super) fn card(vault: &Vault, asked: &wire::ChatCardRequest) -> Result<Answer> {
    Ok(Answer::ChatCard(wire::ChatCardLive {
        exists: vault.chat_card_row_exists(&asked.app, &asked.entity, &asked.id)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The words inside the first `IN (...)` list after `anchor` in the baseline DDL: the schema's
    /// own list, so a word the CHECK gains and this mapping misses fails here.
    fn check_words(anchor: &str) -> Vec<String> {
        // The anchor is unique in the baseline: only `message` checks an `outcome`.
        let ddl = centraid_vault::migrations::BASELINE_SQL;
        let from = ddl
            .find(anchor)
            .and_then(|at| ddl[at..].find("IN (").map(|list| at + list))
            .expect("the DDL lists the anchor's words");
        let list = &ddl[from..][..ddl[from..].find(')').expect("the list closes")];
        list.split('\'')
            .skip(1)
            .step_by(2)
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn every_outcome_word_the_schema_allows_has_a_value() {
        // contracts/migrations/001_baseline.sql: `message.outcome CHECK (outcome IN …)`
        let words = check_words("outcome    TEXT NOT NULL CHECK (outcome IN (");
        // a mis-read of the DDL must not pass for "no word is missing"
        assert!(words.contains(&"sent".to_owned()) && words.contains(&"failed".to_owned()));
        for word in &words {
            assert_ne!(
                outcome_of(word),
                wire::ChatStoredOutcome::Unspecified,
                "{word}"
            );
        }
        assert_eq!(
            outcome_of("from_the_future"),
            wire::ChatStoredOutcome::Unspecified
        );
    }

    #[test]
    fn every_refusal_word_the_schema_allows_has_a_reason() {
        for word in [
            "no_tool_fits",
            "query_failed",
            "unparsable",
            "model_absent",
            "model_failed",
            "vision_absent",
            "attachment_unsupported",
            "attachment_unreadable",
            "attachment_too_large",
        ] {
            assert_ne!(
                refusal_of(word),
                wire::AssistRefusalReason::Unspecified,
                "{word}"
            );
        }
        assert_eq!(
            refusal_of("from_the_future"),
            wire::AssistRefusalReason::Unspecified
        );
    }
}

#[cfg(test)]
#[path = "chat_tests.rs"]
mod search_tests;
