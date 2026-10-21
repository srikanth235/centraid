//! A CONVERSATION, AS THE SHELL READS IT BACK.
//!
//! The writes are [`crate::commands::thread`]. Everything here reads: the thread list, one thread's
//! messages with their cards and attachments, the turns a reopened thread hands the assistant's
//! session, whether the row a card names is still there, and what the chat may read of a vault
//! photograph or document it was handed ([#1135](https://github.com/srikanth235/centraid/issues/1135)).
//!
//! None of it takes a vault-wide lock for longer than one bounded query, and none of it writes: a
//! read that healed a row would be a writer the command plane does not know about.

use rusqlite::{Connection, OptionalExtension};

use crate::blob::base_media_type;
use crate::error::Result;
use crate::file::Vault;
use crate::model::Kind;

/// The longest a thread's title runs, in characters, before it is cut.
pub const TITLE_CHARS: usize = 60;

/// The media types of a document whose text the chat will read.
pub const ATTACH_TEXT_TYPES: [&str; 3] = ["text/plain", "text/markdown", "text/x-markdown"];

/// The largest text document the chat will read, in bytes.
pub const ATTACH_TEXT_MAX_BYTES: usize = 1024 * 1024;

/// The largest original the chat will decode when a photograph has no preview to read instead.
pub const ATTACH_ORIGINAL_MAX_BYTES: i64 = 40 * 1024 * 1024;

/// A thread's title from the words that name it: whitespace collapsed to single spaces, trimmed,
/// and cut to [`TITLE_CHARS`] characters with an ellipsis. Empty when there are no words, which is
/// how a caller refuses it.
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
    /// `updated_at` as epoch milliseconds, so a shell can say "5 min ago" without parsing a date.
    pub updated_ms: i64,
}

/// A card as it was said: a snapshot, with no reference to its row.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StoredCard {
    pub app: String,
    pub entity: String,
    pub row_id: String,
    pub qualifier: String,
    pub title: String,
    pub subtitle: String,
    pub meta: String,
}

/// An attachment as it was sent: the typed reference, and a file to draw as its thumbnail when this
/// device holds one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAttachment {
    /// `photo`, `document` or `image`.
    pub form: String,
    pub label: String,
    /// The vault photograph or document, while it is still in the vault and not in the trash.
    pub entity_id: Option<String>,
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
    /// (a write that waited for a tap), then `applied`, `dismissed`, `stale` or `failed`. A
    /// `proposed` message in a thread just opened has no card waiting on it.
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

/// Where the bytes of a photograph are, for the chat to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PhotoSource {
    /// A file this device holds.
    Held {
        path: std::path::PathBuf,
        /// `preview`, `original` or `thumb`: which of the photograph's bytes this is.
        variant: &'static str,
        /// The owner's caption, if they wrote one.
        title: Option<String>,
    },
    /// The photograph is a video, which the chat does not read.
    NotAnImage,
    /// The row is here and none of its bytes are on this device yet.
    NotHeld,
    /// No such photograph, or it is in the trash.
    Missing,
}

/// A document, for the chat to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentSource {
    Text {
        title: String,
        text: String,
    },
    /// A document whose type the chat does not read (a PDF, a Word file).
    Unsupported {
        media_type: String,
    },
    /// Bigger than [`ATTACH_TEXT_MAX_BYTES`].
    TooLarge,
    /// No such document, it is in the trash, or its text is not in the vault.
    Missing,
}

/// One document the chat can read, for the picker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachableDocument {
    pub document_id: String,
    pub title: String,
    pub media_type: String,
    /// The document's last edit, as the vault stamps it.
    pub updated_at: String,
}

/// The kind a card's `entity` word names, or `None` for a word the vault does not interpret.
fn card_kind(entity: &str) -> Option<Kind> {
    match entity {
        "transaction" => Some(Kind::Txn),
        "project" => Some(Kind::Project),
        other => Kind::parse(other),
    }
}

const THREAD_COLUMNS: &str = "e.id, e.title, t.scope, e.created_at, e.updated_at";
const THREAD_FROM: &str = "FROM thread t JOIN entity e ON e.id = t.id";

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

