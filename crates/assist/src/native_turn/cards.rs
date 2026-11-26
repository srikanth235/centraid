//! A RESULT IS THE CHAT'S EXISTING CARD (R-1088-7): the kind to app and entity.
//!
//! A card is a reference (`app`, `entity`, `id`) and a few words; the app's own tile draws the
//! row. Which app and which entity a kind's card names is the kind's own declaration
//! (`centraid_domain::KindDecl`), read through [`Kind::spec`].

use jiff::civil::Date;

use crate::app::App;
use crate::native::meta::Kind;
use crate::native::world::{Row, Val};
use crate::result::Card;

/// How one kind is drawn as a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CardKind {
    pub kind: Kind,
    pub app: App,
    pub entity: &'static str,
}

/// How a kind is drawn.
#[must_use]
pub fn card_kind(kind: Kind) -> Option<CardKind> {
    let spec = kind.spec();
    Some(CardKind {
        kind,
        app: App::from_id(spec.app)?,
        entity: spec.entity,
    })
}

/// The app a kind belongs to.
#[must_use]
pub fn app_of(kind: Kind) -> Option<App> {
    card_kind(kind).map(|entry| entry.app)
}

/// The card of a row: its name, its date, and one word of state.
#[must_use]
pub fn card_of(row: &Row, today: Date) -> Option<Card> {
    let how = card_kind(row.kind)?;
    let mut card = Card::new(how.app, how.entity, row.id.clone(), row.name.clone());
    if let Some(stamp) = row.date {
        card = card.subtitle(friendly(stamp, today));
    }
    let state = match row.field("status") {
        // the ordinary state of a row is not worth a word on a card
        Some(Val::Enum(status)) if !matches!(*status, "confirmed" | "open" | "posted") => {
            (*status).to_owned()
        }
        _ => String::new(),
    };
    Some(card.meta(state))
}

/// The entity a stored proposal's step card carried before cards kept no words (a thread reads it
/// as no rows).
pub const PROPOSAL_STEP: &str = "proposal_step";

/// A card's day in the member's words (the board's "Today · 11:15"): today, tomorrow and
/// yesterday by name, any other day as `Fri 6 Nov` (with the year when it is not this one), then
/// the time when the row has one.
fn friendly(stamp: crate::native::dates::Stamp, today: Date) -> String {
    use crate::native::dates::{clock, weekday_abbrev};
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let date = stamp.date;
    let day = match (date - today).get_days() {
        0 => "Today".to_owned(),
        1 => "Tomorrow".to_owned(),
        -1 => "Yesterday".to_owned(),
        _ => {
            let month = MONTHS[usize::try_from(date.month() - 1).unwrap_or(0)];
            let year = if date.year() == today.year() {
                String::new()
            } else {
                format!(" {}", date.year())
            };
            format!("{} {} {month}{year}", weekday_abbrev(date), date.day())
        }
    };
    match stamp.time {
        Some(time) => format!("{day} · {}", clock(time)),
        None => day,
    }
}
