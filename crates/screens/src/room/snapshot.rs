//! A ROOM AS TEXT: every app lane's proof. Indented blocks with their fields, empty fields left
//! out, every selector shown as `#label`. The selectors a room claims are stable labels (an
//! entity's id, a verb's name), so a snapshot changes only when what a member sees changes.

use std::fmt::Write as _;

use centraid_api_proto::core_v1 as wire;
use wire::room_block::Kind as B;

struct Out {
    text: String,
}

/// The mark of an element that carries one, under a name the icon scan does not take for a key.
trait Marked {
    fn symbol(&self) -> String;
}

macro_rules! marked {
    ($($ty:ty),*) => {$(impl Marked for $ty {
        fn symbol(&self) -> String {
            self.icon.clone()
        }
    })*};
}

marked!(
    wire::RoomKey,
    wire::RoomTab,
    wire::RoomMenuItem,
    wire::RoomAction
);

impl Out {
    fn line(&mut self, depth: usize, head: &str, parts: &[(&str, String)]) {
        let mut line = format!("{}{head}", "  ".repeat(depth));
        for (name, value) in parts {
            if value.is_empty() || value == "0" || value == "false" {
                continue;
            }
            if value == "true" {
                let _ = write!(line, " {name}");
            } else if name.is_empty() {
                let _ = write!(line, " {value}");
            } else {
                let _ = write!(line, " {name}={value}");
            }
        }
        self.text.push_str(line.trim_end());
        self.text.push('\n');
    }
}

fn q(text: &str) -> String {
    if text.is_empty() {
        String::new()
    } else {
        format!("{text:?}")
    }
}

fn sel(id: &str) -> String {
    if id.is_empty() {
        String::new()
    } else {
        format!("#{id}")
    }
}

fn flag(on: bool) -> String {
    on.to_string()
}

fn num(n: impl ToString) -> String {
    n.to_string()
}

fn lower(name: &str, prefix: &str) -> String {
    name.strip_prefix(prefix)
        .unwrap_or(name)
        .to_ascii_lowercase()
}

fn tone(value: i32) -> String {
    wire::RoomTone::try_from(value)
        .map(|tone| lower(tone.as_str_name(), "ROOM_TONE_"))
        .ok()
        .filter(|name| name != "unspecified" && name != "neutral")
        .unwrap_or_default()
}

/// The room as text.
#[must_use]
pub fn render(room: &wire::Room) -> String {
    let mut out = Out {
        text: String::new(),
    };
    let kind = wire::RoomKind::try_from(room.kind)
        .map(|kind| lower(kind.as_str_name(), "ROOM_KIND_"))
        .unwrap_or_default();
    out.line(
        0,
        &format!("room {kind}"),
        &[("key", q(&room.key)), ("secure", flag(room.secure))],
    );
    if let Some(header) = &room.header {
        header_of(&mut out, header);
    }
    if let Some(band) = &room.band {
        band_of(&mut out, band);
    }
    match &room.state {
        Some(wire::room::State::Loading(_)) => out.line(1, "loading", &[]),
        Some(wire::room::State::Failed(failed)) => out.line(
            1,
            "failed",
            &[
                ("", q(&failed.sentence)),
                ("retry", q(&failed.retry_label)),
                ("", sel(&failed.retry_selector_id)),
            ],
        ),
        Some(wire::room::State::Ready(ready)) => {
            out.line(1, "ready", &[]);
            for block in &ready.blocks {
                block_of(&mut out, 2, block);
            }
        }
        None => out.line(1, "no state", &[]),
    }
    if let Some(status) = &room.status_line {
        out.line(
            1,
            "status",
            &[
                ("", q(&status.sentence)),
                ("action", q(&status.action_label)),
                ("", sel(&status.action_selector_id)),
                ("refused", flag(status.refused)),
            ],
        );
    }
    if let Some(search) = &room.search {
        out.line(
            1,
            "search",
            &[
                ("open", flag(search.open)),
                ("term", q(&search.term)),
                ("placeholder", q(&search.placeholder)),
                ("corrected", q(&search.corrected)),
                ("", sel(&search.selector_id)),
                ("close", sel(&search.close_selector_id)),
            ],
        );
        for row in &search.containers {
            row_of(&mut out, 2, row, "container");
        }
        if let Some(ask) = &search.ask {
            row_of(&mut out, 2, ask, "ask");
        }
    }
    if let Some(selection) = &room.selection {
        out.line(
            1,
            "selection",
            &[
                ("on", flag(selection.on)),
                ("", q(&selection.label)),
                ("count", num(selection.count)),
                ("all", sel(&selection.select_all_selector_id)),
                ("done", sel(&selection.done_selector_id)),
            ],
        );
        for item in &selection.actions {
            menu_item_of(&mut out, 2, item);
        }
    }
    if let Some(place) = &room.restore {
        out.line(
            1,
            "restore",
            &[
                ("anchor", sel(&place.anchor_selector_id)),
                ("fraction", num(place.anchor_fraction_milli)),
                ("term", q(&place.search_term)),
                (
                    "filters",
                    place
                        .filter_selector_ids
                        .iter()
                        .map(|id| sel(id))
                        .collect::<Vec<_>>()
                        .join(","),
                ),
                ("lens", q(&place.lens)),
            ],
        );
    }
    out.text
}

