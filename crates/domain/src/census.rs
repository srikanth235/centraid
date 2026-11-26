//! THE CENSUS (app-plane §7): one row for every action, and which of the two chat surfaces
//! reaches it. A test holds `contracts/assist/catalog-census.csv` to this and refuses an action
//! neither surface covers; the type alone says an action is `Direct` or `Handoff`, so the file's
//! last column is what a reader audits.

use crate::action::{ActionDecl, Chat, Confirm, Handoff, Inverse, Scope, Target};

/// The columns, in order.
pub const HEADER: &str = "action,kind,verb,qualifier,command,target,here,inverse,confirm,chat";

fn confirm(class: Confirm) -> &'static str {
    match class {
        Confirm::None => "none",
        Confirm::Outlined => "outlined",
        Confirm::Owner => "owner",
    }
}

fn scope(scope: Scope) -> &'static str {
    match scope {
        Scope::Home => "home",
        Scope::Member => "member",
        Scope::Account => "account",
        Scope::Day => "day",
        Scope::Person => "person",
    }
}

fn handoff(reason: Handoff) -> &'static str {
    match reason {
        Handoff::PickFile => "pick_file",
        Handoff::Reveal => "reveal",
        Handoff::Destructive => "destructive",
        Handoff::OwnerCheck => "owner_check",
        Handoff::Open => "open",
    }
}

/// One action's row.
#[must_use]
pub fn row(action: &ActionDecl) -> String {
    let inverse = match action.inverse {
        Inverse::Pair(name) => format!("pair:{name}"),
        Inverse::Restore => "restore".to_owned(),
        Inverse::None => "none".to_owned(),
    };
    let chat = match action.chat {
        Chat::Direct(say) => match say.qualifier {
            Some(qualifier) => format!("direct:{}:{qualifier}", say.verb),
            None => format!("direct:{}", say.verb),
        },
        Chat::Handoff(reason) => format!("handoff:{}", handoff(reason)),
        Chat::Card(reason, say) => format!("handoff:{}:says={}", handoff(reason), say.verb),
    };
    let here: Vec<&str> = action.here.iter().copied().map(scope).collect();
    [
        action.name(),
        action.kind.to_owned(),
        action.verb.to_owned(),
        action.qualifier.unwrap_or_default().to_owned(),
        action.command.to_owned(),
        match action.target {
            Target::One => "one",
            Target::Set => "set",
        }
        .to_owned(),
        here.join(" "),
        inverse,
        confirm(action.confirm).to_owned(),
        chat,
    ]
    .join(",")
}

/// The whole file.
#[must_use]
pub fn csv() -> String {
    let mut out = format!("{HEADER}\n");
    for action in crate::ACTIONS {
        out.push_str(&row(action));
        out.push('\n');
    }
    out
}
