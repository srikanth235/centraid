//! THE DEEP LINK (app-plane §10, D4): `centraid://open/<kind>/<id>`. A notification, a widget and
//! a shared link name an item this way and nothing else; no route rides in a payload.

use centraid_domain::KINDS;

/// A link that names an item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Open {
    pub kind: String,
    pub id: String,
    /// The app whose module declares the kind.
    pub app: &'static str,
}

impl Open {
    /// The room key that shows it: `<kind>/<id>`.
    #[must_use]
    pub fn room_key(&self) -> String {
        format!("{}/{}", self.kind, self.id)
    }

    pub fn route_key(&self) -> Result<String, Refused> {
        let route = match self.kind.as_str() {
            "person" => "person",
            "event" => "calendar/event",
            "calendar" => "calendar/calendar",
            "task" => "reminders/task",
            "task_list" => "reminders/list",
            "txn" => "money/txn",
            "account" => "money/account",
            "note" => "notes/note",
            "notebook" => "notes/notebook",
            "document" => "docs/doc",
            "folder" => "docs/folder",
            "photo" => "photos/photo",
            "album" => "photos/album",
            "place" => "photos/place",
            "workout" => "health/workout",
            "locker_item" => "locker/item",
            _ => return Err(Refused::NoRoom(self.kind.clone())),
        };
        Ok(format!("{route}/{}", self.id))
    }

    #[must_use]
    pub fn url(&self) -> String {
        format!("centraid://open/{}/{}", self.kind, self.id)
    }
}

/// Why a link is not one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    NotOurs,
    NotOpen,
    UnknownKind(String),
    BadId,
    NoRoom(String),
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotOurs => f.write_str("not a centraid link"),
            Self::NotOpen => f.write_str("not an open link"),
            Self::UnknownKind(kind) => write!(f, "no kind `{kind}`"),
            Self::BadId => f.write_str("the id is not an id"),
            Self::NoRoom(kind) => write!(f, "no room opens `{kind}`"),
        }
    }
}

impl std::error::Error for Refused {}

fn is_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Parse a link.
///
/// # Errors
/// What the link is instead of an open link on a known kind and a well-formed id.
pub fn parse(url: &str) -> Result<Open, Refused> {
    let rest = url.strip_prefix("centraid://").ok_or(Refused::NotOurs)?;
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let mut parts = rest.split('/');
    if parts.next() != Some("open") {
        return Err(Refused::NotOpen);
    }
    let kind = parts.next().unwrap_or_default();
    let id = parts.next().unwrap_or_default();
    if parts.next().is_some() {
        return Err(Refused::BadId);
    }
    let decl = KINDS
        .iter()
        .find(|decl| decl.id == kind)
        .ok_or_else(|| Refused::UnknownKind(kind.to_owned()))?;
    if !is_id(id) {
        return Err(Refused::BadId);
    }
    Ok(Open {
        kind: kind.to_owned(),
        id: id.to_owned(),
        app: decl.app,
    })
}

/// The link for an item.
#[must_use]
pub fn link(kind: &str, id: &str) -> String {
    format!("centraid://open/{kind}/{id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grammar_resolves_entity_to_its_app_route() {
        let parsed = parse("centraid://open/event/event-1").expect("valid item URL");
        assert_eq!(parsed.route_key(), Ok("calendar/event/event-1".to_owned()));
        assert_eq!(parsed.url(), "centraid://open/event/event-1");
    }

    #[test]
    fn routes_are_named_by_each_registered_detail_room() {
        for (kind, route) in [
            ("person", "person"),
            ("event", "calendar/event"),
            ("calendar", "calendar/calendar"),
            ("task", "reminders/task"),
            ("task_list", "reminders/list"),
            ("txn", "money/txn"),
            ("account", "money/account"),
            ("note", "notes/note"),
            ("notebook", "notes/notebook"),
            ("document", "docs/doc"),
            ("folder", "docs/folder"),
            ("photo", "photos/photo"),
            ("album", "photos/album"),
            ("place", "photos/place"),
            ("workout", "health/workout"),
            ("locker_item", "locker/item"),
        ] {
            let open = Open {
                kind: kind.to_owned(),
                id: "item-1".to_owned(),
                app: "unused",
            };
            assert_eq!(open.route_key(), Ok(format!("{route}/item-1")));
        }
    }

    #[test]
    fn grammar_rejects_unknown_or_extra_path_parts() {
        assert!(matches!(
            parse("centraid://open/not_a_kind/item"),
            Err(Refused::UnknownKind(_))
        ));
        assert_eq!(
            parse("centraid://open/event/event-1/edit"),
            Err(Refused::BadId)
        );
        assert_eq!(
            parse("centraid://open/reading/item-1")
                .expect("reading is a kind")
                .route_key(),
            Err(Refused::NoRoom("reading".to_owned()))
        );
    }
}
