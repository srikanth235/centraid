//! PEOPLE'S HOME (`people.home`): People and Touch under ONE band, with Search a
//! field on the current destination and More a sheet.
//!
//! - **People** is the roster: chips (All, Starred, Overdue) and the order
//!   (Recently added, Name) are PARAMETERS of the core's read, so a chip or an
//!   order reads again and the counts stay the whole window's.
//! - **Touch** is the keep-in-touch dashboard: tiles, Reconnect (most overdue
//!   first, each card with "Log a touch"), Upcoming (nearest first), Recent.
//! - **Search** asks the core's name search; the destination under it is kept, so
//!   closing search reads nothing and clears the term.
//! - **The room's grammar** (R-CHROME-1…4): Add person is the header's one
//!   action, search the bar under it, the chips and the sort ONE row, and More
//!   holds Trash alone.
//! - **The star** is a write from the row: it commits at once, the load after it
//!   shows the vault's star, and a refusal's sentence is the status line.
//! - **Contacts** import and follow here ([`ContactsFollow`]): the day-one empty
//!   state offers the phone's contacts, and a pass follows the address book for
//!   as long as this screen lives.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::people_home_event::Kind as H;
use wire::screen_event::Kind as E;

use super::contacts::ContactsFollow;
use super::{Phase, denied, routes};
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::read;
use crate::kit::search;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, people as words};

mod rows;

/// At most what `people.search` asks of the index.
const SEARCH_LIMIT: u32 = 50;

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::PeopleHome(args)) = &route.args else {
        return None;
    };
    let destination = match wire::PeopleDestination::try_from(args.destination) {
        Ok(wire::PeopleDestination::Unspecified) | Err(_) => wire::PeopleDestination::People,
        Ok(destination) => destination,
    };
    Some(Box::new(Home {
        destination,
        chip: wire::PeopleChipKey::All,
        order: wire::PeopleOrder::Recent,
        roster: Phase::Loading,
        touch: Phase::Loading,
        search: Search::default(),
        sheet: wire::people_home_state::Sheet::Unspecified,
        status: None,
        contacts: ContactsFollow::new(),
        attached: false,
    }))
}

/// The search field and its answer.
#[derive(Default)]
struct Search {
    open: bool,
    term: String,
    /// The answer for the trimmed `term`, once there is one to ask.
    held: Option<Phase<wire::PeopleSearch>>,
}

impl Search {
    /// Is a term being answered? Then a read is a search.
    fn active(&self) -> bool {
        self.open && !self.term.trim().is_empty()
    }
}

struct Home {
    destination: wire::PeopleDestination,
    chip: wire::PeopleChipKey,
    order: wire::PeopleOrder,
    roster: Phase<wire::PeopleRoster>,
    touch: Phase<wire::PeopleTouch>,
    search: Search,
    sheet: wire::people_home_state::Sheet,
    /// What a write did, or a refusal's sentence; the page stays.
    status: Option<wire::StatusLine>,
    contacts: ContactsFollow,
    /// The contacts flow has asked the shell whether this device follows.
    attached: bool,
}

impl Home {
    fn reload(&mut self, ctx: &Ctx) {
        if self.search.active() {
            self.search.held = Some(self.read_search(ctx));
            return;
        }
        match self.destination {
            wire::PeopleDestination::Touch => {
                self.touch = Phase::of(read::read(
                    ctx,
                    load::people::Dashboard::default(),
                    |answer| match answer {
                        Answer::PeopleTouch(touch) => Some(touch),
                        _ => None,
                    },
                ));
            }
            _ => {
                let filter = match self.chip {
                    wire::PeopleChipKey::Starred => "starred",
                    wire::PeopleChipKey::Due => "due",
                    _ => "all",
                };
                let sort = match self.order {
                    wire::PeopleOrder::Name => "name",
                    _ => "recent",
                };
                // 0 IS THE DECLARED MAXIMUM: the chips count the whole window.
                let request = load::people::People {
                    filter: Some(filter.to_owned()),
                    limit: 0,
                    sort: Some(sort.to_owned()),
                };
                self.roster = Phase::of(read::read(ctx, request, |answer| match answer {
                    Answer::PeopleRoster(roster) => Some(roster),
                    _ => None,
                }));
            }
        }
    }

