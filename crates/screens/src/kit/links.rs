//! LINKS SET BY HAND, ONCE, FOR EVERY SCREEN THAT OFFERS THEM (#1173, O3): Money's "With" row on a
//! transaction, Photos' "People in this photo", Docs' "About" and Locker's "Linked to". Each is an
//! edge the member writes (`edge.add`, `edge.remove`); this holds what they share and nothing else.
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
//!
//! ## What is proposed, and what is not
//!
//! [`propose`] reads a payee and the people the member keeps and offers at most one: the one whose
//! whole name the payee says. It is a proposal only. Nothing is written until the member confirms,
//! and "Not them" asks again no sooner than the next time the page opens.
//!
//! A person is picked from `people.roster`, an account from `money.accounts` and a place from
//! `photos.places` (named ones only). A read that is refused or fails lists nothing, and the sheet
//! says so in its own words.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::link_event::Kind as E;

use crate::catalog::load;
use crate::kit::read::{self, Reading};
use crate::screen::Ctx;
use crate::strings::{Locale, fill, links as words};

/// What a link can point at, as the picker lists it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Person,
    Account,
    Place,
}

impl Kind {
    /// The `LinkAdd.key` the wire carries.
    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Account => "account",
            Self::Place => "place",
        }
    }

    fn parse(key: &str) -> Option<Self> {
        match key {
            "person" => Some(Self::Person),
            "account" => Some(Self::Account),
            "place" => Some(Self::Place),
            _ => None,
        }
    }

    fn add_label(self, locale: Locale) -> String {
        match self {
            Self::Person => words::add_person(locale),
            Self::Account => words::add_account(locale),
            Self::Place => words::add_place(locale),
        }
    }

    fn placeholder(self, locale: Locale) -> String {
        match self {
            Self::Person => words::search_people(locale),
            Self::Account => words::search_accounts(locale),
            Self::Place => words::search_places(locale),
        }
    }

    fn none(self, locale: Locale) -> String {
        match self {
            Self::Person => words::no_people(locale),
            Self::Account => words::no_accounts(locale),
            Self::Place => words::no_places(locale),
        }
    }
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
    /// The member confirmed the proposal.
    Accepted,
    /// The member waved the proposal off.
    Dismissed,
}

#[derive(Clone, Debug)]
struct Candidate {
    id: String,
    title: String,
    meta: String,
}

#[derive(Clone, Debug)]
struct Open {
    kind: Kind,
    query: String,
    loaded: bool,
    candidates: Vec<Candidate>,
}

/// The state a host holds for its links: which kinds it can add, the picker while it is up, and
/// the people it has read.
#[derive(Clone, Debug)]
pub struct Links {
    adds: Vec<Kind>,
    open: Option<Open>,
    people: Option<Vec<Person>>,
}

impl Links {
    /// A host that can add `adds`, in the order its rows are drawn.
    #[must_use]
    pub fn new(adds: &[Kind]) -> Self {
        Self {
            adds: adds.to_vec(),
            open: None,
            people: None,
        }
    }

    #[must_use]
    pub fn is_open(&self) -> bool {
        self.open.is_some()
    }

    /// Close the picker (the thing it served is gone).
    pub fn close(&mut self) {
        self.open = None;
    }

    /// The people the member keeps, read once: the owner first (as "You"), then the circle in name
    /// order. A read that fails or is refused lists nobody.
    pub fn people(&mut self, ctx: &Ctx) -> &[Person] {
        if self.people.is_none() {
            self.people = Some(read_roster(ctx));
        }
        self.people.as_deref().unwrap_or_default()
    }

    /// Read what the picker lists again (the data it lists moved).
    pub fn reload(&mut self, ctx: &Ctx) {
        self.people = None;
        if let Some(kind) = self.open.as_ref().map(|open| open.kind) {
            let candidates = self.candidates(kind, ctx);
            if let Some(open) = self.open.as_mut() {
                open.candidates = candidates;
                open.loaded = true;
            }
        }
    }

    fn candidates(&mut self, kind: Kind, ctx: &Ctx) -> Vec<Candidate> {
        let locale = ctx.locale();
        match kind {
            Kind::Person => self
                .people(ctx)
                .iter()
                .map(|person| Candidate {
                    id: person.id.clone(),
                    title: person.name.clone(),
                    meta: if person.is_owner {
                        words::you(locale)
                    } else {
                        String::new()
                    },
                })
                .collect(),
            Kind::Account => read_accounts(ctx),
            Kind::Place => read_places(ctx),
        }
    }

