//! WHERE IT CAME FROM (#1185): one quiet line under the Earlier versions entry of every detail
//! page, "From contacts.vcf", for an item that did not come from typing.
//!
//! - **The read** is `shell.origin-of`: the vault's origin of one record, whether a store the phone
//!   is followed from (contacts, calendar, a folder, the health store, a bank statement) or a
//!   one-shot arrival (the camera roll, a picked photo, a vCard, a Markdown folder, a Locker CSV, a
//!   scan, an upload, the phone's Reminders). The same read for all of them.
//! - **The words** are one sentence shape for every system, "From {label}", in
//!   `strings/shared.rs`; the label is the store's, file's or device's own name. A Locker item's
//!   label is a file name and nothing of what is in it.
//! - **A typed item has no line.** And a read that does not land draws none: the line is a note on
//!   where the item came from, and every value on the page is the member's either way.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog::load;
use crate::kit::read::{self, Reading};
use crate::screen::Ctx;
use crate::strings::{Locale, fill, shared};

/// The line for an origin: `None` when it names nothing (a typed item).
#[must_use]
pub fn line(locale: Locale, label: &str) -> Option<wire::OriginLine> {
    let label = label.trim();
    if label.is_empty() {
        return None;
    }
    Some(wire::OriginLine {
        text: fill(&shared::origin_line(locale), &[("label", label)]),
        accessibility_label: fill(&shared::origin_spoken(locale), &[("label", label)]),
    })
}

/// The line for `entity_id`'s page, when it came from somewhere other than the member's typing.
pub fn read(ctx: &Ctx, entity_id: &str) -> Option<wire::OriginLine> {
    if entity_id.is_empty() {
        return None;
    }
    let reading = read::read(
        ctx,
        load::shell::OriginOf {
            entity_id: entity_id.to_owned(),
        },
        |answer| match answer {
            Answer::OriginOf(found) => Some(found),
            _ => None,
        },
    );
    let Reading::Data(found) = reading else {
        return None;
    };
    line(ctx.locale(), &found.label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_sentence_shape_names_the_store_file_or_device() {
        for label in ["Camera roll", "contacts.vcf", "iCloud", "Apple Health"] {
            let line = line(Locale::En, label).expect("a line");
            assert_eq!(line.text, format!("From {label}"));
            assert_eq!(line.accessibility_label, format!("Came from {label}"));
        }
    }

    #[test]
    fn a_typed_item_has_no_line() {
        assert_eq!(line(Locale::En, ""), None);
        assert_eq!(line(Locale::En, "   "), None);
    }
}