    fn read_search(&self, ctx: &Ctx) -> Phase<wire::PeopleSearch> {
        let mut request: wire::LoadRequest = load::people::Search {
            term: self.search.term.trim().to_owned(),
        }
        .into();
        request.limit = SEARCH_LIMIT;
        Phase::of(read::read(ctx, request, |answer| match answer {
            Answer::PeopleSearch(found) => Some(found),
            _ => None,
        }))
    }

    /// The vault will not let People read: the gate has no band and no More.
    fn denied(&self) -> bool {
        match self.destination {
            wire::PeopleDestination::Touch => matches!(self.touch, Phase::Denied(_)),
            _ => matches!(self.roster, Phase::Denied(_)),
        }
    }

    /// Show `destination` from nothing: another list is a fresh page.
    fn go(&mut self, ctx: &Ctx, destination: wire::PeopleDestination) {
        self.destination = destination;
        self.sheet = wire::people_home_state::Sheet::Unspecified;
        self.search = Search::default();
        self.status = None;
        self.reload(ctx);
    }

    /// A chip, which is always the People destination.
    fn chip(&mut self, ctx: &Ctx, chip: wire::PeopleChipKey, force: bool) {
        let chip = match chip {
            wire::PeopleChipKey::Unspecified => wire::PeopleChipKey::All,
            other => other,
        };
        let on_people = self.destination == wire::PeopleDestination::People;
        if chip == self.chip && on_people && !force {
            return;
        }
        self.chip = chip;
        self.destination = wire::PeopleDestination::People;
        self.search = Search::default();
        self.status = None;
        self.reload(ctx);
    }

    fn set_order(&mut self, ctx: &Ctx, order: wire::PeopleOrder) {
        self.sheet = wire::people_home_state::Sheet::Unspecified;
        if order == self.order || order == wire::PeopleOrder::Unspecified {
            return;
        }
        self.order = order;
        // Touch has no order; the roster reads with it next time.
        if self.destination == wire::PeopleDestination::People {
            self.reload(ctx);
        }
    }

    fn search_term(&mut self, ctx: &Ctx, term: String) {
        self.search.open = true;
        self.search.term = term;
        self.search.held = self.search.active().then(|| self.read_search(ctx));
    }

    /// CLOSE CLEARS the term and its answer; the destination comes back.
    fn search_closed(&mut self, ctx: &Ctx) {
        self.search = Search::default();
        self.reload(ctx);
    }

    /// A person on screen, in search or the roster, by id.
    fn find(&self, party_id: &str) -> Option<(String, bool)> {
        let searched = if self.search.active() {
            match &self.search.held {
                Some(Phase::Ready(found)) => Some(&found.people),
                _ => None,
            }
        } else {
            None
        };
        let listed = match &self.roster {
            Phase::Ready(roster) => Some(&roster.people),
            _ => None,
        };
        searched
            .into_iter()
            .chain(listed)
            .flatten()
            .find(|person| person.party_id == party_id)
            .map(|person| (person.name.clone(), person.starred))
    }

