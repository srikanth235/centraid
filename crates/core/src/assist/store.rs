//! A TURN, SAVED — AND A THREAD, BROUGHT BACK (R-CHAT-1).
//!
//! The plane (`crates/assist`) holds no vault and the session is memory: what
//! the member said and was told is the vault's. This module is the join. At the
//! end of every turn [`save`] writes it through the `chat.save_turn` command —
//! the one writer, so a conversation is receipted, captured and backed up like
//! any other row — and [`reopen`] reads a stored thread back into a
//! [`Session`], so a follow-up is routed as it would have been had the app
//! never closed.
//!
//! # WHAT IS SAVED, AND WHAT IS LOST ON A CRASH
//!
//! A COMPLETED turn is one commit: the question, the answer (or the refusal the
//! member was shown, or the words drawn before a stop), its cards and its
//! attachments. A turn that is still running when the process dies is lost
//! WHOLE and never kept half: the save happens after the plane returns, so
//! there is no moment at which the vault holds a question with no answer. That
//! is deliberate. A half-written turn would be a stored message the member
//! never saw finish, and a restart that shows a question with an empty answer is
//! worse than one that shows the chat as it last stood.
//!
//! # A PROPOSAL KEEPS ITS LIFE (#1088)
//!
//! A native turn that ends in a write parked behind a confirm card is saved with the outcome
//! `proposed` ([`answered_word`]) and the proposal's own words. The pending write is memory
//! (R-1088-10); the vault keeps only how the card ended. [`settle`] records it through
//! `chat.settle_proposal` when the member taps (`applied`, `stale` or `failed`, with the line they
//! were told) or dismisses (`dismissed`), so a thread reopened later reads the settled line and
//! not a question the member had already answered. A card nobody answered is dismissed by the next
//! turn saved into its thread, inside `chat.save_turn` itself.
//!
//! # NOTHING HERE LETS A PICTURE INTO THE VAULT
//!
//! A vault photograph or document is saved as the reference it is. A camera-roll
//! image is saved as a thumbnail of at most [`THUMBNAIL_EDGE`] pixels, made from
//! the pixels the model was shown; the picture itself never is.

use std::io::Cursor;

use base64::Engine as _;
use centraid_api_proto::core_v1 as wire;
use centraid_assist::attach::ImageData;
use centraid_assist::native::park::Confirmed;
use centraid_assist::native_turn::words::{Say, say_with};
use centraid_assist::prompt::Turn;
use centraid_assist::{App, Attachments, Card, Notice, Refusal, Session};

use crate::handle::Handle;

/// The long edge of a stored thumbnail, in pixels.
pub const THUMBNAIL_EDGE: u32 = 256;

/// How many stored turns a reopened session is rebuilt from. The prompt shows
/// only its last two, so more is for the Retry that drops one and the router
/// that skips a refusal.
const REHYDRATE_TURNS: usize = 8;

/// What a saved attachment names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentRef {
    /// `photo`, `document` or `image`.
    pub kind: &'static str,
    pub label: String,
    pub asset_id: Option<String>,
    pub document_id: Option<String>,
    /// A `data:` URI of the stored thumbnail, for an `image`.
    pub thumbnail: Option<String>,
}

/// What the member was told, as it is saved.
#[derive(Debug, Clone, Default)]
pub struct Said {
    /// `answered`, `stopped` or `refused`.
    pub outcome: &'static str,
    pub text: String,
    pub refusal: Option<&'static str>,
    pub notice: Option<&'static str>,
    pub cards: Vec<Card>,
}

/// Where a turn went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Saved {
    pub thread_id: String,
    pub title: String,
}

