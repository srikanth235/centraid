//! LOCKER'S HOME (#1047): Items · Review · Generate, and More as a sheet. One
//! screen, the surface a parameter (law 2). Generate reads nothing; its slot
//! draws the generator. SEARCH IS THE ROOM'S BAR, never a tab (R-CHROME-2/5):
//! opening it lands on the search surface, which no tab names, and closing it
//! goes back to Items.
//!
//! Nothing is read while the wall is up, and a relock drops every answer, the
//! generator's candidate and the clipboard copy the screen made.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::locker_home_event::Kind as H;
use wire::screen_event::Kind as E;

use super::generator::{Generator, system_entropy};
use super::shared::{self, Phase};
use super::wall::{CLIPBOARD_LIFE, Change, Wall};
use super::{handoff, routes};
use crate::catalog::load;
use crate::kit::menu;
use crate::kit::read;
use crate::kit::secret::Secrets;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, locker as words};

/// The filter section's key (`locker-filter-show-starred` on a screen); its
/// options are keyed `all`, `starred`, `archived` and each type's key.
pub const FILTER: &str = "show";
pub const ALL: &str = "all";
pub const STARRED: &str = "starred";
pub const ARCHIVED: &str = "archived";
/// The items that make verification codes: a filter and a category card.
pub const CODES: &str = "codes";
/// The category cards' keys that are not filters.
pub const REVIEW: &str = "review";
pub const TRASH: &str = "trash";
/// Starred and Recently used list at most this many rows on the landing; the
/// Starred filter lists them all.
pub const LANDING_ROWS: usize = 5;

/// The distinct items Review lists: an item with two verdicts counts once.
#[must_use]
pub fn review_count(review: &wire::LockerReview) -> u32 {
    let ids: std::collections::BTreeSet<&str> = [
        &review.compromised,
        &review.insecure_address,
        &review.expired,
        &review.expiring,
    ]
    .into_iter()
    .flatten()
    .map(|row| row.item_id.as_str())
    .collect();
    u32::try_from(ids.len()).unwrap_or(u32::MAX)
}

/// The rows "Recently used" lists, in the core's order (newest use first).
fn recent_of(answer: &wire::LockerItems) -> Vec<&wire::LockerItemRow> {
    answer
        .recent_ids
        .iter()
        .filter_map(|id| answer.items.iter().find(|row| &row.item_id == id))
        .collect()
}

/// The word a category's list is titled with: the filter's own label.
fn list_title(locale: Locale, filter: &str) -> String {
    match filter {
        ALL => words::category_all(locale),
        STARRED => words::filter_starred(locale),
        ARCHIVED => words::filter_archived(locale),
        CODES => words::category_codes(locale),
        kind => (super::types::of(kind).plural)(locale),
    }
}

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::LockerHome(args)) = &route.args else {
        return None;
    };
    let destination = match wire::LockerDestination::try_from(args.destination) {
        Ok(wire::LockerDestination::Unspecified) | Err(_) => wire::LockerDestination::Items,
        Ok(destination) => destination,
    };
    Some(Box::new(Home::new(destination, system_entropy())))
}

/// A factory whose generator draws from `entropy`; tests inject a fixed stream.
pub fn build_with(
    entropy: impl Fn() -> super::generator::Entropy + Send + Sync + 'static,
) -> impl Fn(&wire::Route) -> Option<Box<dyn Screen>> + Send + Sync + 'static {
    move |route| {
        let destination = match &route.args {
            Some(wire::route::Args::LockerHome(args)) => {
                wire::LockerDestination::try_from(args.destination)
                    .unwrap_or(wire::LockerDestination::Items)
            }
            _ => return None,
        };
        Some(Box::new(Home::new(destination, entropy())) as Box<dyn Screen>)
    }
}

