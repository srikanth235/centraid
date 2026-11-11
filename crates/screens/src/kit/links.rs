//! LINKS SET BY HAND, ONCE, FOR EVERY SCREEN THAT OFFERS THEM (#1173, O3; #1185): Money's "With" row
//! on a transaction, Photos' "People in this photo", Docs' "About" and Locker's "Linked to", and the
//! general "Linked to" section any item's page can add. Each is an edge the member writes (a link
//! the vault stores under rel `links`); this holds what they share and nothing else. A link joins
//! any linkable kind to any other; a Locker item can start one but is never offered as a target.
//!
//! ## Adopting "Linked to" on a detail screen (any app, any item)
//!
//! 1. State: `links: Links::new(&Kind::all_but(Kind::Task)).for_entity(&id)`, the kinds the page
//!    offers (everything but its own kind) and the id the picker leaves out.
//! 2. Read, in `reload`: `links::read_linked(ctx, &id)` (`shell.links`, both directions) gives a
//!    `Reading<Vec<wire::LinkedItem>>`; keep the `Data` and fold a `Denied` or `Failed` into the
//!    page's status line, never an empty section.
//! 3. Section: `Links::section(locale, ..)` with `links::rows(locale, &linked)` (each row routes to
//!    the linked item's own page; a link written as `[[title]]` in a note's text says "In the text"
//!    and offers no Remove, since editing the text takes it off); the add row is `Links::adds(locale)` and the sheet is
//!    `Links::picker(locale, &links::ids(&linked))`.
//! 4. Update: send each `wire::LinkEvent` to `Links::update(&event, &links::ids(&linked), ctx)`.
//!    On [`Outcome::Add`] call the app's link action with `{ from: id, to: picked, rel: "links" }`
//!    and on [`Outcome::Remove`] its unlink action with the same input (the manifest's `link` and
//!    `unlink` in Calendar, Health, Notes, People and Reminders; the typed actions that take `rel`
//!    in Docs `add-about`/`remove-about`, Locker `add-link`/`remove-link`, Money
//!    `add-with`/`remove-with`, Photos `add-person`/`remove-person`). Write through the Undo door
//!    (`kit::undo`), then `reload`.
//! 5. `Left`: `Links::close`.
//!
//! ## What the four first hosts do
//!
//! Money, Locker, Docs and Photos keep their person-specific API ([`read_people`], [`person_rows`],
//! [`propose`], [`offer`], [`names`], [`person_route`]) and are unchanged.
//!
//! ## How a host screen uses it
//!
//! 1. The host reads what it is linked to ([`read_people`]: `people.links`, the graph's reading of
//!    the edges that start at the thing) with its own data, and builds its section from
//!    [`Links::section`] and its rows from [`person_rows`].
//! 2. A [`wire::LinkEvent`] goes to [`Links::update`], which answers what the host must do: nothing
//!    ([`Outcome::Moved`]), write a link ([`Outcome::Add`]), take one away ([`Outcome::Remove`]),
//!    or settle the proposal ([`Outcome::Accepted`], [`Outcome::Dismissed`]). The host writes with
//!    its own manifest action and reads again; this module never writes.
//! 3. The picker is a sheet over the host: [`Links::picker`] is its finished state. A row that is
//!    linked already is `selected`, and a tap on it takes the link off, so one list adds and removes.
//!    A host that offers four kinds or more draws one "Add link" row, and the sheet lists the kinds
//!    first.
//!
//! ## What is proposed, and what is not
//!
//! [`propose`] reads a payee and the people the member keeps and offers at most one: the one whose
//! whole name the payee says. It is a proposal only. Nothing is written until the member confirms,
//! and "Not them" asks again no sooner than the next time the page opens.
//!
//! The picker lists `shell.link-candidates` of the chosen kind: the first rows by name that hold
//! the typed term, the owner as "You", never the host's own item and never a Locker item. A read
//! that is refused or fails lists nothing, and the sheet says so in its own words.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::link_event::Kind as E;

use crate::catalog::load;
use crate::kit::read::{self, Reading};
use crate::screen::Ctx;
use crate::shell::row_routes::{self, RowRef};
use crate::strings::{Locale, fill, links as words};

/// What a link can point at, as the picker lists it: every item a link may end at (a Locker item
/// never is one, so it has no kind here).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Person,
    Account,
    Place,
    Task,
    Event,
    Note,
    Document,
    Photo,
    Transaction,
    Workout,
}

