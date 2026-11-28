//! What no one app owns: the labels any item may wear, and the chats.

use crate::kind::{KindDecl, Trash};
use crate::read::{Read, ReadDecl};

use super::{Trashed, trash};

/// Chats in the trash.
pub const TRASH: Read<Trashed> = trash!("shared.trash", "'thread'");

pub const READS: &[ReadDecl] = &[TRASH.decl];

pub const KINDS: &[KindDecl] = &[
    KindDecl::new(
        "tag",
        "shared",
        "tag",
        "tags",
        Trash::Purged("a tag is purged outright; the items that wore it keep everything else"),
    )
    .sits_in(&["tag"]),
    KindDecl::new(
        "thread",
        "shared",
        "chat",
        "chats",
        Trash::Listed("shared.trash"),
    ),
];