fn header_of(out: &mut Out, header: &wire::RoomHeader) {
    out.line(
        1,
        "header",
        &[
            ("title", q(&header.title)),
            ("subtitle", q(&header.subtitle)),
            ("clear", sel(&header.subtitle_clear_selector_id)),
        ],
    );
    if let Some(back) = &header.back {
        out.line(
            2,
            "back",
            &[("", q(&back.label)), ("", sel(&back.selector_id))],
        );
    }
    for key in &header.keys {
        let role = wire::RoomKeyRole::try_from(key.role)
            .map(|role| lower(role.as_str_name(), "ROOM_KEY_ROLE_"))
            .unwrap_or_default();
        out.line(
            2,
            &format!("key {role}"),
            &[
                ("sym", q(&key.symbol())),
                ("", q(&key.label)),
                ("", sel(&key.selector_id)),
                ("disabled", flag(!key.enabled)),
            ],
        );
        if let Some(menu) = &key.menu {
            menu_of(out, 3, menu);
        }
    }
    if let Some(filter) = &header.filter {
        out.line(
            2,
            "filter",
            &[
                ("filtering", flag(filter.filtering)),
                ("clear", sel(&filter.clear_selector_id)),
            ],
        );
        if let Some(menu) = &filter.menu {
            menu_of(out, 3, menu);
        }
    }
}

fn band_of(out: &mut Out, band: &wire::RoomBand) {
    out.line(
        1,
        "band",
        &[
            ("home", sel(&band.home_selector_id)),
            ("search", sel(&band.search_selector_id)),
            ("more", sel(&band.more_selector_id)),
            ("more_selected", flag(band.more_selected)),
        ],
    );
    for tab in &band.tabs {
        out.line(
            2,
            "tab",
            &[
                ("", q(&tab.label)),
                ("sym", q(&tab.symbol())),
                ("selected", flag(tab.selected)),
                ("", sel(&tab.selector_id)),
            ],
        );
    }
    if let Some(more) = &band.more {
        menu_of(out, 2, more);
    }
}

fn menu_of(out: &mut Out, depth: usize, menu: &wire::RoomMenu) {
    out.line(depth, "menu", &[("", sel(&menu.selector_id))]);
    for section in &menu.sections {
        out.line(depth + 1, "section", &[("", q(&section.heading))]);
        for item in &section.items {
            menu_item_of(out, depth + 2, item);
        }
    }
}