impl Kind {
    /// Every kind, in the order a host that offers all of them draws them.
    pub const ALL: [Self; 10] = [
        Self::Person,
        Self::Task,
        Self::Event,
        Self::Note,
        Self::Document,
        Self::Photo,
        Self::Transaction,
        Self::Workout,
        Self::Account,
        Self::Place,
    ];

    /// Every kind but `own`: what an item's page offers, since nothing links to itself.
    #[must_use]
    pub fn all_but(own: Self) -> Vec<Self> {
        Self::ALL.into_iter().filter(|kind| *kind != own).collect()
    }

    /// The `LinkAdd.key` the wire carries, and the word the vault's `shell.links` and
    /// `shell.link-candidates` reads use.
    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Account => "account",
            Self::Place => "place",
            Self::Task => "task",
            Self::Event => "event",
            Self::Note => "note",
            Self::Document => "document",
            Self::Photo => "photo",
            Self::Transaction => "transaction",
            Self::Workout => "workout",
        }
    }

    #[must_use]
    pub fn parse(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.key() == key)
    }

    fn wire(self) -> load::shell::LinkCandidatesKind {
        use load::shell::LinkCandidatesKind as K;
        match self {
            Self::Person => K::Person,
            Self::Account => K::Account,
            Self::Place => K::Place,
            Self::Task => K::Task,
            Self::Event => K::Event,
            Self::Note => K::Note,
            Self::Document => K::Document,
            Self::Photo => K::Photo,
            Self::Transaction => K::Transaction,
            Self::Workout => K::Workout,
        }
    }

    /// The kind's word, over a linked row and on the kind chooser ("Task").
    #[must_use]
    pub fn name(self, locale: Locale) -> String {
        match self {
            Self::Person => words::kind_person(locale),
            Self::Account => words::kind_account(locale),
            Self::Place => words::kind_place(locale),
            Self::Task => words::kind_task(locale),
            Self::Event => words::kind_event(locale),
            Self::Note => words::kind_note(locale),
            Self::Document => words::kind_document(locale),
            Self::Photo => words::kind_photo(locale),
            Self::Transaction => words::kind_transaction(locale),
            Self::Workout => words::kind_workout(locale),
        }
    }

    fn add_label(self, locale: Locale) -> String {
        match self {
            Self::Person => words::add_person(locale),
            Self::Account => words::add_account(locale),
            Self::Place => words::add_place(locale),
            Self::Task => words::add_task(locale),
            Self::Event => words::add_event(locale),
            Self::Note => words::add_note(locale),
            Self::Document => words::add_document(locale),
            Self::Photo => words::add_photo(locale),
            Self::Transaction => words::add_transaction(locale),
            Self::Workout => words::add_workout(locale),
        }
    }

    fn placeholder(self, locale: Locale) -> String {
        match self {
            Self::Person => words::search_people(locale),
            Self::Account => words::search_accounts(locale),
            Self::Place => words::search_places(locale),
            Self::Task => words::search_tasks(locale),
            Self::Event => words::search_events(locale),
            Self::Note => words::search_notes(locale),
            Self::Document => words::search_documents(locale),
            Self::Photo => words::search_photos(locale),
            Self::Transaction => words::search_transactions(locale),
            Self::Workout => words::search_workouts(locale),
        }
    }

    fn none(self, locale: Locale) -> String {
        match self {
            Self::Person => words::no_people(locale),
            Self::Account => words::no_accounts(locale),
            Self::Place => words::no_places(locale),
            Self::Task => words::no_tasks(locale),
            Self::Event => words::no_events(locale),
            Self::Note => words::no_notes(locale),
            Self::Document => words::no_documents(locale),
            Self::Photo => words::no_photos(locale),
            Self::Transaction => words::no_transactions(locale),
            Self::Workout => words::no_workouts(locale),
        }
    }
}

/// The app and entity a linked row of this `shell.links` kind opens (`shell::row_routes`); `None`
/// for a kind with no page, whose row is then drawn without a tap.
fn opens(key: &str) -> Option<(&'static str, &'static str)> {
    Some(match key {
        "person" => ("people", "person"),
        "task" => ("reminders", "task"),
        "event" => ("calendar", "event"),
        "note" => ("notes", "note"),
        "document" => ("docs", "document"),
        "photo" => ("photos", "photo"),
        "transaction" => ("money", "transaction"),
        "workout" => ("health", "workout"),
        "account" => ("money", "account"),
        "place" => ("photos", "place"),
        "locker_item" => ("locker", "locker_item"),
        _ => return None,
    })
}