    /// Take one event. `linked` is the ids the host is linked to now: a tap on one of them in the
    /// picker takes the link off, a tap on any other puts it on.
    pub fn update(&mut self, event: &wire::LinkEvent, linked: &[String], ctx: &Ctx) -> Outcome {
        match &event.kind {
            Some(E::Add(tapped)) => {
                if let Some(kind) = Kind::parse(&tapped.key).filter(|kind| self.adds.contains(kind))
                {
                    let candidates = self.candidates(kind, ctx);
                    self.open = Some(Open {
                        kind,
                        query: String::new(),
                        loaded: true,
                        candidates,
                    });
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
                        kind: open.kind,
                        id: picked.id.clone(),
                    }
                }
            }
            Some(E::Query(typed)) => {
                if let Some(open) = self.open.as_mut() {
                    open.query.clone_from(&typed.text);
                }
                Outcome::Moved
            }
            Some(E::Closed(_)) => {
                self.open = None;
                Outcome::Moved
            }
            Some(E::Accepted(_)) => Outcome::Accepted,
            Some(E::Dismissed(_)) => Outcome::Dismissed,
            None => Outcome::Moved,
        }
    }

    /// The add rows, in the host's order.
    #[must_use]
    pub fn adds(&self, locale: Locale) -> Vec<wire::LinkAdd> {
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
            offer: None,
            empty,
        }
    }

    /// The picker sheet. Matching is by name, ignoring case; a linked row is `selected`.
    #[must_use]
    pub fn picker(&self, locale: Locale, linked: &[String]) -> wire::LinkPicker {
        let Some(open) = &self.open else {
            return wire::LinkPicker::default();
        };
        let needle = open.query.trim().to_lowercase();
        let rows: Vec<wire::LinkRow> = open
            .candidates
            .iter()
            .filter(|c| needle.is_empty() || c.title.to_lowercase().contains(&needle))
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
        } else if open.candidates.is_empty() {
            open.kind.none(locale)
        } else {
            words::no_match(locale)
        };
        wire::LinkPicker {
            open: true,
            title: open.kind.add_label(locale),
            query: open.query.clone(),
            placeholder: open.kind.placeholder(locale),
            candidates: rows,
            empty,
            loaded: open.loaded,
        }
    }
}

/// The people one transaction, document or photograph is joined to (`people.links`).
pub fn read_people(ctx: &Ctx, entity_id: &str) -> Reading<Vec<wire::PeopleLinked>> {
    match read::read(
        ctx,
        load::people::Links {
            entity_id: entity_id.to_owned(),
        },
        |answer| match answer {
            Answer::PeopleLinks(links) => Some(links.people),
            _ => None,
        },
    ) {
        Reading::Data(people) => Reading::Data(people),
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
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

/// A proposal as an offer: "With Priya?", and the member's two choices.
#[must_use]
pub fn offer(locale: Locale, name: &str) -> wire::LinkOffer {
    wire::LinkOffer {
        title: fill(&words::offer_title(locale), &[("name", name)]),
        body: fill(&words::offer_body(locale), &[("name", name)]),
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

fn read_accounts(ctx: &Ctx) -> Vec<Candidate> {
    let Reading::Data(accounts) =
        read::read(ctx, load::money::Accounts {}, |answer| match answer {
            Answer::MoneyAccounts(accounts) => Some(accounts),
            _ => None,
        })
    else {
        return Vec::new();
    };
    let mut named: Vec<Candidate> = accounts
        .on_budget
        .into_iter()
        .chain(accounts.off_budget)
        .filter(|line| !line.closed)
        .map(|line| Candidate {
            id: line.account_id,
            title: line.name,
            meta: String::new(),
        })
        .collect();
    named.sort_by_cached_key(|candidate| candidate.title.to_lowercase());
    named
}

fn read_places(ctx: &Ctx) -> Vec<Candidate> {
    let Reading::Data(places) = read::read(ctx, load::photos::Places {}, |answer| match answer {
        Answer::PhotosPlaces(places) => Some(places),
        _ => None,
    }) else {
        return Vec::new();
    };
    let mut named: Vec<Candidate> = places
        .places
        .into_iter()
        .filter_map(|card| {
            let name = card.name.filter(|name| !name.trim().is_empty())?;
            Some(Candidate {
                id: card.place?.place_id,
                title: name,
                meta: String::new(),
            })
        })
        .collect();
    named.sort_by_cached_key(|candidate| candidate.title.to_lowercase());
    named
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
}
