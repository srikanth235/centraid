//! Saved list appearance, tag browsing and file edges through the screens door.
mod todo_support;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::{
    agenda,
    catalog::{act, load},
    field::Field,
};
use todo_support::*;
use wire::screen_event::Kind as E;
use wire::todo_detail_event as de;

#[test]
fn list_appearance_updates_the_vault_and_project_view() {
    let mut d = driver();
    let id = project(&d, "Reading");
    let i = d.push(agenda::TAB, agenda::routes::project(&id, "Reading"));
    for (field, value) in [("color", "listRaspberry"), ("icon", "Book")] {
        d.send(
            i,
            E::TodoProject(wire::TodoProjectEvent {
                kind: Some(wire::todo_project_event::Kind::Appearance(
                    wire::AgendaFormChanged {
                        field: field.into(),
                        value: value.into(),
                    },
                )),
            }),
        );
    }
    let view = project_state(d.view(i)).appearance.as_ref().unwrap();
    assert!(
        view.colors
            .iter()
            .any(|row| row.key == "listRaspberry" && row.selected)
    );
    assert!(
        view.icons
            .iter()
            .any(|row| row.key == "Book" && row.selected)
    );
    let wire::app_query_response::Answer::AgendaTaskProjects(lists) =
        answer(&d, load::agenda::Projects::default())
    else {
        panic!("projects");
    };
    let list = lists
        .projects
        .iter()
        .find(|list| list.project_id == id)
        .unwrap();
    assert_eq!(list.color.as_deref(), Some("listRaspberry"));
    assert_eq!(list.icon_key, "Book");
}

#[test]
fn tag_browser_keeps_the_tagged_child_with_its_parent() {
    let mut d = driver();
    clear_tasks(&d);
    let parent = task(&d, "Parent");
    let child = add(
        &d,
        act::agenda::AddTask {
            title: "Tagged child".into(),
            parent_id: Field::Is(parent.clone()),
            ..Default::default()
        },
    );
    task(&d, "Unrelated");
    let detail = d.push(agenda::TAB, agenda::routes::task(&child));
    send_detail(
        &mut d,
        detail,
        de::Kind::TagAdded(de::TagAdded {
            label: "weekend".into(),
        }),
    );
    let tag = task_of(&d, &child).tags[0].concept_id.clone();
    let i = d.push(agenda::TAB, agenda::routes::todo_list(wire::TodoView::Tags));
    assert!(
        list_data(d.view(i))
            .tag_choices
            .iter()
            .any(|row| row.key == tag)
    );
    d.send(
        i,
        E::TodoList(wire::TodoListEvent {
            kind: Some(wire::todo_list_event::Kind::TagPicked(
                wire::todo_list_event::TagPicked { key: tag },
            )),
        }),
    );
    let rows: Vec<_> = list_data(d.view(i))
        .groups
        .iter()
        .flat_map(|group| &group.rows)
        .collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].task_id, parent);
    assert_eq!(rows[0].children[0].task_id, child);
}

#[test]
fn task_file_picker_attaches_a_document_and_removal_keeps_the_document() {
    let mut d = driver();
    let task = task(&d, "Warranty");
    let i = d.push(agenda::TAB, agenda::routes::task(&task));
    let attachment = |kind| {
        E::TodoDetail(wire::TodoDetailEvent {
            kind: Some(de::Kind::Attachment(wire::AgendaAttachmentEvent {
                kind: Some(kind),
            })),
        })
    };
    d.send(
        i,
        attachment(wire::agenda_attachment_event::Kind::Add(
            wire::agenda_attachment_event::Add {},
        )),
    );
    assert!(detail_data(d.view(i)).attachments.as_ref().unwrap().busy);
    assert!(d.effects.iter().any(|effect| {
        matches!(
            effect
                .effect
                .as_ref()
                .and_then(|effect| effect.kind.as_ref()),
            Some(wire::effect::Kind::PickFile(pick))
                if pick.kind == wire::pick_file::Kind::Upload as i32
        )
    }));
    d.send(
        i,
        E::EffectResult(wire::EffectResult {
            effect_id: 0,
            outcome: Some(wire::effect_result::Outcome::FilePicked(wire::FilePicked {
                blob: "a".repeat(64),
                byte_size: 40,
                name: "Receipt.pdf".into(),
                media_type: "application/pdf".into(),
            })),
        }),
    );
    let value = detail_data(d.view(i)).attachments.as_ref().unwrap();
    assert!(!value.busy);
    assert_eq!(value.rows.len(), 1, "{:?}", value.status);
    let doc = value.rows[0].id.clone();
    assert_eq!(value.rows[0].title, "Receipt.pdf");
    assert_eq!(
        value.rows[0].route.as_ref().unwrap().screen,
        centraid_screens::docs::DOCUMENT
    );
    d.send(
        i,
        attachment(wire::agenda_attachment_event::Kind::Remove(
            wire::agenda_attachment_event::Remove { id: doc.clone() },
        )),
    );
    assert!(
        detail_data(d.view(i))
            .attachments
            .as_ref()
            .unwrap()
            .rows
            .is_empty()
    );
    let wire::app_query_response::Answer::DocsDocument(document) =
        answer(&d, load::docs::History { document_id: doc })
    else {
        panic!("document")
    };
    assert!(document.document.is_some());
}