/// A person the member keeps, as the picker and the proposal read them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Person {
    pub id: String,
    pub name: String,
    pub is_owner: bool,
}

/// What an event came to, for the host to act on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Only the sheet or the proposal moved.
    Moved,
    /// Link `id`, of `kind`, to the host's thing.
    Add { kind: Kind, id: String },
    /// Take the link to `id` off.
    Remove { id: String },
}

#[derive(Clone, Debug)]
struct Candidate {
    id: String,
    title: String,
    meta: String,
}

/// Where the sheet is: choosing a kind (a host that offers many), or listing one kind's items.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Chooser,
    Items(Kind),
}

#[derive(Clone, Debug)]
struct Open {
    stage: Stage,
    query: String,
    loaded: bool,
    candidates: Vec<Candidate>,
}

/// A host that offers this many kinds or more draws ONE "Add link" row, and the sheet it opens
/// lists the kinds first (in the picker's own rows: no new element). Fewer are drawn as one
/// "Add ..." row each, as the first four hosts always did.
const CHOOSER_FROM: usize = 4;

/// The `LinkAdd.key` of that one row.
const CHOOSER_KEY: &str = "link";

/// The state a host holds for its links: which kinds it can add, the picker while it is up, and
/// the people it has read.
#[derive(Clone, Debug)]
pub struct Links {
    adds: Vec<Kind>,
    /// The host's own item, which the picker never offers (nothing links to itself).
    own: Option<String>,
    open: Option<Open>,
    people: Option<Vec<Person>>,
}

impl Links {
    /// A host that can add `adds`, in the order its rows are drawn.
    #[must_use]
    pub fn new(adds: &[Kind]) -> Self {
        Self {
            adds: adds.to_vec(),
            own: None,
            open: None,
            people: None,
        }
    }

    /// The same, for the page of the item `id`: the picker leaves `id` out.
    #[must_use]
    pub fn for_entity(mut self, id: &str) -> Self {
        self.own = Some(id.to_owned());
        self
    }

    #[must_use]
    pub fn is_open(&self) -> bool {
        self.open.is_some()
    }

    /// The title of the candidate `id` while the picker lists it: a host that keeps the pick
    /// before there is anything to link it to (the quick add) names it from here.
    #[must_use]
    pub fn candidate_title(&self, id: &str) -> Option<String> {
        let open = self.open.as_ref()?;
        open.candidates
            .iter()
            .find(|candidate| candidate.id == id)
            .map(|candidate| candidate.title.clone())
    }

    /// Close the picker (the thing it served is gone).
    pub fn close(&mut self) {
        self.open = None;
    }

    /// Open the picker on its kinds, as the host's one "Add link" row does, for a host that has no
    /// such row to tap (the quick add's Link key). A host that offers few kinds has no chooser.
    pub fn open_chooser(&mut self) {
        if self.chooses_a_kind() {
            self.open = Some(Open {
                stage: Stage::Chooser,
                query: String::new(),
                loaded: true,
                candidates: Vec::new(),
            });
        }
    }

    fn chooses_a_kind(&self) -> bool {
        self.adds.len() >= CHOOSER_FROM
    }

    /// The people the member keeps, read once: the owner first (as "You"), then the circle in name
    /// order. A read that fails or is refused lists nobody. (The proposal reads these; the picker
    /// reads [`read_candidates`].)
    pub fn people(&mut self, ctx: &Ctx) -> &[Person] {
        if self.people.is_none() {
            self.people = Some(read_roster(ctx));
        }
        self.people.as_deref().unwrap_or_default()
    }

    /// Read what the picker lists again (the data it lists moved).
    pub fn reload(&mut self, ctx: &Ctx) {
        self.people = None;
        let Some((kind, query)) = self.open.as_ref().and_then(|open| match open.stage {
            Stage::Items(kind) => Some((kind, open.query.clone())),
            Stage::Chooser => None,
        }) else {
            return;
        };
        let candidates = self.candidates(kind, &query, ctx);
        if let Some(open) = self.open.as_mut() {
            open.candidates = candidates;
            open.loaded = true;
        }
    }

    fn candidates(&self, kind: Kind, term: &str, ctx: &Ctx) -> Vec<Candidate> {
        read_candidates(ctx, kind, term, self.own.as_deref())
    }

    fn open_items(&mut self, kind: Kind, ctx: &Ctx) {
        let candidates = self.candidates(kind, "", ctx);
        self.open = Some(Open {
            stage: Stage::Items(kind),
            query: String::new(),
            loaded: true,
            candidates,
        });
    }

