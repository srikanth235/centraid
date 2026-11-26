//! Calendar: events, and the calendars that hold them.

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported, plain};
use crate::read::{Read, ReadDecl};

use super::{Trashed, trash};

/// Events and calendars in the trash.
pub const TRASH: Read<Trashed> = trash!("calendar.trash", "'event', 'calendar'");

pub const READS: &[ReadDecl] = &[TRASH.decl];

pub const KINDS: &[KindDecl] = &[
    KindDecl::new(
        "event",
        "calendar",
        "event",
        "events",
        Trash::Listed("calendar.trash"),
    )
    .sits_in(&["calendar"])
    .not_top()
    .takes_captures()
    .holds(&["photo", "document"], &["entity.held_counts"])
    .footers(&[
        Footer::Attachments,
        Footer::Linked,
        Footer::MentionedIn,
        Footer::Origin,
        Footer::Says,
    ])
    .exports(Export::File {
        header: "centraid.events.v1",
        format: exported,
    })
    .shares(Share::Payload(plain)),
    KindDecl::new(
        "calendar",
        "calendar",
        "calendar",
        "calendars",
        Trash::Listed("calendar.trash"),
    )
    .holds(&["event"], &["entity.held_counts"])
    .exports(Export::Within("event")),
];
