//! The finished state the shells draw: every label, count and line is made here.

use centraid_api_proto::core_v1 as wire;
use wire::chat_event::device_facts::Network;
use wire::chat_state::Phase;

use super::model::{Chat, Msg, Pending, Proposal, Row, Stage, VisionPhase};
use super::when;
use crate::kit::quantity::{Quantity, UnitsPref};
use crate::screen::Ctx;
use crate::strings::{Locale, chat as words, fill};

fn size_text(bytes: u64) -> String {
    if bytes == 0 {
        return String::new();
    }
    Quantity::bytes(i64::try_from(bytes).unwrap_or(i64::MAX)).words(Locale::En, UnitsPref::Metric)
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
            Phase::NeedsModel if self.too_little_memory() => Some(self.unavailable_step(locale)),
            Phase::NeedsModel => Some(self.needs_step(locale)),
            Phase::Downloading => {
                let waiting = self.waiting_for_wifi();
                Some(wire::ChatModelStep {
                    progress_known: self.progress.is_some(),
                    progress: self.progress.unwrap_or(0.0),
                    status_line: percent(locale, self.progress),
                    title: if waiting {
                        words::waiting_wifi(locale)
                    } else {
                        String::new()
                    },
                    note_line: if waiting {
                        words::waiting_wifi_note(locale)
                    } else {
                        words::downloading_note(locale)
                    },
                    secondary_label: if waiting {
                        words::use_mobile_data_rest(locale)
                    } else {
                        String::new()
                    },
                    secondary_kind: if waiting {
                        wire::ChatStepAction::DownloadCellular as i32
                    } else {
                        0
                    },
                    ..wire::ChatModelStep::default()
                })
            }
            Phase::Loading => Some(wire::ChatModelStep {
                status_line: words::loading(locale),
                ..wire::ChatModelStep::default()
            }),
            Phase::Unavailable => Some(self.unavailable_step(locale)),
            // CHECKING SAYS WHAT IT LOOKS AT, not a blank page (#1188 C12).
            Phase::Checking => Some(wire::ChatModelStep {
                title: words::checking_title(locale),
                note_line: words::checking_body(locale),
                ..wire::ChatModelStep::default()
            }),
            _ => None,
        }
    }

    /// CHAT CANNOT RUN HERE, and why when the phone said: too little memory, in the board's words.
    fn unavailable_step(&self, locale: Locale) -> wire::ChatModelStep {
        if self.too_little_memory() {
            return wire::ChatModelStep {
                title: words::unavailable_title(locale),
                note_line: fill(
                    &words::unavailable_memory(locale),
                    &[("have", &size_text(self.memory_bytes))],
                ),
                ..wire::ChatModelStep::default()
            };
        }
        wire::ChatModelStep {
            status_line: words::unavailable(locale),
            ..wire::ChatModelStep::default()
        }
    }

    /// The download is going, but this phone is on mobile data (or offline) and the member has not
    /// allowed it: the shell holds the transfer until Wi-Fi comes.
    fn waiting_for_wifi(&self) -> bool {
        !self.cellular_ok && matches!(self.network, Network::Cellular | Network::Offline)
    }

    /// THE STEP BEFORE A DOWNLOAD, by what the phone says: not enough space says so and offers a
    /// look again; on mobile data it asks first; otherwise it offers Wi-Fi, and mobile data as the
    /// second choice. The photo reader's own download is named, so the first is not "the only one".
    fn needs_step(&self, locale: Locale) -> wire::ChatModelStep {
        let bytes = self.model_bytes();
        let size = size_text(bytes);
        let size_line = if bytes > 0 {
            fill(&words::size_line(locale), &[("size", &size)])
        } else {
            String::new()
        };
        if self.too_little_space(bytes) {
            return wire::ChatModelStep {
                size_line,
                title: words::low_space_title(locale),
                note_line: fill(
                    &words::low_space_body(locale),
                    &[
                        ("need", &size),
                        ("free", &size_text(self.free_bytes)),
                        ("short", &size_text(bytes - self.free_bytes)),
                    ],
                ),
                action_label: words::check_again(locale),
                action_kind: wire::ChatStepAction::CheckAgain as i32,
                ..wire::ChatModelStep::default()
            };
        }
        if self.network == Network::Cellular && !self.cellular_ok {
            return wire::ChatModelStep {
                size_line,
                title: words::mobile_data_title(locale),
                note_line: fill(&words::mobile_data_body(locale), &[("size", &size)]),
                action_label: words::download_now(locale),
                action_kind: wire::ChatStepAction::DownloadCellular as i32,
                secondary_label: words::wait_wifi(locale),
                secondary_kind: wire::ChatStepAction::WaitWifi as i32,
                ..wire::ChatModelStep::default()
            };
        }
        wire::ChatModelStep {
            size_line,
            note_line: words::download_note(locale),
            extra_line: fill(
                &words::download_photo_note(locale),
                &[("size", &size_text(super::asset::VISION.bytes))],
            ),
            action_label: words::download_action(locale),
            action_kind: wire::ChatStepAction::Download as i32,
            secondary_label: words::use_mobile_data(locale),
            secondary_kind: wire::ChatStepAction::DownloadCellular as i32,
            ..wire::ChatModelStep::default()
        }
    }

    fn model_bytes(&self) -> u64 {
        super::asset::model().bytes
    }

    fn vision_step(&self, locale: Locale) -> Option<wire::ChatModelStep> {
        if self.phase != Phase::Ready {
            return None;
        }
        match self.vision.phase {
            // THE PHOTO READER'S SHEET (ChatPhotoDownload.dc.html): Wi-Fi is the first choice, mobile
            // data an explicit second, Not now takes the photo off. A tap on the offer is never the
            // member's word for mobile data.
            VisionPhase::Needs if self.wants_reader() => {
                let size = size_text(self.vision_bytes());
                Some(wire::ChatModelStep {
                    size_line: fill(&words::vision_line(locale), &[("size", &size)]),
                    title: words::photo_reader_title(locale),
                    note_line: fill(&words::photo_reader_body(locale), &[("size", &size)]),
                    action_label: words::download_action(locale),
                    action_kind: wire::ChatStepAction::Download as i32,
                    secondary_label: words::use_mobile_data(locale),
                    secondary_kind: wire::ChatStepAction::DownloadCellular as i32,
                    tertiary_label: words::not_now(locale),
                    tertiary_kind: wire::ChatStepAction::NotNow as i32,
                    status_line: self
                        .vision
                        .error
                        .map(|fail| self.fail_line(fail, locale))
                        .unwrap_or_default(),
                    ..wire::ChatModelStep::default()
                })
            }
            VisionPhase::Downloading => {
                let waiting = !self.vision.cellular_ok
                    && matches!(self.network, Network::Cellular | Network::Offline);
                Some(wire::ChatModelStep {
                    progress_known: self.vision.progress.is_some(),
                    progress: self.vision.progress.unwrap_or(0.0),
                    status_line: percent(locale, self.vision.progress),
                    title: if waiting {
                        words::waiting_wifi(locale)
                    } else {
                        String::new()
                    },
                    secondary_label: if waiting {
                        words::use_mobile_data_rest(locale)
                    } else {
                        String::new()
                    },
                    secondary_kind: if waiting {
                        wire::ChatStepAction::DownloadCellular as i32
                    } else {
                        0
                    },
                    ..wire::ChatModelStep::default()
                })
            }
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
    pub(super) fn retry_loses_an_attachment(&self) -> bool {
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
                let editable = self.editable().filter(|_| !self.editing);
                self.messages
                    .iter()
                    .enumerate()
                    .map(|(at, message)| {
                        let mut drawn = self.message(message, locale);
                        drawn.can_edit = editable == Some(at);
                        drawn
                    })
                    .collect()
            } else {
                Vec::new()
            },
            empty_line: if ready && empty {
                words::empty_line(locale)
            } else {
                String::new()
            },
            suggestions: if ready && !self.running {
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
            edit_label: words::edit(locale),
            editing: ready && self.editing,
            edit_text: if ready && self.editing {
                self.messages
                    .iter()
                    .rfind(|message| message.user)
                    .map(|message| message.text.clone())
                    .unwrap_or_default()
            } else {
                String::new()
            },
            edit_token: self.edit_token,
            editing_title: words::editing_title(locale),
            editing_body: words::editing_body(locale),
            cancel_edit_label: words::cancel_edit(locale),
            dictate_label: words::dictate(locale),
            listening_label: words::listening(locale),
            dictation_off_label: words::dictation_off(locale),
            latest_label: words::latest(locale),
            jump_to_latest_label: words::jump_to_latest(locale),
            can_retry: ready
                && !self.running
                && self.asked.is_some()
                && !empty
                && !self.retry_loses_an_attachment(),
            // NEW CHAT is the pencil, drawn only inside a chat already saved: a fresh conversation
            // has nothing to start over from.
            can_new_chat: ready && !self.thread_id.is_empty(),
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
            accepted_send: self.accepted_send,
            threads_error: if self.threads_error {
                words::error_thread_write(locale)
            } else {
                String::new()
            },
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
        let mark = if message.failed {
            words::did_not_finish(locale)
        } else if message.stopped {
            words::stopped(locale)
        } else {
            String::new()
        };
        if !mark.is_empty() {
            label.push_str(". ");
            label.push_str(&mark);
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
            can_edit: false,
            mark,
            mark_failed: message.failed,
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
    parts.extend(held.steps.iter().filter_map(|step| {
        let said = if step.summary.is_empty() {
            &step.title
        } else {
            &step.summary
        };
        (!said.is_empty()).then(|| said.clone())
    }));
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
                title: step.title.clone(),
                subtitle: if step.title.is_empty() {
                    String::new()
                } else if !step.changes.is_empty() {
                    step.changes.clone()
                } else {
                    super::confirm::subtitle(step.noun, &step.when, locale)
                },
            })
            .collect(),
        more_line: more,
        title: words::proposal_title(locale),
        app: held.app().to_owned(),
        confirm_label: super::confirm::label(
            held.steps.iter().map(|step| (step.verb, step.noun)),
            locale,
        ),
        cancel_label: words::not_now(locale),
        destructive: held.destructive,
        settled_line: held.line.clone(),
        undo: held.undo.iter().filter_map(|undo| undo.status()).collect(),
        accessibility_label: parts.join(". "),
    }
}