    /// Take one event. `linked` is the ids the host is linked to now: a tap on one of them in the
    /// picker takes the link off, a tap on any other puts it on.
    pub fn update(&mut self, event: &wire::LinkEvent, linked: &[String], ctx: &Ctx) -> Outcome {
        match &event.kind {
            Some(E::Add(tapped)) => {
                if tapped.key == CHOOSER_KEY && self.chooses_a_kind() {
                    self.open_chooser();
                } else if let Some(kind) =
                    Kind::parse(&tapped.key).filter(|kind| self.adds.contains(kind))
                {
                    self.open_items(kind, ctx);
                }
                Outcome::Moved
            }
            Some(E::Remove(tapped)) => Outcome::Remove {
                id: tapped.id.clone(),
            },
            Some(E::Pick(picked)) => {
                let Some(open) = self.open.take() else {
                    return Outcome::Moved;
                };
                if open.stage == Stage::Chooser {
                    // A tap on a kind: its items take the sheet's place.
                    match Kind::parse(&picked.id).filter(|kind| self.adds.contains(kind)) {
                        Some(kind) => self.open_items(kind, ctx),
                        None => self.open = Some(open),
                    }
                    return Outcome::Moved;
                }
                let Stage::Items(kind) = open.stage else {
                    return Outcome::Moved;
                };
                if !open.candidates.iter().any(|c| c.id == picked.id) {
                    self.open = Some(open);
                    return Outcome::Moved;
                }
                if linked.contains(&picked.id) {
                    Outcome::Remove {
                        id: picked.id.clone(),
                    }
                } else {
                    Outcome::Add {
                        kind,
                        id: picked.id.clone(),
                    }
                }
            }
            Some(E::Query(typed)) => {
                let Some(open) = self.open.as_mut() else {
                    return Outcome::Moved;
                };
                open.query.clone_from(&typed.text);
                // Typing asks the vault again: it answers the first rows whose title holds the
                // term, so a long list is never walked here.
                if let Stage::Items(kind) = open.stage {
                    let term = typed.text.clone();
                    let candidates = self.candidates(kind, &term, ctx);
                    if let Some(open) = self.open.as_mut() {
                        open.candidates = candidates;
                        open.loaded = true;
                    }
                }
                Outcome::Moved
            }
            Some(E::Closed(_)) => {
                self.open = None;
                Outcome::Moved
            }
            None => Outcome::Moved,
        }
    }

    /// The add rows, in the host's order: one per kind, or the one "Add link" row of a host that
    /// offers many.
    #[must_use]
    pub fn adds(&self, locale: Locale) -> Vec<wire::LinkAdd> {
        if self.chooses_a_kind() {
            return vec![wire::LinkAdd {
                key: CHOOSER_KEY.to_owned(),
                label: words::add_link(locale),
            }];
        }
        self.adds
            .iter()
            .map(|kind| wire::LinkAdd {
                key: kind.key().to_owned(),
                label: kind.add_label(locale),
            })
            .collect()
    }

    /// The section: `title`, the host's `rows`, this host's add rows, and what it says when empty.
    #[must_use]
    pub fn section(
        &self,
        locale: Locale,
        title: String,
        rows: Vec<wire::LinkRow>,
        empty: String,
    ) -> wire::LinkSection {
        wire::LinkSection {
            title,
            rows,
            adds: self.adds(locale),
            empty,
        }
    }

    /// The picker sheet. The vault has matched the typed term already; a linked row is `selected`.
    /// On the chooser, the typed words narrow the kinds.
    #[must_use]
    pub fn picker(&self, locale: Locale, linked: &[String]) -> wire::LinkPicker {
        let Some(open) = &self.open else {
            return wire::LinkPicker::default();
        };
        let kind = match open.stage {
            Stage::Items(kind) => kind,
            Stage::Chooser => return self.chooser_picker(locale, open),
        };
        let rows: Vec<wire::LinkRow> = open
            .candidates
            .iter()
            .map(|c| wire::LinkRow {
                id: c.id.clone(),
                title: c.title.clone(),
                meta: c.meta.clone(),
                route: None,
                remove_label: String::new(),
                selected: linked.contains(&c.id),
            })
            .collect();
        let empty = if !rows.is_empty() {
            String::new()
        } else if open.query.trim().is_empty() {
            kind.none(locale)
        } else {
            words::no_match(locale)
        };
        wire::LinkPicker {
            open: true,
            title: kind.add_label(locale),
            query: open.query.clone(),
            placeholder: kind.placeholder(locale),
            candidates: rows,
            empty,
            loaded: open.loaded,
        }
    }