fn messages_of(connection: &Connection, thread_id: &str) -> Result<Vec<StoredMessage>> {
    let mut statement = connection.prepare(
        "SELECT ordinal, role, text, outcome, refusal, notice, cards
           FROM message WHERE thread_id = ?1 ORDER BY ordinal",
    )?;
    let rows = statement
        .query_map([thread_id], |row| {
            let cards: String = row.get(6)?;
            Ok(StoredMessage {
                ordinal: row.get(0)?,
                role: row.get(1)?,
                text: row.get(2)?,
                outcome: row.get(3)?,
                refusal: row.get(4)?,
                notice: row.get(5)?,
                cards: cards_of(&cards),
                attachments: Vec::new(),
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// The cards a message snapshot holds. A snapshot this build cannot read is no cards, not a thread
/// that will not open.
fn cards_of(json: &str) -> Vec<StoredCard> {
    let word = |card: &serde_json::Value, key: &str| {
        card.get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    serde_json::from_str::<Vec<serde_json::Value>>(json)
        .unwrap_or_default()
        .iter()
        .map(|card| StoredCard {
            app: word(card, "app"),
            entity: word(card, "entity"),
            row_id: word(card, "id"),
            qualifier: word(card, "qualifier"),
            title: word(card, "title"),
            subtitle: word(card, "subtitle"),
            meta: word(card, "meta"),
        })
        .collect()
}

impl Vault {
    /// Every thread, newest activity first, at most `limit`.
    ///
    /// # Errors
    /// [`crate::error::VaultError`] when the vault itself is unreadable.
    pub fn chat_threads(&self, limit: usize) -> Result<Vec<ThreadRow>> {
        self.read(|connection| {
            let mut statement = connection.prepare(&format!(
                "SELECT {THREAD_COLUMNS} {THREAD_FROM} ORDER BY e.updated_at DESC, e.n DESC LIMIT ?1"
            ))?;
            let rows = statement
                .query_map([i64::try_from(limit).unwrap_or(i64::MAX)], thread_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// The threads `ids` name, IN THE ORDER OF `ids` (the order a search ranked them). An id with no
    /// thread is skipped: a thread deleted between the search and this read is not an error.
    ///
    /// # Errors
    /// [`crate::error::VaultError`] when the vault itself is unreadable.
    pub fn chat_thread_rows(&self, ids: &[String]) -> Result<Vec<ThreadRow>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut rows = self.read(|connection| {
            let placeholders = vec!["?"; ids.len()].join(", ");
            let mut statement = connection.prepare(&format!(
                "SELECT {THREAD_COLUMNS} {THREAD_FROM} WHERE e.id IN ({placeholders})"
            ))?;
            let rows = statement
                .query_map(rusqlite::params_from_iter(ids), thread_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        rows.sort_by_key(|row| ids.iter().position(|id| *id == row.thread_id));
        Ok(rows)
    }

    /// Whether a thread's last answer is a proposal nobody has settled. `false` for a thread with
    /// no answer, and for one that is not there. The core asks before it settles, so a card tapped
    /// twice writes the vault once and tells no screen the second time.
    ///
    /// # Errors
    /// [`crate::error::VaultError`] when the vault itself is unreadable.
    pub fn chat_proposal_waiting(&self, thread_id: &str) -> Result<bool> {
        self.read(|connection| {
            let last: Option<String> = connection
                .query_row(
                    "SELECT outcome FROM message WHERE thread_id = ?1 AND role = 'assistant'
                      ORDER BY ordinal DESC LIMIT 1",
                    [thread_id],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(last.as_deref() == Some("proposed"))
        })
    }

    /// One thread and its messages, or `None` when there is no such thread.
    ///
    /// # Errors
    /// [`crate::error::VaultError`] when the vault itself is unreadable.
    pub fn chat_thread(&self, thread_id: &str) -> Result<Option<StoredThread>> {
        let found = self.read(|connection| {
            let thread = connection
                .query_row(
                    &format!("SELECT {THREAD_COLUMNS} {THREAD_FROM} WHERE e.id = ?1"),
                    [thread_id],
                    thread_row,
                )
                .optional()?;
            let Some(thread) = thread else {
                return Ok(None);
            };
            let messages = messages_of(connection, thread_id)?;
            Ok(Some((thread, messages)))
        })?;
        let Some((thread, mut messages)) = found else {
            return Ok(None);
        };
        // A trashed photograph or document is as gone to the member as a purged one, so its
        // reference reads as lost here too.
        let attachments: Vec<(i64, StoredAttachment, Option<String>)> = self.read(|connection| {
            let mut statement = connection.prepare(
                "SELECT a.ordinal, a.form, a.label,
                        (SELECT id FROM entity WHERE id = a.entity_id AND deleted_at IS NULL), a.thumb
                   FROM message_attachment a WHERE a.thread_id = ?1 ORDER BY a.ordinal, a.position",
            )?;
            let rows = statement
                .query_map([thread_id], |row| {
                    Ok((
                        row.get(0)?,
                        StoredAttachment {
                            form: row.get(1)?,
                            label: row.get(2)?,
                            entity_id: row.get(3)?,
                            thumbnail_path: None,
                        },
                        row.get(4)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        for (ordinal, mut attachment, thumb) in attachments {
            attachment.thumbnail_path = self.attachment_thumbnail(&attachment, thumb.as_deref())?;
            if let Some(message) = messages.iter_mut().find(|m| m.ordinal == ordinal) {
                message.attachments.push(attachment);
            }
        }
        Ok(Some(StoredThread { thread, messages }))
    }

    /// The file an attachment's chip draws, when this device holds one: the stored thumbnail of a
    /// camera-roll image, or the vault photograph's own `thumb` derivative. A document has none.
    fn attachment_thumbnail(
        &self,
        attachment: &StoredAttachment,
        thumb: Option<&str>,
    ) -> Result<Option<String>> {
        let hash: Option<String> = match (thumb, attachment.entity_id.as_deref()) {
            (Some(hash), _) => Some(hash.to_owned()),
            (None, Some(photo)) if attachment.form == "photo" => self.read(|connection| {
                Ok(connection
                    .query_row(
                        "SELECT d.out FROM photo p JOIN derivative d ON d.blob = p.blob
                          WHERE p.id = ?1 AND d.variant = 'thumb'",
                        [photo],
                        |row| row.get(0),
                    )
                    .optional()?)
            })?,
            _ => None,
        };
        let (Some(hash), Some(blobs)) = (hash, self.blobs()) else {
            return Ok(None);
        };
        Ok(blobs
            .path_of(&hash)
            .ok()
            .flatten()
            .map(|path| path.to_string_lossy().into_owned()))
    }

    /// The last `turns` turns of a thread that kept a routing record, oldest first, for a reopened
    /// thread's session. A turn with no record (a stopped one) is not history: the assistant never
    /// recorded it either.
    ///
    /// # Errors
    /// [`crate::error::VaultError`] when the vault itself is unreadable.
    pub fn chat_history(&self, thread_id: &str, turns: usize) -> Result<Vec<StoredTurn>> {
        self.read(|connection| {
            let mut statement = connection.prepare(
                "SELECT u.text, a.record
                   FROM message a
                   JOIN message u ON u.thread_id = a.thread_id AND u.ordinal = a.ordinal - 1
                  WHERE a.thread_id = ?1 AND a.role = 'assistant' AND a.record IS NOT NULL
                  ORDER BY a.ordinal DESC LIMIT ?2",
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

    /// The last question put to a thread, whatever became of it: what a retry asks again.
    ///
    /// # Errors
    /// [`crate::error::VaultError`] when the vault itself is unreadable.
    pub fn chat_last_question(&self, thread_id: &str) -> Result<Option<String>> {
        self.read(|connection| {
            Ok(connection
                .query_row(
                    "SELECT text FROM message WHERE thread_id = ?1 AND role = 'user'
                      ORDER BY ordinal DESC LIMIT 1",
                    [thread_id],
                    |row| row.get(0),
                )
                .optional()?)
        })
    }

    /// Whether the row a card names is still in the vault and not in the trash.
    ///
    /// A card is a snapshot with no foreign key, so this is asked at the moment of a tap. An app a
    /// card may not name ([`crate::roster`]: Locker, or one that does not exist) is answered
    /// `false`; an ENTITY word this does not interpret, of a real app, is answered `true`, because
    /// the shell opens whatever it has a route for and an unknown card is not evidence that a row
    /// is gone.
    ///
    /// # Errors
    /// [`crate::error::VaultError`] when the vault itself is unreadable.
    pub fn chat_card_row_exists(&self, app: &str, entity: &str, row_id: &str) -> Result<bool> {
        if !crate::roster::is_card_app(app) {
            return Ok(false);
        }
        let Some(kind) = card_kind(entity) else {
            return Ok(true);
        };
        self.read(|connection| {
            Ok(connection
                .query_row(
                    "SELECT 1 FROM entity WHERE id = ?1 AND kind = ?2 AND deleted_at IS NULL",
                    rusqlite::params![row_id, kind.as_str()],
                    |_| Ok(()),
                )
                .optional()?
                .is_some())
        })
    }

    /// The documents the chat can read (`text/plain`, `text/markdown`), newest edit first, at most
    /// `limit`. A PDF or a Word file is not offered: the picker lists only what an attach would not
    /// refuse.
    ///
    /// # Errors
    /// [`crate::error::VaultError`] when the vault itself is unreadable.
    pub fn attachable_documents(&self, limit: usize) -> Result<Vec<AttachableDocument>> {
        // Read wide: the type filter is applied in Rust (a media type carries parameters), so the
        // page is not exactly `limit`.
        let rows: Vec<AttachableDocument> = self.read(|connection| {
            let mut statement = connection.prepare(
                "SELECT e.id, e.title, d.media_type, e.updated_at
                   FROM document d JOIN entity e ON e.id = d.id
                  WHERE e.deleted_at IS NULL ORDER BY e.updated_at DESC, e.n DESC LIMIT 500",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok(AttachableDocument {
                        document_id: row.get(0)?,
                        title: row.get(1)?,
                        media_type: row.get(2)?,
                        updated_at: row.get(3)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        Ok(rows
            .into_iter()
            .filter(|document| {
                ATTACH_TEXT_TYPES.contains(&base_media_type(&document.media_type).as_str())
            })
            .take(limit)
            .collect())
    }

    /// Locate a photograph's bytes for the chat: the `preview` derivative (a 2048-pixel JPEG, which
    /// is what a phone can afford to decode), else the original when it is not enormous, else the
    /// `thumb`. Only files this device holds count, and a video is not an image to read.
    ///
    /// # Errors
    /// [`crate::error::VaultError`] when the vault itself is unreadable.
    pub fn attachment_photo(&self, photo_id: &str) -> Result<PhotoSource> {
        type Row = (String, String, String, String, i64);
        let photo: Option<Row> = self.read(|connection| {
            Ok(connection
                .query_row(
                    "SELECT p.blob, p.form, e.title, p.media_type, b.size
                       FROM photo p JOIN entity e ON e.id = p.id JOIN blob b ON b.hash = p.blob
                      WHERE p.id = ?1 AND e.deleted_at IS NULL",
                    [photo_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .optional()?)
        })?;
        let Some((blob, form, title, _, size)) = photo else {
            return Ok(PhotoSource::Missing);
        };
        if form == "video" {
            return Ok(PhotoSource::NotAnImage);
        }
        let derived: Vec<(String, String)> = self.read(|connection| {
            let mut statement = connection.prepare(
                "SELECT variant, out FROM derivative
                  WHERE blob = ?1 AND variant IN ('preview', 'thumb') AND out IS NOT NULL",
            )?;
            let rows = statement
                .query_map([&blob], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        let Some(blobs) = self.blobs() else {
            return Ok(PhotoSource::NotHeld);
        };
        let derivative = |variant: &str| {
            derived
                .iter()
                .find(|(held, _)| held == variant)
                .map(|(_, hash)| hash.as_str())
        };
        let original = (size <= ATTACH_ORIGINAL_MAX_BYTES).then_some(blob.as_str());
        for (variant, hash) in [
            ("preview", derivative("preview")),
            ("original", original),
            ("thumb", derivative("thumb")),
        ] {
            let Some(hash) = hash else { continue };
            match blobs.path_of(hash) {
                Ok(Some(path)) => {
                    return Ok(PhotoSource::Held {
                        path,
                        variant,
                        title: (!title.is_empty()).then_some(title),
                    });
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!("the content store could not answer for {photo_id}: {error}");
                }
            }
        }
        Ok(PhotoSource::NotHeld)
    }

    /// Read a document's text for the chat: the words the blob's `text` derivative holds, when the
    /// document is `text/plain` or `text/markdown`.
    ///
    /// # Errors
    /// [`crate::error::VaultError`] when the vault itself is unreadable.
    pub fn attachment_document(&self, document_id: &str) -> Result<DocumentSource> {
        type Row = (String, String, Option<String>);
        let document: Option<Row> = self.read(|connection| {
            Ok(connection
                .query_row(
                    "SELECT e.title, d.media_type, (SELECT x.text FROM derivative x
                                                     WHERE x.blob = d.blob AND x.variant = 'text')
                       FROM document d JOIN entity e ON e.id = d.id
                      WHERE d.id = ?1 AND e.deleted_at IS NULL",
                    [document_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?)
        })?;
        let Some((title, media_type, text)) = document else {
            return Ok(DocumentSource::Missing);
        };
        let media_type = base_media_type(&media_type);
        if !ATTACH_TEXT_TYPES.contains(&media_type.as_str()) {
            return Ok(DocumentSource::Unsupported { media_type });
        }
        Ok(match text {
            None => DocumentSource::Missing,
            Some(text) if text.len() > ATTACH_TEXT_MAX_BYTES => DocumentSource::TooLarge,
            Some(text) => DocumentSource::Text { title, text },
        })
    }
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

    #[test]
    fn a_card_entity_names_a_kind_or_none() {
        assert_eq!(card_kind("transaction"), Some(Kind::Txn));
        assert_eq!(card_kind("project"), Some(Kind::Project));
        assert_eq!(card_kind("album"), Some(Kind::Album));
        assert_eq!(card_kind("somethingnew"), None);
    }
}
