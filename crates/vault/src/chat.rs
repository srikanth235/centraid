//! A CONVERSATION, AS THE SHELL READS IT BACK.
//!
//! The writes are `commands::chat`. Everything here reads: the thread list,
//! one thread's messages with their cards and attachments, the turns a
//! reopened thread hands the assistant's session, and whether the row a card
//! names is still there.
//!
//! None of it takes a vault-wide lock for longer than one bounded query, and
//! none of it writes: a read that healed a row would be a writer the command
//! plane does not know about.

use crate::error::Result;
use crate::file::Vault;

/// The longest a thread's title runs, in characters, before it is cut.
pub const TITLE_CHARS: usize = 60;

/// A thread's title from the words that name it: whitespace collapsed to
/// single spaces, trimmed, and cut to [`TITLE_CHARS`] characters with an
/// ellipsis. Empty when there are no words, which is how a caller refuses it.
#[must_use]
pub fn title_of(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= TITLE_CHARS {
        return collapsed;
    }
    let cut: String = collapsed.chars().take(TITLE_CHARS).collect();
    format!("{}…", cut.trim_end())
}

/// One thread, as the drawer lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadRow {
    pub thread_id: String,
    pub title: String,
    /// The app the chat was opened from, or `None` for every app.
    pub scope_app: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// `updated_at` as epoch milliseconds, so a shell can say "5 min ago"
    /// without parsing a date.
    pub updated_ms: i64,
}

/// A card as it was said: a snapshot, with no reference to its row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredCard {
    pub app: String,
    pub entity: String,
    pub row_id: String,
    pub qualifier: String,
    pub title: String,
    pub subtitle: String,
    pub meta: String,
}

/// An attachment as it was sent: the typed reference, and a file to draw as its
/// thumbnail when this device holds one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAttachment {
    /// `photo`, `document` or `image`.
    pub kind: String,
    pub label: String,
    /// The vault photograph, while it is still in the vault.
    pub asset_id: Option<String>,
    /// The vault document, while it is still in the vault.
    pub document_id: Option<String>,
    /// The stored thumbnail of a camera-roll image.
    pub thumb_content_id: Option<String>,
    /// A path the shell can draw, resolved here so one read answers the thread.
    pub thumbnail_path: Option<String>,
}

/// One message of a thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredMessage {
    pub ordinal: i64,
    /// `user` or `assistant`.
    pub role: String,
    pub text: String,
    /// `sent` (a question), `answered`, `stopped` or `refused`; or a proposal's life: `proposed`
    /// (a write that waited for a tap), then `applied`, `dismissed`, `stale` or `failed`
    /// (rung twelve). A `proposed` message in a thread just opened has no card waiting on it.
    pub outcome: String,
    pub refusal: Option<String>,
    pub notice: Option<String>,
    pub cards: Vec<StoredCard>,
    pub attachments: Vec<StoredAttachment>,
}

/// A thread and everything said in it, oldest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredThread {
    pub thread: ThreadRow,
    pub messages: Vec<StoredMessage>,
}

/// One earlier turn, as the assistant's session wants it back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredTurn {
    /// The member's words.
    pub question: String,
    /// The assistant's routing record for the turn, when it kept one.
    pub record_json: Option<String>,
}

/// The apps a card may name: the ones the assistant reads, Locker never among
/// them.
const CARD_APPS: [&str; 7] = [
    "agenda", "docs", "notes", "people", "photos", "tally", "tasks",
];

