//! The attachments section of the event and task pages, and a task's link (#1173), through the door
//! a shell uses. The shell picks and stages the bytes (`PickFile`); the screen files them as a photo
//! or a document and attaches them. Nothing here streams a byte: the shell's half is answered by
//! value, as a shell answers it.

mod calendar_support;

#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;
use calendar_support::World;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda;
use centraid_screens::catalog::{act, load};
use centraid_screens::field::Field;
use centraid_screens::{docs, photos};
use wire::agenda_attachment_event::Kind as A;
use wire::effect::Kind as Fx;
use wire::effect_result::Outcome as O;
use wire::screen_event::Kind as E;

fn world() -> World {
    World::with(wire_task_screen())
}

fn wire_task_screen() -> centraid_screens::Registry {
    centraid_screens::Registry::default().with(
        centraid_screens::reminders::TASK,
        centraid_screens::reminders::detail::build,
    )
}

fn an_event(world: &mut World) -> String {
    world.propose(
        "Dinner",
        "2099-06-16T19:00:00",
        "2099-06-16T20:00:00",
        |_| {},
    )
}

fn a_task(world: &mut World, url: Option<&str>) -> String {
    let done = world.act(act::reminders::AddTask {
        title: "Book flights".to_owned(),
        url: url.map_or(Field::Keep, |url| Field::Is(url.to_owned())),
        ..Default::default()
    });
    let output: serde_json::Value = serde_json::from_slice(&done.output).expect("json output");
    output["id"].as_str().expect("the id").to_owned()
}

fn on_event(world: &mut World, page: u64, kind: A) {
    world.send_event(
        page,
        wire::agenda_event_event::Kind::Attachment(wire::AgendaAttachmentEvent {
            kind: Some(kind),
        }),
    );
}

fn section(world: &World, page: u64) -> &wire::AgendaAttachmentsSection {
    world
        .event_data(page)
        .attachments
        .as_ref()
        .expect("an attachments section")
}

fn task_state(world: &World, page: u64) -> &wire::TodoDetailState {
    match &world.driver.view(page).kind {
        Some(wire::view_state::Kind::TodoDetail(state)) => state,
        other => panic!("not a task page: {other:?}"),
    }
}

fn task_data(world: &World, page: u64) -> &wire::TodoDetailData {
    match &task_state(world, page).content {
        Some(wire::todo_detail_state::Content::Data(data)) => data,
        other => panic!("the task page has no data: {other:?}"),
    }
}

fn on_task(
    world: &mut World,
    page: u64,
    kind: wire::todo_detail_event::Kind,
) -> wire::ScreenUpdate {
    world.driver.send(
        page,
        E::TodoDetail(wire::TodoDetailEvent { kind: Some(kind) }),
    )
}

fn picked(blob: char, size: u64, name: &str, media_type: &str) -> O {
    O::FilePicked(wire::FilePicked {
        blob: blob.to_string().repeat(64),
        byte_size: size,
        name: name.to_owned(),
        media_type: media_type.to_owned(),
    })
}

fn picker(world: &World) -> Option<wire::pick_file::Kind> {
    world.driver.effects.iter().find_map(|request| {
        match request.effect.as_ref()?.kind.as_ref()? {
            Fx::PickFile(pick) => wire::pick_file::Kind::try_from(pick.kind).ok(),
            _ => None,
        }
    })
}

/// What the vault holds attached to one item, a page.
fn attached(
    world: &World,
    item: &str,
    after: Option<String>,
    limit: u32,
) -> wire::AgendaAttachments {
    // An event's attachments are Calendar's to read and a task's are Reminders': ask the one that
    // holds the item.
    let ask = |of_task: bool| {
        let answer = if of_task {
            world.load(load::reminders::Attachments {
                item_id: item.to_owned(),
                after: after.clone(),
                limit,
            })
        } else {
            world.load(load::calendar::Attachments {
                item_id: item.to_owned(),
                after: after.clone(),
                limit,
            })
        };
        let wire::app_query_response::Answer::AgendaAttachments(page) = answer else {
            panic!("attachments answered something else");
        };
        page
    };
    let events = ask(false);
    if events.attachments.is_empty() {
        ask(true)
    } else {
        events
    }
}

/// A document of fake bytes, attached to `item` as another surface would.
fn attach_document(world: &mut World, item: &str, title: &str, seed: char) -> String {
    let done = world.act(act::docs::Upload {
        blob: seed.to_string().repeat(64),
        media_type: "application/pdf".to_owned(),
        title: title.to_owned(),
        size: Some(2048),
        ..Default::default()
    });
    let output: serde_json::Value = serde_json::from_slice(&done.output).expect("json output");
    let id = output["id"].as_str().expect("the id").to_owned();
    world.act(act::calendar::Attach {
        from: item.to_owned(),
        to: id.clone(),
    });
    id
}