#[test]
fn task_photo_picker_retries_the_same_source_and_saves_the_image_attachment() {
    let mut d = driver();
    let task = task(&d, "Check the meter");
    let i = d.push(agenda::TAB, agenda::routes::task(&task));
    assert_eq!(
        detail_data(d.view(i))
            .attachments
            .as_ref()
            .unwrap()
            .add_photo_label,
        "Add photo"
    );
    let event = |kind| {
        E::TodoDetail(wire::TodoDetailEvent {
            kind: Some(de::Kind::Attachment(wire::AgendaAttachmentEvent {
                kind: Some(kind),
            })),
        })
    };
    d.effects.clear();
    d.send(
        i,
        event(wire::agenda_attachment_event::Kind::AddPhoto(
            wire::agenda_attachment_event::AddPhoto {},
        )),
    );
    let picker_is_photo = |d: &centraid_screens::testing::Driver| {
        assert!(matches!(
            d.effects.last().and_then(|request| request.effect.as_ref()).and_then(|effect| effect.kind.as_ref()),
            Some(wire::effect::Kind::PickFile(pick)) if pick.kind == wire::pick_file::Kind::Photo as i32
        ));
    };
    picker_is_photo(&d);
    assert_eq!(
        detail_data(d.view(i))
            .attachments
            .as_ref()
            .unwrap()
            .status
            .as_ref()
            .unwrap()
            .sentence,
        "Choose a photo to attach"
    );
    d.answer_effect(wire::effect_result::Outcome::Failed(wire::EffectFailed {
        reason: "the photo cannot be read".into(),
        ..Default::default()
    }));
    let view = detail_data(d.view(i)).attachments.as_ref().unwrap();
    assert!(!view.busy);
    assert!(view.rows.is_empty());
    assert!(view.status.as_ref().unwrap().refused);
    d.send(
        i,
        event(wire::agenda_attachment_event::Kind::Retry(
            wire::agenda_attachment_event::Retry {},
        )),
    );
    picker_is_photo(&d);
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    let view = detail_data(d.view(i)).attachments.as_ref().unwrap();
    assert!(!view.busy);
    assert!(view.status.is_none());
    assert!(view.rows.is_empty());
    d.send(
        i,
        event(wire::agenda_attachment_event::Kind::AddPhoto(
            wire::agenda_attachment_event::AddPhoto {},
        )),
    );
    d.answer_effect(wire::effect_result::Outcome::FilePicked(wire::FilePicked {
        blob: "c".repeat(64),
        byte_size: 2048,
        name: "Meter.heic".into(),
        media_type: "image/heic".into(),
    }));
    let view = detail_data(d.view(i)).attachments.as_ref().unwrap();
    assert!(!view.busy);
    assert_eq!(view.rows.len(), 1, "{:?}", view.status);
    let row = &view.rows[0];
    assert_eq!(row.title, "Meter.heic");
    assert_eq!(
        row.route.as_ref().unwrap().screen,
        centraid_screens::docs::DOCUMENT
    );
    let wire::app_query_response::Answer::DocsDocument(image) = answer(
        &d,
        load::docs::History {
            document_id: row.id.clone(),
        },
    ) else {
        panic!("document");
    };
    let image = image.document.unwrap();
    assert_eq!(image.content_id, "c".repeat(64));
    assert_eq!(image.media_type, "image/heic");
    assert_eq!(image.kind, wire::DocsKind::Image as i32);
}

#[test]
fn attachment_picker_failure_has_retry_and_cancellation_leaves_no_status() {
    let mut d = driver();
    let task = task(&d, "Insurance");
    let i = d.push(agenda::TAB, agenda::routes::task(&task));
    let send = |kind| {
        E::TodoDetail(wire::TodoDetailEvent {
            kind: Some(de::Kind::Attachment(wire::AgendaAttachmentEvent {
                kind: Some(kind),
            })),
        })
    };
    d.send(
        i,
        send(wire::agenda_attachment_event::Kind::Add(
            wire::agenda_attachment_event::Add {},
        )),
    );
    d.send(
        i,
        E::EffectResult(wire::EffectResult {
            effect_id: 0,
            outcome: Some(wire::effect_result::Outcome::Failed(wire::EffectFailed {
                reason: "provider unavailable".into(),
                ..Default::default()
            })),
        }),
    );
    let view = detail_data(d.view(i)).attachments.as_ref().unwrap();
    assert!(view.status.as_ref().unwrap().refused);
    assert_eq!(view.status.as_ref().unwrap().action_label, "Try again");
    d.effects.clear();
    d.send(
        i,
        send(wire::agenda_attachment_event::Kind::Retry(
            wire::agenda_attachment_event::Retry {},
        )),
    );
    assert!(detail_data(d.view(i)).attachments.as_ref().unwrap().busy);
    assert!(d.effects.iter().any(|effect| {
        matches!(
            effect
                .effect
                .as_ref()
                .and_then(|effect| effect.kind.as_ref()),
            Some(wire::effect::Kind::PickFile(_))
        )
    }));
    d.send(
        i,
        E::EffectResult(wire::EffectResult {
            effect_id: 0,
            outcome: Some(wire::effect_result::Outcome::Failed(wire::EffectFailed {
                cancelled: true,
                ..Default::default()
            })),
        }),
    );
    let view = detail_data(d.view(i)).attachments.as_ref().unwrap();
    assert!(view.status.is_none());
    assert!(!view.busy);
    assert!(view.rows.is_empty());
}
