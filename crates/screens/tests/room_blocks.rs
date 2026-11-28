//! Every block of `room.proto` has a builder; one room holding all of them claims each selector
//! once, and reads as the golden text.

use std::collections::BTreeSet;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::room::blocks::{self, glyph, glyph_mark};
use centraid_screens::room::form::{self, Save};
use centraid_screens::room::frame::{self, room};
use centraid_screens::room::selector::{Act, Handler};
use centraid_screens::room::{Sel, Ui, snapshot};
use serde_json::json;
use wire::room_block::Kind as B;

fn arm(block: &wire::RoomBlock) -> &'static str {
    match block.kind.as_ref().expect("a block arm") {
        B::Hero(_) => "hero",
        B::Section(_) => "section",
        B::Row(_) => "row",
        B::Facts(_) => "facts",
        B::Form(_) => "form",
        B::Choice(_) => "choice",
        B::Figure(_) => "figure",
        B::Prose(_) => "prose",
        B::Media(_) => "media",
        B::Progress(_) => "progress",
        B::Empty(_) => "empty",
        B::Wall(_) => "wall",
        B::Tiles(_) => "tiles",
        B::Glance(_) => "glance",
        B::Trash(_) => "trash",
        B::Confirm(_) => "confirm",
        B::Menu(_) => "menu",
        B::Attachments(_) => "attachments",
        B::Linked(_) => "linked",
        B::MentionedIn(_) => "mentioned_in",
        B::Says(_) => "says",
        B::EarlierVersions(_) => "earlier_versions",
        B::Origin(_) => "origin",
        B::CalendarGrid(_) => "calendar_grid",
        B::PhotoGrid(_) => "photo_grid",
        B::NoteEditor(_) => "note_editor",
        B::Chart(_) => "chart",
    }
}

fn walk(blocks: &[wire::RoomBlock], seen: &mut BTreeSet<&'static str>) {
    for block in blocks {
        seen.insert(arm(block));
        if let Some(B::Section(section)) = &block.kind {
            walk(&section.blocks, seen);
        }
    }
}

