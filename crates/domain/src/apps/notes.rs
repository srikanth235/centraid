//! Notes: notes, the notebooks that hold them, and the lists a member gathers things in.

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported, plain};
use crate::read::{Read, ReadDecl};

use super::{Trashed, trash};

/// Notes, notebooks and lists in the trash.
pub const TRASH: Read<Trashed> = trash!("notes.trash", "'note', 'notebook', 'list'");

pub const READS: &[ReadDecl] = &[TRASH.decl];

pub const KINDS: &[KindDecl] = &[
    KindDecl::new(
        "note",
        "notes",
        "note",
        "notes",
        Trash::Listed("notes.trash"),
    )
    .sits_in(&["notebook"])
    .takes_captures()
    .holds(&["photo", "document"], &["entity.held_counts"])
    .footers(&[
        Footer::Attachments,
        Footer::Linked,
        Footer::MentionedIn,
        Footer::Origin,
    ])
    .exports(Export::File {
        header: "centraid.notes.v1",
        format: exported,
    })
    .shares(Share::Payload(plain)),
    KindDecl::new(
        "notebook",
        "notes",
        "notebook",
        "notebooks",
        Trash::Listed("notes.trash"),
    )
    .sits_in(&["notebook"])
    .holds(&["note", "notebook"], &["entity.held_counts"])
    .exports(Export::Within("note")),
    KindDecl::new(
        "list",
        "notes",
        "list",
        "lists",
        Trash::Listed("notes.trash"),
    ),
];