    fn chooser_picker(&self, locale: Locale, open: &Open) -> wire::LinkPicker {
        let needle = open.query.trim().to_lowercase();
        let rows: Vec<wire::LinkRow> = self
            .adds
            .iter()
            .filter(|kind| needle.is_empty() || kind.name(locale).to_lowercase().contains(&needle))
            .map(|kind| wire::LinkRow {
                id: kind.key().to_owned(),
                title: kind.name(locale),
                meta: String::new(),
                route: None,
                remove_label: String::new(),
                selected: false,
            })
            .collect();
        wire::LinkPicker {
            open: true,
            title: words::add_link(locale),
            query: open.query.clone(),
            placeholder: words::search_kinds(locale),
            empty: if rows.is_empty() {
                words::no_match(locale)
            } else {
                String::new()
            },
            candidates: rows,
            loaded: true,
        }
    }
}

/// The items of `kind` the picker offers for a typed `term` (`shell.link-candidates`): the first
/// rows by name whose title holds it, the owner as "You", never `own` (the host's own item). A read
/// that is refused or fails lists nothing, and the sheet says so in its own words.
fn read_candidates(ctx: &Ctx, kind: Kind, term: &str, own: Option<&str>) -> Vec<Candidate> {
    let locale = ctx.locale();
    let Reading::Data(found) = read::read(
        ctx,
        load::shell::LinkCandidates {
            kind: kind.wire(),
            limit: 0,
            term: (!term.trim().is_empty()).then(|| term.trim().to_owned()),
        },
        |answer| match answer {
            Answer::LinkCandidates(found) => Some(found),
            _ => None,
        },
    ) else {
        return Vec::new();
    };
    found
        .candidates
        .into_iter()
        .filter(|row| own != Some(row.id.as_str()))
        .map(|row| Candidate {
            id: row.id,
            title: row.title,
            meta: if row.is_owner {
                words::you(locale)
            } else {
                String::new()
            },
        })
        .collect()
}

/// WHAT THE ITEM `entity_id` IS LINKED TO, whichever page set the link (`shell.links`): a note's
/// link shows on the event it points at. Build the section's rows from it with [`rows`] and the
/// ids the picker marks from it with [`ids`].
pub fn read_linked(ctx: &Ctx, entity_id: &str) -> Reading<Vec<wire::LinkedItem>> {
    read::read(
        ctx,
        load::shell::Links {
            entity_id: entity_id.to_owned(),
        },
        |answer| match answer {
            Answer::LinkedItems(linked) => Some(linked.items),
            _ => None,
        },
    )
}

/// The ids of what a page is linked to: what [`Links::update`] and [`Links::picker`] take as
/// `linked`.
#[must_use]
pub fn ids(linked: &[wire::LinkedItem]) -> Vec<String> {
    linked.iter().map(|item| item.id.clone()).collect()
}

/// The rows of a page's links: the title, the kind over it ("Task", "You" on the owner), a key to
/// take the link off, and the page that opens the linked item (the same routing a search hit
/// takes; an account or a place has no page).
#[must_use]
pub fn rows(locale: Locale, linked: &[wire::LinkedItem]) -> Vec<wire::LinkRow> {
    linked
        .iter()
        .map(|item| {
            let route = opens(&item.kind).and_then(|(app, entity)| {
                row_routes::route(&RowRef::new(app, entity, &item.id, &item.title), "", &[])
            });
            wire::LinkRow {
                id: item.id.clone(),
                title: item.title.clone(),
                meta: if item.in_text {
                    words::in_text(locale)
                } else if item.is_owner {
                    words::you(locale)
                } else {
                    Kind::parse(&item.kind)
                        .map(|kind| kind.name(locale))
                        .unwrap_or_default()
                },
                route,
                // A link written in a note's text has no Remove: the text is edited instead.
                remove_label: if item.in_text {
                    String::new()
                } else {
                    fill(&words::remove(locale), &[("name", item.title.as_str())])
                },
                selected: false,
            }
        })
        .collect()
}

/// The people one transaction, document or photograph is joined to (`people.links`).
pub fn read_people(ctx: &Ctx, entity_id: &str) -> Reading<Vec<wire::PeopleLinked>> {
    read::read(
        ctx,
        load::people::Links {
            entity_id: entity_id.to_owned(),
        },
        |answer| match answer {
            Answer::PeopleLinks(links) => Some(links.people),
            _ => None,
        },
    )
}