impl Vault {
    /// Every thread, newest activity first, at most `limit`.
    ///
    /// # Errors
    /// [`crate::error::VaultError`] when the vault itself is unreadable.
    pub fn chat_threads(&self, limit: usize) -> Result<Vec<ThreadRow>> {
        self.read(|connection| {
            let mut statement = connection.prepare(
                "SELECT thread_id, title, scope_app, created_at, updated_at
                   FROM chat_thread
                  ORDER BY updated_at DESC, thread_id DESC
                  LIMIT ?1",
            )?;
            let rows = statement
                .query_map([i64::try_from(limit).unwrap_or(i64::MAX)], thread_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// Whether a thread's last answer is a proposal nobody has settled (rung twelve): a write that
    /// parked behind a card and has not been applied, dismissed, found stale or refused. `false`
    /// for a thread with no answer, and for one that is not there.
    ///
    /// The core asks before it settles, so a card tapped twice writes the vault once and tells
    /// no screen the second time.
    ///
    /// # Errors
    /// [`crate::error::VaultError`] when the vault itself is unreadable.
    pub fn chat_proposal_waiting(&self, thread_id: &str) -> Result<bool> {
        self.read(|connection| {
            let last: Option<String> = connection
                .query_row(
                    "SELECT outcome FROM chat_message
                      WHERE thread_id = ?1 AND role = 'assistant'
                      ORDER BY ordinal DESC LIMIT 1",
                    [thread_id],
                    |row| row.get(0),
                )
                .ok();
            Ok(last.as_deref() == Some("proposed"))
        })
    }

    /// One thread and its messages, or `None` when there is no such thread.
    ///
    /// # Errors
    /// [`crate::error::VaultError`] when the vault itself is unreadable.
    pub fn chat_thread(&self, thread_id: &str) -> Result<Option<StoredThread>> {
        let thread = self.read(|connection| {
            Ok(connection
                .query_row(
                    "SELECT thread_id, title, scope_app, created_at, updated_at
                       FROM chat_thread WHERE thread_id = ?1",
                    [thread_id],
                    thread_row,
                )
                .ok())
        })?;
        let Some(thread) = thread else {
            return Ok(None);
        };
        let mut messages: Vec<StoredMessage> = self.read(|connection| {
            let mut statement = connection.prepare(
                "SELECT ordinal, role, text, outcome, refusal, notice
                   FROM chat_message WHERE thread_id = ?1 ORDER BY ordinal",
            )?;
            let rows = statement
                .query_map([thread_id], |row| {
                    Ok(StoredMessage {
                        ordinal: row.get(0)?,
                        role: row.get(1)?,
                        text: row.get(2)?,
                        outcome: row.get(3)?,
                        refusal: row.get(4)?,
                        notice: row.get(5)?,
                        cards: Vec::new(),
                        attachments: Vec::new(),
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        let cards: Vec<(i64, StoredCard)> = self.read(|connection| {
            let mut statement = connection.prepare(
                "SELECT message_ordinal, app, entity, row_id, qualifier, title, subtitle, meta
                   FROM chat_message_card WHERE thread_id = ?1
                  ORDER BY message_ordinal, position",
            )?;
            let rows = statement
                .query_map([thread_id], |row| {
                    Ok((
                        row.get(0)?,
                        StoredCard {
                            app: row.get(1)?,
                            entity: row.get(2)?,
                            row_id: row.get(3)?,
                            qualifier: row.get(4)?,
                            title: row.get(5)?,
                            subtitle: row.get(6)?,
                            meta: row.get(7)?,
                        },
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        for (ordinal, card) in cards {
            if let Some(message) = messages.iter_mut().find(|m| m.ordinal == ordinal) {
                message.cards.push(card);
            }
        }
        let attachments: Vec<(i64, StoredAttachment)> = self.read(|connection| {
            // A trashed photograph or document is as gone to the member as a
            // purged one, so its reference reads as lost here too.
            let mut statement = connection.prepare(
                "SELECT a.message_ordinal, a.kind, a.label,
                        (SELECT asset_id FROM media_asset
                          WHERE asset_id = a.asset_id AND deleted_at IS NULL),
                        (SELECT document_id FROM core_document
                          WHERE document_id = a.document_id AND deleted_at IS NULL),
                        a.thumb_content_id
                   FROM chat_message_attachment a WHERE a.thread_id = ?1
                  ORDER BY a.message_ordinal, a.position",
            )?;
            let rows = statement
                .query_map([thread_id], |row| {
                    Ok((
                        row.get(0)?,
                        StoredAttachment {
                            kind: row.get(1)?,
                            label: row.get(2)?,
                            asset_id: row.get(3)?,
                            document_id: row.get(4)?,
                            thumb_content_id: row.get(5)?,
                            thumbnail_path: None,
                        },
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        for (ordinal, mut attachment) in attachments {
            attachment.thumbnail_path = self.attachment_thumbnail(&attachment)?;
            if let Some(message) = messages.iter_mut().find(|m| m.ordinal == ordinal) {
                message.attachments.push(attachment);
            }
        }
        Ok(Some(StoredThread { thread, messages }))
    }

    /// The file an attachment's chip draws, when this device holds one: the
    /// stored thumbnail of a camera-roll image, or the vault photograph's own
    /// `thumb` derivative. A document has none.
    fn attachment_thumbnail(&self, attachment: &StoredAttachment) -> Result<Option<String>> {
        if let Some(content_id) = &attachment.thumb_content_id {
            let found = self.content_location(content_id, "", "")?;
            return Ok(found.path.map(|path| path.to_string_lossy().into_owned()));
        }
        let Some(asset_id) = &attachment.asset_id else {
            return Ok(None);
        };
        let hash: Option<String> = self.read(|connection| {
            Ok(connection
                .query_row(
                    "SELECT d.content_hash FROM media_asset a
                       JOIN core_content_derivative d ON d.content_id = a.content_id
                      WHERE a.asset_id = ?1 AND a.deleted_at IS NULL
                        AND d.variant = 'thumb' AND d.content_hash IS NOT NULL",
                    [asset_id],
                    |row| row.get(0),
                )
                .ok())
        })?;
        let (Some(hash), Some(blobs)) = (hash, self.blobs()) else {
            return Ok(None);
        };
        Ok(blobs
            .path_of(&hash)
            .ok()
            .flatten()
            .map(|path| path.to_string_lossy().into_owned()))
    }

    /// The last `turns` turns of a thread that kept a routing record, oldest
    /// first, for a reopened thread's session. A turn with no record (a stopped
    /// one) is not history: the assistant never recorded it either.
    ///
    /// # Errors
    /// [`crate::error::VaultError`] when the vault itself is unreadable.
    pub fn chat_history(&self, thread_id: &str, turns: usize) -> Result<Vec<StoredTurn>> {
        self.read(|connection| {
            let mut statement = connection.prepare(
                "SELECT u.text, a.record_json
                   FROM chat_message a
                   JOIN chat_message u
                     ON u.thread_id = a.thread_id AND u.ordinal = a.ordinal - 1
                  WHERE a.thread_id = ?1 AND a.role = 'assistant' AND a.record_json IS NOT NULL
                  ORDER BY a.ordinal DESC
                  LIMIT ?2",
            )?;
            let mut rows = statement
                .query_map(
                    rusqlite::params![thread_id, i64::try_from(turns).unwrap_or(i64::MAX)],
                    |row| {
                        Ok(StoredTurn {
                            question: row.get(0)?,
                            record_json: row.get(1)?,
                        })
                    },
                )?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows.reverse();
            Ok(rows)
        })
    }

    /// The last question put to a thread, whatever became of it: what a retry
    /// asks again.
    ///
    /// # Errors
    /// [`crate::error::VaultError`] when the vault itself is unreadable.
    pub fn chat_last_question(&self, thread_id: &str) -> Result<Option<String>> {
        self.read(|connection| {
            Ok(connection
                .query_row(
                    "SELECT text FROM chat_message
                      WHERE thread_id = ?1 AND role = 'user'
                      ORDER BY ordinal DESC LIMIT 1",
                    [thread_id],
                    |row| row.get(0),
                )
                .ok())
        })
    }

    /// Whether the row a card names is still in the vault and not in a trash.
    ///
    /// A card is a snapshot with no foreign key, so this is asked at the
    /// moment of a tap. An app a card may not name (Locker, or one that does
    /// not exist) is answered `false`; an ENTITY of a real app this does not
    /// know is answered `true`, because the shell opens whatever it has a
    /// route for and an unknown card is not evidence that a row is gone.
    ///
    /// # Errors
    /// [`crate::error::VaultError`] when the vault itself is unreadable.
    pub fn chat_card_row_exists(&self, app: &str, entity: &str, row_id: &str) -> Result<bool> {
        if !CARD_APPS.contains(&app) {
            return Ok(false);
        }
        let sql = match (app, entity) {
            ("tasks", "task") => {
                "SELECT COUNT(*) FROM schedule_task WHERE task_id = ?1 AND deleted_at IS NULL"
            }
            ("tasks", "project") => "SELECT COUNT(*) FROM schedule_project WHERE project_id = ?1",
            ("agenda", "event") => {
                "SELECT COUNT(*) FROM core_event WHERE event_id = ?1 AND deleted_at IS NULL"
            }
            ("notes", "note") => {
                "SELECT COUNT(*) FROM knowledge_note WHERE note_id = ?1 AND deleted_at IS NULL"
            }
            ("docs", "document") => {
                "SELECT COUNT(*) FROM core_document WHERE document_id = ?1 AND deleted_at IS NULL"
            }
            ("people", "person") => {
                "SELECT COUNT(*) FROM people_profile WHERE party_id = ?1 AND deleted_at IS NULL"
            }
            ("photos", "photo") => {
                "SELECT COUNT(*) FROM media_asset WHERE asset_id = ?1 AND deleted_at IS NULL"
            }
            ("tally", "expense") => {
                "SELECT COUNT(*) FROM tally_expense WHERE expense_id = ?1 AND deleted_at IS NULL"
            }
            ("tally", "friend") => "SELECT COUNT(*) FROM tally_friend WHERE party_id = ?1",
            _ => return Ok(true),
        };
        self.read(|connection| {
            let count: i64 = connection.query_row(sql, [row_id], |row| row.get(0))?;
            Ok(count > 0)
        })
    }
}

fn thread_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadRow> {
    let updated_at: String = row.get(4)?;
    Ok(ThreadRow {
        thread_id: row.get(0)?,
        title: row.get(1)?,
        scope_app: row.get(2)?,
        created_at: row.get(3)?,
        updated_ms: crate::clock::parse_iso_ms(&updated_at).unwrap_or_default(),
        updated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_is_the_first_question_trimmed() {
        assert_eq!(title_of("  what   is due\n today?  "), "what is due today?");
        assert_eq!(title_of("   \n "), "");
    }

    #[test]
    fn a_long_question_is_cut_on_a_character_boundary() {
        let long = "é".repeat(TITLE_CHARS + 25);
        let title = title_of(&long);
        assert_eq!(title.chars().count(), TITLE_CHARS + 1);
        assert!(title.ends_with('…'));
        let exact = "a".repeat(TITLE_CHARS);
        assert_eq!(title_of(&exact), exact);
    }
}
