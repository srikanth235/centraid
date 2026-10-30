//! The finished state the shells draw: every label, count and line is made here.

use centraid_api_proto::core_v1 as wire;
use wire::chat_state::Phase;

use super::model::{Chat, Msg, Pending, Proposal, Row, Stage, VisionPhase};
use super::when;
use crate::screen::Ctx;
use crate::strings::{Locale, chat as words, fill};

fn size_text(bytes: u64) -> String {
    const MEGABYTE: u64 = 1_000_000;
    const GIGABYTE: u64 = 1_000_000_000;
    if bytes == 0 {
        return String::new();
    }
    if bytes >= GIGABYTE {
        let tenths = (bytes * 10 + GIGABYTE / 2) / GIGABYTE;
        format!("{}.{} GB", tenths / 10, tenths % 10)
    } else {
        format!("{} MB", ((bytes + MEGABYTE / 2) / MEGABYTE).max(1))
    }
}

fn percent(locale: Locale, progress: Option<f32>) -> String {
    progress.map_or_else(
        || words::download_progress_unknown(locale),
        |fraction| {
            fill(
                &words::download_progress(locale),
                &[("percent", &format!("{}%", (fraction * 100.0) as u32))],
            )
        },
    )
}

/// The words of an answer for a screen reader: the Markdown a small model writes without being
/// asked (`**bold**`, `` `code` ``, `# heading`) is the view's to draw as styling, and a reader
/// that said "star star" would be speaking the markers. List markers stay.
fn spoken(text: &str) -> String {
    text.replace("**", "")
        .replace("__", "")
        .replace('`', "")
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            let hashes = trimmed.chars().take_while(|c| *c == '#').count();
            if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(char::is_whitespace) {
                trimmed[hashes..].trim_start().to_owned()
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

impl Chat {
    fn model_step(&self, locale: Locale) -> Option<wire::ChatModelStep> {
        match self.phase {
            Phase::NeedsModel => Some(wire::ChatModelStep {
                size_line: if self.model_bytes() > 0 {
                    fill(
                        &words::size_line(locale),
                        &[("size", &size_text(self.model_bytes()))],
                    )
                } else {
                    String::new()
                },
                note_line: words::download_note(locale),
                action_label: words::download_action(locale),
                ..wire::ChatModelStep::default()
            }),
            Phase::Downloading => Some(wire::ChatModelStep {
                progress_known: self.progress.is_some(),
                progress: self.progress.unwrap_or(0.0),
                status_line: percent(locale, self.progress),
                ..wire::ChatModelStep::default()
            }),
            Phase::Loading => Some(wire::ChatModelStep {
                status_line: words::loading(locale),
                ..wire::ChatModelStep::default()
            }),
            Phase::Unavailable => Some(wire::ChatModelStep {
                status_line: words::unavailable(locale),
                ..wire::ChatModelStep::default()
            }),
            _ => None,
        }
    }

    fn model_bytes(&self) -> u64 {
        super::asset::MODEL.bytes
    }

    fn vision_step(&self, locale: Locale) -> Option<wire::ChatModelStep> {
        if self.phase != Phase::Ready {
            return None;
        }
        match self.vision.phase {
            VisionPhase::Needs if self.wants_reader() => Some(wire::ChatModelStep {
                size_line: fill(
                    &words::vision_line(locale),
                    &[("size", &size_text(self.vision_bytes()))],
                ),
                action_label: words::vision_action(locale),
                status_line: self
                    .vision
                    .error
                    .map(|fail| self.fail_line(fail, locale))
                    .unwrap_or_default(),
                ..wire::ChatModelStep::default()
            }),
            VisionPhase::Downloading => Some(wire::ChatModelStep {
                progress_known: self.vision.progress.is_some(),
                progress: self.vision.progress.unwrap_or(0.0),
                status_line: percent(locale, self.vision.progress),
                ..wire::ChatModelStep::default()
            }),
            VisionPhase::Loading => Some(wire::ChatModelStep {
                status_line: words::vision_loading(locale),
                ..wire::ChatModelStep::default()
            }),
            _ => None,
        }
    }

    /// A Retry sends the last question's attachments again, and a stored one that cannot be sent
    /// (a camera-roll image kept only as a thumbnail, a photo since deleted) would be dropped from
    /// the answer without a word. So the question can be asked again only when everything it
    /// carried still can.
    fn retry_loses_an_attachment(&self) -> bool {
        self.messages
            .iter()
            .rev()
            .find(|message| message.user)
            .is_some_and(|message| {
                message
                    .attachments
                    .iter()
                    .any(|held| held.source == super::model::Source::Unavailable)
            })
    }

    fn thread_item(&self, row: &Row, locale: Locale) -> wire::ChatThreadItem {
        let current = row.id == self.thread_id;
        let ago = when::ago(locale, row.updated_ms, self.now_ms);
        let accessibility = [
            row.title.clone(),
            ago.clone(),
            if current {
                words::current_chat(locale)
            } else {
                String::new()
            },
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
        wire::ChatThreadItem {
            thread_id: row.id.clone(),
            title: row.title.clone(),
            ago,
            current,
            accessibility_label: accessibility,
        }
    }

    pub(super) fn render(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        // THE DRAWER SHOWS THE CHATS A SEARCH FOUND while a term is answered, and the plain list
        // otherwise.
        let searching =
            self.found.is_some() && self.search.open && !self.search.answered.trim().is_empty();
        let shown: &[Row] = if searching {
            self.found.as_deref().unwrap_or_default()
        } else {
            &self.threads
        };
        let ready = self.phase == Phase::Ready;
        let empty = self.messages.is_empty();
        let title = self
            .threads
            .iter()
            .find(|row| row.id == self.thread_id)
            .map(|row| row.title.clone())
            .unwrap_or_else(|| self.thread_title.clone());
        let corrected = self.search.corrected.clone();
        let state = wire::ChatState {
            phase: self.phase as i32,
            title: if title.is_empty() {
                words::new_chat(locale)
            } else {
                title
            },
            subtitle: if self.vault_name.is_empty() {
                words::subtitle(locale)
            } else {
                fill(
                    &words::subtitle_vault(locale),
                    &[("vault", &self.vault_name)],
                )
            },
            scope_app: self.scope.clone(),
            messages: if ready {
                self.messages
                    .iter()
                    .map(|message| self.message(message, locale))
                    .collect()
            } else {
                Vec::new()
            },
            empty_line: if ready && empty {
                words::empty_line(locale)
            } else {
                String::new()
            },
            suggestions: if ready && empty {
                self.suggestions.clone()
            } else {
                Vec::new()
            },
            streaming: ready && self.running,
            activity: if ready && self.running {
                self.activity.clone()
            } else {
                String::new()
            },
            error: self
                .error
                .map(|fail| self.fail_line(fail, locale))
                .unwrap_or_default(),
            model_step: self.model_step(locale),
            composer_placeholder: words::composer_placeholder(locale),
            send_label: words::send(locale),
            stop_label: words::stop(locale),
            new_chat_label: words::new_chat(locale),
            retry_label: words::retry(locale),
            copy_label: words::copy(locale),
            can_retry: ready
                && !self.running
                && self.asked.is_some()
                && !empty
                && !self.retry_loses_an_attachment(),
            can_new_chat: ready && (!empty || !self.thread_id.is_empty()),
            pending: if ready {
                self.pending
                    .iter()
                    .map(|held| attachment(held, locale))
                    .collect()
            } else {
                Vec::new()
            },
            can_attach: ready && self.can_attach(),
            attach_label: words::attach(locale),
            attach_vault_photo_label: words::attach_vault_photo(locale),
            attach_library_photo_label: words::attach_library_photo(locale),
            attach_document_label: words::attach_document(locale),
            remove_attachment_label: words::remove_attachment(locale),
            vision_step: self.vision_step(locale),
            vision_blocked: ready && self.vision_blocked(),
            drawer_open: self.drawer_open,
            threads: shown
                .iter()
                .map(|row| self.thread_item(row, locale))
                .collect(),
            threads_empty_line: if searching && shown.is_empty() {
                fill(
                    &words::drawer_search_no_match(locale),
                    &[("term", &self.search.answered)],
                )
            } else if shown.is_empty() {
                words::threads_empty(locale)
            } else {
                String::new()
            },
            thread_id: self.thread_id.clone(),
            can_manage_thread: !self.thread_id.is_empty() && !self.running,
            drawer_label: words::drawer_label(locale),
            menu_label: words::menu_label(locale),
            rename_label: words::rename(locale),
            delete_label: words::delete(locale),
            delete_all_label: words::delete_all(locale),
            cancel_label: words::cancel(locale),
            save_label: words::save(locale),
            rename_title: words::rename_title(locale),
            delete_title: words::delete_title(locale),
            delete_body: words::delete_body(locale),
            delete_all_title: words::delete_all_title(locale),
            delete_all_body: words::delete_all_body(locale),
            card_gone_line: if self.card_gone {
                words::card_gone(locale)
            } else {
                String::new()
            },
            current_label: words::current_chat(locale),
            drawer_search: Some(wire::ChatDrawerSearch {
                open: self.search.open,
                term: self.search.term.clone(),
                corrected_label: if corrected.is_empty() {
                    String::new()
                } else {
                    crate::kit::search::corrected(locale, &corrected)
                },
                corrected,
            }),
            drawer_search_placeholder: words::drawer_search_placeholder(locale),
            can_delete_all: !searching && !self.threads.is_empty(),
            attach_photo_route: Some(crate::photos::routes::attach_picker()),
            document_sheet: Some(wire::ChatDocumentSheet {
                open: self.sheet.open,
                title: words::attach_pick_document(locale),
                empty_line: words::attach_no_documents(locale),
                loaded: self.sheet.loaded,
                rows: self
                    .sheet
                    .rows
                    .iter()
                    .map(|document| wire::ChatDocumentRow {
                        doc_id: document.doc_id.clone(),
                        title: document.title.clone(),
                        subtitle: document.updated_at.chars().take(10).collect(),
                    })
                    .collect(),
            }),
            close_label: words::close(locale),
            copied_label: words::copied(locale),
            scope_all_label: words::scope_all(locale),
            scope_label: words::scope_label(locale),
            scopes: super::scopable_apps()
                .into_iter()
                .map(|app| wire::ChatScopeOption {
                    app: app.to_owned(),
                    name: super::turn::app_name(app),
                })
                .collect(),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Chat(Box::new(state))),
            ..wire::ViewState::default()
        }
    }

    fn message(&self, message: &Msg, locale: Locale) -> wire::ChatMessage {
        let mut label = if message.user {
            words::a11y_you(locale)
        } else {
            words::a11y_answer(locale)
        };
        if !message.text.is_empty() {
            label.push_str(": ");
            label.push_str(&spoken(&message.text));
        }
        for held in &message.attachments {
            label.push_str(". ");
            label.push_str(&words::a11y_attached(locale));
            label.push_str(": ");
            label.push_str(&attachment_label(held, locale));
        }
        if message.stopped {
            label.push_str(". ");
            label.push_str(&words::stopped(locale));
        }
        wire::ChatMessage {
            id: message.id,
            role: if message.user {
                wire::chat_message::Role::User
            } else {
                wire::chat_message::Role::Assistant
            } as i32,
            text: message.text.clone(),
            cards: message.cards.clone(),
            streaming: message.streaming,
            accessibility_label: label,
            attachments: message
                .attachments
                .iter()
                .map(|held| attachment(held, locale))
                .collect(),
            note: if message.truncated {
                words::note_doc_truncated(locale)
            } else {
                String::new()
            },
            pending: message.proposal.as_ref().map(|held| proposal(held, locale)),
        }
    }
}

fn attachment_label(held: &Pending, locale: Locale) -> String {
    if !held.label.is_empty() {
        held.label.clone()
    } else if held.photo {
        words::chip_photo(locale)
    } else {
        words::chip_document(locale)
    }
}

fn attachment(held: &Pending, locale: Locale) -> wire::ChatAttachment {
    wire::ChatAttachment {
        id: held.id,
        kind: if held.photo {
            wire::chat_attachment::Kind::Photo
        } else {
            wire::chat_attachment::Kind::Document
        } as i32,
        label: attachment_label(held, locale),
        thumbnail_path: held.thumbnail_path.clone(),
    }
}

/// A parked write, as the card the view draws. The labels are the copy's: the view owns no word.
fn proposal(held: &Proposal, locale: Locale) -> wire::ChatPending {
    use wire::chat_pending::State;
    let more = if held.more > 0 {
        words::more_steps(locale, u64::from(held.more))
    } else {
        String::new()
    };
    let mut parts = vec![words::a11y_proposal(locale)];
    if held.destructive {
        parts.push(words::a11y_destructive(locale));
    }
    parts.extend(held.steps.iter().map(|step| step.summary.clone()));
    if !more.is_empty() {
        parts.push(more.clone());
    }
    if !held.line.is_empty() {
        parts.push(held.line.clone());
    }
    wire::ChatPending {
        pending_id: held.id.clone(),
        state: match held.stage {
            Stage::Waiting => State::Waiting,
            Stage::Working => State::Working,
            Stage::Applied => State::Applied,
            Stage::NotDone => State::NotDone,
            Stage::Stale => State::Stale,
            Stage::Inert => State::Inert,
        } as i32,
        steps: held
            .steps
            .iter()
            .map(|step| wire::ChatPendingStep {
                summary: step.summary.clone(),
                destructive: step.destructive,
            })
            .collect(),
        more_line: more,
        confirm_label: words::confirm(locale),
        cancel_label: words::cancel(locale),
        destructive: held.destructive,
        settled_line: held.line.clone(),
        accessibility_label: parts.join(". "),
    }
}