fn menu_item_of(out: &mut Out, depth: usize, item: &wire::RoomMenuItem) {
    out.line(
        depth,
        "item",
        &[
            ("", q(&item.label)),
            ("secondary", q(&item.secondary)),
            ("sym", q(&item.symbol())),
            ("destructive", flag(item.destructive)),
            ("checked", flag(item.checked)),
            ("disabled", flag(!item.enabled && item.submenu.is_empty())),
            ("", sel(&item.selector_id)),
        ],
    );
    for sub in &item.submenu {
        menu_item_of(out, depth + 1, sub);
    }
}

fn action_of(out: &mut Out, depth: usize, name: &str, action: &wire::RoomAction) {
    out.line(
        depth,
        name,
        &[
            ("", q(&action.label)),
            ("sym", q(&action.symbol())),
            ("destructive", flag(action.destructive)),
            ("disabled", flag(!action.enabled)),
            ("", sel(&action.selector_id)),
        ],
    );
}

fn chips_of(chips: &[wire::RoomChip]) -> String {
    chips
        .iter()
        .map(|chip| {
            let mut text = q(&chip.label);
            let tone = tone(chip.tone);
            if !tone.is_empty() {
                let _ = write!(text, ":{tone}");
            }
            if !chip.remove_selector_id.is_empty() {
                let _ = write!(text, " x{}", sel(&chip.remove_selector_id));
            }
            text
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn mark_of(mark: Option<&wire::RoomMark>) -> String {
    match mark.and_then(|mark| mark.kind.as_ref()) {
        Some(wire::room_mark::Kind::Glyph(glyph)) => format!("glyph:{}", glyph.icon),
        Some(wire::room_mark::Kind::Thumb(thumb)) => format!("thumb:{}", thumb.r#ref),
        Some(wire::room_mark::Kind::Check(check)) => {
            let state = wire::RoomCheckState::try_from(check.state)
                .map(|state| lower(state.as_str_name(), "ROOM_CHECK_STATE_"))
                .unwrap_or_default();
            format!("check:{state}{}", sel(&check.selector_id))
        }
        None => String::new(),
    }
}

fn row_of(out: &mut Out, depth: usize, row: &wire::RoomRow, head: &str) {
    let trailing = if row.trailing.is_empty() {
        String::new()
    } else {
        let tone = tone(row.trailing_tone);
        if tone.is_empty() {
            q(&row.trailing)
        } else {
            format!("{}:{tone}", q(&row.trailing))
        }
    };
    out.line(
        depth,
        head,
        &[
            ("", sel(&row.selector_id)),
            ("", q(&row.title)),
            ("meta", q(&row.meta)),
            ("trailing", trailing),
            ("chips", chips_of(&row.chips)),
            ("mark", mark_of(row.mark.as_ref())),
            ("a11y", q(&row.a11y_label)),
            ("dimmed", flag(row.dimmed)),
            ("pending", flag(row.pending)),
            ("selected", flag(row.selected)),
            (
                "swipe",
                row.swipe
                    .as_ref()
                    .map(|swipe| format!("{} {}", q(&swipe.label), sel(&swipe.selector_id)))
                    .unwrap_or_default(),
            ),
        ],
    );
    if let Some(menu) = &row.menu {
        menu_of(out, depth + 1, menu);
    }
}

fn block_of(out: &mut Out, depth: usize, block: &wire::RoomBlock) {
    let Some(kind) = &block.kind else {
        out.line(depth, "empty block", &[]);
        return;
    };
    match kind {
        B::Hero(hero) => {
            out.line(
                depth,
                "hero",
                &[
                    ("", q(&hero.title)),
                    ("noun", q(&hero.noun)),
                    ("mark", mark_of(hero.mark.as_ref())),
                    ("chips", chips_of(&hero.chips)),
                ],
            );
            for line in &hero.lines {
                out.line(depth + 1, "line", &[("", q(line))]);
            }
            if let Some(primary) = &hero.primary {
                action_of(out, depth + 1, "primary", primary);
            }
            if let Some(menu) = &hero.menu {
                menu_of(out, depth + 1, menu);
            }
        }
        B::Section(section) => {
            out.line(
                depth,
                "section",
                &[
                    ("", sel(&section.selector_id)),
                    ("", q(&section.heading)),
                    ("count", q(&section.count_label)),
                    ("next", sel(&section.next_page_selector_id)),
                ],
            );
            if let Some(trailing) = &section.trailing {
                action_of(out, depth + 1, "trailing", trailing);
            }
            for inner in &section.blocks {
                block_of(out, depth + 1, inner);
            }
        }
        B::Row(row) => row_of(out, depth, row, "row"),
        B::Facts(facts) => {
            out.line(depth, "facts", &[]);
            for fact in &facts.facts {
                let kind = wire::RoomFactKind::try_from(fact.kind)
                    .map(|kind| lower(kind.as_str_name(), "ROOM_FACT_KIND_"))
                    .unwrap_or_default();
                out.line(
                    depth + 1,
                    "fact",
                    &[
                        ("", q(&fact.label)),
                        ("", q(&fact.value)),
                        ("kind", kind),
                        ("sealed", flag(fact.sealed)),
                        ("open", sel(&fact.open_selector_id)),
                        ("copy", sel(&fact.copy_selector_id)),
                        ("reveal", sel(&fact.reveal_selector_id)),
                    ],
                );
            }
        }
        B::Form(form) => form_of(out, depth, form),
        B::Choice(choice) => choice_of(out, depth, "choice", choice),
        B::Figure(figure) => out.line(
            depth,
            "figure",
            &[
                ("", q(&figure.label)),
                ("", q(&figure.value)),
                ("caption", q(&figure.caption)),
                ("tone", tone(figure.tone)),
            ],
        ),
        B::Prose(prose) => {
            out.line(depth, "prose", &[("", q(&prose.text))]);
            for span in &prose.spans {
                out.line(
                    depth + 1,
                    "link",
                    &[
                        ("", format!("{}..{}", span.start, span.end)),
                        ("", sel(&span.selector_id)),
                    ],
                );
            }
        }
        B::Media(media) => media_of(out, depth, media),
        B::Progress(progress) => {
            out.line(
                depth,
                "progress",
                &[
                    ("", q(&progress.label)),
                    ("done", num(progress.done)),
                    ("total", num(progress.total)),
                    ("count", q(&progress.count_label)),
                ],
            );
            if let Some(cancel) = &progress.cancel {
                action_of(out, depth + 1, "cancel", cancel);
            }
        }
        B::Empty(empty) => {
            out.line(
                depth,
                "empty",
                &[
                    (
                        "glyph",
                        q(&empty
                            .glyph
                            .as_ref()
                            .map(|g| g.icon.clone())
                            .unwrap_or_default()),
                    ),
                    ("", q(&empty.title)),
                    ("body", q(&empty.body)),
                ],
            );
            if let Some(action) = &empty.action {
                action_of(out, depth + 1, "action", action);
            }
        }
        B::Wall(wall) => {
            out.line(
                depth,
                "wall",
                &[
                    ("", q(&wall.title)),
                    ("body", q(&wall.body)),
                    ("failure", q(&wall.failure)),
                ],
            );
            if let Some(unlock) = &wall.unlock {
                action_of(out, depth + 1, "unlock", unlock);
            }
        }
        B::Tiles(tiles) => {
            out.line(depth, "tiles", &[]);
            for tile in &tiles.tiles {
                out.line(
                    depth + 1,
                    "tile",
                    &[
                        ("", q(&tile.label)),
                        ("subtitle", q(&tile.subtitle)),
                        (
                            "glyph",
                            q(&tile
                                .glyph
                                .as_ref()
                                .map(|g| g.icon.clone())
                                .unwrap_or_default()),
                        ),
                        ("", sel(&tile.selector_id)),
                    ],
                );
            }
        }
        B::Glance(glance) => {
            out.line(
                depth,
                "glance",
                &[("", q(&glance.title)), ("", sel(&glance.selector_id))],
            );
            for line in &glance.lines {
                out.line(depth + 1, "line", &[("", q(line))]);
            }
        }
        B::Trash(trash) => {
            out.line(
                depth,
                "trash",
                &[
                    ("", q(&trash.heading)),
                    ("retention", q(&trash.retention)),
                    ("next", sel(&trash.next_page_selector_id)),
                ],
            );
            for row in &trash.rows {
                out.line(
                    depth + 1,
                    "row",
                    &[
                        ("", sel(&row.selector_id)),
                        ("", q(&row.title)),
                        ("meta", q(&row.meta)),
                        ("restore", sel(&row.restore_selector_id)),
                        ("purge", sel(&row.purge_selector_id)),
                    ],
                );
            }
            if let Some(empty) = &trash.empty_trash {
                action_of(out, depth + 1, "empty_trash", empty);
            }
        }
        B::Confirm(confirm) => {
            let class = wire::RoomConfirmClass::try_from(confirm.class)
                .map(|class| lower(class.as_str_name(), "ROOM_CONFIRM_CLASS_"))
                .unwrap_or_default();
            out.line(
                depth,
                &format!("confirm {class}"),
                &[
                    ("", q(&confirm.title)),
                    ("body", q(&confirm.body)),
                    ("warning", q(&confirm.warning)),
                    (
                        "yes",
                        format!(
                            "{}{}",
                            q(&confirm.confirm_label),
                            sel(&confirm.confirm_selector_id)
                        ),
                    ),
                    (
                        "no",
                        format!(
                            "{}{}",
                            q(&confirm.cancel_label),
                            sel(&confirm.cancel_selector_id)
                        ),
                    ),
                ],
            );
        }
        B::Menu(menu) => menu_of(out, depth, menu),
        B::Attachments(attachments) => {
            out.line(depth, "attachments", &[("", q(&attachments.heading))]);
            for row in &attachments.items {
                row_of(out, depth + 1, row, "row");
            }
            if let Some(add) = &attachments.add {
                menu_of(out, depth + 1, add);
            }
        }
        B::Linked(linked) => {
            out.line(depth, "linked", &[("", q(&linked.heading))]);
            for row in &linked.items {
                row_of(out, depth + 1, row, "row");
            }
            if let Some(add) = &linked.add {
                action_of(out, depth + 1, "add", add);
            }
        }
        B::MentionedIn(mentioned) => {
            out.line(depth, "mentioned_in", &[("", q(&mentioned.heading))]);
            for row in &mentioned.items {
                row_of(out, depth + 1, row, "row");
            }
        }
        B::Says(says) => {
            let source = wire::RoomSaysSource::try_from(says.source)
                .map(|source| lower(source.as_str_name(), "ROOM_SAYS_SOURCE_"))
                .unwrap_or_default();
            out.line(
                depth,
                &format!("says {source}"),
                &[("", q(&says.heading)), ("take", q(&says.take_label))],
            );
            for field in &says.fields {
                out.line(
                    depth + 1,
                    "field",
                    &[
                        ("", q(&field.label)),
                        ("stated", q(&field.stated)),
                        ("mine", q(&field.mine)),
                        ("", sel(&field.take_selector_id)),
                    ],
                );
            }
        }
        B::EarlierVersions(earlier) => out.line(
            depth,
            "earlier_versions",
            &[
                ("", q(&earlier.summary)),
                ("count", num(earlier.count)),
                ("", sel(&earlier.selector_id)),
            ],
        ),
        B::Origin(origin) => out.line(
            depth,
            "origin",
            &[("", q(&origin.line)), ("", sel(&origin.selector_id))],
        ),
        B::CalendarGrid(grid) => {
            let view = wire::RoomCalendarView::try_from(grid.view)
                .map(|view| lower(view.as_str_name(), "ROOM_CALENDAR_VIEW_"))
                .unwrap_or_default();
            out.line(
                depth,
                &format!("calendar_grid {view}"),
                &[
                    ("anchor", q(&grid.anchor_day)),
                    ("now", num(grid.now_minute)),
                    ("prev", sel(&grid.prev_selector_id)),
                    ("next", sel(&grid.next_selector_id)),
                    ("today", sel(&grid.today_selector_id)),
                    ("create", sel(&grid.create_selector_id)),
                ],
            );
            for day in &grid.days {
                out.line(
                    depth + 1,
                    "day",
                    &[
                        ("", q(&day.day)),
                        ("label", q(&day.label)),
                        ("today", flag(day.today)),
                        ("selected", flag(day.selected)),
                        ("out_of_scope", flag(!day.in_scope)),
                        ("more", num(day.more_count)),
                    ],
                );
                for item in &day.items {
                    out.line(
                        depth + 2,
                        "item",
                        &[
                            ("", sel(&item.selector_id)),
                            ("", q(&item.title)),
                            ("time", q(&item.time_label)),
                            ("all_day", flag(item.all_day)),
                            ("done", flag(item.done)),
                            ("overdue", flag(item.overdue)),
                            ("needs_reply", flag(item.needs_reply)),
                        ],
                    );
                }
            }
        }
        B::PhotoGrid(grid) => {
            let zoom = wire::RoomPhotoZoom::try_from(grid.zoom)
                .map(|zoom| lower(zoom.as_str_name(), "ROOM_PHOTO_ZOOM_"))
                .unwrap_or_default();
            out.line(
                depth,
                &format!("photo_grid {zoom}"),
                &[("next", sel(&grid.next_page_selector_id))],
            );
            for section in &grid.sections {
                out.line(depth + 1, "section", &[("", q(&section.heading))]);
                for tile in &section.tiles {
                    out.line(
                        depth + 2,
                        "tile",
                        &[
                            ("", sel(&tile.selector_id)),
                            ("a11y", q(&tile.a11y_label)),
                            ("starred", flag(tile.starred)),
                            ("selected", flag(tile.selected)),
                        ],
                    );
                }
            }
            if let Some(viewer) = &grid.viewer {
                out.line(
                    depth + 1,
                    "viewer",
                    &[
                        ("index", num(viewer.index)),
                        ("count", num(viewer.count)),
                        ("details_open", flag(viewer.details_open)),
                        ("slideshow", flag(viewer.slideshow)),
                    ],
                );
                if let Some(current) = &viewer.current {
                    media_of(out, depth + 2, current);
                }
                for detail in &viewer.details {
                    block_of(out, depth + 2, detail);
                }
            }
        }
        B::NoteEditor(editor) => {
            out.line(
                depth,
                "note_editor",
                &[
                    ("", sel(&editor.selector_id)),
                    ("title", q(&editor.title)),
                    ("rev", num(editor.rev)),
                    ("base", q(&editor.base_revision_id)),
                    ("read_only", flag(editor.read_only)),
                    ("focused", flag(editor.focused)),
                ],
            );
            out.line(depth + 1, "body", &[("", q(&editor.body))]);
            if let Some(autosave) = &editor.autosave {
                autosave_of(out, depth + 1, autosave);
            }
            if let Some(suggest) = &editor.suggest {
                out.line(
                    depth + 1,
                    "suggest",
                    &[
                        ("trigger", q(&suggest.trigger)),
                        ("query", q(&suggest.query)),
                    ],
                );
                for candidate in &suggest.candidates {
                    out.line(
                        depth + 2,
                        "candidate",
                        &[
                            ("", q(&candidate.title)),
                            ("noun", q(&candidate.noun)),
                            ("", sel(&candidate.selector_id)),
                        ],
                    );
                }
            }
            for asset in &editor.assets {
                media_of(out, depth + 1, asset);
            }
        }
        B::Chart(chart) => {
            out.line(
                depth,
                "chart",
                &[
                    ("", sel(&chart.selector_id)),
                    ("summary", q(&chart.summary)),
                    ("readout", q(&chart.readout_point_id)),
                    ("empty", q(&chart.empty_sentence)),
                ],
            );
            for series in &chart.series {
                let mark = wire::RoomChartMark::try_from(series.mark)
                    .map(|mark| lower(mark.as_str_name(), "ROOM_CHART_MARK_"))
                    .unwrap_or_default();
                out.line(
                    depth + 1,
                    &format!("series {mark}"),
                    &[("", q(&series.label)), ("points", num(series.points.len()))],
                );
                for point in &series.points {
                    out.line(
                        depth + 2,
                        "point",
                        &[
                            ("", q(&point.id)),
                            ("x", q(&point.x_label)),
                            ("y", q(&point.y_label)),
                        ],
                    );
                }
            }
            for rule in &chart.rules {
                out.line(
                    depth + 1,
                    "rule",
                    &[("", q(&rule.label)), ("tone", tone(rule.tone))],
                );
            }
        }
    }
}

fn media_of(out: &mut Out, depth: usize, media: &wire::RoomMedia) {
    let kind = wire::RoomMediaKind::try_from(media.kind)
        .map(|kind| lower(kind.as_str_name(), "ROOM_MEDIA_KIND_"))
        .unwrap_or_default();
    out.line(
        depth,
        &format!("media {kind}"),
        &[
            ("", sel(&media.selector_id)),
            (
                "thumb",
                q(&media
                    .thumb
                    .as_ref()
                    .map(|t| t.r#ref.clone())
                    .unwrap_or_default()),
            ),
            ("caption", q(&media.caption)),
            ("duration", q(&media.duration_label)),
        ],
    );
}

fn choice_of(out: &mut Out, depth: usize, head: &str, choice: &wire::RoomChoice) {
    let style = wire::RoomChoiceStyle::try_from(choice.style)
        .map(|style| lower(style.as_str_name(), "ROOM_CHOICE_STYLE_"))
        .unwrap_or_default();
    out.line(
        depth,
        &format!("{head} {style}"),
        &[
            ("", q(&choice.label)),
            ("multiple", flag(choice.multiple)),
            ("", sel(&choice.selector_id)),
        ],
    );
    for option in &choice.options {
        out.line(
            depth + 1,
            "option",
            &[
                ("", q(&option.label)),
                ("id", q(&option.id)),
                ("selected", flag(option.selected)),
            ],
        );
    }
}

fn autosave_of(out: &mut Out, depth: usize, autosave: &wire::RoomAutosave) {
    let phase = wire::RoomAutosavePhase::try_from(autosave.phase)
        .map(|phase| lower(phase.as_str_name(), "ROOM_AUTOSAVE_PHASE_"))
        .unwrap_or_default();
    out.line(
        depth,
        &format!("autosave {phase}"),
        &[
            ("", q(&autosave.label)),
            ("refused", flag(autosave.refused)),
            (
                "reload",
                format!(
                    "{}{}",
                    q(&autosave.reload_label),
                    sel(&autosave.reload_selector_id)
                ),
            ),
        ],
    );
}

fn field_of(out: &mut Out, depth: usize, field: &wire::RoomField) {
    use wire::room_field::Input as I;
    let head = match &field.input {
        Some(I::Text(_)) => "text",
        Some(I::Money(_)) => "money",
        Some(I::Moment(_)) => "moment",
        Some(I::Choice(_)) => "choice",
        Some(I::Toggle(_)) => "toggle",
        Some(I::Item(_)) => "item",
        Some(I::File(_)) => "file",
        Some(I::Secret(_)) => "secret",
        None => "field",
    };
    let value = match &field.input {
        Some(I::Text(text)) => format!("{} rev={}", q(&text.value), text.rev),
        Some(I::Money(money)) => q(&money.display),
        Some(I::Moment(moment)) => q(&moment.display),
        Some(I::Toggle(toggle)) => if toggle.on { "on" } else { "off" }.to_owned(),
        Some(I::Item(pick)) => q(&pick.display),
        Some(I::File(pick)) => q(&pick.display),
        Some(I::Secret(secret)) => {
            if secret.masked {
                "masked".to_owned()
            } else {
                q(&secret.value)
            }
        }
        _ => String::new(),
    };
    out.line(
        depth,
        head,
        &[
            ("", sel(&field.selector_id)),
            ("", q(&field.label)),
            ("", value),
            ("hint", q(&field.hint)),
            ("error", q(&field.error)),
            ("required", flag(field.required)),
            ("focused", flag(field.focused)),
        ],
    );
    match &field.input {
        Some(I::Choice(choice)) => {
            for option in &choice.options {
                out.line(
                    depth + 1,
                    "option",
                    &[("", q(&option.label)), ("selected", flag(option.selected))],
                );
            }
        }
        Some(I::Text(text)) if !text.chips.is_empty() => {
            out.line(depth + 1, "chips", &[("", chips_of(&text.chips))]);
        }
        _ => {}
    }
}

fn form_of(out: &mut Out, depth: usize, form: &wire::RoomForm) {
    out.line(depth, "form", &[]);
    for field in &form.fields {
        field_of(out, depth + 1, field);
    }
    for repeat in &form.repeats {
        out.line(
            depth + 1,
            "repeat",
            &[("", q(&repeat.label)), ("", sel(&repeat.selector_id))],
        );
        for group in &repeat.rows {
            out.line(
                depth + 2,
                "group",
                &[
                    ("", sel(&group.selector_id)),
                    ("remove", sel(&group.remove_selector_id)),
                ],
            );
            for field in &group.fields {
                field_of(out, depth + 3, field);
            }
        }
        if let Some(add) = &repeat.add {
            action_of(out, depth + 2, "add", add);
        }
    }
    match &form.save {
        Some(wire::room_form::Save::Autosave(autosave)) => autosave_of(out, depth + 1, autosave),
        Some(wire::room_form::Save::Explicit(explicit)) => out.line(
            depth + 1,
            "explicit",
            &[
                (
                    "save",
                    format!(
                        "{}{}",
                        q(&explicit.save_label),
                        sel(&explicit.save_selector_id)
                    ),
                ),
                (
                    "cancel",
                    format!(
                        "{}{}",
                        q(&explicit.cancel_label),
                        sel(&explicit.cancel_selector_id)
                    ),
                ),
                ("save_disabled", flag(!explicit.save_enabled)),
                ("dirty", flag(explicit.dirty)),
                ("drafted", flag(explicit.drafted)),
            ],
        ),
        None => {}
    }
}

/// Compare `room` with the golden file `name` under `tests/rooms/`. With `CENTRAID_BLESS=1` the
/// file is written; otherwise a missing or different file fails with both texts.
///
/// # Panics
/// When the snapshot differs from the golden file, or there is none.
pub fn assert_room(name: &str, room: &wire::Room) {
    assert_text(name, &render(room));
}

/// [`assert_room`] for text already rendered.
///
/// # Panics
/// When the text differs from the golden file, or there is none.
pub fn assert_text(name: &str, text: &str) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("rooms")
        .join(format!("{name}.txt"));
    if std::env::var_os("CENTRAID_BLESS").is_some() {
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("create the rooms dir");
        std::fs::write(&path, text).expect("write the golden file");
        return;
    }
    let want = std::fs::read_to_string(&path).unwrap_or_else(|_| {
        panic!(
            "no golden file {}: run with CENTRAID_BLESS=1, then read it before committing",
            path.display()
        )
    });
    assert_eq!(
        want,
        text,
        "room `{name}` differs from {}; run with CENTRAID_BLESS=1 only if the change is meant",
        path.display()
    );
}