fn everything() -> (wire::Room, Sel) {
    let mut sel = Sel::new();
    let mut ui = Ui::default();
    let s = &mut sel;
    let open = |id: &str| Handler::Open(format!("thing/{id}"));
    let trash = |id: &str| Handler::Act(Act::new("entity.trash", json!({ "ids": [id] })));

    let hero = blocks::hero("Bread")
        .noun("note")
        .mark(glyph_mark("note", "amber"))
        .line("Edited today")
        .chip(blocks::chip("Pinned", wire::RoomTone::Accent))
        .primary(blocks::action(
            s,
            "hero/catch-up",
            "Catch up",
            "check",
            Handler::Tag("catch-up".into()),
        ))
        .block();

    let r1 = blocks::row(s, "row/1", "Banana bread", open("1"))
        .meta("Yesterday")
        .trailing("$4.20", wire::RoomTone::Warning)
        .chip(blocks::chip("Shared", wire::RoomTone::Net))
        .mark(glyph_mark("note", "amber"))
        .a11y("Banana bread, yesterday")
        .swipe(s, "row/1/trash", "Move to trash", trash("1"))
        .menu(blocks::menu(
            "row/1/menu",
            vec![blocks::menu_section(
                "",
                vec![
                    blocks::menu_item(s, "row/1/star", "Star", Handler::Tag("star".into())),
                    blocks::menu_item(s, "row/1/select", "Select", Handler::SelectMode(true)),
                ],
            )],
            s,
        ))
        .build();
    let r2 = blocks::row(s, "row/2", "Pending one", open("2"))
        .pending()
        .dimmed()
        .into_block();
    let section = blocks::section(s, "section/a", "Recent")
        .count_label("2 of 9")
        .trailing(blocks::action(
            s,
            "section/a/all",
            "Show all",
            "",
            open("all"),
        ))
        .block(blocks::block(B::Row(r1)))
        .block(r2)
        .next_page(s, "section/a/next")
        .into_block();

    let reveal = blocks::sealed_fact(s, "Password", "fact/pw", Handler::Tag("reveal".into()));
    let phone = blocks::fact_actions(
        s,
        blocks::fact("Phone", "555 0100", wire::RoomFactKind::Phone),
        "fact/phone",
        Some(Handler::Tag("call".into())),
        Some(Handler::Tag("copy".into())),
    );
    let facts = blocks::facts(vec![phone, reveal]);

    let title = form::text(
        s,
        &mut ui.fields,
        "title",
        "Title",
        wire::RoomTextKind::Line,
        "Bread",
        0,
    )
    .required()
    .focused()
    .hint("What is it?")
    .build();
    let amount = form::money(s, "amount", "Amount", 420, "USD", 2, "$4.20").build();
    let due = form::moment(
        s,
        "due",
        "Due",
        wire::RoomMoment {
            kind: wire::RoomMomentKind::Day as i32,
            value: "2026-11-30".into(),
            zone: String::new(),
            display: "Nov 30".into(),
            clearable: true,
        },
    )
    .build();
    let flag = form::toggle(s, "flag", "Flagged", true).build();
    let pick = form::choice(
        s,
        "kind",
        "Kind",
        wire::RoomChoiceStyle::Segmented,
        vec![
            blocks::option("a", "A", true),
            blocks::option("b", "B", false),
        ],
    )
    .build();
    let item = form::item_pick(s, "home", "In", "Recipes", "notebook")
        .clearable(s, "home")
        .build();
    let file = form::file_pick(s, "file", "File", "scan.pdf").build();
    let secret = form::secret(s, "secret", "Secret", true, "").build();
    let guest = form::group(
        "guest/1",
        vec![
            form::text(
                s,
                &mut ui.fields,
                "guest-1",
                "Name",
                wire::RoomTextKind::Line,
                "Ana",
                0,
            )
            .build(),
        ],
        Handler::Tag("remove-guest".into()),
        s,
    );
    let guests = form::repeat(
        s,
        "guests",
        "Guests",
        vec![guest],
        "Add a guest",
        Handler::Tag("add-guest".into()),
    );
    let save = form::explicit(
        s,
        form::Explicit {
            save_label: "Save",
            save: Handler::Tag("save".into()),
            cancel_label: "Cancel",
            cancel: Handler::Back,
            save_enabled: true,
            dirty: true,
            drafted: false,
        },
    );
    let form_block = form::form(
        vec![title, amount, due, flag, pick, item, file, secret],
        vec![guests],
        Save::Explicit(save),
    );
    let prose_form = form::form(
        vec![],
        vec![],
        Save::Autosave(form::conflict(
            s,
            "Changed elsewhere",
            "Reload",
            Handler::Tag("reload".into()),
        )),
    );

    let choice = blocks::choice_block(blocks::choice(
        s,
        "choice/view",
        "View",
        wire::RoomChoiceStyle::Chips,
        true,
        vec![
            blocks::option("day", "Day", true),
            blocks::option("week", "Week", false),
        ],
        "view",
    ));
    let figure = blocks::figure("Balance", "$1,204.00", "as of today", wire::RoomTone::Seam);
    let prose = blocks::prose_with_links(
        s,
        "See [[Taxes]] later",
        vec![(4, 13, "link/taxes", open("taxes"))],
    );
    let media = blocks::media_block(blocks::media(
        s,
        "media/1",
        wire::RoomMediaKind::Image,
        wire::RoomThumb {
            r#ref: "thumb:1".into(),
            alt: "Loaf".into(),
            hue_key: String::new(),
        },
        open("photo"),
    ));
    let progress = blocks::progress(
        "Exporting",
        3,
        10,
        "3 of 10",
        Some(blocks::action(
            s,
            "progress/cancel",
            "Cancel",
            "",
            Handler::Tag("cancel".into()),
        )),
    );
    let empty = blocks::empty(
        glyph("note", ""),
        "No notes",
        "Make one.",
        Some(blocks::action(
            s,
            "empty/add",
            "New note",
            "plus",
            Handler::Tag("new".into()),
        )),
    );
    let wall = blocks::wall(
        "Locker is locked",
        "Unlock with Face ID.",
        blocks::action(
            s,
            "wall/unlock",
            "Unlock",
            "",
            Handler::Tag("unlock".into()),
        ),
        "",
    );
    let tiles = blocks::tiles(vec![blocks::tile(
        s,
        "tile/notes",
        "Notes",
        "12",
        glyph("note", ""),
        open("notes"),
    )]);
    let glance = blocks::glance(
        s,
        "glance/today",
        "Today",
        &["2 events", "1 task"],
        glyph("calendar", ""),
        open("today"),
    );
    let trash_rows = vec![blocks::trash_row(
        s,
        "trash/1",
        "Old note",
        "Deleted today · Erased in 30 days",
        Handler::Act(Act::new("entity.restore", json!({ "ids": ["1"] }))),
        Handler::Act(Act::new("entity.purge", json!({ "id": "1" }))),
    )];
    let trash_block = blocks::trash_block(blocks::trash(
        "Trash · 1",
        "30 days, then erased",
        trash_rows,
        Some(blocks::destructive(
            s,
            "trash/empty",
            "Empty Trash",
            "",
            Handler::Tag("empty".into()),
        )),
    ));
    let confirm = blocks::confirm(
        s,
        blocks::Confirm {
            class: wire::RoomConfirmClass::Outlined,
            title: "Erase this note?",
            body: "It cannot come back.",
            warning: "",
            confirm_label: "Erase",
            confirm: Handler::Tag("erase".into()),
            cancel_label: "Cancel",
            cancel: Handler::Back,
        },
    );
    let menu = blocks::menu_block(blocks::menu(
        "more",
        vec![blocks::menu_section(
            "",
            vec![blocks::submenu(
                "Sort",
                vec![blocks::menu_item(
                    s,
                    "more/sort/title",
                    "Title",
                    Handler::Tag("sort".into()),
                )],
            )],
        )],
        s,
    ));
    let item_row =
        |s: &mut Sel, id: &str| blocks::row(s, id, "Item", Handler::Tag("open".into())).build();
    let attachments = blocks::attachments(
        "Attachments",
        vec![item_row(s, "att/1")],
        Some(blocks::menu(
            "att/add",
            vec![blocks::menu_section(
                "",
                vec![blocks::menu_item(
                    s,
                    "att/add/scan",
                    "Scan",
                    Handler::Tag("scan".into()),
                )],
            )],
            s,
        )),
    );
    let linked = blocks::linked(
        "Linked",
        vec![item_row(s, "lnk/1")],
        Some(blocks::action(
            s,
            "lnk/add",
            "Link",
            "",
            Handler::Tag("link".into()),
        )),
    );
    let mentioned = blocks::mentioned_in("Mentioned in", vec![item_row(s, "men/1")]);
    let says_field = blocks::says_field(
        s,
        "says/name",
        "Name",
        "Ana B.",
        "Ana",
        Handler::Tag("take".into()),
    );
    let says = blocks::says(
        wire::RoomSaysSource::Phone,
        "Phone says",
        vec![says_field],
        "Take",
    );
    let earlier = blocks::earlier_versions(s, "3 earlier versions", 3, open("versions"));
    let origin = blocks::origin(s, "From Contacts, 3 Nov", Some(open("origin")));

    let canvas_id = blocks::canvas(s, "canvas", "canvas");
    let calendar = blocks::calendar_grid(wire::RoomCalendarGrid {
        view: wire::RoomCalendarView::Day as i32,
        anchor_day: "2026-11-26".into(),
        days: vec![wire::RoomCalendarDay {
            day: "2026-11-26".into(),
            label: "Thu 26".into(),
            today: true,
            in_scope: true,
            items: vec![wire::RoomCalendarItem {
                selector_id: s.on("cal/item/1", Handler::Tag("cal-item".into())),
                title: "Lunch".into(),
                time_label: "12:00".into(),
                ..wire::RoomCalendarItem::default()
            }],
            ..wire::RoomCalendarDay::default()
        }],
        create_selector_id: canvas_id,
        ..wire::RoomCalendarGrid::default()
    });
    let photos = blocks::photo_grid(wire::RoomPhotoGrid {
        zoom: wire::RoomPhotoZoom::Months as i32,
        sections: vec![wire::RoomPhotoSection {
            heading: "November".into(),
            tiles: vec![wire::RoomPhotoTile {
                selector_id: s.on("photo/1", Handler::Tag("photo".into())),
                a11y_label: "Loaf".into(),
                ..wire::RoomPhotoTile::default()
            }],
        }],
        ..wire::RoomPhotoGrid::default()
    });
    let editor = blocks::note_editor(wire::RoomNoteEditor {
        selector_id: s.on("editor", Handler::Tag("note".into())),
        title: "Bread".into(),
        body: "Flour".into(),
        ..wire::RoomNoteEditor::default()
    });
    let chart = blocks::chart(wire::RoomChart {
        selector_id: s.on("chart", Handler::Tag("chart".into())),
        summary: "Up".into(),
        series: vec![wire::RoomChartSeries {
            label: "Weight".into(),
            mark: wire::RoomChartMark::Line as i32,
            points: vec![wire::RoomChartPoint {
                id: "p1".into(),
                x_label: "Nov".into(),
                y_label: "70 kg".into(),
                ..wire::RoomChartPoint::default()
            }],
            ..wire::RoomChartSeries::default()
        }],
        ..wire::RoomChart::default()
    });

    let built = room(wire::RoomKind::AppPlace, "everything")
        .title("Everything")
        .subtitle("Scope")
        .back(s, "Home")
        .key(
            s,
            "key/add",
            wire::RoomKeyRole::Add,
            "plus",
            "New",
            Handler::Tag("new".into()),
        )
        .band(frame::band(
            vec![
                frame::tab(s, "tab/a", "A", "a", true),
                frame::tab(s, "tab/b", "B", "b", false),
            ],
            Some(Handler::Tag("home".into())),
            None,
            s,
        ))
        .status(s, "Done", "Undo", false)
        .search(s, &ui, "Search")
        .selection(s, &ui, "0 selected", vec![])
        .ready(vec![
            hero,
            section,
            facts,
            form_block,
            prose_form,
            choice,
            figure,
            prose,
            media,
            progress,
            empty,
            wall,
            tiles,
            glance,
            trash_block,
            confirm,
            menu,
            attachments,
            linked,
            mentioned,
            says,
            earlier,
            origin,
            calendar,
            photos,
            editor,
            chart,
        ])
        .build();
    (built, sel)
}

#[test]
fn every_block_has_a_builder_and_each_selector_is_claimed_once() {
    let (room, sel) = everything();
    assert!(sel.errors().is_empty(), "{:?}", sel.errors());
    let mut seen = BTreeSet::new();
    let Some(wire::room::State::Ready(ready)) = &room.state else {
        panic!("ready");
    };
    walk(&ready.blocks, &mut seen);
    assert_eq!(seen.len(), 27, "23 blocks and 4 canvases: {seen:?}");
    let map = sel.finish().expect("a finished map");
    assert!(map.knows("row/1") && map.get("row/1").is_some());
    assert!(
        map.get("back")
            .is_some_and(|handler| *handler == Handler::Back)
    );
}

#[test]
fn the_room_with_every_block_reads_as_text() {
    let (room, _) = everything();
    snapshot::assert_room("every_block", &room);
}