#[test]
fn an_event_with_nothing_attached_says_so_and_offers_both_adds() {
    let mut world = world();
    let id = an_event(&mut world);
    let page = world.open_event(&id, &id, None, "2099-06-16");
    let section = section(&world, page);
    assert_eq!(section.heading, "Attachments");
    assert!(section.items.is_empty());
    assert_eq!(section.empty_label, "Nothing attached yet.");
    assert_eq!(section.add_photo_label, "Add photo");
    assert_eq!(section.add_file_label, "Add file");
    assert!(!section.busy && !section.has_more);
    assert!(section.remove_confirm.is_none() && section.status.is_none());
}

#[test]
fn add_photo_asks_the_shell_for_a_photo_then_makes_it_and_attaches_it() {
    let mut world = world();
    let id = an_event(&mut world);
    let page = world.open_event(&id, &id, None, "2099-06-16");
    on_event(&mut world, page, A::AddPhoto(Default::default()));
    assert_eq!(picker(&world), Some(wire::pick_file::Kind::Photo));
    assert!(section(&world, page).busy);
    // A second add while one is under way is nothing.
    on_event(&mut world, page, A::AddFile(Default::default()));
    assert_eq!(world.driver.effects.len(), 1);

    let request = world.driver.effects[0].clone();
    world
        .driver
        .answer_effect(O::FileProgress(wire::FileProgress {
            staged_bytes: 100,
            total_bytes: 4096,
            name: "IMG_0042.jpg".to_owned(),
        }));
    assert_eq!(section(&world, page).busy_label, "Adding IMG_0042.jpg");
    // A progress answer keeps the one effect id: the pick is answered again by the same request.
    world.driver.effects.push(request);
    world
        .driver
        .answer_effect(picked('a', 4096, "IMG_0042.jpg", "image/jpeg"));
    let section = section(&world, page);
    // The attach says so, with Undo (#1185).
    assert!(!section.busy);
    let status = section.status.as_ref().expect("a status line");
    assert_eq!(
        (status.sentence.as_str(), status.action_label.as_str()),
        ("Attachment added", "Undo")
    );
    assert_eq!(section.items.len(), 1);
    let tile = &section.items[0];
    assert_eq!(tile.kind, "photo");
    assert_eq!(tile.title, "Photo");
    assert_eq!(tile.meta, "Photo · 4 KB");
    assert_eq!(tile.icon_key, "Image");
    assert_eq!(tile.badge, "");
    assert_eq!(tile.remove_label, "Remove");
    assert_eq!(tile.accessibility_label, "Photo, Photo");
    // A tap opens the photo in Photos' viewer.
    let route = tile.route.as_ref().expect("a route");
    assert_eq!(route.screen, photos::LIGHTBOX);
    // The vault holds the edge, and the photo is Photos'.
    let held = attached(&world, &id, None, 10);
    assert_eq!(held.attachments.len(), 1);
    assert_eq!(held.attachments[0].kind, "photo");
    assert_eq!(held.attachments[0].attachment_id, tile.attachment_id);
}

#[test]
fn add_file_asks_for_a_file_and_the_document_opens_in_docs() {
    let mut world = world();
    let id = an_event(&mut world);
    let page = world.open_event(&id, &id, None, "2099-06-16");
    on_event(&mut world, page, A::AddFile(Default::default()));
    assert_eq!(picker(&world), Some(wire::pick_file::Kind::Upload));
    world
        .driver
        .answer_effect(picked('b', 2_400_000, "Lease.pdf", ""));
    let section = section(&world, page);
    assert_eq!(section.items.len(), 1, "{:?}", section.status);
    let tile = &section.items[0];
    assert_eq!(tile.kind, "document");
    assert_eq!(tile.title, "Lease.pdf");
    assert_eq!(tile.meta, "PDF · 2.4 MB");
    assert_eq!(tile.badge, "PDF");
    assert_eq!(tile.icon_key, "FileText");
    assert_eq!(tile.accessibility_label, "Lease.pdf, PDF");
    let route = tile.route.as_ref().expect("a route");
    assert_eq!(route.screen, docs::DOCUMENT);
    assert_eq!(attached(&world, &id, None, 10).attachments.len(), 1);
    assert_eq!(section.heading, "Attachments · 1");
}

