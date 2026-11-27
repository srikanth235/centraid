//! Room selector registry. Each interactive element has one event address, and duplicate claims are refused.

use std::collections::{BTreeMap, BTreeSet};

use centraid_domain::action::{MAX_TARGETS, Target};
use centraid_domain::catalogue::ACTIONS;

/// What a room refuses to be finished as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomError {
    /// Two elements claimed one selector.
    Repeated(String),
    /// A handler named an action the catalogue does not hold.
    UnknownAction(String),
    /// A set action took no ids or more than the catalogue allows.
    TargetSet(String),
    /// A selector was claimed with no text.
    Empty,
}

impl std::fmt::Display for RoomError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Repeated(id) => write!(f, "selector `{id}` is claimed twice in one room"),
            Self::UnknownAction(name) => write!(f, "`{name}` is not in the action catalogue"),
            Self::TargetSet(name) => write!(f, "`{name}` takes between 1 and {MAX_TARGETS} ids"),
            Self::Empty => f.write_str("a selector must not be empty"),
        }
    }
}

impl std::error::Error for RoomError {}

/// A catalogue action with the input a tap sends it.
#[derive(Debug, Clone, PartialEq)]
pub struct Act {
    pub name: String,
    pub input: serde_json::Value,
}

impl Act {
    /// The action `name` (`kind.verb` or `kind.verb/qualifier`) over `input`.
    #[must_use]
    pub fn new(name: &str, input: serde_json::Value) -> Self {
        Self {
            name: name.to_owned(),
            input,
        }
    }

    fn check(&self) -> Result<(), RoomError> {
        let Some(decl) = ACTIONS.iter().find(|each| each.name() == self.name) else {
            return Err(RoomError::UnknownAction(self.name.clone()));
        };
        if decl.target == Target::Set {
            let count = self
                .input
                .get("ids")
                .and_then(serde_json::Value::as_array)
                .map_or(0, Vec::len);
            if count == 0 || count > MAX_TARGETS {
                return Err(RoomError::TargetSet(self.name.clone()));
            }
        }
        Ok(())
    }
}

/// What a selector does when it is tapped, or its field changes.
#[derive(Debug, Clone, PartialEq)]
pub enum Handler {
    /// Run a catalogue action.
    Act(Act),
    /// Push the room named `key`.
    Open(String),
    /// Open a new chat with this question retained as its draft context.
    Ask(String),
    /// Pop to the parent.
    Back,
    /// The room's own business: the screen is told the tag.
    Tag(String),
    /// Toggle one target in the selection.
    Pick(String),
    /// Turn Select mode on or off.
    SelectMode(bool),
    /// Select every target the room lists.
    SelectAll,
    /// Open the search field.
    SearchOpen,
    /// Close the search field and clear its term (✕).
    SearchClose,
    /// The search field's text.
    SearchTerm,
    /// Toggle one filter item.
    Filter(String),
    /// Clear every filter item.
    FilterClear,
    /// Choose the root lens (view, zoom, list).
    Lens(String),
    /// A text field: its edits land in the field state under this name.
    Field(String),
    /// Answer the status line's Undo.
    Undo,
    /// The next page of the section or canvas that carries this selector.
    NextPage(String),
}

/// The selectors of one room and what each does.
#[derive(Debug, Default, Clone)]
pub struct Sel {
    used: BTreeSet<String>,
    handlers: BTreeMap<String, Handler>,
    errors: Vec<RoomError>,
}

impl Sel {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Claim `id` for `handler` and return the id.
    pub fn on(&mut self, id: impl Into<String>, handler: Handler) -> String {
        let id = self.claim(id);
        if let Handler::Act(act) = &handler
            && let Err(error) = act.check()
        {
            self.errors.push(error);
        }
        self.handlers.insert(id.clone(), handler);
        id
    }

    /// Claim `id` for something that is addressed but does nothing on its own (a scroll anchor, a
    /// row whose tap is its mark's).
    pub fn anchor(&mut self, id: impl Into<String>) -> String {
        self.claim(id)
    }