/// A person's row in a section: their name, "You" on the owner, a key to take the link off, and
/// the route that opens them.
#[must_use]
pub fn person_row(locale: Locale, id: &str, name: &str, is_owner: bool) -> wire::LinkRow {
    wire::LinkRow {
        id: id.to_owned(),
        title: name.to_owned(),
        meta: if is_owner {
            words::you(locale)
        } else {
            String::new()
        },
        route: Some(person_route(id, name)),
        remove_label: fill(&words::remove(locale), &[("name", name)]),
        selected: false,
    }
}

/// The rows of linked people.
#[must_use]
pub fn person_rows(locale: Locale, people: &[wire::PeopleLinked]) -> Vec<wire::LinkRow> {
    people
        .iter()
        .map(|person| person_row(locale, &person.party_id, &person.name, person.is_owner))
        .collect()
}

/// Who the page says it is with: names joined, or "No one".
#[must_use]
pub fn names(locale: Locale, people: &[wire::PeopleLinked]) -> String {
    if people.is_empty() {
        return words::no_one(locale);
    }
    people
        .iter()
        .map(|person| person.name.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// The wire route People registers a person's page under: a screen never names another app's module.
#[must_use]
pub fn person_route(party_id: &str, name: &str) -> wire::Route {
    wire::Route {
        sheet: false,
        screen: "people.person".to_owned(),
        args: Some(wire::route::Args::PeoplePerson(wire::PeoplePersonRoute {
            party_id: party_id.to_owned(),
            name: name.to_owned(),
            log_touch: false,
        })),
    }
}

/// A proposal as Money's offer: "With Priya?", and the member's two choices.
#[must_use]
pub fn offer(locale: Locale, name: &str) -> wire::MoneyOffer {
    wire::MoneyOffer {
        key: "with".to_owned(),
        title: fill(&words::offer_title(locale), &[("name", name)]),
        body: fill(&words::offer_body(locale), &[("name", name)]),
        detail: String::new(),
        accept_label: words::offer_confirm(locale),
        dismiss_label: words::offer_dismiss(locale),
    }
}

/// Lower-case words, split on anything that is not a letter or a digit.
fn words_of(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// The person a payee names, if exactly one: a person (never the owner, never one already linked)
/// whose whole name, word for word and in order, is among the payee's words. When two people match
/// the longer name wins; a tie proposes nobody, because a guess between two people is no proposal.
#[must_use]
pub fn propose<'a>(payees: &[&str], people: &'a [Person], linked: &[String]) -> Option<&'a Person> {
    let said: Vec<Vec<String>> = payees.iter().map(|payee| words_of(payee)).collect();
    let mut best: Option<(&Person, usize)> = None;
    let mut tied = false;
    for person in people
        .iter()
        .filter(|person| !person.is_owner && !linked.contains(&person.id))
    {
        let name = words_of(&person.name);
        if name.is_empty() || name.iter().map(String::len).sum::<usize>() < 2 {
            continue;
        }
        let named = said.iter().any(|payee| {
            payee
                .windows(name.len())
                .any(|window| window == name.as_slice())
        });
        if !named {
            continue;
        }
        match best {
            Some((_, longest)) if name.len() < longest => {}
            Some((_, longest)) if name.len() == longest => tied = true,
            _ => {
                best = Some((person, name.len()));
                tied = false;
            }
        }
    }
    best.filter(|_| !tied).map(|(person, _)| person)
}

fn read_roster(ctx: &Ctx) -> Vec<Person> {
    let Reading::Data(roster) = read::read(
        ctx,
        load::people::People {
            filter: Some("all".to_owned()),
            limit: 0,
            sort: Some("name".to_owned()),
        },
        |answer| match answer {
            Answer::PeopleRoster(roster) => Some(roster),
            _ => None,
        },
    ) else {
        return Vec::new();
    };
    let mut people = Vec::with_capacity(roster.people.len() + 1);
    if let Some(owner) = roster.owner {
        people.push(Person {
            id: owner.party_id,
            name: owner.name,
            is_owner: true,
        });
    }
    people.extend(roster.people.into_iter().map(|row| Person {
        id: row.party_id,
        name: row.name,
        is_owner: false,
    }));
    people
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person(id: &str, name: &str, is_owner: bool) -> Person {
        Person {
            id: id.to_owned(),
            name: name.to_owned(),
            is_owner,
        }
    }

    #[test]
    fn a_link_written_in_a_notes_text_says_so_and_offers_no_remove() {
        let item = |id: &str, in_text: bool| wire::LinkedItem {
            id: id.to_owned(),
            kind: "note".to_owned(),
            title: format!("Note {id}"),
            is_owner: false,
            in_text,
        };
        let rows = rows(Locale::En, &[item("a", true), item("b", false)]);
        assert_eq!(
            (rows[0].meta.as_str(), rows[0].remove_label.as_str()),
            ("In the text", "")
        );
        assert_eq!(
            (rows[1].meta.as_str(), rows[1].remove_label.as_str()),
            ("Note", "Remove Note b")
        );
    }

    #[test]
    fn every_kind_with_a_page_routes_and_a_kind_without_one_does_not() {
        let row = |kind: &str| wire::LinkedItem {
            id: "x".to_owned(),
            kind: kind.to_owned(),
            title: "T".to_owned(),
            is_owner: false,
            in_text: false,
        };
        for kind in Kind::ALL {
            let rows = rows(Locale::En, &[row(kind.key())]);
            assert!(rows[0].route.is_some(), "{} has a page", kind.key());
        }
        let account = rows(Locale::En, &[row("account")]);
        assert_eq!(
            account[0].route.as_ref().map(|r| r.screen.as_str()),
            Some("money.accounts")
        );
        let place = rows(Locale::En, &[row("place")]);
        assert_eq!(
            place[0].route.as_ref().map(|r| r.screen.as_str()),
            Some("photos.shelf")
        );
        let none = rows(Locale::En, &[row("mystery")]);
        assert!(none[0].route.is_none(), "no page: not tappable");
    }

    #[test]
    fn a_payee_that_says_a_whole_name_proposes_that_person() {
        let people = [person("a", "Priya Rao", false), person("b", "Maya", false)];
        let found = propose(&["UPI PRIYA RAO 4412"], &people, &[]);
        assert_eq!(found.map(|p| p.id.as_str()), Some("a"));
        let one_word = propose(&["Maya's Kitchen"], &people, &[]);
        assert_eq!(one_word.map(|p| p.id.as_str()), Some("b"));
    }

    #[test]
    fn half_a_name_is_not_a_proposal() {
        let people = [person("a", "Priya Rao", false)];
        assert!(propose(&["UPI PRIYA 4412"], &people, &[]).is_none());
        assert!(propose(&["Priyanka Rao"], &people, &[]).is_none());
    }

    #[test]
    fn the_owner_and_a_person_already_linked_are_never_proposed() {
        let people = [person("me", "Srikanth", true), person("a", "Maya", false)];
        assert!(propose(&["Srikanth"], &people, &[]).is_none());
        assert!(propose(&["Maya"], &people, &["a".to_owned()]).is_none());
    }

    #[test]
    fn two_people_the_payee_names_equally_propose_nobody_and_the_longer_name_wins() {
        let people = [
            person("a", "Maya", false),
            person("b", "Maya", false),
            person("c", "Maya Rao", false),
        ];
        assert_eq!(
            propose(&["Maya Rao"], &people, &[]).map(|p| p.id.as_str()),
            Some("c")
        );
        assert!(propose(&["Maya"], &people, &[]).is_none());
    }

    #[test]
    fn the_names_of_the_linked_people_are_joined_or_no_one() {
        let linked = [
            wire::PeopleLinked {
                party_id: "a".into(),
                name: "Maya".into(),
                is_owner: false,
            },
            wire::PeopleLinked {
                party_id: "b".into(),
                name: "Ravi".into(),
                is_owner: false,
            },
        ];
        assert_eq!(names(Locale::En, &linked), "Maya, Ravi");
        assert_eq!(names(Locale::En, &[]), "No one");
    }

    fn linked(id: &str, kind: &str, title: &str, is_owner: bool) -> wire::LinkedItem {
        wire::LinkedItem {
            id: id.to_owned(),
            kind: kind.to_owned(),
            title: title.to_owned(),
            is_owner,
            in_text: false,
        }
    }

    #[test]
    fn every_kind_parses_its_own_key_and_nothing_else_does() {
        for kind in Kind::ALL {
            assert_eq!(Kind::parse(kind.key()), Some(kind), "{}", kind.key());
        }
        let keys: std::collections::BTreeSet<&str> =
            Kind::ALL.iter().map(|kind| kind.key()).collect();
        assert_eq!(keys.len(), Kind::ALL.len(), "two kinds share a key");
        assert_eq!(Kind::parse("locker_item"), None);
        assert_eq!(Kind::parse("link"), None);
        assert_eq!(Kind::parse(""), None);
    }

    #[test]
    fn all_but_leaves_out_the_one_kind_and_never_offers_a_locker_item() {
        for own in Kind::ALL {
            let offered = Kind::all_but(own);
            assert!(!offered.contains(&own), "{} offered to itself", own.key());
            assert_eq!(offered.len(), Kind::ALL.len() - 1);
            assert!(offered.iter().all(|kind| kind.key() != "locker_item"));
        }
        assert!(Kind::ALL.iter().all(|kind| kind.key() != "locker_item"));
    }

    #[test]
    fn every_kind_has_words_in_the_kit() {
        for kind in Kind::ALL {
            assert!(!kind.name(Locale::En).is_empty());
            assert!(!kind.add_label(Locale::En).is_empty());
            assert!(!kind.placeholder(Locale::En).is_empty());
            assert!(!kind.none(Locale::En).is_empty());
        }
    }

    #[test]
    fn a_linked_row_opens_the_page_of_the_kind_it_is() {
        let id = "x1";
        let cases = [
            ("person", Some("people.person")),
            ("task", Some("reminders.task")),
            ("event", Some("calendar.event")),
            ("note", Some("notes.editor")),
            ("document", Some("docs.document")),
            ("photo", Some("photos.lightbox")),
            ("transaction", Some("money.transaction")),
            ("workout", Some("health.workout")),
            ("locker_item", Some("locker.item")),
            ("account", Some("money.accounts")),
            ("place", Some("photos.shelf")),
            ("mystery", None),
        ];
        for (kind, screen) in cases {
            let made = rows(Locale::En, &[linked(id, kind, "T", false)]);
            assert_eq!(made.len(), 1);
            let opened = made[0].route.as_ref();
            assert_eq!(opened.map(|route| route.screen.as_str()), screen, "{kind}");
        }
    }

    #[test]
    fn a_linked_row_says_its_kind_or_you_and_names_what_removing_it_does() {
        let made = rows(
            Locale::En,
            &[
                linked("a", "task", "Pay rent", false),
                linked("b", "person", "Srikanth", true),
            ],
        );
        assert_eq!(made[0].meta, "Task");
        assert_eq!(made[1].meta, "You");
        assert!(made[0].remove_label.contains("Pay rent"));
        assert!(!made[0].selected);
        assert_eq!(
            ids(&[
                linked("a", "task", "t", false),
                linked("b", "note", "n", false)
            ]),
            ["a", "b"]
        );
    }

    #[test]
    fn the_picker_over_candidates_marks_the_linked_ones_selected() {
        let mut links = Links::new(&Kind::all_but(Kind::Note)).for_entity("me");
        links.open = Some(Open {
            stage: Stage::Items(Kind::Task),
            query: String::new(),
            loaded: true,
            candidates: vec![
                Candidate {
                    id: "t1".into(),
                    title: "Pay rent".into(),
                    meta: String::new(),
                },
                Candidate {
                    id: "t2".into(),
                    title: "Call Maya".into(),
                    meta: String::new(),
                },
            ],
        });
        let picker = links.picker(Locale::En, &["t2".to_owned()]);
        assert!(picker.open && picker.loaded);
        assert_eq!(picker.title, "Add task");
        let selected: Vec<(&str, bool)> = picker
            .candidates
            .iter()
            .map(|row| (row.id.as_str(), row.selected))
            .collect();
        assert_eq!(selected, [("t1", false), ("t2", true)]);
        assert!(picker.empty.is_empty());
    }

    #[test]
    fn a_host_of_many_kinds_draws_one_add_row_and_a_sheet_of_kinds() {
        let mut links = Links::new(&Kind::all_but(Kind::Task));
        let adds = links.adds(Locale::En);
        assert_eq!(adds.len(), 1);
        assert_eq!(adds[0].key, "link");
        links.open = Some(Open {
            stage: Stage::Chooser,
            query: String::new(),
            loaded: true,
            candidates: Vec::new(),
        });
        let picker = links.picker(Locale::En, &[]);
        let listed: Vec<&str> = picker.candidates.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(listed.len(), 9);
        assert!(!listed.contains(&"task") && !listed.contains(&"locker_item"));
        let few = Links::new(&[Kind::Person, Kind::Account]);
        assert_eq!(few.adds(Locale::En).len(), 2);
    }
}
