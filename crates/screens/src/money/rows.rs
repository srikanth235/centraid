//! A TRANSACTION AS A LIST DRAWS IT, once: Activity and Search share these rows.
//! The chips are the core's flags and nothing else — a line is drawn as the
//! vault holds it (`posted`, `void`, half of a transfer), never as a state this
//! crate works out from a date or an amount.

use centraid_api_proto::core_v1 as wire;
use wire::MoneyFlag as Flag;
use wire::status_chip::Tone;

use super::fold::{self, chip};
use super::routes;
use crate::strings::{Locale, money as words};

fn has(flags: &[i32], flag: Flag) -> bool {
    flags.contains(&(flag as i32))
}

/// The flags as chips, in the order a member reads them.
#[must_use]
pub fn chips(locale: Locale, flags: &[i32], has_category: bool) -> Vec<wire::StatusChip> {
    let mut chips = Vec::new();
    for raw in flags {
        match Flag::try_from(*raw).unwrap_or(Flag::Unspecified) {
            // A transfer says so in its meta line ("Transfer · not counted as spending"),
            // so it wears no badge of its own.
            Flag::Void => chips.push(chip(words::chip_void(locale), Tone::Seam)),
            Flag::Uncategorised if !has_category => {
                chips.push(chip(words::chip_no_category(locale), Tone::Seam));
            }
            Flag::Future => chips.push(chip(words::chip_future(locale), Tone::Neutral)),
            _ => {}
        }
    }
    chips
}

/// One activity row as a list draws it. `parent` is the title of the page the
/// row is on, which the transaction page's back control says.
///
/// `with_day` is a search hit: its meta leads with the day, the category stands
/// at the trailing edge under the amount, and the tile is neutral. Activity's row
/// puts the category first in its meta and wears the category's colour.
#[must_use]
pub fn row(
    locale: Locale,
    source: &wire::MoneyActivityRow,
    today: &str,
    with_account: bool,
    with_day: bool,
    parent: &str,
) -> wire::MoneyRow {
    let transfer = has(&source.flags, Flag::Transfer);
    let struck = transfer || has(&source.flags, Flag::Void);
    let category = source.category_label.clone().unwrap_or_default();
    let parts = if transfer && !with_day {
        vec![words::transfer_meta(locale)]
    } else {
        vec![
            if with_day {
                fold::day_short(locale, &source.posted_on)
            } else {
                category.clone()
            },
            if with_account {
                source.account_label.clone()
            } else {
                String::new()
            },
            if source.display_name != source.raw && !source.raw.is_empty() {
                source.raw.clone()
            } else {
                String::new()
            },
            if transfer {
                words::not_spending(locale)
            } else {
                String::new()
            },
        ]
    };
    let meta = parts
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let title = if source.display_name.is_empty() {
        source.raw.clone()
    } else {
        source.display_name.clone()
    };
    let accessibility_label = [
        title.clone(),
        fold::day_heading(locale, &source.posted_on, today),
        category.clone(),
        meta.clone(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(", ");
    wire::MoneyRow {
        txn_id: source.txn_id.clone(),
        initial: title
            .chars()
            .find(|c| c.is_alphanumeric())
            .map(|c| c.to_uppercase().collect())
            .unwrap_or_default(),
        title,
        meta,
        amount: fold::text(source.amount.as_ref()),
        // Money out is ink, not red: red is a state. A transfer or a void is
        // "not counted"; money in is green (`positive`).
        amount_tone: if struck { Tone::Seam } else { Tone::Neutral } as i32,
        positive: !struck && source.amount.as_ref().is_some_and(|a| a.minor > 0),
        // Search shows the category at the trailing edge; Activity has it in the meta.
        category_label: if with_day { category } else { String::new() },
        color_key: if with_day {
            String::new()
        } else {
            fold::color_key(source.category_id.as_deref().unwrap_or_default())
        },
        tile_icon: if transfer {
            "Swap".to_owned()
        } else {
            String::new()
        },
        chips: chips(locale, &source.flags, source.category_id.is_some()),
        accessibility_label,
        dimmed: struck,
        route: Some(routes::transaction(&source.txn_id, parent)),
    }
}

/// Rows grouped under their day, in the order given (newest first). `totals` is
/// the core's net of each day (`MoneyActivity.days`); a day with no entry, or one
/// not yet complete, draws no total.
#[must_use]
pub fn sections(
    locale: Locale,
    rows: &[wire::MoneyActivityRow],
    totals: &[wire::MoneyDayTotal],
    today: &str,
    parent: &str,
) -> Vec<wire::MoneyDaySection> {
    let mut out: Vec<wire::MoneyDaySection> = Vec::new();
    for source in rows {
        let line = row(locale, source, today, true, false, parent);
        match out.last_mut() {
            Some(last) if last.day == source.posted_on => last.rows.push(line),
            _ => {
                let day = totals
                    .iter()
                    .find(|d| d.day == source.posted_on && d.complete);
                let (total, positive) =
                    day.map_or((String::new(), false), |d| fold::signed_total(&d.totals));
                out.push(wire::MoneyDaySection {
                    day: source.posted_on.clone(),
                    heading: fold::day_heading(locale, &source.posted_on, today),
                    rows: vec![line],
                    total,
                    total_positive: positive,
                });
            }
        }
    }
    out
}