#[test]
fn a_closed_picker_says_nothing_and_a_refusal_says_where_to_turn_it_on() {
    let mut world = world();
    let id = an_event(&mut world);
    let page = world.open_event(&id, &id, None, "2099-06-16");
    on_event(&mut world, page, A::AddPhoto(Default::default()));
    world.driver.answer_effect(O::Done(wire::EffectDone {}));
    assert!(!section(&world, page).busy);
    assert!(section(&world, page).status.is_none());

    on_event(&mut world, page, A::AddPhoto(Default::default()));
    world.driver.answer_effect(O::Failed(wire::EffectFailed {
        reason: "denied".to_owned(),
        denied: true,
        cancelled: false,
    }));
    let status = section(&world, page).status.clone().expect("a refusal");
    assert!(status.refused);
    assert_eq!(status.sentence, "Allow access in Settings to add it.");
    on_event(&mut world, page, A::StatusDismissed(Default::default()));
    assert!(section(&world, page).status.is_none());

    on_event(&mut world, page, A::AddFile(Default::default()));
    world.driver.answer_effect(O::Failed(wire::EffectFailed {
        reason: "unavailable".to_owned(),
        ..Default::default()
    }));
    assert_eq!(
        section(&world, page)
            .status
            .as_ref()
            .map(|s| s.sentence.as_str()),
        Some("This phone has no picker for that.")
    );
    on_event(&mut world, page, A::AddFile(Default::default()));
    world.driver.answer_effect(O::Failed(wire::EffectFailed {
        reason: "cancelled".to_owned(),
        cancelled: true,
        ..Default::default()
    }));
    assert!(
        section(&world, page).status.is_none(),
        "a cancel is not a failure"
    );
    assert!(attached(&world, &id, None, 10).attachments.is_empty());
}

#[test]
fn remove_asks_says_the_file_stays_and_detaches_only_the_edge() {
    let mut world = world();
    let id = an_event(&mut world);
    let doc = attach_document(&mut world, &id, "Menu", 'c');
    let page = world.open_event(&id, &id, None, "2099-06-16");
    assert_eq!(section(&world, page).items.len(), 1);

    on_event(
        &mut world,
        page,
        A::RemoveAsked(wire::agenda_attachment_event::RemoveAsked {
            attachment_id: "not-attached".to_owned(),
        }),
    );
    assert!(section(&world, page).remove_confirm.is_none());
    on_event(
        &mut world,
        page,
        A::RemoveAsked(wire::agenda_attachment_event::RemoveAsked {
            attachment_id: doc.clone(),
        }),
    );
    let confirm = section(&world, page)
        .remove_confirm
        .clone()
        .expect("a confirm");
    assert_eq!(confirm.title, "Remove this attachment?");
    assert_eq!(confirm.body, "It comes off here. The file stays in Docs.");
    assert_eq!(confirm.confirm_label, "Remove");
    assert!(confirm.destructive);

    on_event(&mut world, page, A::RemoveDismissed(Default::default()));
    assert!(section(&world, page).remove_confirm.is_none());
    assert_eq!(attached(&world, &id, None, 10).attachments.len(), 1);

    on_event(
        &mut world,
        page,
        A::RemoveAsked(wire::agenda_attachment_event::RemoveAsked {
            attachment_id: doc.clone(),
        }),
    );
    on_event(&mut world, page, A::RemoveConfirmed(Default::default()));
    assert!(section(&world, page).items.is_empty());
    assert_eq!(section(&world, page).empty_label, "Nothing attached yet.");
    assert!(attached(&world, &id, None, 10).attachments.is_empty());
    // THE DOCUMENT IS STILL DOCS': it can be starred, which only a live document takes.
    world.act(act::docs::Star { document_id: doc });
}

#[test]
fn a_photos_confirm_says_it_stays_in_photos() {
    let mut world = world();
    let id = an_event(&mut world);
    let page = world.open_event(&id, &id, None, "2099-06-16");
    on_event(&mut world, page, A::AddPhoto(Default::default()));
    world
        .driver
        .answer_effect(picked('d', 1024, "a.png", "image/png"));
    let photo = section(&world, page).items[0].attachment_id.clone();
    on_event(
        &mut world,
        page,
        A::RemoveAsked(wire::agenda_attachment_event::RemoveAsked {
            attachment_id: photo,
        }),
    );
    assert_eq!(
        section(&world, page)
            .remove_confirm
            .as_ref()
            .map(|c| c.body.as_str()),
        Some("It comes off here. The photo stays in Photos.")
    );
}