    fn claim(&mut self, id: impl Into<String>) -> String {
        let id = id.into();
        if id.is_empty() {
            self.errors.push(RoomError::Empty);
        } else if !self.used.insert(id.clone()) {
            self.errors.push(RoomError::Repeated(id.clone()));
        }
        id
    }

    /// Whether `id` was claimed.
    #[must_use]
    pub fn has(&self, id: &str) -> bool {
        self.used.contains(id)
    }

    /// Every selector claimed, in name order.
    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.used.iter().map(String::as_str)
    }

    /// The refusals so far.
    #[must_use]
    pub fn errors(&self) -> &[RoomError] {
        &self.errors
    }

    /// The map, or the first refusal.
    ///
    /// # Errors
    /// A repeated or empty selector, an unknown action, a set action with no ids.
    pub fn finish(self) -> Result<HandlerMap, RoomError> {
        match self.errors.into_iter().next() {
            Some(error) => Err(error),
            None => Ok(HandlerMap {
                handlers: self.handlers,
                anchors: self.used,
            }),
        }
    }
}

/// The finished map of a room.
#[derive(Debug, Default, Clone)]
pub struct HandlerMap {
    handlers: BTreeMap<String, Handler>,
    anchors: BTreeSet<String>,
}

impl HandlerMap {
    #[must_use]
    pub fn get(&self, id: &str) -> Option<&Handler> {
        self.handlers.get(id)
    }

    /// Whether the room holds this selector at all (handler or not).
    #[must_use]
    pub fn knows(&self, id: &str) -> bool {
        self.anchors.contains(id)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.anchors.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.anchors.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_repeated_selector_is_refused_when_the_room_is_finished() {
        let mut sel = Sel::new();
        sel.on("row/1", Handler::Open("note/1".into()));
        sel.on("row/1", Handler::Back);
        assert_eq!(
            sel.finish().unwrap_err(),
            RoomError::Repeated("row/1".into())
        );
    }

    #[test]
    fn an_anchor_and_a_handler_cannot_share_a_selector() {
        let mut sel = Sel::new();
        sel.anchor("row/1");
        sel.on("row/1", Handler::Back);
        assert!(matches!(sel.finish(), Err(RoomError::Repeated(_))));
    }

    #[test]
    fn an_empty_selector_is_refused() {
        let mut sel = Sel::new();
        sel.on("", Handler::Back);
        assert_eq!(sel.finish().unwrap_err(), RoomError::Empty);
    }

    #[test]
    fn an_action_must_be_in_the_catalogue() {
        let mut sel = Sel::new();
        sel.on("x", Handler::Act(Act::new("note.explode", json!({}))));
        assert_eq!(
            sel.finish().unwrap_err(),
            RoomError::UnknownAction("note.explode".into())
        );
    }

    #[test]
    fn a_set_action_takes_between_one_and_the_most_ids() {
        let set = ACTIONS
            .iter()
            .find(|each| each.target == Target::Set)
            .expect("the catalogue has set actions")
            .name();
        let mut none = Sel::new();
        none.on("a", Handler::Act(Act::new(&set, json!({ "ids": [] }))));
        assert!(matches!(none.finish(), Err(RoomError::TargetSet(_))));
        let mut many = Sel::new();
        let ids: Vec<String> = (0..=MAX_TARGETS).map(|n| n.to_string()).collect();
        many.on("a", Handler::Act(Act::new(&set, json!({ "ids": ids }))));
        assert!(matches!(many.finish(), Err(RoomError::TargetSet(_))));
        let mut one = Sel::new();
        one.on("a", Handler::Act(Act::new(&set, json!({ "ids": ["x"] }))));
        assert_eq!(one.finish().unwrap().len(), 1);
    }

    #[test]
    fn distinct_selectors_make_a_map_that_knows_them() {
        let mut sel = Sel::new();
        sel.on("a", Handler::Back);
        sel.anchor("b");
        let map = sel.finish().unwrap();
        assert!(map.get("a").is_some() && map.get("b").is_none());
        assert!(map.knows("b") && !map.knows("c"));
    }
}
