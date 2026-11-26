use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::people as reads;
use centraid_domain::read::Args;
use rand::RngCore as _;
use serde_json::{Map, Value, json};

use super::blocks::{self, Confirm, glyph};
use super::door::Door;
use super::form::{self, Explicit, Save};
use super::frame::{self, room};
use super::screen::{Build, Event, Input, Outcome, Registry, RoomScreen};
use super::selector::{Act, Handler, Sel};
use crate::strings::{Locale, fill, people as words, shared};

pub const PEOPLE: &str = "people";
pub const LISTS: &str = "people/lists";
pub const NEW_PERSON: &str = "people/new";
pub const NEW_LIST: &str = "people/lists/new";
pub const TRASH: &str = "people/trash";

const EN: Locale = Locale::En;
const PREVIEW_LIMIT: usize = 3;
const MAX_NAME_CHARS: usize = 200;
const MAX_META_CHARS: usize = 200;
const MAX_VALUE_CHARS: usize = 300;
const FILTER_STARRED: &str = "filter/starred";
const SORT_NAME: &str = "sort/name";
const SORT_RECENT: &str = "sort/recent";

#[must_use]
pub fn registry() -> Registry {
    Registry::new()
        .exact(PEOPLE, || Box::new(PeopleList::default()))
        .exact(LISTS, || Box::new(ListsPage::default()))
        .exact(NEW_PERSON, || Box::new(PersonForm::new_person()))
        .exact(NEW_LIST, || Box::new(NewListForm::default()))
        .exact(TRASH, || Box::new(PeopleTrash::default()))
        .exact("people/trash/empty", || Box::new(EmptyTrashConfirm))
        .with(Box::new(|key| {
            if let Some(id) = key.strip_prefix("people/trash/purge/") {
                return Some(Box::new(PurgeConfirm { id: id.to_owned() }));
            }
            if let Some(rest) = key.strip_prefix("people/list/") {
                if let Some(id) = rest.strip_suffix("/add") {
                    return Some(Box::new(AddToList { id: id.to_owned() }));
                }
                return Some(Box::new(ListDetail {
                    id: rest.to_owned(),
                    loaded: 50,
                }));
            }
            if let Some(rest) = key.strip_prefix("person/") {
                if let Some(id) = rest.strip_suffix("/edit") {
                    return Some(Box::new(PersonForm::edit_person(id.to_owned())));
                }
                if let Some(id) = rest.strip_suffix("/trash-confirm") {
                    return Some(Box::new(TrashPersonConfirm { id: id.to_owned() }));
                }
                if let Some((id, source)) = rest.split_once("/with/") {
                    return Some(Box::new(WithSection {
                        id: id.to_owned(),
                        source: source.to_owned(),
                        loaded: 50,
                    }));
                }
                if let Some((id, target)) = rest.split_once("/merge/") {
                    return Some(Box::new(MergeConfirm {
                        from: id.to_owned(),
                        into: target.to_owned(),
                    }));
                }
                if let Some(id) = rest.strip_suffix("/merge") {
                    return Some(Box::new(MergePick { id: id.to_owned() }));
                }
                return Some(Box::new(PersonDetail {
                    id: rest.to_owned(),
                }));
            }
            None
        }))
}