struct Home {
    wall: Wall,
    secrets: Secrets,
    destination: wire::LockerDestination,
    sheet: wire::locker_home_state::Sheet,
    filter: String,
    /// The category whose list the page shows; `None` is the landing of
    /// category cards, Starred and Recently used.
    browsing: Option<String>,
    search_open: bool,
    term: String,
    items: Phase<wire::LockerItems>,
    review: Phase<wire::LockerReview>,
    hits: Phase<wire::LockerSearch>,
    generator: Generator,
    status: Option<wire::StatusLine>,
}

impl Home {
    fn new(destination: wire::LockerDestination, entropy: super::generator::Entropy) -> Self {
        Self {
            wall: Wall::default(),
            secrets: Secrets::view_shielded(),
            destination,
            sheet: wire::locker_home_state::Sheet::None,
            filter: ALL.to_owned(),
            browsing: None,
            search_open: false,
            term: String::new(),
            items: Phase::Loading,
            review: Phase::Loading,
            hits: Phase::Loading,
            generator: Generator::new(entropy),
            status: None,
        }
    }

    // --- reads ---------------------------------------------------------------

    /// Read what the surface on screen shows — and nothing while locked.
    fn reload(&mut self, ctx: &Ctx) {
        if !self.wall.is_open() {
            return;
        }
        use wire::LockerDestination as D;
        match self.destination {
            D::Review => {
                self.review = Phase::of(read::read(
                    ctx,
                    load::locker::Review::default(),
                    |a| match a {
                        Answer::LockerReview(review) => Some(review),
                        _ => None,
                    },
                ));
            }
            D::Search if !self.term.trim().is_empty() => {
                self.hits = Phase::of(read::read(
                    ctx,
                    load::locker::Search {
                        term: self.term.clone(),
                    },
                    |a| match a {
                        Answer::LockerSearch(search) => Some(search),
                        _ => None,
                    },
                ));
            }
            // Items — and Generate and an empty search, which read the shelf so
            // a change event on them re-reads something true.
            _ => {
                self.read_items(ctx);
                // The Review card counts what Review would list.
                if self.destination == D::Items {
                    self.review = Phase::of(read::read(
                        ctx,
                        load::locker::Review::default(),
                        |a| match a {
                            Answer::LockerReview(review) => Some(review),
                            _ => None,
                        },
                    ));
                }
            }
        }
    }

    fn read_items(&mut self, ctx: &Ctx) {
        self.items = Phase::of(read::read(
            ctx,
            load::locker::Items {
                archived: Some(self.filter == ARCHIVED),
                limit: 0,
            },
            |a| match a {
                Answer::LockerItems(items) => Some(items),
                _ => None,
            },
        ));
    }

    /// A RELOCK KEEPS WHERE THE MEMBER WAS — the tab and the filter — and
    /// nothing of what they saw; search is closed, because a term is content.
    fn wipe(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        self.items = Phase::Loading;
        self.review = Phase::Loading;
        self.hits = Phase::Loading;
        self.search_open = false;
        self.term.clear();
        self.sheet = wire::locker_home_state::Sheet::None;
        self.status = None;
        self.generator.forget();
        handoff::clear();
        let mut effects = self.secrets.hide_all(ctx);
        effects.extend(self.secrets.clear_clip(ctx));
        if self.destination == wire::LockerDestination::Search {
            self.destination = wire::LockerDestination::Items;
        }
        effects
    }

    /// THE MEMBER LOCKED BY HAND (the header's key, More's Lock row): the wall closes and the
    /// page wipes what it held.
    fn lock_now(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let step = self.wall.event(
            ctx,
            wire::LockerWallEvent {
                kind: Some(wire::locker_wall_event::Kind::Lock(
                    wire::locker_wall_event::LockTapped {},
                )),
            },
        );
        self.walled(ctx, step)
    }

    /// Apply what the wall did to the page under it.
    fn walled(&mut self, ctx: &Ctx, step: super::wall::Step) -> Vec<wire::Effect> {
        let mut effects = step.effects;
        match step.change {
            Change::Opened => {
                self.generator.regenerate();
                self.reload(ctx);
            }
            Change::Closed => effects.extend(self.wipe(ctx)),
            Change::None => {}
        }
        effects
    }

