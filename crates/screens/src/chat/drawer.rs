//! The drawer of past chats, its search, and a stored chat opened, renamed or deleted.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::assist_request::Kind as Ask;

use super::model::{Chat, Fail, Msg, Pending, Proposal, Row, Search, Source, Stage};
use super::turn::stored_card;
use crate::catalog::{act, load};
use crate::kit::act as writes;
use crate::kit::read::{self, Reading};
use crate::screen::Ctx;
use crate::strings::chat as words;

fn rows_of(rows: &[wire::ChatThreadRow]) -> Vec<Row> {
    rows.iter()
        .map(|row| Row {
            id: row.thread_id.clone(),
            title: row.title.clone(),
            updated_ms: row.updated_ms,
        })
        .collect()
}

impl Chat {
    /// The drawer's list, read. A refusal to answer leaves the list as it was. A search that is
    /// showing is read again with the list: a chat renamed or deleted since it was answered must
    /// not stay in the results.
    pub(super) fn read_threads(&mut self, ctx: &Ctx) {
        self.clock();
        let reading = read::read(
            ctx,
            load::shell::Chats {
                limit: 0,
                term: None,
            },
            |answer| match answer {
                Answer::ChatThreads(threads) => Some(threads),
                _ => None,
            },
        );
        if let Reading::Data(threads) = reading {
            self.threads = rows_of(&threads.threads);
        }
        if self.search.open && !self.search.term.trim().is_empty() {
            self.run_search(ctx);
        }
    }

    pub(super) fn drawer_toggled(&mut self, open: bool, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.drawer_open == open {
            return Vec::new();
        }
        self.drawer_open = open;
        if open {
            // Opening reads the list again: it is never older than the last act.
            self.read_threads(ctx);
        } else {
            // Shutting the drawer closes its search with it: the term does not come back.
            self.search = Search::default();
            self.found = None;
        }
        Vec::new()
    }

    pub(super) fn search_opened(&mut self) -> Vec<wire::Effect> {
        if self.drawer_open && !self.search.open {
            self.search.open = true;
        }
        Vec::new()
    }

    /// The field changed. A blank term puts the plain list back and reads nothing; any other asks
    /// the core. The rows on screen stay while the new term reads, and the words the last answer
    /// corrected go with it.
    pub(super) fn search_term(&mut self, term: &str, ctx: &Ctx) -> Vec<wire::Effect> {
        if !self.drawer_open {
            return Vec::new();
        }
        if self.search.open && self.search.term == term {
            return Vec::new();
        }
        self.search.open = true;
        self.search.term = term.to_owned();
        self.search.corrected.clear();
        if term.trim().is_empty() {
            self.search.answered.clear();
            self.found = None;
        } else {
            self.run_search(ctx);
        }
        Vec::new()
    }

    pub(super) fn search_closed(&mut self) -> Vec<wire::Effect> {
        self.search = Search::default();
        self.found = None;
        Vec::new()
    }

    fn run_search(&mut self, ctx: &Ctx) {
        let term = self.search.term.trim().to_owned();
        let reading = read::read(
            ctx,
            load::shell::Chats {
                limit: 0,
                term: Some(term.clone()),
            },
            |answer| match answer {
                Answer::ChatThreads(threads) => Some(threads),
                _ => None,
            },
        );
        // A refusal to answer leaves the drawer as it was; an answer for a term since changed is
        // dropped (this read is synchronous, so the term is always current).
        if let Reading::Data(found) = reading {
            self.found = Some(rows_of(&found.threads));
            self.search.answered = term;
            self.search.corrected = found.corrected;
            self.clock();
        }
    }