/// The refusal word the schema stores, or `None` for the one that is not saved:
/// a turn that never started because another was running.
#[must_use]
pub const fn refusal_word(refusal: &Refusal) -> Option<&'static str> {
    Some(match refusal {
        Refusal::NoToolFits => "no_tool_fits",
        Refusal::QueryFailed(_) => "query_failed",
        Refusal::Unparsable(_) => "unparsable",
        Refusal::ModelAbsent => "model_absent",
        Refusal::ModelFailed(_) => "model_failed",
        Refusal::VisionAbsent => "vision_absent",
        Refusal::AttachmentUnsupported => "attachment_unsupported",
        Refusal::AttachmentUnreadable => "attachment_unreadable",
        Refusal::AttachmentTooLarge => "attachment_too_large",
        Refusal::Cancelled | Refusal::Busy => return None,
    })
}

/// The notice word the schema stores.
#[must_use]
pub fn notice_word(notices: &[Notice]) -> Option<&'static str> {
    notices.first().map(|notice| match notice {
        Notice::DocTruncated => "doc_truncated",
    })
}

/// The outcome word a turn's answer is saved as: `proposed` when the turn ended in a write that
/// waits for the member's tap, else `answered`.
#[must_use]
pub const fn answered_word(parked: bool) -> &'static str {
    if parked { "proposed" } else { "answered" }
}

/// How a tap ended, as the schema stores it (rung twelve): `None` for a tap on a card that was not
/// waiting, which changes nothing and so records nothing.
#[must_use]
pub const fn settled_word(outcome: &Confirmed) -> Option<&'static str> {
    match outcome {
        Confirmed::Done { .. } => Some("applied"),
        Confirmed::Stale { .. } => Some("stale"),
        Confirmed::Refused { .. } => Some("failed"),
        Confirmed::Unknown => None,
    }
}

/// The line a dismissed proposal keeps: the sentence a dismissal answers with, `Not done.`
/// (`SAID_NOT_DONE` with no reason to give).
#[must_use]
pub fn dismissed_text() -> String {
    say_with(Say::NotDone, &[("reason", "")])
        .trim_end()
        .to_owned()
}

/// A thumbnail of the pixels the model read, as a `data:` URI.
///
/// Made from the decoded image the plane already holds (448 pixels on its long
/// edge at most), so nothing is decoded twice and the original never is read
/// again. `None` when the pixels will not encode, which loses the thumbnail and
/// nothing else.
#[must_use]
pub fn thumbnail_uri(image: &ImageData) -> Option<String> {
    let buffer = image::RgbImage::from_raw(image.width, image.height, image.rgb.clone())?;
    let picture = image::DynamicImage::ImageRgb8(buffer);
    let scaled = if picture.width().max(picture.height()) > THUMBNAIL_EDGE {
        picture.thumbnail(THUMBNAIL_EDGE, THUMBNAIL_EDGE)
    } else {
        picture
    };
    let mut jpeg = Vec::new();
    scaled
        .to_rgb8()
        .write_to(&mut Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
        .ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(jpeg)
    ))
}

/// What a request's attachments save as, named by the request and not by what
/// resolved: a refused attachment is still the one the member attached.
///
/// `resolved` is what the plane read (its pixels make the thumbnail of a
/// camera-roll image); `None` when nothing resolved.
#[must_use]
pub fn refs_of(
    attachments: &[wire::AssistAttachment],
    resolved: Option<&Attachments>,
) -> Vec<AttachmentRef> {
    attachments
        .iter()
        .filter_map(|attachment| {
            let label = attachment.label.clone();
            match attachment.kind.as_ref()? {
                wire::assist_attachment::Kind::VaultPhoto(photo) => Some(AttachmentRef {
                    kind: "photo",
                    label,
                    asset_id: Some(photo.asset_id.clone()),
                    document_id: None,
                    thumbnail: None,
                }),
                wire::assist_attachment::Kind::VaultDoc(doc) => Some(AttachmentRef {
                    kind: "document",
                    label,
                    asset_id: None,
                    document_id: Some(doc.doc_id.clone()),
                    thumbnail: None,
                }),
                wire::assist_attachment::Kind::ImageBytes(_) => Some(AttachmentRef {
                    kind: "image",
                    label,
                    asset_id: None,
                    document_id: None,
                    thumbnail: resolved
                        .and_then(|held| held.image.as_ref())
                        .and_then(thumbnail_uri),
                }),
            }
        })
        .collect()
}

