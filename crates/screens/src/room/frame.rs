//! THE ROOM'S OWN SLOTS (app-plane §5.2): header, band, state, status line, search and selection.
//! The room owns them; a screen only fills them.

use centraid_api_proto::core_v1 as wire;

use super::selector::{Handler, Sel};
use super::ui::Ui;

pub struct Frame(wire::Room);

#[must_use]
pub fn room(kind: wire::RoomKind, key: &str) -> Frame {
    Frame(wire::Room {
        kind: kind as i32,
        key: key.to_owned(),
        header: Some(wire::RoomHeader::default()),
        ..wire::Room::default()
    })
}

impl Frame {
    fn header(&mut self) -> &mut wire::RoomHeader {
        self.0.header.get_or_insert_with(wire::RoomHeader::default)
    }

    #[must_use]
    pub fn title(mut self, title: &str) -> Self {
        self.header().title = title.to_owned();
        self
    }

    #[must_use]
    pub fn subtitle(mut self, subtitle: &str) -> Self {
        self.header().subtitle = subtitle.to_owned();
        self
    }

    /// A scope line the member can clear (✕).
    #[must_use]
    pub fn scope(mut self, sel: &mut Sel, subtitle: &str, clear: Handler) -> Self {
        let id = sel.on("subtitle/clear", clear);
        let header = self.header();
        header.subtitle = subtitle.to_owned();
        header.subtitle_clear_selector_id = id;
        self
    }

    /// Back to the named parent, whose label Rust computed.
    #[must_use]
    pub fn back(mut self, sel: &mut Sel, label: &str) -> Self {
        self.header().back = Some(wire::RoomBack {
            label: label.to_owned(),
            selector_id: sel.on("back", Handler::Back),
        });
        self
    }

    #[must_use]
    pub fn key(
        mut self,
        sel: &mut Sel,
        id: &str,
        role: wire::RoomKeyRole,
        icon: &str,
        label: &str,
        handler: Handler,
    ) -> Self {
        self.header().keys.push(wire::RoomKey {
            selector_id: sel.on(id, handler),
            role: role as i32,
            icon: icon.to_owned(),
            label: label.to_owned(),
            enabled: true,
            menu: None,
        });
        self
    }

    /// A "…" key whose menu holds the page's less common verbs.
    #[must_use]
    pub fn menu_key(mut self, sel: &mut Sel, id: &str, label: &str, menu: wire::RoomMenu) -> Self {
        self.header().keys.push(wire::RoomKey {
            selector_id: sel.anchor(id),
            role: wire::RoomKeyRole::Menu as i32,
            icon: "MoreHoriz".to_owned(),
            label: label.to_owned(),
            enabled: true,
            menu: Some(menu),
        });
        self
    }

    /// The funnel: its whole menu, solid when filtering, and "Clear filters" first.
    #[must_use]
    pub fn filter(mut self, sel: &mut Sel, menu: wire::RoomMenu, ui: &Ui) -> Self {
        let filtering = ui.filtering();
        self.header().filter = Some(wire::RoomFilterMenu {
            menu: Some(menu),
            filtering,
            clear_selector_id: sel.on("filter/clear", Handler::FilterClear),
        });
        self
    }

    #[must_use]
    pub fn band(mut self, band: wire::RoomBand) -> Self {
        self.0.band = Some(band);
        self
    }

    #[must_use]
    pub fn status(
        mut self,
        sel: &mut Sel,
        sentence: &str,
        undo_label: &str,
        refused: bool,
    ) -> Self {
        self.0.status_line = Some(wire::RoomStatusLine {
            sentence: sentence.to_owned(),
            action_label: undo_label.to_owned(),
            action_selector_id: if undo_label.is_empty() {
                String::new()
            } else {
                sel.on("status/undo", Handler::Undo)
            },
            refused,
        });
        self
    }

    #[must_use]
    pub fn search(mut self, sel: &mut Sel, ui: &Ui, placeholder: &str) -> Self {
        let selector_id = sel.on(
            "search",
            if ui.search_open() {
                Handler::SearchTerm
            } else {
                Handler::SearchOpen
            },
        );
        let mut search = wire::RoomSearch {
            open: ui.search_open(),
            selector_id,
            term: ui.search_term().to_owned(),
            placeholder: placeholder.to_owned(),
            ..wire::RoomSearch::default()
        };
        if ui.search_open() {
            search.close_selector_id = sel.on("search/close", Handler::SearchClose);
        }
        self.0.search = Some(search);
        self
    }

    /// The selection bar: the verbs valid for the whole target set.
    #[must_use]
    pub fn selection(
        mut self,
        sel: &mut Sel,
        ui: &Ui,
        label: &str,
        actions: Vec<wire::RoomMenuItem>,
    ) -> Self {
        let on = ui.selecting();
        self.0.selection = Some(wire::RoomSelection {
            on,
            label: if on { label.to_owned() } else { String::new() },
            count: u32::try_from(ui.picked_count()).unwrap_or(u32::MAX),
            select_all_selector_id: if on {
                sel.on("selection/all", Handler::SelectAll)
            } else {
                String::new()
            },
            done_selector_id: if on {
                sel.on("selection/done", Handler::SelectMode(false))
            } else {
                String::new()
            },
            actions: if on { actions } else { Vec::new() },
        });
        self
    }

    #[must_use]
    pub fn secure(mut self) -> Self {
        self.0.secure = true;
        self
    }

    #[must_use]
    pub fn loading(mut self) -> Self {
        self.0.state = Some(wire::room::State::Loading(wire::RoomLoading {}));
        self
    }

    #[must_use]
    pub fn failed(mut self, sel: &mut Sel, sentence: &str, retry_label: &str) -> Self {
        self.0.state = Some(wire::room::State::Failed(wire::RoomFailed {
            sentence: sentence.to_owned(),
            retry_label: retry_label.to_owned(),
            retry_selector_id: sel.on("retry", Handler::Tag("retry".to_owned())),
        }));
        self
    }

    #[must_use]
    pub fn ready(mut self, blocks: Vec<wire::RoomBlock>) -> Self {
        self.0.state = Some(wire::room::State::Ready(wire::RoomReady { blocks }));
        self
    }

    #[must_use]
    pub fn build(self) -> wire::Room {
        self.0
    }
}

#[must_use]
pub fn tab(sel: &mut Sel, id: &str, label: &str, icon: &str, selected: bool) -> wire::RoomTab {
    wire::RoomTab {
        selector_id: sel.on(id, Handler::Tag(format!("tab:{id}"))),
        label: label.to_owned(),
        icon: icon.to_owned(),
        selected,
    }
}

#[must_use]
pub fn band(
    tabs: Vec<wire::RoomTab>,
    home: Option<Handler>,
    search: Option<Handler>,
    sel: &mut Sel,
) -> wire::RoomBand {
    wire::RoomBand {
        tabs,
        home_selector_id: home.map(|h| sel.on("band/home", h)).unwrap_or_default(),
        search_selector_id: search.map(|h| sel.on("band/search", h)).unwrap_or_default(),
        ..wire::RoomBand::default()
    }
}
