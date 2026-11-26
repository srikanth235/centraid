//! THE ACTION CATALOGUE (app-plane §4, M4).
//!
//! An action is `(kind, verb, qualifier)` and wraps **one vault command**, or the same command
//! over `ids[]`. Its name is the command's: `<kind>.<verb>`, with `/<qualifier>` when the
//! qualifier is what tells two actions of one command apart. Actions belong to kinds, not apps.
//!
//! [`ACTION_VERBS`] and [`SYSTEM_VERBS`] together are the vault's verbs
//! (`crates/vault/tests/command_list.rs`): a new vault verb must be classified.

/// The verbs a member or the assistant intends. The vault's other 21 are called by core
/// services and followers, never by a screen or chat.
pub const ACTION_VERBS: [&str; 76] = [
    "add",
    "add_date",
    "add_guest",
    "add_item",
    "add_note",
    "add_relationship",
    "apply",
    "asset_add",
    "asset_remove",
    "asset_reorder",
    "cancel",
    "categorize",
    "clear",
    "color",
    "complete",
    "confirm_match",
    "create",
    "create_text",
    "delete",
    "dismiss_match",
    "duplicate_item",
    "edit",
    "edit_date",
    "edit_item",
    "edit_occurrence",
    "empty_trash",
    "export",
    "export_all",
    "export_csv",
    "export_ics",
    "export_vcf",
    "export_zip",
    "import",
    "import_csv",
    "import_vcf",
    "keep_version",
    "link_transfer",
    "locate",
    "log",
    "merge",
    "move",
    "organize",
    "prefer_contact_point",
    "propose",
    "purge",
    "record",
    "remove",
    "remove_contact_point",
    "remove_date",
    "remove_field",
    "remove_passkey",
    "rename",
    "reopen",
    "reorder_contact_points",
    "replace",
    "respond",
    "restore",
    "restore_version",
    "retitle",
    "save_contact_point",
    "set",
    "set_avatar",
    "set_carry",
    "set_cover",
    "set_field",
    "set_opening",
    "set_passkey",
    "set_place",
    "snooze",
    "split",
    "stop",
    "style",
    "take_stated",
    "totp_code",
    "trash",
    "unlink_transfer",
];

/// The verbs only core services and followers call.
pub const SYSTEM_VERBS: [&str; 21] = [
    "advance_cursor",
    "calendar",
    "camera_roll",
    "collect",
    "contacts",
    "counts",
    "drop",
    "files",
    "health",
    "health_readings",
    "mark_unlock_failed",
    "mark_unlocked",
    "mark_used",
    "reminders",
    "remember_layout",
    "save_turn",
    "settle_proposal",
    "stage",
    "statement",
    "undo",
    "write",
];

/// Commands whose verb is an action verb and which are still a core service's: the health
/// follower's day totals. Every followed store's pass (`follow.contacts`, …) has a system verb
/// of its own, so only `follow.stop` and `follow.take_stated` are actions.
pub const SYSTEM_COMMANDS: [&str; 1] = ["measurement.record"];

/// The most ids an action takes at once.
pub const MAX_TARGETS: usize = 500;

/// The type of one input field, as the vault command's input says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ty {
    Text,
    Int,
    Num,
    Bool,
    List,
    Object,
    /// One of these words.
    OneOf(&'static [&'static str]),
}

/// One field of an action's input.
#[derive(Debug, Clone, Copy)]
pub struct Field {
    pub name: &'static str,
    pub ty: Ty,
    pub required: bool,
    /// An id the core mints when the input leaves it out.
    pub minted: bool,
}

/// A required field.
#[must_use]
pub const fn req(name: &'static str, ty: Ty) -> Field {
    Field {
        name,
        ty,
        required: true,
        minted: false,
    }
}

/// An optional field.
#[must_use]
pub const fn opt(name: &'static str, ty: Ty) -> Field {
    Field {
        name,
        ty,
        required: false,
        minted: false,
    }
}

/// An id the core mints when it is left out.
#[must_use]
pub const fn mint(name: &'static str) -> Field {
    Field {
        name,
        ty: Ty::Text,
        required: false,
        minted: true,
    }
}

/// An id the core mints and the command requires.
#[must_use]
pub const fn mint_req(name: &'static str) -> Field {
    Field {
        name,
        ty: Ty::Text,
        required: true,
        minted: true,
    }
}

/// What an action acts on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// One row, or the one it makes.
    One,
    /// `ids[]`, 1 to [`MAX_TARGETS`], atomic: one commit, one `invoke_key`, one Undo.
    Set,
}

/// Where the member stands when they press `+`, and the input it fills.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// Inside a notebook, folder, task list, calendar or task: `parent_id`.
    Home,
    /// Inside an album or list: the `contains` edge, in the same commit.
    Member,
    /// Inside an account: `account_id`.
    Account,
    /// A calendar day: the start day.
    Day,
    /// From a person's page: a `with` or `about` edge, in the same commit.
    Person,
}

/// How Undo takes an action back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inverse {
    /// The paired action, by name, over the same ids (or the ids the commit made).
    Pair(&'static str),
    /// Each `(entity, seq)` the commit wrote, put back from its history.
    Restore,
    /// Not undoable.
    None,
}