fn attachment_json(attachment: &AttachmentRef) -> serde_json::Value {
    let mut out = serde_json::json!({ "kind": attachment.kind, "label": attachment.label });
    if let Some(id) = &attachment.asset_id {
        out["asset_id"] = serde_json::json!(id);
    }
    if let Some(id) = &attachment.document_id {
        out["document_id"] = serde_json::json!(id);
    }
    if let Some(uri) = &attachment.thumbnail {
        out["thumbnail_data_uri"] = serde_json::json!(uri);
    }
    out
}

/// Everything one save needs.
pub struct Turned<'a> {
    pub key: &'a str,
    /// The thread this chat already saves into, if it has one.
    pub thread: Option<&'a str>,
    /// The turn replaces the thread's last one (a retry).
    pub replace_last: bool,
    pub scope: Option<App>,
    pub question: &'a str,
    pub attachments: &'a [AttachmentRef],
    pub said: &'a Said,
    /// The assistant's routing record, when the plane kept one.
    pub record: Option<&'a Turn>,
}

fn command_input(turned: &Turned<'_>, thread: Option<&str>, replace: bool) -> serde_json::Value {
    let mut answer = serde_json::json!({
        "outcome": turned.said.outcome,
        "text": turned.said.text,
        "cards": turned.said.cards.iter().map(|card| {
            let mut out = serde_json::json!({
                "app": card.app.id(), "entity": card.entity, "id": card.id, "title": card.title,
            });
            for (key, value) in [
                ("qualifier", &card.qualifier),
                ("subtitle", &card.subtitle),
                ("meta", &card.meta),
            ] {
                if !value.is_empty() {
                    out[key] = serde_json::json!(value);
                }
            }
            out
        }).collect::<Vec<_>>(),
    });
    if let Some(word) = turned.said.refusal {
        answer["refusal"] = serde_json::json!(word);
    }
    if let Some(word) = turned.said.notice {
        answer["notice"] = serde_json::json!(word);
    }
    if let Some(record) = turned.record {
        answer["record_json"] = serde_json::json!(record.to_json());
    }
    let mut question = serde_json::json!({ "text": turned.question });
    if !turned.attachments.is_empty() {
        question["attachments"] = turned.attachments.iter().map(attachment_json).collect();
    }
    let mut input = serde_json::json!({ "turn": { "question": question, "answer": answer } });
    if let Some(thread) = thread {
        input["thread_id"] = serde_json::json!(thread);
        if replace {
            input["replace_last"] = serde_json::json!(true);
        }
    } else if let Some(scope) = turned.scope {
        input["scope_app"] = serde_json::json!(scope.id());
    }
    input
}

fn run(
    handle: &Handle,
    turned: &Turned<'_>,
    thread: Option<&str>,
    replace: bool,
    key: &str,
) -> Option<Saved> {
    let input = serde_json::to_vec(&command_input(turned, thread, replace)).ok()?;
    let command = wire::Command {
        name: "chat.save_turn".to_owned(),
        input,
        invoke_key: key.to_owned(),
        ..wire::Command::default()
    };
    let changes = crate::events::ChangeFeed::new(handle.events());
    let outcome = handle
        .with_vault(|vault| {
            crate::api::invoke(
                vault,
                handle.registry(),
                &handle.owner(),
                &command,
                &changes,
            )
        })
        .map_err(|error| tracing::warn!("a chat turn could not be saved: {error}"))
        .ok()?;
    if outcome.status != wire::CommandStatus::Executed as i32 {
        tracing::warn!("a chat turn was not saved: {}", outcome.reason);
        return None;
    }
    let output: serde_json::Value = serde_json::from_slice(&outcome.output).ok()?;
    Some(Saved {
        thread_id: output.get("thread_id")?.as_str()?.to_owned(),
        title: output
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    })
}

