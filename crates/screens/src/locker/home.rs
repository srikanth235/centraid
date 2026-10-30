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
use crate::kit::read;
use crate::kit::secret::Secrets;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, locker as words};

pub const ALL: &str = "all";
pub const STARRED: &str = "starred";
pub const ARCHIVED: &str = "archived";

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
            _ => self.read_items(ctx),
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
                "review" if self.destination != D::Review => self.goto(ctx, D::Review),
                "generate" if self.destination != D::Generate => self.goto(ctx, D::Generate),
                _ => {}
            },
            Some(H::Filter(filter)) => {
                if filter.key != self.filter {
                    let shelf_changed = (filter.key == ARCHIVED) != (self.filter == ARCHIVED);
                    self.filter = filter.key;
                    // THE ARCHIVED SHELF IS ANOTHER READ ("keep forever, hide
                    // from lists" — asked for, never filtered out of the live
                    // one); every other filter re-folds the shelf already held.
                    if shelf_changed {
                        self.items = Phase::Loading;
                        self.read_items(ctx);
                    }
                }
            }
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
                "lock" => {
                    let step = self.wall.event(
                        ctx,
                        wire::LockerWallEvent {
                            kind: Some(wire::locker_wall_event::Kind::Lock(
                                wire::locker_wall_event::LockTapped {},
                            )),
                        },
                    );
                    effects.extend(self.walled(ctx, step));
                }
                // A page the shell pushes: the sheet closes behind the tap.
                _ => self.sheet = wire::locker_home_state::Sheet::None,
            },
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
            kind => answer
                .items
                .iter()
                .filter(|row| row.r#type == kind)
                .collect(),
        };
        let total = answer.total;
        let mut chips = vec![wire::LockerChoice {
            key: ALL.to_owned(),
            label: words::filter_all(locale),
            selected: filter == ALL,
            detail: total.map(|total| total.to_string()).unwrap_or_default(),
        }];
        let starred = answer.items.iter().filter(|row| row.starred).count();
        if starred > 0 || filter == STARRED {
            chips.push(wire::LockerChoice {
                key: STARRED.to_owned(),
                label: words::filter_starred(locale),
                selected: filter == STARRED,
                detail: starred.to_string(),
            });
        }
        for by_type in &answer.by_type {
            chips.push(wire::LockerChoice {
                key: by_type.r#type.clone(),
                label: (super::types::of(&by_type.r#type).plural)(locale),
                selected: filter == by_type.r#type,
                detail: by_type.count.to_string(),
            });
        }
        let archived = answer.archived_count.unwrap_or(0);
        if archived > 0 || filter == ARCHIVED {
            chips.push(wire::LockerChoice {
                key: ARCHIVED.to_owned(),
                label: words::filter_archived(locale),
                selected: filter == ARCHIVED,
                detail: answer
                    .archived_count
                    .map(|count| count.to_string())
                    .unwrap_or_default(),
            });
        }
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
        wire::LockerHomeData {
            status_line: words::items_status(locale),
            filters: chips,
            rows: shown
                .into_iter()
                .map(|row| shared::row(locale, row, &words::app_name(locale)))
                .collect(),
            window,
            items_empty: empty,
            ..wire::LockerHomeData::default()
        }
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
                filter: self.filter.clone(),
                status: self.status.clone(),
            })),
            ..wire::ViewState::default()
        }
    }
}
