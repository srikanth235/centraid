//! WHAT A ROOM KEEPS BETWEEN BUILDS (app-plane §5, §6): the search field, the selection, the
//! checked filter items, the root lens, how far the room is scrolled and its text fields. The
//! builder reads it; events change it; keep-my-place saves and restores part of it.

use std::collections::BTreeSet;

use centraid_api_proto::core_v1 as wire;

use super::field::Fields;

/// How far a room is scrolled: the first visible row, and 0–999 of how far past it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scroll {
    pub anchor: String,
    pub fraction_milli: u32,
}

/// What a room saves on push and restores on pop. In memory only.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Place {
    pub scroll: Option<Scroll>,
    pub search_term: String,
    pub search_open: bool,
    pub filters: Vec<String>,
    pub lens: String,
}

impl Place {
    #[must_use]
    pub fn wire(&self) -> wire::RoomPlace {
        let (anchor, fraction) = self
            .scroll
            .as_ref()
            .map_or((String::new(), 0), |s| (s.anchor.clone(), s.fraction_milli));
        wire::RoomPlace {
            anchor_selector_id: anchor,
            anchor_fraction_milli: fraction,
            search_term: self.search_term.clone(),
            filter_selector_ids: self.filters.clone(),
            lens: self.lens.clone(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Ui {
    search_open: bool,
    term: String,
    selecting: bool,
    picked: BTreeSet<String>,
    listed: Vec<String>,
    filters: BTreeSet<String>,
    lens: Option<String>,
    scroll: Option<Scroll>,
    pub fields: Fields,
}

impl Ui {
    #[must_use]
    pub fn search_open(&self) -> bool {
        self.search_open
    }

    #[must_use]
    pub fn search_term(&self) -> &str {
        &self.term
    }

    pub fn open_search(&mut self) {
        self.search_open = true;
    }

    pub fn set_term(&mut self, term: &str) {
        self.search_open = true;
        term.clone_into(&mut self.term);
    }

    pub fn close_search(&mut self) {
        self.search_open = false;
        self.term.clear();
    }

    #[must_use]
    pub fn selecting(&self) -> bool {
        self.selecting
    }

    pub fn select_mode(&mut self, on: bool) {
        self.selecting = on;
        if !on {
            self.picked.clear();
        }
    }

    pub fn pick(&mut self, id: &str) {
        if !self.picked.remove(id) {
            self.picked.insert(id.to_owned());
        }
    }

    #[must_use]
    pub fn is_picked(&self, id: &str) -> bool {
        self.picked.contains(id)
    }

    #[must_use]
    pub fn picked_count(&self) -> usize {
        self.picked.len()
    }

    /// The ids the target set holds, in a stable order.
    pub fn picked(&self) -> impl Iterator<Item = &str> {
        self.picked.iter().map(String::as_str)
    }

    /// What the room lists now: what "select all" takes. The builder says it on each build.
    pub fn list(&mut self, ids: impl IntoIterator<Item = String>) {
        self.listed = ids.into_iter().collect();
        self.picked.retain(|id| self.listed.contains(id));
    }

    pub fn pick_all(&mut self) {
        self.picked = self.listed.iter().cloned().collect();
    }

    #[must_use]
    pub fn filtering(&self) -> bool {
        !self.filters.is_empty()
    }

    #[must_use]
    pub fn is_filtered(&self, id: &str) -> bool {
        self.filters.contains(id)
    }

    pub fn toggle_filter(&mut self, id: &str) {
        if !self.filters.remove(id) {
            self.filters.insert(id.to_owned());
        }
    }

    pub fn clear_filters(&mut self) {
        self.filters.clear();
    }

    #[must_use]
    pub fn lens(&self) -> Option<&str> {
        self.lens.as_deref()
    }

    pub fn set_lens(&mut self, lens: &str) {
        self.lens = Some(lens.to_owned());
    }

    pub fn scrolled(&mut self, scroll: Scroll) {
        self.scroll = Some(scroll);
    }

    #[must_use]
    pub fn place(&self) -> Place {
        Place {
            scroll: self.scroll.clone(),
            search_term: self.term.clone(),
            search_open: self.search_open,
            filters: self.filters.iter().cloned().collect(),
            lens: self.lens.clone().unwrap_or_default(),
        }
    }

    pub fn restore(&mut self, place: &Place) {
        self.scroll.clone_from(&place.scroll);
        self.term.clone_from(&place.search_term);
        self.search_open = place.search_open;
        self.filters = place.filters.iter().cloned().collect();
        self.lens = (!place.lens.is_empty()).then(|| place.lens.clone());
    }
}