/// Save one turn, and say where it went. `None` when it could not be saved,
/// which loses the history of the turn and nothing else: the member still has
/// the answer on screen.
///
/// A thread the chat names that is no longer there (deleted from another place
/// while this chat was open) starts a NEW thread rather than losing the turn.
#[must_use]
pub fn save(handle: &Handle, turned: &Turned<'_>) -> Option<Saved> {
    if let Some(saved) = run(
        handle,
        turned,
        turned.thread,
        turned.replace_last,
        turned.key,
    ) {
        return Some(saved);
    }
    // A retry names the first attempt's key, so the second needs its own.
    turned.thread.and_then(|_| {
        run(
            handle,
            turned,
            None,
            false,
            &format!("{}:fresh", turned.key),
        )
    })
}

/// Record how a chat's waiting proposal ended, and the line the member was told for it. `false`
/// when it could not be recorded, which loses the history of the tap and nothing else: the member
/// has the answer on screen, and the card is settled in memory whatever the vault said.
fn settle(handle: &Handle, thread: &str, key: &str, outcome: &str, text: &str) -> bool {
    // A CARD TAPPED TWICE SETTLES ONCE, and the second tap writes nothing and tells no screen
    // anything: only a thread whose last answer is a proposal nobody has settled is written to.
    if !handle
        .with_vault(|vault| Ok(vault.chat_proposal_waiting(thread)?))
        .unwrap_or(false)
    {
        return false;
    }
    let input = serde_json::json!({ "thread_id": thread, "outcome": outcome, "text": text });
    let Ok(input) = serde_json::to_vec(&input) else {
        return false;
    };
    let command = wire::Command {
        name: "chat.settle_proposal".to_owned(),
        input,
        invoke_key: key.to_owned(),
        ..wire::Command::default()
    };
    let changes = crate::events::ChangeFeed::new(handle.events());
    let ran = handle
        .with_vault(|vault| {
            crate::api::invoke(
                vault,
                handle.registry(),
                &handle.owner(),
                &command,
                &changes,
            )
        })
        .map_err(|error| tracing::warn!("a proposal could not be settled: {error}"))
        .ok();
    match ran {
        Some(outcome) if outcome.status == wire::CommandStatus::Executed as i32 => true,
        Some(outcome) => {
            tracing::warn!("a proposal was not settled: {}", outcome.reason);
            false
        }
        None => false,
    }
}

/// Settle the proposal a chat's last saved turn parked: nothing when that turn never reached the
/// vault (a failed save leaves the thread's last turn some earlier one, which is not a proposal).
pub(super) fn settle_slot(
    handle: &Handle,
    slot: &super::Slot,
    pending_id: &str,
    outcome: &str,
    text: &str,
) -> bool {
    if !slot.last_saved.load(std::sync::atomic::Ordering::SeqCst) {
        return false;
    }
    let Some(thread) = super::locked(&slot.thread).clone() else {
        return false;
    };
    settle(
        handle,
        &thread,
        &format!("chat.settle_proposal:{pending_id}:{outcome}"),
        outcome,
        text,
    )
}

/// A stored thread, as a session and its scope.
pub struct Reopened {
    pub session: Session,
    pub scope: Option<App>,
    pub title: String,
}