    fn star(&mut self, ctx: &Ctx, party_id: &str) {
        let Some((name, starred)) = self.find(party_id) else {
            return;
        };
        let request: wire::ActRequest = if starred {
            act::people::UnstarPerson {
                person_id: party_id.to_owned(),
            }
            .into()
        } else {
            act::people::StarPerson {
                person_id: party_id.to_owned(),
            }
            .into()
        };
        let key = kit_act::key(&[&request.action.clone(), party_id], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        let locale = ctx.locale();
        self.status = Some(if settled.committed {
            plain(fill(
                &if starred {
                    words::outcome_unstarred(locale)
                } else {
                    words::outcome_starred(locale)
                },
                &[("name", &name)],
            ))
        } else {
            refused(settled.refusal)
        });
        self.reload(ctx);
    }

    fn event(&mut self, event: wire::PeopleHomeEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(kind) = event.kind else {
            return Vec::new();
        };
        match kind {
            H::Refreshed(_) => self.reload(ctx),
            // The same destination is nothing; More is a sheet; another is a swap.
            H::Band(picked) => match picked.key.as_str() {
                "more" => self.sheet = wire::people_home_state::Sheet::More,
                "people" if self.destination != wire::PeopleDestination::People => {
                    self.go(ctx, wire::PeopleDestination::People);
                }
                "touch" if self.destination != wire::PeopleDestination::Touch => {
                    self.go(ctx, wire::PeopleDestination::Touch);
                }
                _ => {}
            },
            H::Chip(picked) => self.chip(
                ctx,
                wire::PeopleChipKey::try_from(picked.chip).unwrap_or_default(),
                false,
            ),
            H::Order(picked) => self.set_order(
                ctx,
                wire::PeopleOrder::try_from(picked.order).unwrap_or_default(),
            ),
            H::Tile(picked) => match picked.key.as_str() {
                "all" => self.chip(ctx, wire::PeopleChipKey::All, true),
                "reconnect" => self.chip(ctx, wire::PeopleChipKey::Due, true),
                "starred" => self.chip(ctx, wire::PeopleChipKey::Starred, true),
                _ => {}
            },
            H::SearchOpened(_) => self.search.open = true,
            H::SearchTerm(typed) => self.search_term(ctx, typed.term),
            H::SearchClosed(_) => self.search_closed(ctx),
            H::SheetOpened(opened) => {
                self.sheet = match wire::people_home_state::Sheet::try_from(opened.sheet) {
                    Ok(sheet) => sheet,
                    Err(_) => wire::people_home_state::Sheet::Unspecified,
                };
            }
            H::SheetClosed(_) => self.sheet = wire::people_home_state::Sheet::Unspecified,
            H::Star(toggled) => self.star(ctx, &toggled.party_id),
            H::ImportContacts(_) => {
                self.status = None;
                return self.contacts.import(ctx);
            }
        }
        Vec::new()
    }

    fn band(&self, locale: Locale) -> Vec<wire::PeopleBandTab> {
        if self.denied() {
            return Vec::new();
        }
        let tab = |key: &str, label: String, icon: &str, current: bool| wire::PeopleBandTab {
            key: key.to_owned(),
            label,
            icon_key: icon.to_owned(),
            current,
        };
        let on = |destination| self.destination == destination;
        vec![
            tab(
                "people",
                words::band_people(locale),
                "Users",
                on(wire::PeopleDestination::People),
            ),
            // The catalog's nearest to "keeping in touch": a pulse.
            tab(
                "touch",
                words::band_touch(locale),
                "Activity",
                on(wire::PeopleDestination::Touch),
            ),
            tab("more", words::band_more(locale), "MoreHoriz", false),
        ]
    }

    fn chrome(locale: Locale) -> wire::PeopleHomeChrome {
        wire::PeopleHomeChrome {
            add_person: words::add_person(locale),
            search_label: words::search_label(locale),
            search_placeholder: words::search_placeholder(locale),
            search_close: words::search_close(locale),
            retry: words::retry(locale),
            loading: words::loading(locale),
            more_title: words::more_title(locale),
            sort_heading: words::sort_heading(locale),
            home: words::band_home(locale),
            cancel: words::cancel(locale),
            import_contacts: words::import_contacts(locale),
        }
    }

    fn order_choices(&self, locale: Locale) -> Vec<wire::PeopleOrderChoice> {
        [
            (wire::PeopleOrder::Recent, words::sort_recent(locale)),
            (wire::PeopleOrder::Name, words::sort_name(locale)),
        ]
        .into_iter()
        .map(|(order, label)| wire::PeopleOrderChoice {
            order: order as i32,
            label,
            selected: order == self.order,
        })
        .collect()
    }

    /// THE CHIP ROW: the roster's chips, the current one selected. None on
    /// Touch (no filter there), over search, whose names no chip narrows, or
    /// while the roster is not there.
    fn chips(&self, locale: Locale) -> Vec<wire::PeopleChip> {
        if self.destination != wire::PeopleDestination::People || self.search.open {
            return Vec::new();
        }
        match &self.roster {
            Phase::Ready(roster) => rows::chips(locale, roster, self.chip),
            _ => Vec::new(),
        }
    }

    fn search_state(&self, locale: Locale) -> wire::PeopleSearchState {
        let mut state = wire::PeopleSearchState {
            open: self.search.open,
            term: self.search.term.clone(),
            ..wire::PeopleSearchState::default()
        };
        if !self.search.active() {
            return state;
        }
        if let Some(Phase::Ready(found)) = &self.search.held {
            state.results = Some(rows::search(locale, found));
            if !found.corrected.is_empty() {
                state.corrected = search::corrected(locale, &found.corrected);
            }
            state.ask = Some(search::offer(locale, &self.search.term, "people"));
        }
        state
    }

    fn status(&self) -> Option<wire::StatusLine> {
        self.status
            .clone()
            .or_else(|| self.contacts.status().cloned())
    }
}

fn plain(sentence: String) -> wire::StatusLine {
    wire::StatusLine {
        sentence,
        action_label: String::new(),
        refused: false,
    }
}

fn refused(sentence: String) -> wire::StatusLine {
    wire::StatusLine {
        sentence,
        action_label: String::new(),
        refused: true,
    }
}

impl Screen for Home {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(kind) = event.kind else {
            return Vec::new();
        };
        // The contacts flow's own events first: its timers and the answers to its effects.
        if let Some(effects) = self.contacts.on_event(&kind, ctx) {
            return effects;
        }
        match kind {
            E::Appeared(_) => {
                self.reload(ctx);
                if !self.attached {
                    self.attached = true;
                    return self.contacts.attach();
                }
            }
            E::DataChanged(_) | E::EnvironmentChanged(_) => self.reload(ctx),
            E::PeopleHome(home) => return self.event(home, ctx),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::people_home_state::Content as C;
        let locale = ctx.locale();
        let failure = || C::Failure(read::failure(locale));
        // A search that did not land replaces the destination: it is not an empty one.
        let searched = if self.search.active() {
            match &self.search.held {
                Some(Phase::Failed) => Some(failure()),
                Some(Phase::Denied(denial)) => Some(C::Denied(denied(locale, denial))),
                _ => None,
            }
        } else {
            None
        };
        let content = searched.unwrap_or_else(|| match self.destination {
            wire::PeopleDestination::Touch => match &self.touch {
                Phase::Loading => C::Loading(wire::Loading { first_load: true }),
                Phase::Failed => failure(),
                Phase::Denied(denial) => C::Denied(denied(locale, denial)),
                Phase::Ready(answer) => C::Touch(Box::new(rows::touch(locale, answer))),
            },
            _ => match &self.roster {
                Phase::Loading => C::Loading(wire::Loading { first_load: true }),
                Phase::Failed => failure(),
                Phase::Denied(denial) => C::Denied(denied(locale, denial)),
                Phase::Ready(answer) => {
                    C::Roster(Box::new(rows::roster(locale, answer, self.chip)))
                }
            },
        });
        let chips = self.chips(locale);
        let order = self
            .order_choices(locale)
            .into_iter()
            .find(|choice| choice.selected)
            .map(|choice| choice.label)
            .unwrap_or_default();
        let sort_chip = (!chips.is_empty()).then(|| wire::PeopleSortChip {
            spoken: fill(&words::sort_chip_spoken(locale), &[("order", &order)]),
            label: order,
        });
        let denied_now = self.denied();
        let state = wire::PeopleHomeState {
            destination: self.destination as i32,
            title: words::app_title(locale),
            band: self.band(locale),
            chrome: Some(Self::chrome(locale)),
            content: Some(content),
            chips,
            sort_chip,
            search: Some(self.search_state(locale)),
            more_rows: if denied_now {
                Vec::new()
            } else {
                vec![wire::PeopleMoreRow {
                    key: "trash".to_owned(),
                    label: words::trash_label(locale),
                    icon_key: "Trash".to_owned(),
                    route: Some(routes::trash()),
                }]
            },
            sheet: self.sheet as i32,
            order_choices: self.order_choices(locale),
            status: self.status(),
            add_person: Some(routes::new_person()),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::PeopleHome(Box::new(state))),
            ..wire::ViewState::default()
        }
    }
}