fn mint_uuid_v7(now_ms: i64) -> String {
    let mut bytes = [0u8; 16];
    let ts = u64::try_from(now_ms.max(0)).unwrap_or(0);
    bytes[0] = ((ts >> 40) & 0xff) as u8;
    bytes[1] = ((ts >> 32) & 0xff) as u8;
    bytes[2] = ((ts >> 24) & 0xff) as u8;
    bytes[3] = ((ts >> 16) & 0xff) as u8;
    bytes[4] = ((ts >> 8) & 0xff) as u8;
    bytes[5] = (ts & 0xff) as u8;
    rand::rng().fill_bytes(&mut bytes[6..]);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

fn draft_key(door: &dyn Door) -> Option<String> {
    let vault = door.vault_id();
    if vault.is_empty() {
        None
    } else {
        Some(format!("draft.{vault}.person"))
    }
}

fn people_band(sel: &mut Sel, active_tab: &str) -> wire::RoomBand {
    let tabs = vec![
        frame::tab(
            sel,
            "tab/people",
            &words::tab_people(EN),
            "Users",
            active_tab == PEOPLE,
        ),
        frame::tab(
            sel,
            "tab/lists",
            &words::tab_lists(EN),
            "List",
            active_tab == LISTS,
        ),
    ];
    let mut more_trash = blocks::menu_item(
        sel,
        "more/trash",
        &shared::trash_entry(EN),
        Handler::Open(TRASH.to_owned()),
    );
    more_trash.secondary = shared::trash_entry_meta(EN);
    let more_items = vec![
        blocks::menu_item(
            sel,
            "more/contacts",
            &words::more_following(EN),
            Handler::Tag("more:contacts".to_owned()),
        ),
        blocks::menu_item(
            sel,
            "more/import",
            &words::more_import(EN),
            Handler::Tag("more:import".to_owned()),
        ),
        blocks::menu_item(
            sel,
            "more/export",
            &words::more_export(EN),
            Handler::Tag("more:export".to_owned()),
        ),
        more_trash,
    ];
    let more_menu = blocks::menu(
        "band/more/menu",
        vec![blocks::menu_section("", more_items)],
        sel,
    );
    let mut band = frame::band(
        tabs,
        Some(Handler::Tag("nav:home".to_owned())),
        Some(Handler::SearchOpen),
        sel,
    );
    band.more_selector_id = sel.anchor("band/more");
    band.more = Some(more_menu);
    band
}

fn handle_more_or_nav(tag: &str) -> Option<Outcome> {
    match tag {
        "nav:home" => Some(Outcome::replace(super::shell::HOME)),
        "tab:tab/people" => Some(Outcome::replace(PEOPLE)),
        "tab:tab/lists" => Some(Outcome::replace(LISTS)),
        "more:contacts" => Some(Outcome::say(&words::follow_contacts_note(EN))),
        "more:import" => Some(Outcome::say(&words::import_note(EN))),
        "more:export" => Some(Outcome::say(&words::export_note(EN))),
        _ => None,
    }
}

fn summary_meta(person: &reads::PersonSummary, is_self: bool) -> String {
    if is_self {
        return words::my_card(EN);
    }
    let mut parts = Vec::new();
    if let Some(role) = person.role.as_deref().filter(|s| !s.is_empty()) {
        parts.push(role.to_owned());
    }
    if let Some(org) = person.org.as_deref().filter(|s| !s.is_empty()) {
        parts.push(org.to_owned());
    }
    if let Some(days) = person.cadence_days
        && let Ok(n) = u64::try_from(days)
    {
        parts.push(words::cadence_days(EN, n));
    }
    parts.join(" · ")
}

fn person_row_menu(sel: &mut Sel, person: &reads::PersonSummary) -> wire::RoomMenu {
    let id = &person.id;
    let starred = person.starred_at.is_some();
    let star_act = if starred {
        Act::new(
            "flag.clear/starred",
            json!({ "flag": "starred", "ids": [id] }),
        )
    } else {
        Act::new(
            "flag.set/starred",
            json!({ "flag": "starred", "ids": [id] }),
        )
    };
    let mut trash = blocks::menu_item(
        sel,
        &format!("row/{id}/menu/trash"),
        &shared::trash_move(EN),
        Handler::Act(Act::new("entity.trash", json!({ "ids": [id] }))),
    );
    trash.destructive = true;
    let items = vec![
        blocks::menu_item(
            sel,
            &format!("row/{id}/menu/open"),
            &shared::kit_open(EN),
            Handler::Open(format!("person/{id}")),
        ),
        blocks::menu_item(
            sel,
            &format!("row/{id}/menu/edit"),
            &words::menu_edit(EN),
            Handler::Open(format!("person/{id}/edit")),
        ),
        blocks::menu_item(
            sel,
            &format!("row/{id}/menu/star"),
            &if starred {
                words::menu_unstar(EN)
            } else {
                words::menu_star(EN)
            },
            Handler::Act(star_act),
        ),
        blocks::menu_item(
            sel,
            &format!("row/{id}/menu/share"),
            &words::menu_share(EN),
            Handler::Tag(format!("share:{id}")),
        ),
        blocks::menu_item(
            sel,
            &format!("row/{id}/menu/merge"),
            &words::menu_merge(EN),
            Handler::Open(format!("person/{id}/merge")),
        ),
        blocks::menu_item(
            sel,
            &format!("row/{id}/menu/select"),
            &words::menu_select(EN),
            Handler::SelectMode(true),
        ),
        trash,
    ];
    blocks::menu(
        &format!("row/{id}/menu"),
        vec![blocks::menu_section("", items)],
        sel,
    )
}

struct PeopleList {
    loaded: usize,
}

impl Default for PeopleList {
    fn default() -> Self {
        Self { loaded: 50 }
    }
}

impl RoomScreen for PeopleList {
    fn key(&self) -> String {
        PEOPLE.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let starred_only = b.ui.is_filtered(FILTER_STARRED);
        let sort_recent = b.ui.lens() == Some(SORT_RECENT);

        let answer = if starred_only {
            b.reload(&reads::LIST_STARRED, &Args::new(), self.loaded)
        } else if sort_recent {
            b.reload(&reads::LIST_RECENT, &Args::new(), self.loaded)
        } else {
            b.reload(&reads::LIST, &Args::new(), self.loaded)
        };
        let self_id = b
            .run(&reads::SELF_ID, &Args::new())
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|row| row.0);

        let mut frame = room(wire::RoomKind::AppPlace, PEOPLE).title(&words::title(EN));

        let mut starred_item = blocks::menu_item(
            &mut b.sel,
            FILTER_STARRED,
            &words::filter_starred(EN),
            Handler::Filter(FILTER_STARRED.to_owned()),
        );
        starred_item.checked = starred_only;

        let mut sort_name_item = blocks::menu_item(
            &mut b.sel,
            SORT_NAME,
            &words::sort_name(EN),
            Handler::Lens(SORT_NAME.to_owned()),
        );
        sort_name_item.checked = !sort_recent;

        let mut sort_recent_item = blocks::menu_item(
            &mut b.sel,
            SORT_RECENT,
            &words::sort_recent(EN),
            Handler::Lens(SORT_RECENT.to_owned()),
        );
        sort_recent_item.checked = sort_recent;

        let funnel = blocks::menu(
            "filter",
            vec![
                blocks::menu_section(&words::filter_section_show(EN), vec![starred_item]),
                blocks::menu_section(
                    &words::filter_section_sort(EN),
                    vec![sort_name_item, sort_recent_item],
                ),
            ],
            &mut b.sel,
        );
        frame = frame
            .filter(&mut b.sel, funnel, b.ui)
            .key(
                &mut b.sel,
                "key/add",
                wire::RoomKeyRole::Add,
                "Plus",
                &words::add_person(EN),
                Handler::Open(NEW_PERSON.to_owned()),
            )
            .search(&mut b.sel, b.ui, &words::search_placeholder(EN));

        if !b.ui.selecting() {
            frame = frame.band(people_band(&mut b.sel, PEOPLE));
        }

        let answer = match answer {
            Ok(answer) => answer,
            Err(refused) => {
                return frame
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let term = b.ui.search_term().trim().to_ascii_lowercase();
        let visible: Vec<reads::PersonSummary> = answer
            .rows
            .into_iter()
            .filter(|p| {
                if term.is_empty() {
                    return true;
                }
                p.title.to_ascii_lowercase().contains(&term)
                    || p.role
                        .as_deref()
                        .is_some_and(|r| r.to_ascii_lowercase().contains(&term))
                    || p.org
                        .as_deref()
                        .is_some_and(|o| o.to_ascii_lowercase().contains(&term))
            })
            .collect();

        if !visible.is_empty() {
            let count = u64::try_from(visible.len()).unwrap_or(u64::MAX);
            frame = frame.subtitle(&words::people_count(EN, count));
        }

        b.ui.list(visible.iter().map(|p| p.id.clone()));

        if b.ui.selecting() {
            let picked: Vec<String> = b.ui.picked().map(str::to_owned).collect();
            let count = u64::try_from(picked.len()).unwrap_or(u64::MAX);
            let mut bulk_actions = Vec::new();
            if !picked.is_empty() {
                bulk_actions.push(blocks::menu_item(
                    &mut b.sel,
                    "selection/star",
                    &words::menu_star(EN),
                    Handler::Tag("bulk:star".to_owned()),
                ));
                let mut bulk_trash = blocks::menu_item(
                    &mut b.sel,
                    "selection/trash",
                    &shared::trash_move(EN),
                    Handler::Tag("bulk:trash".to_owned()),
                );
                bulk_trash.destructive = true;
                bulk_actions.push(bulk_trash);
            }
            frame = frame.selection(
                &mut b.sel,
                b.ui,
                &words::selected_count(EN, count),
                bulk_actions,
            );
        }

        let blocks_out = if visible.is_empty() {
            if !term.is_empty() {
                vec![blocks::empty(
                    glyph("Users", ""),
                    &words::empty_search_title(EN),
                    &fill(&words::empty_search_body(EN), &[("term", &term)]),
                    None,
                )]
            } else {
                let add = blocks::action(
                    &mut b.sel,
                    "empty/add",
                    &words::add_person(EN),
                    "Plus",
                    Handler::Open(NEW_PERSON.to_owned()),
                );
                vec![blocks::empty(
                    glyph("Users", ""),
                    &words::empty_title(EN),
                    &words::empty_body(EN),
                    Some(add),
                )]
            }
        } else {
            let selecting = b.ui.selecting();
            let mut rows = Vec::with_capacity(visible.len());
            for person in &visible {
                let is_self = self_id.as_deref() == Some(person.id.as_str());
                let meta = summary_meta(person, is_self);
                let tap = if selecting {
                    Handler::Pick(person.id.clone())
                } else {
                    Handler::Open(format!("person/{}", person.id))
                };
                let mut row = blocks::row(
                    &mut b.sel,
                    &format!("row/{}", person.id),
                    &person.title,
                    tap,
                )
                .selected(selecting && b.ui.is_picked(&person.id));
                if !meta.is_empty() {
                    row = row.meta(&meta);
                }
                if person.starred_at.is_some() {
                    row = row.chip(blocks::chip(
                        &words::starred_chip(EN),
                        wire::RoomTone::Neutral,
                    ));
                }
                if !selecting {
                    let menu = person_row_menu(&mut b.sel, person);
                    row = row.menu(menu).swipe(
                        &mut b.sel,
                        &format!("row/{}/trash", person.id),
                        &shared::trash_move(EN),
                        Handler::Act(Act::new("entity.trash", json!({ "ids": [person.id] }))),
                    );
                }
                rows.push(row.into_block());
            }
            let mut list_section =
                blocks::section(&mut b.sel, "section/people", &words::title(EN)).blocks(rows);
            if answer.next.is_some() {
                list_section = list_section.next_page(&mut b.sel, "section/people/next");
            }
            vec![list_section.into_block()]
        };

        frame.ready(blocks_out).build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if let Some(outcome) = handle_more_or_nav(tag) {
            return outcome;
        }
        if tag == "next:section/people" {
            self.loaded = self.loaded.saturating_add(50);
            return Outcome::default();
        }
        if tag.starts_with("share:") {
            return Outcome::say(&words::shared(EN));
        }
        if tag == "bulk:star" || tag == "bulk:trash" {
            let ids: Vec<String> = e.ui.picked().map(str::to_owned).collect();
            if ids.is_empty() {
                return Outcome::default();
            }
            let act = if tag == "bulk:star" {
                Act::new("flag.set/starred", json!({ "flag": "starred", "ids": ids }))
            } else {
                Act::new("entity.trash", json!({ "ids": ids }))
            };
            return match e.door.act(&act) {
                Ok(done) => {
                    e.ui.select_mode(false);
                    Outcome::done(&done.sentence, done.undo)
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

fn contact_kind_label(kind: &str) -> String {
    match kind {
        "phone" => words::kind_phone(EN),
        "email" => words::kind_email(EN),
        "address" => words::kind_address(EN),
        "url" => words::kind_url(EN),
        "handle" => words::kind_handle(EN),
        other => other.to_owned(),
    }
}

fn fact_kind(kind: &str) -> wire::RoomFactKind {
    match kind {
        "phone" => wire::RoomFactKind::Phone,
        "email" => wire::RoomFactKind::Email,
        "address" => wire::RoomFactKind::Address,
        "url" => wire::RoomFactKind::Link,
        _ => wire::RoomFactKind::Text,
    }
}

fn date_kind_label(kind: &str) -> String {
    match kind {
        "birthday" => words::date_birthday(EN),
        "anniversary" => words::date_anniversary(EN),
        _ => words::date_other(EN),
    }
}

struct PersonDetail {
    id: String,
}

impl PersonDetail {
    fn timeline_section(
        b: &mut Build<'_>,
        person_id: &str,
        source_key: &str,
        heading: &str,
        items: &[(String, String, String)],
        has_more: bool,
    ) -> Option<wire::RoomBlock> {
        if items.is_empty() {
            return None;
        }
        let mut sec = blocks::section(&mut b.sel, &format!("with/{source_key}"), heading);
        if items.len() > PREVIEW_LIMIT || has_more {
            sec = sec.trailing(blocks::action(
                &mut b.sel,
                &format!("with/{source_key}/all"),
                &words::show_all(EN),
                "",
                Handler::Open(format!("person/{person_id}/with/{source_key}")),
            ));
        }
        for (item_id, title, meta) in items.iter().take(PREVIEW_LIMIT) {
            let mut row =
                blocks::still_row(&mut b.sel, &format!("with/{source_key}/{item_id}"), title);
            if !meta.is_empty() {
                row = row.meta(meta);
            }
            sec = sec.block(row.into_block());
        }
        Some(sec.into_block())
    }
}

impl RoomScreen for PersonDetail {
    fn key(&self) -> String {
        format!("person/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let person_arg = Args::new().text("person", &self.id);
        let id_arg = Args::new().text("id", &self.id);

        let detail = match b.run(&reads::BY_ID, &id_arg) {
            Ok(answer) => answer.rows.into_iter().next(),
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::title(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let Some(person) = detail else {
            return room(wire::RoomKind::PushedPage, &self.key())
                .title(&words::title(EN))
                .back(&mut b.sel, &words::title(EN))
                .ready(vec![blocks::empty(
                    glyph("User", ""),
                    &words::not_found(EN),
                    "",
                    None,
                )])
                .build();
        };

        let self_id = b
            .run(&reads::SELF_ID, &Args::new())
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|r| r.0);
        let is_self = self_id.as_deref() == Some(person.id.as_str());

        let starred = person.starred_at.is_some();
        let star_act = if starred {
            Act::new(
                "flag.clear/starred",
                json!({ "flag": "starred", "ids": [&self.id] }),
            )
        } else {
            Act::new(
                "flag.set/starred",
                json!({ "flag": "starred", "ids": [&self.id] }),
            )
        };
        let mut trash_item = blocks::menu_item(
            &mut b.sel,
            "menu/trash",
            &shared::trash_move(EN),
            Handler::Tag("trash".to_owned()),
        );
        trash_item.destructive = true;
        let overflow = blocks::menu(
            "menu/more",
            vec![blocks::menu_section(
                "",
                vec![
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/edit",
                        &words::menu_edit(EN),
                        Handler::Open(format!("person/{}/edit", self.id)),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/star",
                        &if starred {
                            words::menu_unstar(EN)
                        } else {
                            words::menu_star(EN)
                        },
                        Handler::Act(star_act),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/share",
                        &words::menu_share(EN),
                        Handler::Tag("share".to_owned()),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/merge",
                        &words::menu_merge(EN),
                        Handler::Open(format!("person/{}/merge", self.id)),
                    ),
                    trash_item,
                ],
            )],
            &mut b.sel,
        );

        let noun = if is_self {
            words::my_card(EN)
        } else {
            shared::trash_noun_person(EN)
        };
        let mut hero = blocks::hero(&person.title)
            .noun(&noun)
            .primary(blocks::action(
                &mut b.sel,
                "hero/catch_up",
                &words::catch_up(EN),
                "Activity",
                Handler::Tag("catch_up".to_owned()),
            ));
        let role_org: Vec<&str> = [person.role.as_deref(), person.org.as_deref()]
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .collect();
        if !role_org.is_empty() {
            hero = hero.line(&role_org.join(" · "));
        }
        if let Some(nick) = person.nickname.as_deref().filter(|s| !s.is_empty()) {
            hero = hero.line(nick);
        }
        if let Some(met) = person.met.as_deref().filter(|s| !s.is_empty()) {
            hero = hero.line(met);
        }
        if let Some(days) = person.cadence_days
            && let Ok(n) = u64::try_from(days)
        {
            hero = hero.line(&words::cadence_days(EN, n));
        }
        if starred {
            hero = hero.chip(blocks::chip(
                &words::starred_chip(EN),
                wire::RoomTone::Neutral,
            ));
        }
        let here_menu = blocks::menu(
            "hero/here",
            vec![blocks::menu_section(
                &words::menu_here(EN),
                vec![
                    blocks::menu_item(
                        &mut b.sel,
                        "here/catch_up",
                        &words::here_catch_up(EN),
                        Handler::Tag("catch_up".to_owned()),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "here/note",
                        &words::here_note(EN),
                        Handler::Tag("here_note".to_owned()),
                    ),
                ],
            )],
            &mut b.sel,
        );
        hero = hero.menu(here_menu);

        let mut blocks_out = vec![hero.block()];

        if let Ok(mut points) = b.run(&reads::CONTACT_POINTS, &person_arg)
            && !points.rows.is_empty()
        {
            points.rows.sort_by(|a, c| {
                a.position
                    .total_cmp(&c.position)
                    .then_with(|| a.id.cmp(&c.id))
            });
            let facts: Vec<wire::RoomFact> = points
                .rows
                .iter()
                .map(|point| {
                    let label = point
                        .label
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .map_or_else(|| contact_kind_label(&point.kind), str::to_owned);
                    let base = blocks::fact(&label, &point.value, fact_kind(&point.kind));
                    blocks::fact_actions(
                        &mut b.sel,
                        base,
                        &format!("cp/{}", point.id),
                        Some(Handler::Tag(format!("open:cp:{}", point.id))),
                        Some(Handler::Tag(format!("copy:cp:{}", point.id))),
                    )
                })
                .collect();
            blocks_out.push(
                blocks::section(&mut b.sel, "section/contact", &words::section_contact(EN))
                    .block(blocks::facts(facts))
                    .into_block(),
            );
        }

        if let Ok(dates) = b.run(&reads::DATES, &person_arg)
            && !dates.rows.is_empty()
        {
            let mut date_rows = Vec::new();
            for date in &dates.rows {
                let label = date
                    .label
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .map_or_else(|| date_kind_label(&date.kind), str::to_owned);
                let (trailing, handler) = match &date.reminder_id {
                    Some(rem_id) => (
                        words::reminder_on(EN),
                        Handler::Tag(format!("rem:off:{rem_id}")),
                    ),
                    None => (
                        words::remind_me(EN),
                        Handler::Tag(format!("rem:on:{}", date.id)),
                    ),
                };
                date_rows.push(
                    blocks::row(&mut b.sel, &format!("date/{}", date.id), &label, handler)
                        .meta(&date.date)
                        .trailing(&trailing, wire::RoomTone::Neutral)
                        .into_block(),
                );
            }
            blocks_out.push(
                blocks::section(&mut b.sel, "section/dates", &words::section_dates(EN))
                    .blocks(date_rows)
                    .into_block(),
            );
        }

        if let Ok(relations) = b.run(&reads::RELATIONS, &person_arg)
            && !relations.rows.is_empty()
        {
            let rows: Vec<wire::RoomBlock> = relations
                .rows
                .iter()
                .map(|rel| {
                    let mut row = blocks::row(
                        &mut b.sel,
                        &format!("rel/{}", rel.id),
                        &rel.name,
                        Handler::Open(format!("person/{}", rel.id)),
                    );
                    if !rel.relation.is_empty() {
                        row = row.meta(&rel.relation);
                    }
                    row.into_block()
                })
                .collect();
            blocks_out.push(
                blocks::section(
                    &mut b.sel,
                    "section/relations",
                    &words::section_relations(EN),
                )
                .blocks(rows)
                .into_block(),
            );
        }

        // "With <name>" timeline (S11): one section per source, previewing first rows, no counts.
        if let Ok(events) = b.run(&reads::EVENTS, &person_arg) {
            let items: Vec<(String, String, String)> = events
                .rows
                .into_iter()
                .map(|ev| (ev.id, ev.title, ev.starts))
                .collect();
            if let Some(sec) = Self::timeline_section(
                b,
                &self.id,
                "events",
                &words::section_events(EN),
                &items,
                events.next.is_some(),
            ) {
                blocks_out.push(sec);
            }
        }
        if let Ok(notes) = b.run(&reads::NOTES, &person_arg) {
            let mut items = Vec::new();
            for note_id in notes.rows.iter().take(PREVIEW_LIMIT + 1) {
                let title = b
                    .run(&reads::ENTITY_TITLE, &Args::new().text("id", &note_id.0))
                    .ok()
                    .and_then(|a| a.rows.into_iter().next())
                    .map_or_else(|| shared::trash_untitled(EN), |r| r.title);
                items.push((note_id.0.clone(), title, String::new()));
            }
            if let Some(sec) = Self::timeline_section(
                b,
                &self.id,
                "notes",
                &words::section_notes(EN),
                &items,
                notes.next.is_some(),
            ) {
                blocks_out.push(sec);
            }
        }
        if let Ok(photos) = b.run(&reads::PHOTOS, &person_arg) {
            let items: Vec<(String, String, String)> = photos
                .rows
                .into_iter()
                .map(|r| (r.id, r.title, String::new()))
                .collect();
            if let Some(sec) = Self::timeline_section(
                b,
                &self.id,
                "photos",
                &words::section_photos(EN),
                &items,
                photos.next.is_some(),
            ) {
                blocks_out.push(sec);
            }
        }
        if let Ok(payments) = b.run(&reads::PAYMENTS, &person_arg) {
            let items: Vec<(String, String, String)> = payments
                .rows
                .into_iter()
                .map(|r| (r.id, r.title, String::new()))
                .collect();
            if let Some(sec) = Self::timeline_section(
                b,
                &self.id,
                "payments",
                &words::section_payments(EN),
                &items,
                payments.next.is_some(),
            ) {
                blocks_out.push(sec);
            }
        }
        if let Ok(workouts) = b.run(&reads::WORKOUTS, &person_arg) {
            let items: Vec<(String, String, String)> = workouts
                .rows
                .into_iter()
                .map(|r| (r.id, r.title, String::new()))
                .collect();
            if let Some(sec) = Self::timeline_section(
                b,
                &self.id,
                "workouts",
                &words::section_workouts(EN),
                &items,
                workouts.next.is_some(),
            ) {
                blocks_out.push(sec);
            }
        }
        if let Ok(catch_ups) = b.run(&reads::CATCH_UPS, &person_arg) {
            let items: Vec<(String, String, String)> = catch_ups
                .rows
                .into_iter()
                .map(|r| (r.id, r.title, String::new()))
                .collect();
            if let Some(sec) = Self::timeline_section(
                b,
                &self.id,
                "catch_ups",
                &words::section_catch_ups(EN),
                &items,
                catch_ups.next.is_some(),
            ) {
                blocks_out.push(sec);
            }
        }
        if let Ok(docs) = b.run(&reads::DOCS, &person_arg) {
            let items: Vec<(String, String, String)> = docs
                .rows
                .into_iter()
                .map(|r| (r.id, r.title, String::new()))
                .collect();
            if let Some(sec) = Self::timeline_section(
                b,
                &self.id,
                "docs",
                &words::section_docs(EN),
                &items,
                docs.next.is_some(),
            ) {
                blocks_out.push(sec);
            }
        }

        // Footers: linked, mentioned_in, attachments, earlier_versions, origin.
        let linked_rows = b
            .run(&reads::LINKED, &person_arg)
            .map(|a| a.rows)
            .unwrap_or_default();
        let mut linked_items = Vec::new();
        for other in &linked_rows {
            let (title, kind) = b
                .run(&reads::ENTITY_TITLE, &Args::new().text("id", &other.0))
                .ok()
                .and_then(|a| a.rows.into_iter().next())
                .map_or_else(
                    || (shared::trash_untitled(EN), String::new()),
                    |r| (r.title, r.kind),
                );
            let mut row = blocks::still_row(&mut b.sel, &format!("linked/{}", other.0), &title);
            if !kind.is_empty() {
                row = row.meta(&kind);
            }
            linked_items.push(row.build());
        }
        let add_link = blocks::action(
            &mut b.sel,
            "footer/linked/add",
            &words::footer_add_link(EN),
            "Link",
            Handler::Tag("footer:add_link".to_owned()),
        );
        blocks_out.push(blocks::linked(
            &words::footer_linked(EN),
            linked_items,
            Some(add_link),
        ));

        if let Ok(mentioned) = b.run(&reads::MENTIONED_IN, &person_arg)
            && !mentioned.rows.is_empty()
        {
            let rows: Vec<wire::RoomRow> = mentioned
                .rows
                .iter()
                .map(|r| {
                    blocks::still_row(&mut b.sel, &format!("mentioned/{}", r.id), &r.title).build()
                })
                .collect();
            blocks_out.push(blocks::mentioned_in(&words::footer_mentioned(EN), rows));
        }

        let attach_rows = b
            .run(&reads::ATTACHMENTS, &person_arg)
            .map(|a| a.rows)
            .unwrap_or_default();
        let attach_items: Vec<wire::RoomRow> = attach_rows
            .iter()
            .map(|r| {
                blocks::still_row(&mut b.sel, &format!("attach/{}", r.id), &r.title)
                    .meta(&r.kind)
                    .build()
            })
            .collect();
        let attach_menu = blocks::menu(
            "footer/attach/menu",
            vec![blocks::menu_section(
                "",
                vec![
                    blocks::menu_item(
                        &mut b.sel,
                        "attach/scan",
                        &words::attach_scan(EN),
                        Handler::Tag("attach:scan".to_owned()),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "attach/file",
                        &words::attach_file(EN),
                        Handler::Tag("attach:file".to_owned()),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "attach/photo",
                        &words::attach_photo(EN),
                        Handler::Tag("attach:photo".to_owned()),
                    ),
                ],
            )],
            &mut b.sel,
        );
        blocks_out.push(blocks::attachments(
            &words::footer_attachments(EN),
            attach_items,
            Some(attach_menu),
        ));

        if let Ok(rev) = b.run(&reads::REVISIONS_COUNT, &person_arg)
            && let Some(count) = rev.rows.first().map(|c| c.0).filter(|&n| n > 0)
        {
            let n = u64::try_from(count).unwrap_or(0);
            let n32 = u32::try_from(count).unwrap_or(u32::MAX);
            blocks_out.push(blocks::earlier_versions(
                &mut b.sel,
                &words::versions_summary(EN, n),
                n32,
                Handler::Tag("versions".to_owned()),
            ));
        }

        if let Some(label) = person.arrived_label.as_deref().filter(|s| !s.is_empty()) {
            blocks_out.push(blocks::origin(
                &mut b.sel,
                &fill(&shared::origin_line(EN), &[("label", label)]),
                None,
            ));
        }

        // Also watch touches_held so a trash check stays fresh.
        b.read(&reads::TOUCHES_HELD.decl);

        room(wire::RoomKind::PushedPage, &self.key())
            .title(&person.title)
            .back(&mut b.sel, &words::title(EN))
            .menu_key(&mut b.sel, "key/more", &words::menu_more(EN), overflow)
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "catch_up" {
            let act = Act::new(
                "touch.log",
                json!({
                    "kind": "Call",
                    "people": [&self.id],
                }),
            );
            return match e.door.act(&act) {
                Ok(done) => Outcome::done(&words::catch_up_logged(EN), done.undo),
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        if tag == "here_note" {
            let act = Act::new(
                "person.add_note",
                json!({
                    "id": &self.id,
                    "text": words::here_note(EN),
                }),
            );
            return match e.door.act(&act) {
                Ok(done) => Outcome::done(&done.sentence, done.undo),
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        if tag == "share" {
            return Outcome::say(&words::shared(EN));
        }
        if tag.starts_with("copy:cp:") {
            return Outcome::say(&words::copied(EN));
        }
        if tag.starts_with("open:cp:") {
            return Outcome::say(&words::opened(EN));
        }
        if let Some(date_id) = tag.strip_prefix("rem:on:") {
            let act = Act::new(
                "reminder.add",
                json!({
                    "entity_id": &self.id,
                    "date_id": date_id,
                    "offset_min": 0,
                }),
            );
            return match e.door.act(&act) {
                Ok(done) => Outcome::done(&words::reminder_added(EN), done.undo),
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        if let Some(rem_id) = tag.strip_prefix("rem:off:") {
            let act = Act::new("reminder.remove", json!({ "id": rem_id }));
            return match e.door.act(&act) {
                Ok(done) => Outcome::done(&words::reminder_removed(EN), done.undo),
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        if tag == "trash" {
            let held = e
                .door
                .reader()
                .ok()
                .and_then(|r| {
                    r.run(&reads::TOUCHES_HELD, &Args::new().text("person", &self.id))
                        .ok()
                })
                .and_then(|a| a.rows.into_iter().next())
                .map_or(0, |h| h.count);
            if held > 0 {
                return Outcome::push(&format!("person/{}/trash-confirm", self.id));
            }
            let act = Act::new("entity.trash", json!({ "ids": [&self.id] }));
            return match e.door.act(&act) {
                Ok(_) => Outcome::pop(),
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct WithSection {
    id: String,
    source: String,
    loaded: usize,
}

impl RoomScreen for WithSection {
    fn key(&self) -> String {
        format!("person/{}/with/{}", self.id, self.source)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let heading = match self.source.as_str() {
            "events" => words::section_events(EN),
            "notes" => words::section_notes(EN),
            "photos" => words::section_photos(EN),
            "payments" => words::section_payments(EN),
            "workouts" => words::section_workouts(EN),
            "catch_ups" => words::section_catch_ups(EN),
            "docs" => words::section_docs(EN),
            _ => words::title(EN),
        };
        let person_name = b
            .run(&reads::BY_ID, &Args::new().text("id", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map_or_else(|| words::title(EN), |p| p.title);

        let args = Args::new().text("person", &self.id);
        let (items, has_more): (Vec<(String, String, String)>, bool) = match self.source.as_str() {
            "events" => match b.reload(&reads::EVENTS, &args, self.loaded) {
                Ok(a) => (
                    a.rows
                        .into_iter()
                        .map(|r| (r.id, r.title, r.starts))
                        .collect(),
                    a.next.is_some(),
                ),
                Err(e) => {
                    return room(wire::RoomKind::PushedPage, &self.key())
                        .title(&heading)
                        .back(&mut b.sel, &person_name)
                        .failed(&mut b.sel, &e.0, &shared::kit_retry(EN))
                        .build();
                }
            },
            "notes" => match b.reload(&reads::NOTES, &args, self.loaded) {
                Ok(a) => {
                    let mut out = Vec::with_capacity(a.rows.len());
                    for id in a.rows {
                        let title = b
                            .run(&reads::ENTITY_TITLE, &Args::new().text("id", &id.0))
                            .ok()
                            .and_then(|ans| ans.rows.into_iter().next())
                            .map_or_else(|| shared::trash_untitled(EN), |r| r.title);
                        out.push((id.0, title, String::new()));
                    }
                    (out, a.next.is_some())
                }
                Err(e) => {
                    return room(wire::RoomKind::PushedPage, &self.key())
                        .title(&heading)
                        .back(&mut b.sel, &person_name)
                        .failed(&mut b.sel, &e.0, &shared::kit_retry(EN))
                        .build();
                }
            },
            "photos" | "payments" | "workouts" | "catch_ups" | "docs" => {
                let read = match self.source.as_str() {
                    "photos" => &reads::PHOTOS,
                    "payments" => &reads::PAYMENTS,
                    "workouts" => &reads::WORKOUTS,
                    "catch_ups" => &reads::CATCH_UPS,
                    _ => &reads::DOCS,
                };
                match b.reload(read, &args, self.loaded) {
                    Ok(a) => (
                        a.rows
                            .into_iter()
                            .map(|r| (r.id, r.title, String::new()))
                            .collect(),
                        a.next.is_some(),
                    ),
                    Err(e) => {
                        return room(wire::RoomKind::PushedPage, &self.key())
                            .title(&heading)
                            .back(&mut b.sel, &person_name)
                            .failed(&mut b.sel, &e.0, &shared::kit_retry(EN))
                            .build();
                    }
                }
            }
            _ => (Vec::new(), false),
        };

        let mut sec = blocks::section(&mut b.sel, "section/with", &heading);
        for (item_id, title, meta) in items {
            let mut row = blocks::still_row(&mut b.sel, &format!("row/{item_id}"), &title);
            if !meta.is_empty() {
                row = row.meta(&meta);
            }
            sec = sec.block(row.into_block());
        }
        if has_more {
            sec = sec.next_page(&mut b.sel, "section/with/next");
        }

        room(wire::RoomKind::PushedPage, &self.key())
            .title(&heading)
            .back(&mut b.sel, &person_name)
            .ready(vec![sec.into_block()])
            .build()
    }

    fn on(&mut self, _: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "next:section/with" {
            self.loaded = self.loaded.saturating_add(50);
        }
        Outcome::default()
    }
}

#[derive(Clone)]
struct ContactDraft {
    slot: usize,
    point_id: Option<String>,
    kind: String,
    value: String,
    label: String,
}

#[derive(Clone)]
struct DateDraft {
    slot: usize,
    date_id: Option<String>,
    kind: String,
    date: String,
    label: String,
}

struct PersonForm {
    editing: Option<String>,
    initialized: bool,
    dirty: bool,
    drafted: bool,
    confirm_discard: bool,
    name_error: String,
    contacts: Vec<ContactDraft>,
    dates: Vec<DateDraft>,
    next_slot: usize,
}

impl PersonForm {
    fn new_person() -> Self {
        Self {
            editing: None,
            initialized: false,
            dirty: false,
            drafted: false,
            confirm_discard: false,
            name_error: String::new(),
            contacts: Vec::new(),
            dates: Vec::new(),
            next_slot: 1,
        }
    }

    fn edit_person(id: String) -> Self {
        Self {
            editing: Some(id),
            initialized: false,
            dirty: false,
            drafted: false,
            confirm_discard: false,
            name_error: String::new(),
            contacts: Vec::new(),
            dates: Vec::new(),
            next_slot: 1,
        }
    }

    fn load_initial(&mut self, b: &mut Build<'_>) {
        if self.initialized {
            return;
        }
        self.initialized = true;
        if let Some(id) = self.editing.clone() {
            if let Ok(ans) = b.run(&reads::BY_ID, &Args::new().text("id", &id))
                && let Some(p) = ans.rows.into_iter().next()
            {
                b.ui.fields.get_or("name", &p.title);
                b.ui.fields.get_or("role", p.role.as_deref().unwrap_or(""));
                b.ui.fields.get_or("org", p.org.as_deref().unwrap_or(""));
                b.ui.fields
                    .get_or("nickname", p.nickname.as_deref().unwrap_or(""));
                b.ui.fields.get_or("met", p.met.as_deref().unwrap_or(""));
                let cadence = p.cadence_days.map_or_else(String::new, |d| d.to_string());
                b.ui.fields.get_or("cadence", &cadence);
            }
            if let Ok(pts) = b.run(&reads::CONTACT_POINTS, &Args::new().text("person", &id)) {
                for pt in pts.rows {
                    let slot = self.next_slot;
                    self.next_slot += 1;
                    b.ui.fields.get_or(&format!("cp_{slot}_val"), &pt.value);
                    b.ui.fields.get_or(
                        &format!("cp_{slot}_label"),
                        pt.label.as_deref().unwrap_or(""),
                    );
                    self.contacts.push(ContactDraft {
                        slot,
                        point_id: Some(pt.id),
                        kind: pt.kind,
                        value: pt.value,
                        label: pt.label.unwrap_or_default(),
                    });
                }
            }
            if let Ok(dts) = b.run(&reads::DATES, &Args::new().text("person", &id)) {
                for dt in dts.rows {
                    let slot = self.next_slot;
                    self.next_slot += 1;
                    b.ui.fields.get_or(&format!("dt_{slot}_val"), &dt.date);
                    b.ui.fields.get_or(
                        &format!("dt_{slot}_label"),
                        dt.label.as_deref().unwrap_or(""),
                    );
                    self.dates.push(DateDraft {
                        slot,
                        date_id: Some(dt.id),
                        kind: dt.kind,
                        date: dt.date,
                        label: dt.label.unwrap_or_default(),
                    });
                }
            }
            return;
        }
        // D1 draft restore for new person form.
        if let Some(key) = draft_key(b.door)
            && let Some(raw) = b.door.device_get(&key)
            && let Ok(Value::Object(mut obj)) = serde_json::from_str::<Value>(&raw)
            && let Some(Value::Object(fields)) = obj.remove("fields")
        {
            for name in ["name", "role", "org", "nickname", "met", "cadence"] {
                if let Some(val) = fields.get(name).and_then(Value::as_str) {
                    b.ui.fields.get_or(name, val);
                    if !val.is_empty() {
                        self.drafted = true;
                        self.dirty = true;
                    }
                }
            }
        }
    }

    fn persist_draft(&mut self, e: &Event<'_>) {
        if self.editing.is_some() {
            return;
        }
        let Some(key) = draft_key(e.door) else {
            return;
        };
        let mut fields = Map::new();
        for name in ["name", "role", "org", "nickname", "met", "cadence"] {
            let val = e.ui.fields.get(name).map_or("", |f| f.value());
            if !val.is_empty() {
                fields.insert(name.to_owned(), Value::String(val.to_owned()));
            }
        }
        let record = json!({
            "v": 1,
            "kind": "person",
            "fields": fields,
            "saved_at": e.door.now_ms(),
        });
        if e.door.device_put(&key, &record.to_string()).is_ok() {
            self.drafted = !fields.is_empty();
        }
    }

    fn clear_draft(&mut self, door: &dyn Door) {
        if self.editing.is_some() {
            return;
        }
        if let Some(key) = draft_key(door) {
            let _ = door.device_delete(&key);
        }
        self.drafted = false;
    }
}

impl RoomScreen for PersonForm {
    fn key(&self) -> String {
        match &self.editing {
            Some(id) => format!("person/{id}/edit"),
            None => NEW_PERSON.to_owned(),
        }
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        self.load_initial(b);
        let title = if self.editing.is_some() {
            words::edit_person_title(EN)
        } else {
            words::new_person_title(EN)
        };

        if self.confirm_discard {
            let confirm = blocks::confirm(
                &mut b.sel,
                Confirm {
                    class: wire::RoomConfirmClass::Outlined,
                    title: &words::discard_title(EN),
                    body: &words::discard_body(EN),
                    warning: "",
                    confirm_label: &words::discard_confirm(EN),
                    confirm: Handler::Tag("discard:yes".to_owned()),
                    cancel_label: &words::discard_keep(EN),
                    cancel: Handler::Tag("discard:no".to_owned()),
                },
            );
            return room(wire::RoomKind::Sheet, &self.key())
                .title(&words::discard_title(EN))
                .ready(vec![confirm])
                .build();
        }

        let mut name_field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "name",
            &words::field_name(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_NAME_CHARS,
        )
        .required();
        if self.editing.is_none() {
            name_field = name_field.focused();
        }
        if !self.name_error.is_empty() {
            name_field = name_field.error(&self.name_error);
        }

        let fields = vec![
            name_field.build(),
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "role",
                &words::field_role(EN),
                wire::RoomTextKind::Line,
                "",
                MAX_META_CHARS,
            )
            .build(),
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "org",
                &words::field_org(EN),
                wire::RoomTextKind::Line,
                "",
                MAX_META_CHARS,
            )
            .build(),
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "nickname",
                &words::field_nickname(EN),
                wire::RoomTextKind::Line,
                "",
                MAX_META_CHARS,
            )
            .build(),
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "met",
                &words::field_met(EN),
                wire::RoomTextKind::Line,
                "",
                MAX_META_CHARS,
            )
            .build(),
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "cadence",
                &words::field_cadence(EN),
                wire::RoomTextKind::Number,
                "",
                6,
            )
            .build(),
        ];

        let mut contact_groups = Vec::new();
        for cp in &self.contacts {
            let slot = cp.slot;
            let kind_opts = ["phone", "email", "address", "url", "handle"]
                .into_iter()
                .map(|k| blocks::option(k, &contact_kind_label(k), cp.kind == k))
                .collect();
            let kind_field = form::choice(
                &mut b.sel,
                &format!("cp_{slot}_kind"),
                &words::field_contact_kind(EN),
                wire::RoomChoiceStyle::Menu,
                kind_opts,
            )
            .build();
            let val_field = form::text(
                &mut b.sel,
                &mut b.ui.fields,
                &format!("cp_{slot}_val"),
                &words::field_contact_value(EN),
                wire::RoomTextKind::Line,
                &cp.value,
                MAX_VALUE_CHARS,
            )
            .build();
            let label_field = form::text(
                &mut b.sel,
                &mut b.ui.fields,
                &format!("cp_{slot}_label"),
                &words::field_contact_label(EN),
                wire::RoomTextKind::Line,
                &cp.label,
                MAX_META_CHARS,
            )
            .build();
            contact_groups.push(form::group(
                &format!("repeat/cp/{slot}"),
                vec![kind_field, val_field, label_field],
                Handler::Tag(format!("cp:rm:{slot}")),
                &mut b.sel,
            ));
        }

        let mut date_groups = Vec::new();
        for dt in &self.dates {
            let slot = dt.slot;
            let kind_opts = ["birthday", "anniversary", "other"]
                .into_iter()
                .map(|k| blocks::option(k, &date_kind_label(k), dt.kind == k))
                .collect();
            let kind_field = form::choice(
                &mut b.sel,
                &format!("dt_{slot}_kind"),
                &words::field_date_kind(EN),
                wire::RoomChoiceStyle::Menu,
                kind_opts,
            )
            .build();
            let val_field = form::text(
                &mut b.sel,
                &mut b.ui.fields,
                &format!("dt_{slot}_val"),
                &words::field_date_value(EN),
                wire::RoomTextKind::Line,
                &dt.date,
                32,
            )
            .build();
            let label_field = form::text(
                &mut b.sel,
                &mut b.ui.fields,
                &format!("dt_{slot}_label"),
                &words::field_date_label(EN),
                wire::RoomTextKind::Line,
                &dt.label,
                MAX_META_CHARS,
            )
            .build();
            date_groups.push(form::group(
                &format!("repeat/dt/{slot}"),
                vec![kind_field, val_field, label_field],
                Handler::Tag(format!("dt:rm:{slot}")),
                &mut b.sel,
            ));
        }

        let repeats = vec![
            form::repeat(
                &mut b.sel,
                "repeat/contacts",
                &words::repeat_contact(EN),
                contact_groups,
                &words::add_contact(EN),
                Handler::Tag("cp:add".to_owned()),
            ),
            form::repeat(
                &mut b.sel,
                "repeat/dates",
                &words::repeat_dates(EN),
                date_groups,
                &words::add_date(EN),
                Handler::Tag("dt:add".to_owned()),
            ),
        ];

        let save_enabled =
            b.ui.fields
                .get("name")
                .is_some_and(|f| !f.value().trim().is_empty());
        let explicit = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Tag("cancel".to_owned()),
                save_enabled,
                dirty: self.dirty,
                drafted: self.drafted,
            },
        );
        let form_block = form::form(fields, repeats, Save::Explicit(explicit));

        room(wire::RoomKind::Editor, &self.key())
            .title(&title)
            .ready(vec![form_block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        match tag {
            "cp:add" => {
                let slot = self.next_slot;
                self.next_slot += 1;
                self.contacts.push(ContactDraft {
                    slot,
                    point_id: None,
                    kind: "phone".to_owned(),
                    value: String::new(),
                    label: String::new(),
                });
                self.dirty = true;
                return Outcome::default();
            }
            "dt:add" => {
                let slot = self.next_slot;
                self.next_slot += 1;
                self.dates.push(DateDraft {
                    slot,
                    date_id: None,
                    kind: "birthday".to_owned(),
                    date: String::new(),
                    label: String::new(),
                });
                self.dirty = true;
                return Outcome::default();
            }
            "cancel" => {
                if self.dirty {
                    self.confirm_discard = true;
                    return Outcome::default();
                }
                return Outcome::pop();
            }
            "discard:yes" => {
                self.clear_draft(e.door);
                return Outcome::pop();
            }
            "discard:no" => {
                self.confirm_discard = false;
                return Outcome::default();
            }
            "save" => {
                let name =
                    e.ui.fields
                        .get("name")
                        .map_or("", |f| f.value())
                        .trim()
                        .to_owned();
                if name.is_empty() {
                    self.name_error = words::field_name_required(EN);
                    return Outcome::default();
                }
                self.name_error.clear();
                let mut payload = Map::new();
                payload.insert("title".to_owned(), Value::String(name));
                for (field, key) in [
                    ("role", "role"),
                    ("org", "org"),
                    ("nickname", "nickname"),
                    ("met", "met"),
                ] {
                    let val =
                        e.ui.fields
                            .get(field)
                            .map_or("", |f| f.value())
                            .trim()
                            .to_owned();
                    if !val.is_empty() {
                        payload.insert(key.to_owned(), Value::String(val));
                    }
                }
                let cadence_raw = e.ui.fields.get("cadence").map_or("", |f| f.value()).trim();
                if let Ok(days) = cadence_raw.parse::<i64>()
                    && days > 0
                {
                    payload.insert("cadence_days".to_owned(), Value::from(days));
                }

                let person_id = if let Some(id) = self.editing.clone() {
                    payload.insert("id".to_owned(), Value::String(id.clone()));
                    if let Err(refused) =
                        e.door.act(&Act::new("person.edit", Value::Object(payload)))
                    {
                        return Outcome::refuse(&refused.0);
                    }
                    id
                } else {
                    let id = mint_uuid_v7(e.door.now_ms());
                    payload.insert("id".to_owned(), Value::String(id.clone()));
                    if let Err(refused) =
                        e.door.act(&Act::new("person.add", Value::Object(payload)))
                    {
                        return Outcome::refuse(&refused.0);
                    }
                    id
                };

                for cp in &self.contacts {
                    let val =
                        e.ui.fields
                            .get(&format!("cp_{}_val", cp.slot))
                            .map_or(cp.value.as_str(), |f| f.value())
                            .trim()
                            .to_owned();
                    if val.is_empty() {
                        continue;
                    }
                    let label =
                        e.ui.fields
                            .get(&format!("cp_{}_label", cp.slot))
                            .map_or(cp.label.as_str(), |f| f.value())
                            .trim()
                            .to_owned();
                    let mut cp_in = Map::new();
                    cp_in.insert("id".to_owned(), Value::String(person_id.clone()));
                    cp_in.insert("kind".to_owned(), Value::String(cp.kind.clone()));
                    cp_in.insert("value".to_owned(), Value::String(val));
                    if !label.is_empty() {
                        cp_in.insert("label".to_owned(), Value::String(label));
                    }
                    if let Some(pid) = &cp.point_id {
                        cp_in.insert("point_id".to_owned(), Value::String(pid.clone()));
                    }
                    if let Err(refused) = e
                        .door
                        .act(&Act::new("person.save_contact_point", Value::Object(cp_in)))
                    {
                        return Outcome::refuse(&refused.0);
                    }
                }

                for dt in &self.dates {
                    let val =
                        e.ui.fields
                            .get(&format!("dt_{}_val", dt.slot))
                            .map_or(dt.date.as_str(), |f| f.value())
                            .trim()
                            .to_owned();
                    if val.is_empty() {
                        continue;
                    }
                    let label =
                        e.ui.fields
                            .get(&format!("dt_{}_label", dt.slot))
                            .map_or(dt.label.as_str(), |f| f.value())
                            .trim()
                            .to_owned();
                    if let Some(did) = &dt.date_id {
                        let mut dt_in = Map::new();
                        dt_in.insert("date_id".to_owned(), Value::String(did.clone()));
                        dt_in.insert("date".to_owned(), Value::String(val));
                        dt_in.insert("kind".to_owned(), Value::String(dt.kind.clone()));
                        if !label.is_empty() {
                            dt_in.insert("label".to_owned(), Value::String(label));
                        }
                        if let Err(refused) = e
                            .door
                            .act(&Act::new("person.edit_date", Value::Object(dt_in)))
                        {
                            return Outcome::refuse(&refused.0);
                        }
                    } else {
                        let mut dt_in = Map::new();
                        dt_in.insert("id".to_owned(), Value::String(person_id.clone()));
                        dt_in.insert("date".to_owned(), Value::String(val));
                        dt_in.insert("kind".to_owned(), Value::String(dt.kind.clone()));
                        if !label.is_empty() {
                            dt_in.insert("label".to_owned(), Value::String(label));
                        }
                        if let Err(refused) = e
                            .door
                            .act(&Act::new("person.add_date", Value::Object(dt_in)))
                        {
                            return Outcome::refuse(&refused.0);
                        }
                    }
                }

                self.clear_draft(e.door);
                self.dirty = false;
                return Outcome::pop();
            }
            _ => {}
        }

        if let Some(slot_str) = tag.strip_prefix("cp:rm:")
            && let Ok(slot) = slot_str.parse::<usize>()
        {
            if let Some(pos) = self.contacts.iter().position(|c| c.slot == slot) {
                let removed = self.contacts.remove(pos);
                if let Some(pid) = removed.point_id {
                    let _ = e.door.act(&Act::new(
                        "person.remove_contact_point",
                        json!({ "point_id": pid }),
                    ));
                }
                self.dirty = true;
            }
            return Outcome::default();
        }
        if let Some(slot_str) = tag.strip_prefix("dt:rm:")
            && let Ok(slot) = slot_str.parse::<usize>()
        {
            if let Some(pos) = self.dates.iter().position(|d| d.slot == slot) {
                let removed = self.dates.remove(pos);
                if let Some(did) = removed.date_id {
                    let _ = e
                        .door
                        .act(&Act::new("person.remove_date", json!({ "date_id": did })));
                }
                self.dirty = true;
            }
            return Outcome::default();
        }

        if let Input::Option(choice) = input {
            if let Some(rest) = tag.strip_prefix("cp_")
                && let Some(slot_str) = rest.strip_suffix("_kind")
                && let Ok(slot) = slot_str.parse::<usize>()
                && let Some(cp) = self.contacts.iter_mut().find(|c| c.slot == slot)
            {
                cp.kind.clone_from(choice);
                self.dirty = true;
            }
            if let Some(rest) = tag.strip_prefix("dt_")
                && let Some(slot_str) = rest.strip_suffix("_kind")
                && let Ok(slot) = slot_str.parse::<usize>()
                && let Some(dt) = self.dates.iter_mut().find(|d| d.slot == slot)
            {
                dt.kind.clone_from(choice);
                self.dirty = true;
            }
            return Outcome::default();
        }

        if matches!(input, Input::Text(_)) {
            if tag == "name" {
                self.name_error.clear();
            }
            self.dirty = true;
            self.persist_draft(e);
        }
        Outcome::default()
    }
}

struct MergePick {
    id: String,
}

impl RoomScreen for MergePick {
    fn key(&self) -> String {
        format!("person/{}/merge", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let from_name = b
            .run(&reads::BY_ID, &Args::new().text("id", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map_or_else(|| words::title(EN), |p| p.title);
        let people = match b.run(&reads::LIST, &Args::new()) {
            Ok(a) => a.rows,
            Err(refused) => {
                return room(wire::RoomKind::Sheet, &self.key())
                    .title(&words::merge_title(EN))
                    .back(&mut b.sel, &from_name)
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let candidates: Vec<reads::PersonSummary> =
            people.into_iter().filter(|p| p.id != self.id).collect();
        let blocks_out = if candidates.is_empty() {
            vec![blocks::empty(
                glyph("Users", ""),
                &words::merge_empty_title(EN),
                &words::merge_empty_body(EN),
                None,
            )]
        } else {
            let rows: Vec<wire::RoomBlock> = candidates
                .iter()
                .map(|p| {
                    blocks::row(
                        &mut b.sel,
                        &format!("merge/{}", p.id),
                        &p.title,
                        Handler::Open(format!("person/{}/merge/{}", self.id, p.id)),
                    )
                    .meta(&summary_meta(p, false))
                    .into_block()
                })
                .collect();
            let heading = fill(&words::merge_pick_heading(EN), &[("name", &from_name)]);
            vec![
                blocks::section(&mut b.sel, "section/candidates", &heading)
                    .blocks(rows)
                    .into_block(),
            ]
        };
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::merge_title(EN))
            .back(&mut b.sel, &from_name)
            .ready(blocks_out)
            .build()
    }
}

struct MergeConfirm {
    from: String,
    into: String,
}

impl RoomScreen for MergeConfirm {
    fn key(&self) -> String {
        format!("person/{}/merge/{}", self.from, self.into)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let from_name = b
            .run(&reads::BY_ID, &Args::new().text("id", &self.from))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map_or_else(|| shared::trash_untitled(EN), |p| p.title);
        let into_name = b
            .run(&reads::BY_ID, &Args::new().text("id", &self.into))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map_or_else(|| shared::trash_untitled(EN), |p| p.title);
        let title = fill(
            &words::merge_confirm_title(EN),
            &[("from", &from_name), ("into", &into_name)],
        );
        let body = fill(
            &words::merge_confirm_body(EN),
            &[("from", &from_name), ("into", &into_name)],
        );
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &title,
                body: &body,
                warning: "",
                confirm_label: &words::merge_confirm_action(EN),
                confirm: Handler::Tag("merge:confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::merge_title(EN))
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "merge:confirm" {
            let act = Act::new(
                "person.merge",
                json!({ "from": &self.from, "into": &self.into }),
            );
            return match e.door.act(&act) {
                Ok(_) => Outcome::replace(&format!("person/{}", self.into)),
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct TrashPersonConfirm {
    id: String,
}

impl RoomScreen for TrashPersonConfirm {
    fn key(&self) -> String {
        format!("person/{}/trash-confirm", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let name = b
            .run(&reads::BY_ID, &Args::new().text("id", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map_or_else(|| shared::trash_untitled(EN), |p| p.title);
        let held = b
            .run(&reads::TOUCHES_HELD, &Args::new().text("person", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map_or(0, |h| h.count);
        let count = u64::try_from(held.max(0)).unwrap_or(0);
        let title = fill(&words::trash_person_title(EN), &[("name", &name)]);
        let body = fill(&words::trash_person_body(EN, count), &[("name", &name)]);
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &title,
                body: &body,
                warning: "",
                confirm_label: &shared::trash_move(EN),
                confirm: Handler::Tag("trash:confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&shared::trash_move(EN))
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "trash:confirm" {
            let act = Act::new("entity.trash", json!({ "ids": [&self.id] }));
            return match e.door.act(&act) {
                Ok(_) => Outcome::replace(PEOPLE),
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct ListsPage {
    loaded: usize,
}

impl Default for ListsPage {
    fn default() -> Self {
        Self { loaded: 50 }
    }
}

impl RoomScreen for ListsPage {
    fn key(&self) -> String {
        LISTS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let mut frame = room(wire::RoomKind::AppPlace, LISTS)
            .title(&words::lists_title(EN))
            .key(
                &mut b.sel,
                "key/add",
                wire::RoomKeyRole::Add,
                "Plus",
                &words::new_list(EN),
                Handler::Open(NEW_LIST.to_owned()),
            )
            .band(people_band(&mut b.sel, LISTS));

        let answer = match b.reload(&reads::LISTS, &Args::new(), self.loaded) {
            Ok(a) => a,
            Err(refused) => {
                return frame
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let blocks_out = if answer.rows.is_empty() {
            let add = blocks::action(
                &mut b.sel,
                "empty/add",
                &words::new_list(EN),
                "Plus",
                Handler::Open(NEW_LIST.to_owned()),
            );
            vec![blocks::empty(
                glyph("List", ""),
                &words::empty_lists_title(EN),
                &words::empty_lists_body(EN),
                Some(add),
            )]
        } else {
            let mut rows = Vec::with_capacity(answer.rows.len());
            for list in &answer.rows {
                let count = b
                    .run(
                        &reads::LIST_MEMBER_COUNT,
                        &Args::new().text("list", &list.id),
                    )
                    .ok()
                    .and_then(|a| a.rows.into_iter().next())
                    .map_or(0, |c| c.0);
                let n = u64::try_from(count.max(0)).unwrap_or(0);
                let mut del = blocks::menu_item(
                    &mut b.sel,
                    &format!("list/{}/trash", list.id),
                    &words::menu_delete_list(EN),
                    Handler::Act(Act::new("entity.trash", json!({ "ids": [list.id] }))),
                );
                del.destructive = true;
                let menu = blocks::menu(
                    &format!("list/{}/menu", list.id),
                    vec![blocks::menu_section(
                        "",
                        vec![
                            blocks::menu_item(
                                &mut b.sel,
                                &format!("list/{}/open", list.id),
                                &shared::kit_open(EN),
                                Handler::Open(format!("people/list/{}", list.id)),
                            ),
                            del,
                        ],
                    )],
                    &mut b.sel,
                );
                // Lists never take their members on delete (N12).
                let row = blocks::row(
                    &mut b.sel,
                    &format!("row/{}", list.id),
                    &list.title,
                    Handler::Open(format!("people/list/{}", list.id)),
                )
                .meta(&words::people_count(EN, n))
                .menu(menu)
                .swipe(
                    &mut b.sel,
                    &format!("row/{}/trash", list.id),
                    &shared::trash_move(EN),
                    Handler::Act(Act::new("entity.trash", json!({ "ids": [list.id] }))),
                );
                rows.push(row.into_block());
            }
            let mut sec =
                blocks::section(&mut b.sel, "section/lists", &words::lists_title(EN)).blocks(rows);
            if answer.next.is_some() {
                sec = sec.next_page(&mut b.sel, "section/lists/next");
            }
            vec![sec.into_block()]
        };

        frame = frame.ready(blocks_out);
        frame.build()
    }

    fn on(&mut self, _: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if let Some(outcome) = handle_more_or_nav(tag) {
            return outcome;
        }
        if tag == "next:section/lists" {
            self.loaded = self.loaded.saturating_add(50);
        }
        Outcome::default()
    }
}

#[derive(Default)]
struct NewListForm {
    dirty: bool,
    error: String,
}

impl RoomScreen for NewListForm {
    fn key(&self) -> String {
        NEW_LIST.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let mut field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "title",
            &words::field_list_name(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_NAME_CHARS,
        )
        .required()
        .focused();
        if !self.error.is_empty() {
            field = field.error(&self.error);
        }
        let save_enabled =
            b.ui.fields
                .get("title")
                .is_some_and(|f| !f.value().trim().is_empty());
        let explicit = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
                save_enabled,
                dirty: self.dirty,
                drafted: false,
            },
        );
        let form_block = form::form(vec![field.build()], Vec::new(), Save::Explicit(explicit));
        room(wire::RoomKind::Sheet, NEW_LIST)
            .title(&words::new_list_title(EN))
            .ready(vec![form_block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if tag == "save" {
            let title =
                e.ui.fields
                    .get("title")
                    .map_or("", |f| f.value())
                    .trim()
                    .to_owned();
            if title.is_empty() {
                self.error = words::field_name_required(EN);
                return Outcome::default();
            }
            let act = Act::new(
                "container.create",
                json!({
                    "kind": "list",
                    "title": title,
                }),
            );
            return match e.door.act(&act) {
                Ok(_) => Outcome::pop(),
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        if matches!(input, Input::Text(_)) {
            self.dirty = true;
            self.error.clear();
        }
        Outcome::default()
    }
}

struct ListDetail {
    id: String,
    loaded: usize,
}

impl RoomScreen for ListDetail {
    fn key(&self) -> String {
        format!("people/list/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let list = match b.run(&reads::LIST_BY_ID, &Args::new().text("id", &self.id)) {
            Ok(a) => a.rows.into_iter().next(),
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::lists_title(EN))
                    .back(&mut b.sel, &words::lists_title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let Some(list) = list else {
            return room(wire::RoomKind::PushedPage, &self.key())
                .title(&words::lists_title(EN))
                .back(&mut b.sel, &words::lists_title(EN))
                .ready(vec![blocks::empty(
                    glyph("List", ""),
                    &words::list_not_found(EN),
                    "",
                    None,
                )])
                .build();
        };

        let members = match b.reload(
            &reads::LIST_MEMBERS,
            &Args::new().text("list", &self.id),
            self.loaded,
        ) {
            Ok(a) => a,
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&list.title)
                    .back(&mut b.sel, &words::lists_title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let mut trash_list = blocks::menu_item(
            &mut b.sel,
            "menu/trash_list",
            &words::menu_delete_list(EN),
            Handler::Tag("trash_list".to_owned()),
        );
        trash_list.destructive = true;
        let overflow = blocks::menu(
            "menu/more",
            vec![blocks::menu_section(
                "",
                vec![
                    blocks::menu_item(
                        &mut b.sel,
                        "menu/add_member",
                        &words::menu_add_member(EN),
                        Handler::Open(format!("people/list/{}/add", self.id)),
                    ),
                    trash_list,
                ],
            )],
            &mut b.sel,
        );

        let blocks_out = if members.rows.is_empty() {
            let add = blocks::action(
                &mut b.sel,
                "empty/add",
                &words::menu_add_member(EN),
                "Plus",
                Handler::Open(format!("people/list/{}/add", self.id)),
            );
            vec![blocks::empty(
                glyph("Users", ""),
                &words::empty_list_members_title(EN),
                &words::empty_list_members_body(EN),
                Some(add),
            )]
        } else {
            let rows: Vec<wire::RoomBlock> = members
                .rows
                .iter()
                .map(|p| {
                    let remove_act = Act::new(
                        "edge.remove",
                        json!({ "from": &self.id, "rel": "contains", "to": &p.id }),
                    );
                    let mut rm_item = blocks::menu_item(
                        &mut b.sel,
                        &format!("row/{}/remove", p.id),
                        &words::menu_remove_member(EN),
                        Handler::Act(remove_act.clone()),
                    );
                    rm_item.destructive = true;
                    let menu = blocks::menu(
                        &format!("row/{}/menu", p.id),
                        vec![blocks::menu_section("", vec![rm_item])],
                        &mut b.sel,
                    );
                    let mut row = blocks::row(
                        &mut b.sel,
                        &format!("row/{}", p.id),
                        &p.title,
                        Handler::Open(format!("person/{}", p.id)),
                    )
                    .menu(menu)
                    .swipe(
                        &mut b.sel,
                        &format!("row/{}/swipe", p.id),
                        &words::menu_remove_member(EN),
                        Handler::Act(remove_act),
                    );
                    let meta = summary_meta(p, false);
                    if !meta.is_empty() {
                        row = row.meta(&meta);
                    }
                    row.into_block()
                })
                .collect();
            let mut sec = blocks::section(&mut b.sel, "section/members", &list.title).blocks(rows);
            if members.next.is_some() {
                sec = sec.next_page(&mut b.sel, "section/members/next");
            }
            vec![sec.into_block()]
        };

        room(wire::RoomKind::PushedPage, &self.key())
            .title(&list.title)
            .back(&mut b.sel, &words::lists_title(EN))
            .menu_key(&mut b.sel, "key/more", &words::menu_more(EN), overflow)
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "next:section/members" {
            self.loaded = self.loaded.saturating_add(50);
            return Outcome::default();
        }
        if tag == "trash_list" {
            let act = Act::new("entity.trash", json!({ "ids": [&self.id] }));
            return match e.door.act(&act) {
                Ok(_) => Outcome::pop(),
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct AddToList {
    id: String,
}

impl RoomScreen for AddToList {
    fn key(&self) -> String {
        format!("people/list/{}/add", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let list_name = b
            .run(&reads::LIST_BY_ID, &Args::new().text("id", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map_or_else(|| words::lists_title(EN), |l| l.title);
        let title = fill(&words::add_member_title(EN), &[("list", &list_name)]);

        let current: std::collections::BTreeSet<String> = b
            .run(&reads::LIST_MEMBERS, &Args::new().text("list", &self.id))
            .ok()
            .map(|a| a.rows.into_iter().map(|p| p.id).collect())
            .unwrap_or_default();
        let all = match b.run(&reads::LIST, &Args::new()) {
            Ok(a) => a.rows,
            Err(refused) => {
                return room(wire::RoomKind::Sheet, &self.key())
                    .title(&title)
                    .back(&mut b.sel, &list_name)
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let available: Vec<reads::PersonSummary> = all
            .into_iter()
            .filter(|p| !current.contains(&p.id))
            .collect();
        let blocks_out = if available.is_empty() {
            vec![blocks::empty(
                glyph("Users", ""),
                &words::add_member_empty(EN),
                "",
                None,
            )]
        } else {
            let rows: Vec<wire::RoomBlock> = available
                .iter()
                .map(|p| {
                    blocks::row(
                        &mut b.sel,
                        &format!("pick/{}", p.id),
                        &p.title,
                        Handler::Tag(format!("add:{}", p.id)),
                    )
                    .into_block()
                })
                .collect();
            vec![
                blocks::section(&mut b.sel, "section/pick", &title)
                    .blocks(rows)
                    .into_block(),
            ]
        };
        room(wire::RoomKind::Sheet, &self.key())
            .title(&title)
            .back(&mut b.sel, &list_name)
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if let Some(person_id) = tag.strip_prefix("add:") {
            let act = Act::new(
                "edge.add",
                json!({ "from": &self.id, "rel": "contains", "to": person_id }),
            );
            return match e.door.act(&act) {
                Ok(_) => Outcome::pop(),
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct PeopleTrash {
    loaded: usize,
}

impl Default for PeopleTrash {
    fn default() -> Self {
        Self { loaded: 50 }
    }
}

fn short_day(iso: &str) -> &str {
    iso.get(..10).unwrap_or(iso)
}

impl RoomScreen for PeopleTrash {
    fn key(&self) -> String {
        TRASH.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let answer = match b.reload(&reads::TRASH, &Args::new(), self.loaded) {
            Ok(a) => a,
            Err(refused) => {
                return room(wire::RoomKind::PushedPage, TRASH)
                    .title(&shared::trash_title(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let count = u64::try_from(answer.rows.len()).unwrap_or(u64::MAX);
        let heading = if answer.rows.is_empty() {
            shared::trash_title(EN)
        } else {
            shared::trash_count(EN, count)
        };

        let blocks_out = if answer.rows.is_empty() {
            vec![blocks::empty(
                glyph("Trash", ""),
                &shared::trash_empty_headline(EN),
                &shared::trash_empty_state_body(EN),
                None,
            )]
        } else {
            let rows: Vec<wire::RoomTrashRow> = answer
                .rows
                .iter()
                .map(|row| {
                    let meta = format!(
                        "{} {} · {} {}",
                        shared::trash_deleted(EN),
                        short_day(&row.deleted_at),
                        shared::trash_erased(EN),
                        short_day(&row.purge_at),
                    );
                    let title = if row.title.is_empty() {
                        shared::trash_untitled(EN)
                    } else {
                        row.title.clone()
                    };
                    blocks::trash_row(
                        &mut b.sel,
                        &format!("trash/{}", row.id),
                        &title,
                        &meta,
                        Handler::Act(Act::new("entity.restore", json!({ "ids": [row.id] }))),
                        Handler::Open(format!("people/trash/purge/{}", row.id)),
                    )
                })
                .collect();
            let empty_action = blocks::destructive(
                &mut b.sel,
                "trash/empty",
                &shared::trash_empty_action(EN),
                "Trash",
                Handler::Open("people/trash/empty".to_owned()),
            );
            let mut trash = blocks::trash(
                &heading,
                &shared::trash_entry_meta(EN),
                rows,
                Some(empty_action),
            );
            if answer.next.is_some() {
                trash.next_page_selector_id = b
                    .sel
                    .on("trash/next", Handler::NextPage("trash".to_owned()));
            }
            vec![blocks::trash_block(trash)]
        };

        room(wire::RoomKind::PushedPage, TRASH)
            .title(&heading)
            .back(&mut b.sel, &words::title(EN))
            .ready(blocks_out)
            .build()
    }

    fn on(&mut self, _: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "next:trash" {
            self.loaded = self.loaded.saturating_add(50);
        }
        Outcome::default()
    }
}

struct PurgeConfirm {
    id: String,
}

impl RoomScreen for PurgeConfirm {
    fn key(&self) -> String {
        format!("people/trash/purge/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let title = fill(
            &shared::trash_purge_title(EN),
            &[("noun", &shared::trash_noun_person(EN))],
        );
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &title,
                body: &words::purge_person_body(EN),
                warning: "",
                confirm_label: &shared::trash_purge(EN),
                confirm: Handler::Tag("purge:yes".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&shared::trash_purge(EN))
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "purge:yes" {
            let act = Act::new("entity.purge", json!({ "id": &self.id }));
            return match e.door.act(&act) {
                Ok(_) => Outcome::pop(),
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct EmptyTrashConfirm;

impl RoomScreen for EmptyTrashConfirm {
    fn key(&self) -> String {
        "people/trash/empty".to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &shared::trash_empty_title(EN),
                body: &shared::trash_empty_body(EN),
                warning: "",
                confirm_label: &shared::trash_empty_action(EN),
                confirm: Handler::Tag("empty:yes".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&shared::trash_empty_action(EN))
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "empty:yes" {
            let act = Act::new(
                "entity.empty_trash",
                json!({ "kind": "person", "with_kind": "touch" }),
            );
            return match e.door.act(&act) {
                Ok(_) => Outcome::pop(),
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}
