use rusqlite::Row;

use crate::read::{DEFAULT_PAGE, ParamTy, Read, ReadDecl, Shape, desc, param, read};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    pub scope: Option<String>,
    pub at: String,
}

impl ThreadSummary {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            scope: row.get("scope")?,
            at: row.get("at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadDetail {
    pub id: String,
    pub title: String,
    pub scope: Option<String>,
    pub updated_at: String,
}

impl ThreadDetail {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            scope: row.get("scope")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageRow {
    pub thread_id: String,
    pub ordinal: i64,
    pub role: String,
    pub text: String,
    pub outcome: String,
    pub refusal: Option<String>,
    pub notice: Option<String>,
    pub created_at: String,
}

impl MessageRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            thread_id: row.get("thread_id")?,
            ordinal: row.get("ordinal")?,
            role: row.get("role")?,
            text: row.get("text")?,
            outcome: row.get("outcome")?,
            refusal: row.get("refusal")?,
            notice: row.get("notice")?,
            created_at: row.get("created_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MessageCardRow {
    pub thread_id: String,
    pub ordinal: i64,
    pub position: f64,
    pub entity_id: Option<String>,
    pub qualifier: Option<String>,
    pub entity_kind: Option<String>,
    pub entity_title: Option<String>,
    pub entity_deleted_at: Option<String>,
}

impl MessageCardRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            thread_id: row.get("thread_id")?,
            ordinal: row.get("ordinal")?,
            position: row.get("position")?,
            entity_id: row.get("entity_id")?,
            qualifier: row.get("qualifier")?,
            entity_kind: row.get("entity_kind")?,
            entity_title: row.get("entity_title")?,
            entity_deleted_at: row.get("entity_deleted_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MessageAttachmentRow {
    pub thread_id: String,
    pub ordinal: i64,
    pub position: f64,
    pub form: String,
    pub label: Option<String>,
    pub entity_id: Option<String>,
    pub thumb: Option<String>,
    pub entity_kind: Option<String>,
    pub entity_title: Option<String>,
    pub entity_deleted_at: Option<String>,
}

impl MessageAttachmentRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            thread_id: row.get("thread_id")?,
            ordinal: row.get("ordinal")?,
            position: row.get("position")?,
            form: row.get("form")?,
            label: row.get("label")?,
            entity_id: row.get("entity_id")?,
            thumb: row.get("thumb")?,
            entity_kind: row.get("entity_kind")?,
            entity_title: row.get("entity_title")?,
            entity_deleted_at: row.get("entity_deleted_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConceptRow {
    pub id: String,
    pub kind: String,
    pub key: String,
    pub title: String,
}

impl ConceptRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            kind: row.get("kind")?,
            key: row.get("key")?,
            title: row.get("title")?,
        })
    }
}

pub const THREADS: Read<ThreadSummary> = read(
    ReadDecl {
        name: "chat.threads",
        shape: Shape::PagedList,
        sql: "SELECT e.id, e.title, t.scope, e.updated_at AS at \
              FROM entity e JOIN thread t ON t.id = e.id \
              WHERE e.kind = 'thread' AND e.deleted_at IS NULL \
                AND (e.updated_at, e.id) < (:a, :b) \
              ORDER BY e.updated_at DESC, e.id DESC LIMIT :n",
        params: &[],
        reads: &["thread"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    ThreadSummary::of,
);

pub const THREAD_BY_ID: Read<ThreadDetail> = read(
    ReadDecl {
        name: "chat.thread_by_id",
        shape: Shape::ByKey,
        sql: "SELECT thread.id, entity.title, thread.scope, entity.updated_at \
              FROM thread JOIN entity ON entity.id = thread.id \
              WHERE thread.id = :id AND entity.deleted_at IS NULL",
        params: &[param("id", ParamTy::Id)],
        reads: &["thread"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    ThreadDetail::of,
);

pub const MESSAGES: Read<MessageRow> = read(
    ReadDecl {
        name: "chat.messages",
        shape: Shape::BoundedChild,
        sql: "SELECT thread_id, ordinal, role, text, outcome, refusal, notice, created_at \
              FROM message \
              WHERE thread_id = :thread_id \
              ORDER BY ordinal ASC LIMIT 200",
        params: &[param("thread_id", ParamTy::Id)],
        reads: &["message"],
        across: &[],
        bound: 200,
        cursor: &[],
    },
    MessageRow::of,
);

pub const MESSAGE_CARDS: Read<MessageCardRow> = read(
    ReadDecl {
        name: "chat.message_cards",
        shape: Shape::BoundedChild,
        sql: "SELECT c.thread_id, c.ordinal, c.position, c.entity_id, c.qualifier, \
                     e.kind AS entity_kind, e.title AS entity_title, e.deleted_at AS entity_deleted_at \
              FROM message_card c LEFT JOIN entity e ON e.id = c.entity_id \
              WHERE c.thread_id = :thread_id \
              ORDER BY c.ordinal ASC, c.position ASC LIMIT 200",
        params: &[param("thread_id", ParamTy::Id)],
        reads: &["message_card"],
        across: &["entity"],
        bound: 200,
        cursor: &[],
    },
    MessageCardRow::of,
);

pub const MESSAGE_ATTACHMENTS: Read<MessageAttachmentRow> = read(
    ReadDecl {
        name: "chat.message_attachments",
        shape: Shape::BoundedChild,
        sql: "SELECT a.thread_id, a.ordinal, a.position, a.form, a.label, a.entity_id, a.thumb, \
                     e.kind AS entity_kind, e.title AS entity_title, e.deleted_at AS entity_deleted_at \
              FROM message_attachment a LEFT JOIN entity e ON e.id = a.entity_id \
              WHERE a.thread_id = :thread_id \
              ORDER BY a.ordinal ASC, a.position ASC LIMIT 200",
        params: &[param("thread_id", ParamTy::Id)],
        reads: &["message_attachment"],
        across: &["entity"],
        bound: 200,
        cursor: &[],
    },
    MessageAttachmentRow::of,
);

pub const CONCEPTS_BY_KIND: Read<ConceptRow> = read(
    ReadDecl {
        name: "chat.concepts_by_kind",
        shape: Shape::BoundedChild,
        sql: "SELECT c.id, c.kind, c.key, e.title \
              FROM concept c JOIN entity e ON e.id = c.id \
              WHERE c.kind = :kind AND e.deleted_at IS NULL \
              ORDER BY c.key ASC LIMIT 100",
        params: &[param("kind", ParamTy::Text)],
        reads: &["concept"],
        across: &["entity"],
        bound: 100,
        cursor: &[],
    },
    ConceptRow::of,
);

pub const READS: &[ReadDecl] = &[
    THREADS.decl,
    THREAD_BY_ID.decl,
    MESSAGES.decl,
    MESSAGE_CARDS.decl,
    MESSAGE_ATTACHMENTS.decl,
    CONCEPTS_BY_KIND.decl,
];