    /// A past chat was tapped. The one already open only closes the drawer. Anything else stops a
    /// running turn and replaces the thread with the stored messages and a session rebuilt from
    /// them, together, so the messages on screen and the session that continues them cannot
    /// disagree.
    pub(super) fn thread_opened(&mut self, id: &str, told: &str, ctx: &Ctx) -> Vec<wire::Effect> {
        if id.is_empty() {
            return Vec::new();
        }
        if id == self.thread_id {
            return self.drawer_toggled(false, ctx);
        }
        if self.running && self.session != 0 {
            self.cancel_remote(ctx);
        }
        // The list's row wins; a chat found by search can be older than the list's newest
        // hundred, so the title the shell was told (the hit's) is the header until it is read.
        let title = self
            .threads
            .iter()
            .chain(self.found.iter().flatten())
            .find(|row| row.id == id)
            .map_or_else(|| told.to_owned(), |row| row.title.clone());
        let stored = read::read(
            ctx,
            load::shell::Chat {
                thread_id: id.to_owned(),
            },
            |answer| match answer {
                Answer::ChatThread(thread) => Some(thread),
                _ => None,
            },
        );
        let started = ctx.assist(&super::model::assist(Ask::Start(
            wire::AssistStartRequest {
                app: String::new(),
                thread_id: id.to_owned(),
            },
        )));
        let started = match started.ok().and_then(|answer| answer.kind) {
            Some(wire::assist_response::Kind::Started(started)) => Some(started),
            _ => None,
        };
        // A chat deleted from another place says so; a read or a session that failed otherwise
        // is the generic line. Either leaves a new chat.
        if matches!(&stored, Reading::Data(stored) if !stored.found) {
            return self.thread_unavailable(Some(Fail::ThreadGone), ctx);
        }
        let (Reading::Data(stored), Some(started)) = (stored, started) else {
            return self.thread_unavailable(None, ctx);
        };
        self.clear_thread();
        self.thread_id = id.to_owned();
        self.thread_title = title;
        let mut next = 1;
        let mut messages = Vec::new();
        for message in &stored.messages {
            if message.from_member {
                messages.push(Msg {
                    id: next,
                    user: true,
                    text: message.text.clone(),
                    attachments: message
                        .attachments
                        .iter()
                        .enumerate()
                        .map(|(at, held)| pending_of(held, at as u64 + 1))
                        .collect(),
                    ..Msg::default()
                });
                next += 1;
            } else if !message.text.is_empty() || !message.cards.is_empty() {
                use wire::ChatStoredOutcome as O;
                let outcome = O::try_from(message.outcome).unwrap_or(O::Unspecified);
                messages.push(Msg {
                    id: next,
                    user: false,
                    text: message.text.clone(),
                    cards: message.cards.iter().map(stored_card).collect(),
                    stopped: matches!(outcome, O::Stopped | O::Refused),
                    truncated: message
                        .notices
                        .contains(&(wire::AssistNotice::DocTruncated as i32)),
                    proposal: stored_proposal(outcome, ctx),
                    ..Msg::default()
                });
                next += 1;
            }
        }
        let last = stored.messages.last();
        let refused = last.is_some_and(|last| {
            !last.from_member && last.outcome == wire::ChatStoredOutcome::Refused as i32
        });
        self.asked = stored
            .messages
            .iter()
            .rev()
            .find(|message| message.from_member)
            .map(|message| message.text.clone());
        self.error = last
            .filter(|_| refused)
            .and_then(|last| Self::stored_fail(last.refusal));
        self.messages = messages;
        self.next_id = next;
        self.session = started.session_id;
        self.scope = started.scope_app;
        if let Some(row) = &stored.thread {
            self.thread_id.clone_from(&row.thread_id);
            self.thread_title.clone_from(&row.title);
        }
        Vec::new()
    }

    /// A thread that is not in the vault any more (deleted from another place) says so and
    /// becomes a new chat.
    fn thread_unavailable(&mut self, fail: Option<Fail>, ctx: &Ctx) -> Vec<wire::Effect> {
        self.clear_thread();
        self.error = Some(fail.unwrap_or(Fail::Generic));
        if self.session != 0 {
            let _ = ctx.assist(&super::model::assist(Ask::Clear(
                wire::AssistClearRequest {
                    session_id: self.session,
                },
            )));
        }
        self.read_threads(ctx);
        Vec::new()
    }