/// Rebuild a session from a stored thread. `None` when there is no such thread.
///
/// # Errors
/// [`crate::error::CoreError`] when the vault will not read.
pub fn reopen(handle: &Handle, thread_id: &str) -> crate::error::Result<Option<Reopened>> {
    handle.with_vault(|vault| {
        let Some(stored) = vault.chat_thread(thread_id)? else {
            return Ok(None);
        };
        let scope = stored.thread.scope_app.as_deref().and_then(App::from_id);
        let history: Vec<Turn> = vault
            .chat_history(thread_id, REHYDRATE_TURNS)?
            .iter()
            .filter_map(|turn| Turn::from_json(turn.record_json.as_deref()?))
            .collect();
        let last_question = vault.chat_last_question(thread_id)?;
        Ok(Some(Reopened {
            session: Session::restore(scope, history, last_question),
            scope,
            title: stored.thread.title,
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgb(width: u32, height: u32) -> ImageData {
        ImageData {
            width,
            height,
            rgb: (0..width * height * 3).map(|n| (n % 251) as u8).collect(),
            label: String::new(),
        }
    }

    #[test]
    fn a_thumbnail_is_a_small_jpeg_no_larger_than_its_edge() {
        let uri = thumbnail_uri(&rgb(448, 336)).expect("it encodes");
        let encoded = uri
            .strip_prefix("data:image/jpeg;base64,")
            .expect("a jpeg data uri");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("base64");
        assert_eq!(&bytes[..2], &[0xff, 0xd8], "a JPEG");
        let decoded = image::load_from_memory(&bytes).expect("it decodes");
        assert_eq!(decoded.width().max(decoded.height()), THUMBNAIL_EDGE);
        assert_eq!((decoded.width(), decoded.height()), (256, 192));
        assert!(
            bytes.len() < 60_000,
            "a thumbnail, not a picture: {}",
            bytes.len()
        );
    }

    #[test]
    fn a_small_picture_is_not_blown_up() {
        let uri = thumbnail_uri(&rgb(64, 48)).expect("it encodes");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(uri.trim_start_matches("data:image/jpeg;base64,"))
            .unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (64, 48));
    }

    #[test]
    fn pixels_that_do_not_add_up_have_no_thumbnail() {
        let mut broken = rgb(10, 10);
        broken.rgb.truncate(5);
        assert_eq!(thumbnail_uri(&broken), None);
    }

    #[test]
    fn every_way_a_tap_ends_has_its_stored_word_but_a_card_that_was_not_waiting() {
        let done = Confirmed::Done {
            text: String::new(),
            diff: serde_json::json!({}),
            steps: 1,
        };
        let refused = Confirmed::Refused {
            step: 0,
            command: "schedule.set_task_status".to_owned(),
            predicate: "task_exists".to_owned(),
            reason: "That task is gone.".to_owned(),
            landed: 0,
        };
        assert_eq!(settled_word(&done), Some("applied"));
        assert_eq!(
            settled_word(&Confirmed::Stale { rows: Vec::new() }),
            Some("stale")
        );
        assert_eq!(settled_word(&refused), Some("failed"));
        assert_eq!(settled_word(&Confirmed::Unknown), None);
    }

    #[test]
    fn a_parked_turn_is_proposed_and_every_other_answer_is_answered() {
        assert_eq!(answered_word(true), "proposed");
        assert_eq!(answered_word(false), "answered");
    }

    #[test]
    fn a_dismissal_keeps_the_sentence_it_answered_with() {
        assert_eq!(dismissed_text(), "Not done.");
    }

    #[test]
    fn a_busy_turn_and_a_stop_are_not_refusals_to_save() {
        assert_eq!(refusal_word(&Refusal::Busy), None);
        assert_eq!(refusal_word(&Refusal::Cancelled), None);
        assert_eq!(refusal_word(&Refusal::NoToolFits), Some("no_tool_fits"));
        assert_eq!(
            refusal_word(&Refusal::AttachmentTooLarge),
            Some("attachment_too_large")
        );
    }

    #[test]
    fn the_command_input_names_the_scope_only_for_a_new_thread() {
        let said = Said {
            outcome: "answered",
            text: "Rent.".to_owned(),
            ..Said::default()
        };
        let turned = Turned {
            key: "k",
            thread: None,
            replace_last: false,
            scope: Some(App::Tasks),
            question: "what is due?",
            attachments: &[],
            said: &said,
            record: None,
        };
        let fresh = command_input(&turned, None, false);
        assert_eq!(fresh["scope_app"], "tasks");
        assert!(fresh.get("thread_id").is_none());
        let again = command_input(&turned, Some("t-1"), true);
        assert_eq!(again["thread_id"], "t-1");
        assert_eq!(again["replace_last"], true);
        assert!(again.get("scope_app").is_none());
    }
}
