//! Docs: documents and the folders that hold them.

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported, plain};
use crate::read::{Read, ReadDecl};

use super::{Trashed, trash};

/// Documents and folders in the trash.
pub const TRASH: Read<Trashed> = trash!("docs.trash", "'document', 'folder'");

pub const READS: &[ReadDecl] = &[TRASH.decl];

pub const KINDS: &[KindDecl] = &[
    KindDecl::new(
        "document",
        "docs",
        "document",
        "documents",
        Trash::Listed("docs.trash"),
    )
    .sits_in(&[
        "folder", "txn", "event", "workout", "note", "task", "person",
    ])
    .footers(&[
        Footer::Linked,
        Footer::MentionedIn,
        Footer::Origin,
        Footer::Says,
    ])
    .exports(Export::File {
        header: "centraid.documents.v1",
        format: exported,
    })
    .shares(Share::Payload(plain)),
    KindDecl::new(
        "folder",
        "docs",
        "folder",
        "folders",
        Trash::Listed("docs.trash"),
    )
    .sits_in(&["folder"])
    .holds(&["document", "folder"], &["entity.held_counts"])
    .exports(Export::Within("document")),
];
