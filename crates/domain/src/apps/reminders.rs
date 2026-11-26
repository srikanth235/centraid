//! Reminders: tasks, and the lists that hold them.

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported, plain};
use crate::read::{Read, ReadDecl};

use super::{Trashed, trash};

/// Tasks and task lists in the trash.
pub const TRASH: Read<Trashed> = trash!("reminders.trash", "'task', 'task_list'");

pub const READS: &[ReadDecl] = &[TRASH.decl];

pub const KINDS: &[KindDecl] = &[
    KindDecl::new(
        "task",
        "reminders",
        "task",
        "tasks",
        Trash::Listed("reminders.trash"),
    )
    .sits_in(&["task_list", "task"])
    .takes_captures()
    .holds(&["task", "photo", "document"], &["entity.held_counts"])
    .footers(&[
        Footer::Attachments,
        Footer::Linked,
        Footer::MentionedIn,
        Footer::Origin,
        Footer::Says,
    ])
    .exports(Export::File {
        header: "centraid.tasks.v1",
        format: exported,
    })
    .shares(Share::Payload(plain)),
    KindDecl::new(
        "task_list",
        "reminders",
        "task list",
        "task lists",
        Trash::Listed("reminders.trash"),
    )
    .holds(&["task"], &["entity.held_counts"])
    .exports(Export::Within("task")),
];
