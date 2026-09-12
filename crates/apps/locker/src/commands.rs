//! THE SIXTEEN ACTIONS, as command invocations — and the five that refuse to
//! queue.
//!
//! Every Locker action is a thin invocation of ONE typed vault command: the
//! projection lives in the command, not the app
//! (`packages/blueprints/apps/_shared/action-kit.ts`). So this module is a
//! table, not logic.
//!
//! ## `online_only` is exactly v0's five, and the list is the point
//!
//! `ONLINE_ONLY_ACTIONS = [add-item, edit-item, set-field, set-passkey,
//! export]` (`packages/blueprints/apps/locker/writes.ts:33`-`:39`), and the
//! rule the file exists to make structural is: **creating or editing a secret
//! is online only**, because a secret value must never enter the durable
//! offline queue. Two halves of that, stated where v0 states them:
//!
//! - `add-item`, `edit-item`, `set-field` and `set-passkey` carry a sealed
//!   value in the payload. The flag is set **at the point the payload is
//!   built**, not at the call site (`writes.ts`'s own comment), which is why it
//!   is a property of the action table here rather than of a caller.
//! - `export` carries **nothing into** the vault and its *result* is every
//!   secret the locker holds. A mass reveal is the one thing that must never be
//!   queued for later, replayed, or answered from a device's durable store, so
//!   it takes the same door.
//!
//! And what is **not** on the list matters as much (census §A8): `trash`,
//! `restore`, `purge`, `star`, `unstar`, `archive`, `unarchive`, `duplicate`,
//! `remove-field`, `set-addresses` and `clear-passkey` are all durable in the
//! outbox, because a member on a train must be able to trash a login. `reveal`
//! is not an action at all — it is a shell door (§F).
//!
//! ## What `export` means after the custody change (D-1020-L7)
//!
//! The entry stays and its **meaning** moves. In v0 `locker.export` unseals a
//! revision snapshot server-side; after wave 4 the gateway cannot, so the
//! command becomes the seat's confirmed mass unseal with the gateway writing
//! the receipt. `online_only` is still the right flag for exactly the reason
//! `writes.ts` gives — a mass reveal must not be queued, replayed or answered
//! from a durable store — and it now *also* means the obvious: the seat must be
//! able to reach the gateway to have the receipt written before the plaintext
//! exists.
//!
//! ## Two gates, not one
//!
//! [`Confirm`] here is the **manifest's** `confirmation`, which the dispatching
//! surface reads. The command definition's own `confirm` parks a **non-owner**
//! invocation regardless of risk. Locker's two manifest-confirmed actions are
//! `purge-item` and `export`; the `locker.*` catalogue's two command-level
//! gates are on `locker.purge_item` and `locker.export`. Same count, different
//! gates, and collapsing them loses the non-owner park (census §A0).

use std::collections::BTreeMap;

use serde_json::Value;

/// What a command invocation carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    /// The typed vault command, `<schema>.<name>`.
    pub command: &'static str,
    pub input: BTreeMap<String, Value>,
    /// Which of this handler's calls this is. **Mandatory** (D-1020-D3-5): v0's
    /// falls back to the call's ordinal, which is stable only for a handler
    /// that makes the same call sequence every time.
    pub invoke_key: String,
    /// "This decorates the answer": a seat with no gateway settles an optional
    /// invocation as failed rather than refusing the whole run.
    pub optional: bool,
}

impl Invocation {
    /// One invocation of one command.
    #[must_use]
    pub fn new(command: &'static str, invoke_key: &str) -> Self {
        Self {
            command,
            input: BTreeMap::new(),
            invoke_key: invoke_key.to_owned(),
            optional: false,
        }
    }

    /// One input key.
    #[must_use]
    pub fn with(mut self, key: &str, value: Value) -> Self {
        self.input.insert(key.to_owned(), value);
        self
    }

    /// A decoration: a seat with no gateway may settle it as failed.
    #[must_use]
    pub const fn optional(mut self) -> Self {
        self.optional = true;
        self
    }
}

/// The six states a vault invocation settles in. `Denied` is one of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Executed {
        output: Value,
    },
    Parked {
        reason: Option<String>,
    },
    Queued,
    InFlight,
    Failed {
        reason: Option<String>,
    },
    Denied {
        reason: Option<String>,
        code: Option<String>,
    },
}

