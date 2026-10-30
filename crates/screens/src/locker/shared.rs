//! What every Locker screen shares beyond the wall: the three states of a read,
//! the session's reveal as a screen asks it, an item as a list draws it, and
//! the small status-line helpers.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;

use super::types;
use crate::kit::read::Reading;
use crate::screen::Ctx;
use crate::strings::{Locale, fill, locker as words};

/// What a Locker page holds of one read: nothing yet, a refusal, a gate or the
/// answer. A failed read is never an empty list.
#[derive(Clone, Debug)]
pub(super) enum Phase<T> {
    Loading,
    Failed,
    Denied(wire::AppQueryDenial),
    Ready(T),
}

impl<T> Phase<T> {
    pub(super) fn of(reading: Reading<T>) -> Self {
        match reading {
            Reading::Data(data) => Self::Ready(data),
            Reading::Denied(denial) => Self::Denied(denial),
            Reading::Failed => Self::Failed,
        }
    }

    pub(super) fn data(&self) -> Option<&T> {
        match self {
            Self::Ready(data) => Some(data),
            _ => None,
        }
    }
}

/// The gate drawn when the vault will not let Locker read.
pub(super) fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    wire::Denied {
        title: words::denied_title(locale),
        body: words::denied_body(locale),
        receipt: denial
            .code
            .clone()
            .unwrap_or_else(|| words::denied_scope(locale)),
    }
}

/// A one-line status.
pub(super) fn status(sentence: String) -> Option<wire::StatusLine> {
    Some(wire::StatusLine {
        sentence,
        action_label: String::new(),
        refused: false,
    })
}

/// A refusal's status: the core's own sentence.
pub(super) fn refused(sentence: String) -> Option<wire::StatusLine> {
    Some(wire::StatusLine {
        sentence,
        action_label: String::new(),
        refused: true,
    })
}

/// A copy of something that is not a secret: metadata, copied as itself.
pub(super) fn plain_copy(text: &str) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::ClipboardSet(wire::ClipboardSet {
            text: text.to_owned(),
            sensitive: false,
            clear_after_ms: 0,
        })),
    }
}

// ---------------------------------------------------------------------------
// The session's reveal
// ---------------------------------------------------------------------------

/// Why a reveal did not happen.
pub(super) enum Refused {
    /// Idle ended the session under the screen: the wall is the answer.
    Locked,
    /// Any other refusal, in the member's words.
    Said(String),
}

/// One cell's plaintext, and how long the core says it may live.
pub(super) struct Opened {
    pub value: String,
    pub life: Duration,
}

fn sentence_of(locale: Locale, refusal: i32) -> String {
    use wire::LockerRevealRefusal as R;
    match R::try_from(refusal).unwrap_or(R::Unspecified) {
        R::Empty => words::reveal_empty(locale),
        R::NotSealed => words::reveal_gone(locale),
        R::NotASeed => words::code_not_a_seed(locale),
        R::SeedNotShown => words::reveal_seed(locale),
        R::KeyNotShown => words::passkey_note(locale),
        R::Locked => words::reveal_locked(locale),
        _ => words::reveal_did_not_open(locale),
    }
}

fn refusal_of(locale: Locale, answer: &wire::LockerSessionResponse) -> Refused {
    if answer.refusal == wire::LockerRevealRefusal::Locked as i32 {
        Refused::Locked
    } else {
        Refused::Said(sentence_of(locale, answer.refusal))
    }
}