#[test]
fn attachments_are_paged_and_show_more_appends_the_next_page() {
    let mut world = world();
    let id = an_event(&mut world);
    for at in 0..32u32 {
        let seed = char::from_digit(at % 10, 10).expect("a digit");
        let blob = format!("{at:02}{}", seed.to_string().repeat(62));
        let done = world.act(act::docs::Upload {
            blob,
            media_type: "application/pdf".to_owned(),
            title: format!("File {at:02}"),
            size: Some(100),
            ..Default::default()
        });
        let output: serde_json::Value = serde_json::from_slice(&done.output).expect("json");
        world.act(act::calendar::Attach {
            from: id.clone(),
            to: output["id"].as_str().expect("id").to_owned(),
        });
    }
    let page = world.open_event(&id, &id, None, "2099-06-16");
    assert_eq!(section(&world, page).items.len(), 30, "a first screenful");
    assert!(section(&world, page).has_more);
    assert_eq!(section(&world, page).more_label, "Show more");
    assert_eq!(section(&world, page).heading, "Attachments");
    on_event(&mut world, page, A::ShowMore(Default::default()));
    assert_eq!(section(&world, page).items.len(), 32);
    assert!(!section(&world, page).has_more);
    let ids: std::collections::BTreeSet<&str> = section(&world, page)
        .items
        .iter()
        .map(|tile| tile.attachment_id.as_str())
        .collect();
    assert_eq!(ids.len(), 32, "no attachment is drawn twice");
    assert_eq!(section(&world, page).heading, "Attachments · 32");
}

#[test]
fn the_task_page_has_the_same_section_and_the_same_adds() {
    let mut world = world();
    let id = a_task(&mut world, None);
    let page = world.driver.push(agenda::TAB, routes::task(&id));
    let section = task_data(&world, page)
        .attachments
        .clone()
        .expect("a section");
    assert_eq!(section.empty_label, "Nothing attached yet.");

    on_task(
        &mut world,
        page,
        wire::todo_detail_event::Kind::Attachment(wire::AgendaAttachmentEvent {
            kind: Some(A::AddFile(Default::default())),
        }),
    );
    assert_eq!(picker(&world), Some(wire::pick_file::Kind::Upload));
    world
        .driver
        .answer_effect(picked('e', 5000, "Itinerary.pdf", "application/pdf"));
    let section = task_data(&world, page)
        .attachments
        .clone()
        .expect("a section");
    assert_eq!(section.items.len(), 1);
    assert_eq!(section.items[0].title, "Itinerary.pdf");
    assert_eq!(attached(&world, &id, None, 10).attachments.len(), 1);

    let doc = section.items[0].attachment_id.clone();
    for kind in [
        A::RemoveAsked(wire::agenda_attachment_event::RemoveAsked { attachment_id: doc }),
        A::RemoveConfirmed(Default::default()),
    ] {
        on_task(
            &mut world,
            page,
            wire::todo_detail_event::Kind::Attachment(wire::AgendaAttachmentEvent {
                kind: Some(kind),
            }),
        );
    }
    assert!(
        task_data(&world, page)
            .attachments
            .as_ref()
            .expect("a section")
            .items
            .is_empty()
    );
}

#[test]
fn a_task_with_an_address_shows_it_and_opening_it_asks_the_shell() {
    let mut world = world();
    let id = a_task(&mut world, Some("example.com/flights"));
    let page = world.driver.push(agenda::TAB, routes::task(&id));
    let link = task_data(&world, page).link.clone().expect("a link");
    assert_eq!(link.label, "Link");
    assert_eq!(link.url, "example.com/flights");
    assert_eq!(link.open_label, "Open link");
    assert_eq!(link.accessibility_label, "Open link example.com/flights");

    on_task(
        &mut world,
        page,
        wire::todo_detail_event::Kind::OpenLink(Default::default()),
    );
    let opened: Vec<&str> = world
        .driver
        .effects
        .iter()
        .filter_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
            Fx::OpenUrl(open) => Some(open.url.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        opened,
        ["https://example.com/flights"],
        "a bare domain is opened as https"
    );
}

#[test]
fn a_task_with_no_address_has_no_link_and_opening_one_is_nothing() {
    let mut world = world();
    let id = a_task(&mut world, None);
    let page = world.driver.push(agenda::TAB, routes::task(&id));
    assert!(task_data(&world, page).link.is_none());
    on_task(
        &mut world,
        page,
        wire::todo_detail_event::Kind::OpenLink(Default::default()),
    );
    assert!(world.driver.effects.is_empty());
}

#[test]
fn an_address_that_is_not_a_web_address_is_drawn_but_never_opened() {
    let mut world = world();
    let id = a_task(&mut world, Some("javascript:alert(1)"));
    let page = world.driver.push(agenda::TAB, routes::task(&id));
    assert_eq!(
        task_data(&world, page)
            .link
            .as_ref()
            .map(|l| l.url.as_str()),
        Some("javascript:alert(1)")
    );
    on_task(
        &mut world,
        page,
        wire::todo_detail_event::Kind::OpenLink(Default::default()),
    );
    assert!(world.driver.effects.is_empty());
}
