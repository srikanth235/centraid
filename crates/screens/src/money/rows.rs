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
            Flag::Transfer => chips.push(chip(words::chip_transfer(locale), Tone::Seam)),
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
    let meta = [
        if with_day {
            fold::day_short(locale, &source.posted_on)
        } else {
            String::new()
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
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" · ");
    let category = source.category_label.clone().unwrap_or_default();
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
        title,
        meta,
        amount: fold::text(source.amount.as_ref()),
        amount_tone: if struck {
            Tone::Seam
        } else {
            fold::sign_tone(source.amount.as_ref())
        } as i32,
        category_label: category,
        chips: chips(locale, &source.flags, source.category_id.is_some()),
        accessibility_label,
        dimmed: struck,
        route: Some(routes::transaction(&source.txn_id, parent)),
    }
}

/// Rows grouped under their day, in the order given (newest first).
#[must_use]
pub fn sections(
    locale: Locale,
    rows: &[wire::MoneyActivityRow],
    today: &str,
    parent: &str,
) -> Vec<wire::MoneyDaySection> {
    let mut out: Vec<wire::MoneyDaySection> = Vec::new();
    for source in rows {
        let line = row(locale, source, today, true, false, parent);
        match out.last_mut() {
            Some(last) if last.day == source.posted_on => last.rows.push(line),
            _ => out.push(wire::MoneyDaySection {
                day: source.posted_on.clone(),
                heading: fold::day_heading(locale, &source.posted_on, today),
                rows: vec![line],
            }),
        }
    }
    out
}
