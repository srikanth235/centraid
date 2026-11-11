//! PEOPLE'S HOME (`people.home`): People and Touch under ONE band, with Search a
//! field on the current destination and More a sheet.
//!
//! - **People** is the roster, A to Z by default (the Name order; Recently added is the flat
//!   list): the filter (All, Starred, Overdue) and the order
//!   (Recently added, Name) are PARAMETERS of the core's read, so a pick reads
//!   again and the counts stay the whole window's. Both are the header's one
//!   filter menu.
//! - **Touch** is the keep-in-touch dashboard: tiles, Reconnect (most overdue
//!   first, each card with "Log a touch"), Upcoming (nearest first), Recent.
//! - **Search** asks the core's name search; the destination under it is kept, so
//!   closing search reads nothing and clears the term.
//! - **The room's grammar** (R-CHROME-1…4): Add person is the header's one
//!   action beside the filter button, search the bar under it, and More holds
//!   Lists, Import, Export and Trash.
//! - **The star** is a write from the row: it commits at once, the load after it
//!   shows the vault's star, and a refusal's sentence is the status line.
//! - **Contacts** import here ([`ContactsFollow`]): the day-one empty state offers the phone's
//!   contacts. Following the address book is the coordinator's ([`crate::follow`]), whichever
//!   screen is showing; this screen asks it for a pass when it appears and shows what it said.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::people_home_event::Kind as H;
use wire::screen_event::Kind as E;

use super::contacts::ContactsFollow;
use super::{Phase, denied, routes};
use crate::catalog::{act, load};
use crate::follow::Store;
use crate::kit::act as kit_act;
use crate::kit::export;
use crate::kit::menu;
use crate::kit::read;
use crate::kit::search;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, people as words, shared};

mod rows;

/// The More row that stops reading the phone's contacts.
const MORE_STOP: &str = "stop";

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
    Some(Box::new(Home::new(destination)))
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
    /// The member tapped "Stop reading Phone contacts" and has not answered the confirm.
    asking_stop: bool,
    /// The contacts flow has asked the shell whether this device follows.
    attached: bool,
}

impl Home {
    fn new(destination: wire::PeopleDestination) -> Self {
        Self {
            destination,
            chip: wire::PeopleChipKey::All,
            order: wire::PeopleOrder::Name,
            roster: Phase::Loading,
            touch: Phase::Loading,
            search: Search::default(),
            sheet: wire::people_home_state::Sheet::Unspecified,
            status: None,
            contacts: ContactsFollow::new(),
            asking_stop: false,
            attached: false,
        }
    }

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

    /// STOP READING, once the member said so: the status line says what happened, and People goes
    /// on showing the people it already holds.
    fn stop(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        if !std::mem::take(&mut self.asking_stop) {
            return Vec::new();
        }
        let (sentence, refused, effects) = match self.contacts.stop(ctx) {
            Some(effects) => (words::contacts_stopped(locale), false, effects),
            None => (shared::write_refused(locale), true, Vec::new()),
        };
        self.status = Some(wire::StatusLine {
            sentence,
            action_label: String::new(),
            refused,
        });
        self.reload(ctx);
        effects
    }

