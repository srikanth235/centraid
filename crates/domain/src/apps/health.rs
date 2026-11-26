//! Health: workouts and readings.

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported, plain};
use crate::read::{Read, ReadDecl};

use super::{Trashed, trash};

/// Workouts and readings in the trash.
pub const TRASH: Read<Trashed> = trash!("health.trash", "'workout', 'reading'");

pub const READS: &[ReadDecl] = &[TRASH.decl];

pub const KINDS: &[KindDecl] = &[
    KindDecl::new(
        "workout",
        "health",
        "workout",
        "workouts",
        Trash::Listed("health.trash"),
    )
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
        header: "centraid.health.v1",
        format: exported,
    })
    .shares(Share::Payload(plain)),
    KindDecl::new(
        "reading",
        "health",
        "reading",
        "readings",
        Trash::Listed("health.trash"),
    )
    .footers(&[Footer::Origin, Footer::Says])
    .exports(Export::Within("workout")),
    KindDecl::new(
        "workout_kind",
        "health",
        "workout type",
        "workout types",
        Trash::Purged("a type is purged outright; no workout can sit on one that is gone"),
    )
    .sits_in(&["workout_kind"]),
];