impl Outcome {
    /// The output of an executed command, or `None` for every other state.
    #[must_use]
    pub const fn output(&self) -> Option<&Value> {
        match self {
            Self::Executed { output } => Some(output),
            _ => None,
        }
    }

    /// Whether the surface should show the write as still in flight.
    #[must_use]
    pub const fn pending(&self) -> bool {
        matches!(self, Self::Queued | Self::InFlight | Self::Parked { .. })
    }
}

/// The one door an app writes through.
pub trait Commands {
    fn invoke(&self, invocation: &Invocation) -> Result<Outcome, CommandsUnavailable>;
}

/// The door is not there. Fails closed, and says which command it was.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("the vault door is unavailable; {command} was not attempted")]
pub struct CommandsUnavailable {
    pub command: &'static str,
}

/// Whether the **dispatching surface** asks before dispatching.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confirm {
    None,
    Required,
}

/// One row of the action table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionRow {
    pub action: &'static str,
    pub command: &'static str,
    pub confirm: Confirm,
    /// A seat refuses to QUEUE this offline, with a typed reason the shell
    /// renders.
    pub online_only: bool,
}

const fn act(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::None,
        online_only: false,
    }
}

/// An action whose payload can carry a secret value, or whose result is one.
const fn sealed(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::None,
        online_only: true,
    }
}

const fn confirmed(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::Required,
        online_only: false,
    }
}

/// The mass unseal: confirmed **and** online-only, and the only row that is
/// both.
const fn confirmed_sealed(action: &'static str, command: &'static str) -> ActionRow {
    ActionRow {
        action,
        command,
        confirm: Confirm::Required,
        online_only: true,
    }
}

/// THE TABLE. Sixteen actions, sixteen commands, in the manifest's own order.
pub const ACTIONS: [ActionRow; 16] = [
    sealed("add-item", "locker.add_item"),
    sealed("edit-item", "locker.edit_item"),
    act("trash-item", "locker.trash_item"),
    act("restore-item", "locker.restore_item"),
    confirmed("purge-item", "locker.purge_item"),
    act("star-item", "locker.star_item"),
    act("unstar-item", "locker.unstar_item"),
    act("archive-item", "locker.archive_item"),
    act("unarchive-item", "locker.unarchive_item"),
    act("duplicate-item", "locker.duplicate_item"),
    sealed("set-field", "locker.set_field"),
    act("remove-field", "locker.remove_field"),
    act("set-addresses", "locker.set_addresses"),
    sealed("set-passkey", "locker.set_passkey"),
    act("clear-passkey", "locker.clear_passkey"),
    confirmed_sealed("export", "locker.export"),
];

/// v0's `ONLINE_ONLY_ACTIONS`, derived from the table so the two cannot drift.
#[must_use]
pub fn online_only_actions() -> Vec<&'static str> {
    ACTIONS
        .iter()
        .filter(|row| row.online_only)
        .map(|row| row.action)
        .collect()
}

/// The row for an action name.
#[must_use]
pub fn action_row(action: &str) -> Option<&'static ActionRow> {
    ACTIONS.iter().find(|row| row.action == action)
}

/// Does this write need the gateway? v0's `needsGateway(write)`.
#[must_use]
pub fn needs_gateway(action: &str) -> bool {
    action_row(action).is_some_and(|row| row.online_only)
}

/// WHY A WRITE WAS NOT QUEUED — a typed reason, never a silent drop.
///
/// An action a seat refuses to queue is a member-visible fact: the shell says
/// *this needs a connection* and offers to retry, which is a different screen
/// from a write that failed. A port that returned `Err(())` here would leave
/// the shell nothing to render.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "{action} carries a secret value and cannot be queued offline; it needs the gateway (#1020, ONLINE_ONLY_ACTIONS)"
)]
pub struct OnlineOnly {
    pub action: &'static str,
}