    // --- events --------------------------------------------------------------

    /// Change the Items filter to `key`, an option of the menu's one section.
    fn set_filter(&mut self, ctx: &Ctx, key: &str) {
        if key == self.filter {
            return;
        }
        let shelf_changed = (key == ARCHIVED) != (self.filter == ARCHIVED);
        key.clone_into(&mut self.filter);
        // THE ARCHIVED SHELF IS ANOTHER READ ("keep forever, hide from lists" --
        // asked for, never filtered out of the live one); every other filter
        // re-folds the shelf already held.
        if shelf_changed {
            self.items = Phase::Loading;
            self.read_items(ctx);
        }
    }

    /// A category card's pick: a filter the page browses, or Review.
    fn pick_category(&mut self, ctx: &Ctx, key: &str) {
        match key {
            REVIEW => self.goto(ctx, wire::LockerDestination::Review),
            // Trash is a page the card's route opens; nothing to do here.
            TRASH => {}
            _ => {
                let filter = match key {
                    "all" => ALL,
                    CODES => CODES,
                    other => other,
                };
                self.set_filter(ctx, filter);
                self.browsing = Some(filter.to_owned());
            }
        }
    }

    /// Back to the landing: no category open, no filter.
    fn close_category(&mut self, ctx: &Ctx) {
        self.set_filter(ctx, ALL);
        self.browsing = None;
    }

    fn goto(&mut self, ctx: &Ctx, destination: wire::LockerDestination) {
        self.destination = destination;
        self.sheet = wire::locker_home_state::Sheet::None;
        if destination != wire::LockerDestination::Search {
            self.search_open = false;
            self.term.clear();
        }
        if destination != wire::LockerDestination::Generate {
            self.reload(ctx);
        }
    }

    fn event(&mut self, event: wire::LockerHomeEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::LockerDestination as D;
        let mut effects = Vec::new();
        match event.kind {
            Some(H::Band(band)) => match band.key.as_str() {
                "more" => self.sheet = wire::locker_home_state::Sheet::More,
                "items" if self.destination != D::Items => self.goto(ctx, D::Items),
                // The Items key on a category's list is the way back to the landing.
                "items" if self.browsing.is_some() => self.close_category(ctx),
                "review" if self.destination != D::Review => self.goto(ctx, D::Review),
                "generate" if self.destination != D::Generate => self.goto(ctx, D::Generate),
                _ => {}
            },
            Some(H::FilterMenuPicked(picked)) => {
                let pick = menu::Pick::of(&picked);
                if pick.section == FILTER {
                    self.set_filter(ctx, pick.option);
                    self.browsing = Some(pick.option.to_owned());
                }
            }
            Some(H::FilterMenuCleared(_)) => self.close_category(ctx),
            Some(H::CategoryPicked(picked)) => self.pick_category(ctx, &picked.key),
            Some(H::CategoryClosed(_)) => self.close_category(ctx),
            Some(H::SheetOpened(opened)) => {
                self.sheet = wire::locker_home_state::Sheet::try_from(opened.sheet)
                    .unwrap_or(wire::locker_home_state::Sheet::None);
            }
            Some(H::SheetClosed(_)) => self.sheet = wire::locker_home_state::Sheet::None,
            Some(H::SearchOpened(_)) => {
                self.search_open = true;
                self.goto(ctx, D::Search);
            }
            Some(H::SearchTyped(typed)) => {
                self.search_open = true;
                self.destination = D::Search;
                self.term = typed.term;
                if self.term.trim().is_empty() {
                    self.hits = Phase::Loading;
                } else {
                    self.reload(ctx);
                }
            }
            // CLOSING CLEARS (R-1046-6): the term and its hits.
            Some(H::SearchClosed(_)) => {
                self.hits = Phase::Loading;
                self.search_open = false;
                self.term.clear();
                self.goto(ctx, D::Items);
            }
            Some(H::More(more)) => match more.key.as_str() {
                "facts" => self.sheet = wire::locker_home_state::Sheet::Facts,
                "lock" => effects.extend(self.lock_now(ctx)),
                // A page the shell pushes: the sheet closes behind the tap.
                _ => self.sheet = wire::locker_home_state::Sheet::None,
            },
            // THE HEADER'S LOCK KEY: the same lock as More's row.
            Some(H::LockRequested(_)) => effects.extend(self.lock_now(ctx)),
            Some(H::Refreshed(_)) => self.reload(ctx),
            Some(H::GeneratorKind(picked)) => self.generator.pick_kind(&picked.key),
            Some(H::GeneratorLength(length)) => self.generator.set_length(length.length),
            Some(H::GeneratorInclude(toggled)) => self.generator.toggle(&toggled.key),
            Some(H::GeneratorRegenerate(_)) => self.generator.regenerate(),
            Some(H::GeneratorCopy(_)) => {
                let output = self.generator.output().to_owned();
                if !output.is_empty() {
                    effects.extend(self.secrets.copy(ctx, &output, CLIPBOARD_LIFE));
                    self.status = shared::status(words::generated_copied(ctx.locale()));
                }
            }
            Some(H::GeneratorUsed(_)) => handoff::put(self.generator.output()),
            None => {}
        }
        effects
    }

