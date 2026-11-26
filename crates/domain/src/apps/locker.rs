//! Locker: items whose sensitive values are sealed.

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported};
use crate::read::{Read, ReadDecl};

use super::{Trashed, trash};

/// Locker items in the trash.
pub const TRASH: Read<Trashed> = trash!("locker.trash", "'locker_item'");

pub const READS: &[ReadDecl] = &[TRASH.decl];

pub const KINDS: &[KindDecl] = &[KindDecl::new(
    "locker_item",
    "locker",
    "item",
    "items",
    Trash::Listed("locker.trash"),
)
.footers(&[Footer::Linked, Footer::MentionedIn, Footer::Origin])
.exports(Export::File {
    header: "centraid.locker.v1",
    format: exported,
})
.shares(Share::Never(
    "a Locker item is never handed to the share sheet",
))];