/// Reveal one sealed cell (`column`), or a custom field's value (`field_id`
/// set, the column `value_sealed`). The core stamps the item as used before the
/// value exists. `copy` sends the value to the clipboard; the value is the same.
pub(super) fn reveal(
    ctx: &Ctx,
    item_id: &str,
    column: &str,
    field_id: &str,
    copy: bool,
) -> Result<Opened, Refused> {
    let locale = ctx.locale();
    let answer = ctx
        .locker(&wire::LockerSessionRequest {
            step: Some(wire::locker_session_request::Step::Reveal(
                wire::LockerReveal {
                    item_id: item_id.to_owned(),
                    column: if field_id.is_empty() {
                        column.to_owned()
                    } else {
                        "value_sealed".to_owned()
                    },
                    field_id: field_id.to_owned(),
                    copy,
                },
            )),
        })
        .map_err(|error| Refused::Said(error.sentence()))?;
    match answer.revealed.clone() {
        Some(revealed) => Ok(Opened {
            value: revealed.value,
            life: Duration::from_millis(revealed.expires_in_ms.max(1_000)),
        }),
        None => Err(refusal_of(locale, &answer)),
    }
}

/// The code an item's seed makes now. The seed itself is never answered.
pub(super) struct Code {
    pub code: String,
    pub period: u32,
    pub remaining: u32,
}

pub(super) fn totp(ctx: &Ctx, item_id: &str, copy: bool) -> Result<Code, Refused> {
    let locale = ctx.locale();
    let answer = ctx
        .locker(&wire::LockerSessionRequest {
            step: Some(wire::locker_session_request::Step::Totp(
                wire::LockerTotpAsk {
                    item_id: item_id.to_owned(),
                    copy,
                },
            )),
        })
        .map_err(|error| Refused::Said(error.sentence()))?;
    match answer.totp.clone() {
        Some(code) => Ok(Code {
            code: code.code,
            period: code.period_seconds.max(1),
            remaining: code.remaining_seconds.clamp(1, code.period_seconds.max(1)),
        }),
        None => Err(refusal_of(locale, &answer)),
    }
}

/// A fresh id for a row the core seals against before it exists (an item, a
/// custom field): 32 hex digits of the operating system's CSPRNG. `None` when
/// the system gave no entropy, which the caller treats as "cannot save now".
pub(super) fn mint_id() -> Option<String> {
    let bytes = (super::generator::system_entropy())(16);
    (bytes.len() == 16).then(|| bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

// ---------------------------------------------------------------------------
// An item as a list draws it
// ---------------------------------------------------------------------------

/// "1 item" / "12 items".
pub(super) fn items(locale: Locale, count: u64) -> String {
    fill(
        &if count == 1 {
            words::count_one(locale)
        } else {
            words::count_many(locale)
        },
        &[("n", &count.to_string())],
    )
}

/// One list row, secret-free, with its chips and its spoken label.
pub(super) fn row(locale: Locale, item: &wire::LockerItemRow, parent: &str) -> wire::LockerRow {
    let kind = types::of(&item.r#type);
    let mut chips = Vec::new();
    if item.compromised {
        chips.push(wire::StatusChip {
            label: words::chip_compromised(locale),
            tone: wire::status_chip::Tone::Net as i32,
        });
    }
    if item.archived {
        chips.push(wire::StatusChip {
            label: words::chip_archived(locale),
            tone: wire::status_chip::Tone::Seam as i32,
        });
    }
    // ONLY A LOGIN, AN IDENTITY AND A WI-FI HAVE A SUBTITLE OF THEIR OWN; the
    // core fills every other type's with a type word that beside the type
    // would read it twice.
    let subtitle = if kind.subtitled && item.subtitle != "—" {
        item.subtitle.clone()
    } else {
        String::new()
    };
    let meta = [(kind.label)(locale), subtitle, item.tags.join(", ")]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let chip_labels = chips
        .iter()
        .map(|chip| chip.label.clone())
        .collect::<Vec<_>>()
        .join(", ");
    let spoken = [
        Some(item.title.clone()),
        Some(meta.clone()),
        item.starred.then(|| words::starred(locale)),
        (!chip_labels.is_empty()).then_some(chip_labels),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(", ");
    wire::LockerRow {
        item_id: item.item_id.clone(),
        title: item.title.clone(),
        meta,
        type_chip: kind.chip(locale),
        starred: item.starred,
        chips,
        accessibility_label: spoken,
        route: Some(super::routes::item(&item.item_id, parent, "")),
    }
}