/// Build the invocation for an action, refusing an offline one that must not
/// queue.
///
/// `online` is the seat's own answer about the gateway. The refusal is
/// **before** the invocation is built, so a payload carrying a secret never
/// exists in a code path that could reach an outbox.
pub fn invocation_for(
    action: &str,
    invoke_key: &str,
    online: bool,
) -> Result<Invocation, OnlineOnly> {
    let row = action_row(action).ok_or(OnlineOnly {
        // An unknown action is not an online-only action; the caller is the
        // dispatcher and this is unreachable from a manifest-validated call.
        // Refusing rather than panicking keeps it that way.
        action: "unknown",
    })?;
    if row.online_only && !online {
        return Err(OnlineOnly { action: row.action });
    }
    Ok(Invocation::new(row.command, invoke_key))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// EXACTLY V0'S FIVE. The exit criterion names this list, so the list is
    /// asserted against v0's own file rather than against a copy of it.
    #[test]
    fn online_only_is_exactly_v0s_five() {
        assert_eq!(
            online_only_actions(),
            [
                "add-item",
                "edit-item",
                "set-field",
                "set-passkey",
                "export"
            ]
        );

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join("packages/blueprints/apps/locker/writes.ts");
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("reading {}: {error}", path.display()));
        let declared = source
            .split("export const ONLINE_ONLY_ACTIONS: readonly string[] = [")
            .nth(1)
            .expect("v0 declares ONLINE_ONLY_ACTIONS")
            .split(']')
            .next()
            .expect("the list closes");
        let v0: Vec<String> = declared
            .split(',')
            .map(|entry| entry.trim().trim_matches('"').to_owned())
            .filter(|entry| !entry.is_empty())
            .collect();
        assert_eq!(
            v0,
            online_only_actions()
                .iter()
                .map(|action| (*action).to_owned())
                .collect::<Vec<String>>(),
            "the port's online_only set is not v0's ONLINE_ONLY_ACTIONS"
        );
    }

    /// The eleven that DO queue, named, because their absence from the list is
    /// the other half of the rule.
    #[test]
    fn every_metadata_action_queues() {
        let queueable: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| !row.online_only)
            .map(|row| row.action)
            .collect();
        assert_eq!(
            queueable,
            [
                "trash-item",
                "restore-item",
                "purge-item",
                "star-item",
                "unstar-item",
                "archive-item",
                "unarchive-item",
                "duplicate-item",
                "remove-field",
                "set-addresses",
                "clear-passkey",
            ]
        );
        for action in queueable {
            assert!(!needs_gateway(action), "{action} refuses to queue");
        }
    }

    /// A secret never enters a code path that could reach the outbox.
    #[test]
    fn an_offline_seat_refuses_a_secret_bearing_action_before_building_it() {
        let refusal = invocation_for("add-item", "k0", false).expect_err("refused");
        assert_eq!(refusal.action, "add-item");
        assert!(refusal.to_string().contains("cannot be queued offline"));

        let queued = invocation_for("trash-item", "k0", false).expect("queues");
        assert_eq!(queued.command, "locker.trash_item");
        assert_eq!(queued.invoke_key, "k0");

        let online = invocation_for("add-item", "k1", true).expect("online");
        assert_eq!(online.command, "locker.add_item");
    }

    /// Every action names one command, and no command is named twice.
    #[test]
    fn the_table_is_one_command_per_action_and_no_duplicates() {
        assert_eq!(ACTIONS.len(), 16);
        let mut commands: Vec<&str> = ACTIONS.iter().map(|row| row.command).collect();
        commands.sort_unstable();
        let count = commands.len();
        commands.dedup();
        assert_eq!(commands.len(), count, "a command is invoked by two actions");
        for row in ACTIONS {
            assert!(
                row.command.starts_with("locker."),
                "{} invokes {}, which is not a locker.* command — every Locker \
                 action writes through its own schema",
                row.action,
                row.command
            );
        }
    }

    /// `export` is the only row that is both confirmed and online-only, and
    /// that pair is what makes it a mass unseal rather than a write.
    #[test]
    fn export_is_the_only_confirmed_online_only_action() {
        let both: Vec<&str> = ACTIONS
            .iter()
            .filter(|row| row.online_only && row.confirm == Confirm::Required)
            .map(|row| row.action)
            .collect();
        assert_eq!(both, ["export"]);
    }

    #[test]
    fn an_optional_invocation_says_so_and_a_plain_one_does_not() {
        let plain = Invocation::new("locker.counts", "k0");
        assert!(!plain.optional);
        assert!(Invocation::new("locker.counts", "k0").optional().optional);
    }
}