    fn event(&mut self, event: wire::PeopleHomeEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(kind) = event.kind else {
            return Vec::new();
        };
        match kind {
            H::Refreshed(_) => {
                self.reload(ctx);
                ctx.follows().changed(ctx, Store::Contacts);
            }
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
            // THE HEADER'S MENU belongs to the roster, and is not offered over
            // search or while denied: a pick that arrives anyway is nothing.
            H::FilterMenuPicked(picked) if self.menu_offered() => {
                let pick = menu::Pick::of(&picked);
                if let Some(chip) = rows::chip_of(pick) {
                    self.chip(ctx, chip, false);
                } else if let Some(order) = rows::order_of(pick) {
                    self.set_order(ctx, order);
                }
            }
            H::FilterMenuCleared(_) if self.menu_offered() => {
                self.chip(ctx, wire::PeopleChipKey::All, false);
            }
            H::FilterMenuPicked(_) | H::FilterMenuCleared(_) => {}
            H::Tile(picked) => match picked.key.as_str() {
                "all" => self.chip(ctx, wire::PeopleChipKey::All, true),
                "reconnect" => self.chip(ctx, wire::PeopleChipKey::Due, true),
                "starred" => self.chip(ctx, wire::PeopleChipKey::Starred, true),
                _ => {}
            },
            H::SearchOpened(_) => self.search.open = true,
            H::SearchTerm(typed) => self.search_term(ctx, typed.term),
            H::SearchClosed(_) => self.search_closed(ctx),
            H::SheetClosed(_) => self.sheet = wire::people_home_state::Sheet::Unspecified,
            // THE ONE MORE ROW WITH NO ROUTE: it asks before it stops.
            H::MoreRow(picked) => {
                if picked.key == MORE_STOP && self.contacts.can_stop(ctx) {
                    self.asking_stop = true;
                    self.sheet = wire::people_home_state::Sheet::Unspecified;
                }
            }
            H::StopDismissed(_) => self.asking_stop = false,
            H::StopConfirmed(_) => return self.stop(ctx),
            H::Star(toggled) => self.star(ctx, &toggled.party_id),
            H::ImportContacts(_) => {
                self.status = None;
                return self.contacts.import(ctx);
            }
            H::ContactsAction(_) => {
                self.status = None;
                if self.contacts.needs_settings(ctx) {
                    // THE PHONE SAID NO: only its own Settings can say yes.
                    return vec![wire::Effect {
                        kind: Some(wire::effect::Kind::VaultCommand(wire::VaultCommand {
                            kind: Some(wire::vault_command::Kind::Open(
                                wire::home_status::Destination::Phone as i32,
                            )),
                        })),
                    }];
                }
                return self.contacts.toggle(ctx);
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
            home: words::band_home(locale),
            cancel: words::cancel(locale),
            import_contacts: words::import_contacts(locale),
        }
    }

    /// Is the header's menu offered? On the roster, not over search and not while
    /// the roster is not there (loading, failed or denied).
    fn menu_offered(&self) -> bool {
        self.destination == wire::PeopleDestination::People
            && !self.search.open
            && matches!(self.roster, Phase::Ready(_))
    }

    /// THE HEADER'S FILTER MENU: the roster's filters with their counts and its
    /// order. None on Touch (no filter there), over search, whose names no filter
    /// narrows, or while the roster is not there.
    fn filter_menu(&self, locale: Locale) -> Option<wire::FilterMenu> {
        if !self.menu_offered() {
            return None;
        }
        match &self.roster {
            Phase::Ready(roster) => Some(rows::filter_menu(locale, roster, self.chip, self.order)),
            _ => None,
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

    fn status(&self, ctx: &Ctx) -> Option<wire::StatusLine> {
        self.status
            .clone()
            .or_else(|| self.contacts.status().cloned())
            .or_else(|| {
                ctx.follows()
                    .report(Store::Contacts)
                    .status(ctx, Store::Contacts)
            })
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
        // The contacts flow's own events first: the answers to the effects it asked.
        if let Some(effects) = self.contacts.on_event(&kind, ctx) {
            return effects;
        }
        match kind {
            E::Appeared(_) => {
                self.reload(ctx);
                ctx.follows().changed(ctx, Store::Contacts);
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
                Phase::Ready(answer) => C::Roster(Box::new(rows::roster(
                    locale, answer, self.chip, self.order,
                ))),
            },
        });
        let denied_now = self.denied();
        let state = wire::PeopleHomeState {
            destination: self.destination as i32,
            title: words::app_title(locale),
            band: self.band(locale),
            chrome: Some(Self::chrome(locale)),
            content: Some(content),
            search: Some(self.search_state(locale)),
            more_rows: if denied_now {
                Vec::new()
            } else {
                let back = words::app_title(locale);
                let export = export::entry(locale, super::EXPORT);
                vec![
                    wire::PeopleMoreRow {
                        key: "lists".to_owned(),
                        label: crate::strings::people_lists::more_row(locale),
                        icon_key: "List".to_owned(),
                        route: Some(routes::lists(&back)),
                        meta: String::new(),
                    },
                    wire::PeopleMoreRow {
                        key: "import".to_owned(),
                        label: words::more_import(locale),
                        icon_key: "Download".to_owned(),
                        route: Some(routes::import(&back)),
                        meta: String::new(),
                    },
                    wire::PeopleMoreRow {
                        key: export.key.to_owned(),
                        label: export.label,
                        icon_key: export.icon_key.to_owned(),
                        route: Some(export.route),
                        meta: String::new(),
                    },
                    wire::PeopleMoreRow {
                        key: "trash".to_owned(),
                        label: words::trash_label(locale),
                        icon_key: "Trash".to_owned(),
                        route: Some(routes::trash()),
                        meta: shared::trash_entry_meta(locale),
                    },
                ]
                .into_iter()
                // THE STOP ROW, last (as Health's): the same words for every followed store.
                .chain(self.contacts.can_stop(ctx).then(|| wire::PeopleMoreRow {
                    key: MORE_STOP.to_owned(),
                    label: crate::kit::follow::stop_row(locale, &words::contacts_title(locale)),
                    icon_key: "Stop".to_owned(),
                    route: None,
                    meta: String::new(),
                }))
                .collect()
            },
            sheet: self.sheet as i32,
            status: self.status(ctx),
            contacts: (!denied_now).then(|| self.contacts.row(ctx)),
            stop: (self.asking_stop && !denied_now).then(|| {
                crate::kit::follow::stop_confirm(
                    locale,
                    &words::app_title(locale),
                    &words::contacts_title(locale),
                    &words::contacts_kept(locale),
                )
            }),
            add_person: Some(routes::new_person()),
            filter_menu: self.filter_menu(locale),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::PeopleHome(Box::new(state))),
            ..wire::ViewState::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(search_open: bool, destination: wire::PeopleDestination) -> Home {
        let mut home = Home::new(destination);
        home.roster = Phase::Ready(wire::PeopleRoster::default());
        home.search.open = search_open;
        home
    }

    #[test]
    fn the_menu_is_the_rosters_alone_and_only_once_the_roster_is_there() {
        let locale = Locale::En;
        let people = wire::PeopleDestination::People;
        assert!(ready(false, people).filter_menu(locale).is_some());
        // Over search, no filter narrows a name.
        assert!(ready(true, people).filter_menu(locale).is_none());
        // Touch has nothing to filter.
        assert!(
            ready(false, wire::PeopleDestination::Touch)
                .filter_menu(locale)
                .is_none()
        );
        // Not while loading, failed or denied: no counts to show, nothing to pick.
        for phase in [
            Phase::Loading,
            Phase::Failed,
            Phase::Denied(wire::AppQueryDenial::default()),
        ] {
            let mut home = Home::new(people);
            home.roster = phase;
            assert!(home.filter_menu(locale).is_none());
            assert!(!home.menu_offered());
        }
    }
}