    /// Rename: the row and the header change at once; the vault is told after.
    pub(super) fn thread_renamed(&mut self, id: &str, title: &str, ctx: &Ctx) -> Vec<wire::Effect> {
        let named = title.split_whitespace().collect::<Vec<_>>().join(" ");
        if id.is_empty() || named.is_empty() {
            return Vec::new();
        }
        for row in self
            .threads
            .iter_mut()
            .chain(self.found.iter_mut().flatten())
        {
            if row.id == id {
                row.title.clone_from(&named);
            }
        }
        if id == self.thread_id {
            self.thread_title.clone_from(&named);
        }
        self.write(
            act::shell::RenameChat {
                chat_thread_id: id.to_owned(),
                title: named,
            },
            ctx,
        );
        Vec::new()
    }

    /// Delete one chat. The open one goes back to a new chat (and the core's session is cleared,
    /// which unbinds it); another leaves the list at once. Either way the vault is told, and the
    /// list is read again after.
    pub(super) fn thread_deleted(&mut self, id: &str, ctx: &Ctx) -> Vec<wire::Effect> {
        if id.is_empty() {
            return Vec::new();
        }
        let was_open = id == self.thread_id;
        self.threads.retain(|row| row.id != id);
        if let Some(found) = &mut self.found {
            found.retain(|row| row.id != id);
        }
        self.write(
            act::shell::DeleteChat {
                chat_thread_id: id.to_owned(),
            },
            ctx,
        );
        if was_open {
            self.reset_session(ctx);
        }
        self.read_threads(ctx);
        Vec::new()
    }

    /// Delete every chat in this vault. An open stored chat goes back to a new one.
    pub(super) fn all_threads_deleted(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let stored = !self.thread_id.is_empty();
        self.threads.clear();
        self.drawer_open = false;
        self.search = Search::default();
        self.found = None;
        self.write(act::shell::ClearChats {}, ctx);
        if stored {
            self.reset_session(ctx);
        }
        self.read_threads(ctx);
        Vec::new()
    }

    /// A new chat on the same session: the transcript goes, the core unbinds the stored thread.
    fn reset_session(&mut self, ctx: &Ctx) {
        let threads = std::mem::take(&mut self.threads);
        self.clear_thread();
        self.threads = threads;
        if self.session != 0 {
            let _ = ctx.assist(&super::model::assist(Ask::Clear(
                wire::AssistClearRequest {
                    session_id: self.session,
                },
            )));
            self.suggest(ctx);
        }
    }

    fn write(&mut self, request: impl Into<wire::ActRequest>, ctx: &Ctx) {
        self.seq += 1;
        let key = writes::key(&["chat"], self.seq);
        let _ = writes::act(ctx, request, &key);
    }
}

/// The card a stored answer draws, if any (R-1088-10). A `proposed` answer is a write no session
/// holds any more: its text is the "Proposed: …" line and its card is INERT, nothing to tap and
/// nothing run, with no id because the core has nothing by that name. The four ends need no card:
/// the vault replaced the answer's text with the line the member was told ("Done.", "Not done.",
/// "That changed since. Ask again."), and that text is what the message draws.
fn stored_proposal(outcome: wire::ChatStoredOutcome, ctx: &Ctx) -> Option<Proposal> {
    (outcome == wire::ChatStoredOutcome::Proposed).then(|| Proposal {
        id: String::new(),
        steps: Vec::new(),
        more: 0,
        destructive: false,
        stage: Stage::Inert,
        line: words::not_done(ctx.locale()),
    })
}

/// A stored attachment as a chip: what it was, never its bytes, and whether a retry can send it
/// again.
fn pending_of(held: &wire::ChatStoredAttachment, id: u64) -> Pending {
    use wire::ChatStoredAttachmentKind as K;
    let kind = K::try_from(held.kind).unwrap_or(K::Unspecified);
    let source = match kind {
        K::Photo if !held.asset_id.is_empty() => Source::VaultPhoto(held.asset_id.clone()),
        K::Document if !held.document_id.is_empty() => {
            Source::VaultDocument(held.document_id.clone())
        }
        // A camera-roll image kept only its thumbnail, and a photo or a document the member has
        // since deleted is not there to send.
        _ => Source::Unavailable,
    };
    Pending {
        id,
        photo: kind != K::Document,
        label: held.label.clone(),
        thumbnail_path: held.thumbnail_path.clone(),
        source,
    }
}