/// Whether, and how, the member is asked first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confirm {
    /// Everything with an Undo: the status line says what happened.
    None,
    /// A `confirm` block in a sheet: what cannot be taken back, or takes much with it.
    Outlined,
    /// The OS owner check, then the action.
    Owner,
}

/// Why a card, and not the model, finishes an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handoff {
    /// The member picks the file.
    PickFile,
    /// A Locker secret is revealed behind its wall.
    Reveal,
    /// A confirm sheet, filled, because the action cannot be taken back.
    Destructive,
    /// The OS owner check comes first: an export.
    OwnerCheck,
}

/// What the model says for an action: one verb of `contracts/assist/verbs.json`, the kinds it
/// says it on, and the narrowing it names (`edit:cadence`). `(verb, kind, qualifier)` names one
/// action, so two actions never say the same triple.
#[derive(Debug, Clone, Copy)]
pub struct Say {
    pub verb: &'static str,
    pub kinds: &'static [&'static str],
    pub qualifier: Option<&'static str>,
}

/// How chat reaches an action. Every action has one: no action is screen-only.
#[derive(Debug, Clone, Copy)]
pub enum Chat {
    /// The model's call runs as `actor='assistant'`; the answer shows a card with Undo.
    Direct(Say),
    /// A card opens the screen with the inputs filled.
    Handoff(Handoff),
}

/// One action.
#[derive(Debug, Clone, Copy)]
pub struct ActionDecl {
    /// An entity kind, or a command group (`entity`, `flag`, `edge`, …).
    pub kind: &'static str,
    pub verb: &'static str,
    /// What tells this action from another of the same `(kind, verb)`: an arrival route, or the
    /// one field a narrow edit sets.
    pub qualifier: Option<&'static str>,
    /// The vault command it wraps.
    pub command: &'static str,
    /// The command's input, typed.
    pub input: &'static [Field],
    pub target: Target,
    pub here: &'static [Scope],
    /// Commands run in the same commit when a `Member` or `Person` scope is present; Undo
    /// inverts all.
    pub with: &'static [&'static str],
    pub inverse: Inverse,
    pub confirm: Confirm,
    pub chat: Chat,
}

impl ActionDecl {
    /// The name Undo and the census use: `kind.verb`, or `kind.verb/qualifier`.
    #[must_use]
    pub fn name(&self) -> String {
        match self.qualifier {
            Some(qualifier) => format!("{}.{}/{qualifier}", self.kind, self.verb),
            None => format!("{}.{}", self.kind, self.verb),
        }
    }
}

/// An action over `command`, `kind` and `verb`, taking `input`. It acts on one row, fills
/// nothing from where the member stands, puts back from history, asks nothing, and must be given
/// its chat surface.
#[must_use]
pub const fn act(
    kind: &'static str,
    verb: &'static str,
    command: &'static str,
    input: &'static [Field],
) -> ActionDecl {
    ActionDecl {
        kind,
        verb,
        qualifier: None,
        command,
        input,
        target: Target::One,
        here: &[],
        with: &[],
        inverse: Inverse::Restore,
        confirm: Confirm::None,
        chat: Chat::Handoff(Handoff::PickFile),
    }
}

impl ActionDecl {
    /// What tells it from another action of the same kind and verb.
    #[must_use]
    pub const fn q(mut self, qualifier: &'static str) -> Self {
        self.qualifier = Some(qualifier);
        self
    }

    /// It takes `ids[]`.
    #[must_use]
    pub const fn set(mut self) -> Self {
        self.target = Target::Set;
        self
    }

    #[must_use]
    pub const fn here(mut self, here: &'static [Scope]) -> Self {
        self.here = here;
        self
    }

    #[must_use]
    pub const fn with(mut self, with: &'static [&'static str]) -> Self {
        self.with = with;
        self
    }

    /// Undo runs this action, by name.
    #[must_use]
    pub const fn pair(mut self, action: &'static str) -> Self {
        self.inverse = Inverse::Pair(action);
        self
    }

    /// Undo cannot take it back.
    #[must_use]
    pub const fn irreversible(mut self) -> Self {
        self.inverse = Inverse::None;
        self
    }

    #[must_use]
    pub const fn outlined(mut self) -> Self {
        self.confirm = Confirm::Outlined;
        self
    }

    #[must_use]
    pub const fn owner(mut self) -> Self {
        self.confirm = Confirm::Owner;
        self
    }

    /// The model says `verb` on `kinds`.
    #[must_use]
    pub const fn say(mut self, verb: &'static str, kinds: &'static [&'static str]) -> Self {
        self.chat = Chat::Direct(Say {
            verb,
            kinds,
            qualifier: None,
        });
        self
    }

    /// The model says `verb:qualifier` on `kinds`.
    #[must_use]
    pub const fn say_q(
        mut self,
        verb: &'static str,
        kinds: &'static [&'static str],
        qualifier: &'static str,
    ) -> Self {
        self.chat = Chat::Direct(Say {
            verb,
            kinds,
            qualifier: Some(qualifier),
        });
        self
    }

    /// A card finishes it.
    #[must_use]
    pub const fn hand(mut self, reason: Handoff) -> Self {
        self.chat = Chat::Handoff(reason);
        self
    }
}