    // --- views ---------------------------------------------------------------

    fn items_data(&self, locale: Locale, answer: &wire::LockerItems) -> wire::LockerHomeData {
        let filter = self.filter.as_str();
        let shown: Vec<&wire::LockerItemRow> = match filter {
            ALL | ARCHIVED => answer.items.iter().collect(),
            STARRED => answer.items.iter().filter(|row| row.starred).collect(),
            CODES => answer.items.iter().filter(|row| row.has_code).collect(),
            kind => answer
                .items
                .iter()
                .filter(|row| row.r#type == kind)
                .collect(),
        };
        let total = answer.total;
        let mut options = vec![menu::counted(
            ALL,
            words::filter_all(locale),
            total.unwrap_or(0),
            filter == ALL,
        )];
        let starred = answer.items.iter().filter(|row| row.starred).count();
        if starred > 0 || filter == STARRED {
            options.push(menu::counted(
                STARRED,
                words::filter_starred(locale),
                u32::try_from(starred).unwrap_or(u32::MAX),
                filter == STARRED,
            ));
        }
        let codes = answer.items.iter().filter(|row| row.has_code).count();
        if codes > 0 || filter == CODES {
            options.push(menu::counted(
                CODES,
                words::category_codes(locale),
                u32::try_from(codes).unwrap_or(u32::MAX),
                filter == CODES,
            ));
        }
        for by_type in &answer.by_type {
            options.push(menu::counted(
                by_type.r#type.clone(),
                (super::types::of(&by_type.r#type).plural)(locale),
                by_type.count,
                filter == by_type.r#type,
            ));
        }
        let archived = answer.archived_count.unwrap_or(0);
        if archived > 0 || filter == ARCHIVED {
            options.push(menu::counted(
                ARCHIVED,
                words::filter_archived(locale),
                archived,
                filter == ARCHIVED,
            ));
        }
        // LIT while anything but All narrows the list. A lone All is nothing to
        // choose between, so no button.
        let filter_menu = (options.len() > 1 || filter != ALL).then(|| {
            menu::menu(
                locale,
                vec![menu::single(FILTER, words::filter_title(locale), options)],
                filter != ALL,
            )
        });
        let day_one = filter == ALL && total == Some(0) && archived == 0;
        let empty = if !shown.is_empty() {
            None
        } else if day_one {
            Some(wire::EmptyState {
                headline: words::day_one(locale),
                body: words::day_one_body(locale),
                action_label: words::day_one_action(locale),
                ..wire::EmptyState::default()
            })
        } else if filter == ARCHIVED {
            Some(wire::EmptyState {
                headline: words::archived_empty(locale),
                body: words::archived_empty_body(locale),
                ..wire::EmptyState::default()
            })
        } else {
            Some(wire::EmptyState {
                headline: words::filter_empty(locale),
                ..wire::EmptyState::default()
            })
        };
        let window = match (answer.truncated, total) {
            (true, Some(total)) if filter == ALL => fill(
                &words::window(locale),
                &[
                    ("shown", &answer.items.len().to_string()),
                    ("total", &total.to_string()),
                ],
            ),
            (true, _) => words::window_unknown(locale),
            _ => String::new(),
        };
        let parent = words::app_name(locale);
        if self.browsing.is_none() {
            // THE LANDING: category cards, then Starred and Recently used.
            return wire::LockerHomeData {
                status_line: words::unlocked_status(locale),
                filter_menu,
                categories: if day_one {
                    Vec::new()
                } else {
                    self.categories(locale, answer)
                },
                starred_title: words::filter_starred(locale),
                starred: answer
                    .items
                    .iter()
                    .filter(|row| row.starred)
                    .take(LANDING_ROWS)
                    .map(|row| shared::row(locale, row, &parent))
                    .collect(),
                recent_title: words::recent_head(locale),
                recent: recent_of(answer)
                    .into_iter()
                    .map(|row| shared::row(locale, row, &parent))
                    .collect(),
                items_empty: if day_one { empty } else { None },
                ..wire::LockerHomeData::default()
            };
        }
        let list_title = list_title(locale, filter);
        wire::LockerHomeData {
            status_line: words::items_status(locale),
            filter_menu,
            rows: shown
                .into_iter()
                .map(|row| shared::row(locale, row, &parent))
                .collect(),
            window,
            items_empty: empty,
            list_title,
            list_back_label: parent,
            ..wire::LockerHomeData::default()
        }
    }

    /// The six cards, in the board's order, each with its own count.
    fn categories(&self, locale: Locale, answer: &wire::LockerItems) -> Vec<wire::LockerCategory> {
        let of_type = |kind: &str| {
            answer
                .by_type
                .iter()
                .find(|count| count.r#type == kind)
                .map_or(0, |count| count.count)
        };
        let live = answer.items.iter().filter(|row| !row.archived);
        let codes = u32::try_from(live.filter(|row| row.has_code).count()).unwrap_or(u32::MAX);
        let review = match &self.review {
            Phase::Ready(review) => review_count(review),
            _ => 0,
        };
        let card = |key: &str, label: String, count: u32, icon: &str, color: &str| {
            let spoken = format!("{label}, {}", shared::items(locale, u64::from(count)));
            wire::LockerCategory {
                key: key.to_owned(),
                label,
                count,
                icon_key: icon.to_owned(),
                color_key: color.to_owned(),
                route: None,
                accessibility_label: spoken,
            }
        };
        let mut trash = card(
            TRASH,
            words::category_trash(locale),
            answer.trashed_count.unwrap_or(0),
            "Trash",
            "graphite",
        );
        trash.route = Some(routes::trash());
        vec![
            card(
                "all",
                words::category_all(locale),
                answer.total.unwrap_or(0),
                "Key",
                "blue",
            ),
            card(
                CODES,
                words::category_codes(locale),
                codes,
                "Hash",
                "indigo",
            ),
            card(
                "card",
                words::category_cards(locale),
                of_type("card"),
                "Coin",
                "violet",
            ),
            card(
                "wifi",
                words::category_wifi(locale),
                of_type("wifi"),
                "Wifi",
                "petrol",
            ),
            card(
                REVIEW,
                words::category_review(locale),
                review,
                "Shield",
                "raspberry",
            ),
            trash,
        ]
    }

    fn review_data(locale: Locale, answer: &wire::LockerReview) -> wire::LockerHomeData {
        let parent = words::app_name(locale);
        let verdicts = [
            (
                "compromised",
                words::review_compromised(locale),
                words::review_compromised_reason(locale),
                &answer.compromised,
            ),
            (
                "insecure_address",
                words::review_http(locale),
                words::review_http_reason(locale),
                &answer.insecure_address,
            ),
            (
                "expired",
                words::review_expired(locale),
                words::review_expired_reason(locale),
                &answer.expired,
            ),
            (
                "expiring",
                words::review_expiring(locale),
                words::review_expiring_reason(locale),
                &answer.expiring,
            ),
        ];
        let sections: Vec<wire::LockerReviewSection> = verdicts
            .into_iter()
            .filter(|(_, _, _, rows)| !rows.is_empty())
            .map(|(key, title, reason, rows)| wire::LockerReviewSection {
                key: key.to_owned(),
                head: Some(wire::LockerSectionHead {
                    title,
                    count: u32::try_from(rows.len()).unwrap_or(u32::MAX),
                }),
                reason,
                rows: rows
                    .iter()
                    .map(|row| shared::row(locale, row, &parent))
                    .collect(),
            })
            .collect();
        let clear = if answer.reviewed == 0 {
            Some(wire::EmptyState {
                headline: words::review_nothing(locale),
                ..wire::EmptyState::default()
            })
        } else if sections.is_empty() {
            Some(wire::EmptyState {
                headline: words::review_clear(locale),
                body: words::review_clear_body(locale),
                ..wire::EmptyState::default()
            })
        } else {
            None
        };
        wire::LockerHomeData {
            status_line: words::items_status(locale),
            review: sections,
            review_unchecked_title: words::review_unchecked(locale),
            review_unchecked: vec![
                wire::LockerFact {
                    label: words::review_weak(locale),
                    detail: words::review_weak_reason(locale),
                },
                wire::LockerFact {
                    label: words::review_breach(locale),
                    detail: words::review_breach_reason(locale),
                },
            ],
            review_clear: clear,
            review_note: fill(
                &if answer.truncated {
                    words::review_note_truncated(locale)
                } else {
                    words::review_note(locale)
                },
                &[("items", &shared::items(locale, u64::from(answer.reviewed)))],
            ),
            ..wire::LockerHomeData::default()
        }
    }

    fn search_data(&self, locale: Locale) -> wire::LockerHomeData {
        let base = wire::LockerHomeData {
            status_line: words::items_status(locale),
            ..wire::LockerHomeData::default()
        };
        let Some(answer) = self.hits.data().filter(|_| !self.term.trim().is_empty()) else {
            return base;
        };
        wire::LockerHomeData {
            hits: answer
                .items
                .iter()
                .map(|row| shared::row(locale, row, &words::app_name(locale)))
                .collect(),
            search_empty: answer.items.is_empty().then(|| wire::EmptyState {
                headline: fill(&words::search_empty(locale), &[("term", &answer.term)]),
                body: words::search_note(locale),
                ..wire::EmptyState::default()
            }),
            ..base
        }
    }

    fn content(&self, locale: Locale) -> Option<wire::locker_home_state::Content> {
        use wire::LockerDestination as D;
        use wire::locker_home_state::Content as C;
        if !self.wall.is_open() {
            return None;
        }
        Some(match self.destination {
            D::Generate => C::Data(Box::new(wire::LockerHomeData {
                status_line: words::items_status(locale),
                generator: Some(self.generator.view(locale)),
                ..wire::LockerHomeData::default()
            })),
            D::Review => match &self.review {
                Phase::Loading => C::Loading(wire::Loading { first_load: true }),
                Phase::Failed => C::Failure(read::failure(locale)),
                Phase::Denied(denial) => C::Denied(shared::denied(locale, denial)),
                Phase::Ready(answer) => C::Data(Box::new(Self::review_data(locale, answer))),
            },
            D::Search => C::Data(Box::new(self.search_data(locale))),
            _ => match &self.items {
                Phase::Loading => C::Loading(wire::Loading { first_load: true }),
                Phase::Failed => C::Failure(read::failure(locale)),
                Phase::Denied(denial) => C::Denied(shared::denied(locale, denial)),
                Phase::Ready(answer) => C::Data(Box::new(self.items_data(locale, answer))),
            },
        })
    }

    fn band(&self, locale: Locale) -> Vec<wire::LockerBandTab> {
        use wire::LockerDestination as D;
        let denied = matches!(
            (self.destination, &self.items, &self.review),
            (D::Items, Phase::Denied(_), _) | (D::Review, _, Phase::Denied(_))
        );
        if !self.wall.is_open() || denied {
            return Vec::new();
        }
        let tab = |key: &str, label: String, icon: &str, current: bool| wire::LockerBandTab {
            key: key.to_owned(),
            label,
            icon_key: icon.to_owned(),
            current,
        };
        vec![
            tab(
                "items",
                words::band_items(locale),
                "Key",
                self.destination == D::Items,
            ),
            tab(
                "review",
                words::band_review(locale),
                "Shield",
                self.destination == D::Review,
            ),
            tab(
                "generate",
                words::band_generate(locale),
                "Sparkle",
                self.destination == D::Generate,
            ),
            tab("more", words::band_more(locale), "MoreHoriz", false),
        ]
    }

    fn chrome(locale: Locale) -> wire::LockerHomeChrome {
        let parent = words::app_name(locale);
        let more =
            |key: &str, label: String, meta: String, icon: &str, route: Option<wire::Route>| {
                wire::LockerMoreRow {
                    key: key.to_owned(),
                    label,
                    meta,
                    icon_key: icon.to_owned(),
                    route,
                }
            };
        wire::LockerHomeChrome {
            title: parent.clone(),
            add_label: words::add_item(locale),
            add_route: Some(routes::add("", false)),
            lock_label: words::lock_key(locale),
            retry: words::retry(locale),
            more_title: words::more_title(locale),
            // THE HANDOFF'S MORE ROWS, in its order, as far as the phone has
            // them: Import, Trash and Export — then what the phone adds, the
            // facts and the Lock. There is no Access history (#1146): the
            // Locker keeps no log to show.
            more_rows: vec![
                more(
                    "import",
                    words::more_import(locale),
                    words::more_import_meta(locale),
                    "Download",
                    Some(routes::import(&parent)),
                ),
                more(
                    "trash",
                    words::more_trash(locale),
                    words::more_trash_meta(locale),
                    "Trash",
                    Some(routes::trash()),
                ),
                more(
                    "export",
                    words::more_export(locale),
                    words::more_export_meta(locale),
                    "Share",
                    Some(routes::export(&parent)),
                ),
                more(
                    "facts",
                    words::more_facts(locale),
                    words::more_facts_meta(locale),
                    "Info",
                    None,
                ),
                more(
                    "lock",
                    words::lock_now(locale),
                    words::more_lock_meta(locale),
                    "Lock",
                    None,
                ),
            ],
            facts_title: words::more_facts(locale),
            facts: vec![
                wire::LockerFact {
                    label: words::keeps_list(locale),
                    detail: words::keeps_list_detail(locale),
                },
                wire::LockerFact {
                    label: words::keeps_secret(locale),
                    detail: words::keeps_secret_detail(locale),
                },
                wire::LockerFact {
                    label: words::keeps_use(locale),
                    detail: words::keeps_use_detail(locale),
                },
                wire::LockerFact {
                    label: words::keeps_backup(locale),
                    detail: words::keeps_backup_detail(locale),
                },
            ],
            search_placeholder: words::search_placeholder(locale),
            search_note: words::search_note(locale),
            close_label: words::close(locale),
        }
    }
}

impl Screen for Home {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            // OPENING LOCKER IS THE ASK: no wall before the prompt.
            Some(E::Appeared(_)) => {
                let step = self.wall.appeared(ctx, true);
                let effects = self.walled(ctx, step);
                // A home that finds the session already open still reads.
                if self.wall.is_open() && matches!(self.items, Phase::Loading) {
                    self.reload(ctx);
                }
                effects
            }
            Some(E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                if self.wall.is_open() {
                    self.reload(ctx);
                    Vec::new()
                } else {
                    let step = self.wall.recheck(ctx);
                    self.walled(ctx, step)
                }
            }
            Some(E::LockerWall(wall)) => {
                let step = self.wall.event(ctx, wall);
                self.walled(ctx, step)
            }
            Some(E::Lifecycle(lifecycle)) => {
                let step = self.wall.lifecycle(ctx, lifecycle.foreground);
                self.walled(ctx, step)
            }
            Some(E::LockerHome(home)) => {
                if !self.wall.is_open() {
                    // Any tap on a screen the session ended under finds out.
                    let step = self.wall.recheck(ctx);
                    return self.walled(ctx, step);
                }
                self.event(home, ctx)
            }
            Some(E::EffectResult(result)) => {
                self.secrets.answered(ctx, &result);
                let step = self.wall.answered(ctx, &result);
                self.walled(ctx, step)
            }
            Some(E::TimerFired(fired)) => self.secrets.fired(&fired.timer),
            Some(E::Left(_)) => {
                self.secrets.conceal();
                self.generator.forget();
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let open = self.wall.is_open();
        let searched = self.search_open || self.destination == wire::LockerDestination::Search;
        // THE UNLOCKS THE PHONE REFUSED while Locker was shut (#1146), said once
        // under the line that tells what stays hidden.
        let mut content = self.content(locale);
        if let (Some(wire::locker_home_state::Content::Data(data)), Some(failed)) =
            (content.as_mut(), self.wall.failures_line(locale))
        {
            data.status_line = format!("{} {failed}", data.status_line);
        }
        wire::ViewState {
            kind: Some(wire::view_state::Kind::LockerHome(wire::LockerHomeState {
                wall: self.wall.view(locale),
                secure: open,
                destination: self.destination as i32,
                content,
                sheet: self.sheet as i32,
                band: self.band(locale),
                chrome: Some(Self::chrome(locale)),
                search: Some(wire::LockerSearchField {
                    open: searched,
                    term: self.term.clone(),
                    answered_term: self
                        .hits
                        .data()
                        .map(|answer| answer.term.clone())
                        .unwrap_or_default(),
                    // LOCKER NEVER OFFERS ASK (#1097, R-1097-29): a search term
                    // here can itself be a secret, and Ask would write it into
                    // a chat thread, the chat index and the model's context.
                    corrected: self
                        .hits
                        .data()
                        .filter(|answer| answer.term.trim() == self.term.trim())
                        .map(|answer| answer.corrected.clone())
                        .unwrap_or_default(),
                }),
                status: self.status.clone(),
            })),
            ..wire::ViewState::default()
        }
    }
}

#[cfg(test)]
mod landing_tests {
    use super::*;

    fn row(id: &str) -> wire::LockerItemRow {
        wire::LockerItemRow {
            item_id: id.to_owned(),
            ..wire::LockerItemRow::default()
        }
    }

    #[test]
    fn recently_used_keeps_the_cores_order_and_drops_an_id_with_no_row() {
        let answer = wire::LockerItems {
            items: vec![row("a"), row("b"), row("c")],
            recent_ids: vec!["c".to_owned(), "gone".to_owned(), "a".to_owned()],
            ..wire::LockerItems::default()
        };
        let ids: Vec<&str> = recent_of(&answer)
            .into_iter()
            .map(|row| row.item_id.as_str())
            .collect();
        assert_eq!(ids, ["c", "a"]);
    }

    #[test]
    fn an_item_with_two_verdicts_counts_once_in_review() {
        let review = wire::LockerReview {
            compromised: vec![row("a"), row("b")],
            insecure_address: vec![row("a")],
            expired: vec![row("c")],
            ..wire::LockerReview::default()
        };
        assert_eq!(review_count(&review), 3);
    }
}
