//! An attachment is a saved document/photo joined by an edge, never inline file bytes.
//! A failed edge write retries the existing document instead of uploading a second copy.
use crate::catalog::act;
use crate::kit::act as write;
use crate::screen::Ctx;
use crate::strings::{Locale, agenda as words, shared};
use centraid_api_proto::core_v1 as wire;

#[derive(Default)]
pub struct Attachments {
    picking: bool,
    file: Option<wire::FilePicked>,
    document: Option<String>,
    remove: Option<String>,
    upload_key: String,
    status: Option<wire::StatusLine>,
}

impl Attachments {
    pub fn event(
        &mut self,
        ctx: &Ctx,
        owner: &str,
        known: &[String],
        event: &wire::AgendaAttachmentEvent,
    ) -> Vec<wire::Effect> {
        use wire::agenda_attachment_event::Kind;
        match &event.kind {
            Some(Kind::Add(_)) if !self.picking => {
                *self = Self::default();
                self.pick(ctx)
            }
            Some(Kind::Remove(remove)) if !self.picking && known.contains(&remove.id) => {
                *self = Self {
                    remove: Some(remove.id.clone()),
                    ..Self::default()
                };
                self.save(ctx, owner);
                Vec::new()
            }
            Some(Kind::Retry(_)) if !self.picking => {
                if self.file.is_none() && self.document.is_none() && self.remove.is_none() {
                    self.pick(ctx)
                } else {
                    self.save(ctx, owner);
                    Vec::new()
                }
            }
            _ => Vec::new(),
        }
    }

    fn pick(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        self.picking = true;
        self.status = Some(wire::StatusLine {
            sentence: words::attachment_picking(ctx.locale()),
            ..Default::default()
        });
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::PickFile(wire::PickFile {
                kind: wire::pick_file::Kind::Upload as i32,
            })),
        }]
    }

    pub fn result(
        &mut self,
        ctx: &Ctx,
        owner: &str,
        result: &wire::effect_result::Outcome,
    ) -> bool {
        if !self.picking {
            return false;
        }
        use wire::effect_result::Outcome as O;
        match result {
            O::FileProgress(_) => true,
            O::FilePicked(file) => {
                self.picking = false;
                self.file = Some(file.clone());
                self.upload_key =
                    write::key(&["agenda-attachment", owner, &file.blob], write::fresh());
                self.save(ctx, owner);
                true
            }
            O::Done(_) => {
                *self = Self::default();
                true
            }
            O::Failed(failed) if failed.cancelled => {
                *self = Self::default();
                true
            }
            O::Failed(_) => {
                self.picking = false;
                self.failed(ctx.locale(), words::attachment_failed(ctx.locale()));
                true
            }
            _ => false,
        }
    }

    fn failed(&mut self, locale: Locale, sentence: String) {
        self.status = Some(wire::StatusLine {
            sentence,
            action_label: shared::kit_retry(locale),
            refused: true,
        });
    }

    fn save(&mut self, ctx: &Ctx, owner: &str) {
        if let Some(id) = self.remove.as_ref() {
            let settled = write::act(
                ctx,
                act::agenda::Detach {
                    from: owner.to_owned(),
                    to: id.clone(),
                },
                &write::key(&["detach", owner, id], write::fresh()),
            );
            if !settled.committed {
                self.failed(ctx.locale(), settled.refusal);
                return;
            }
            *self = Self {
                status: Some(wire::StatusLine {
                    sentence: words::attachment_removed(ctx.locale()),
                    ..Default::default()
                }),
                ..Self::default()
            };
            return;
        }
        if self.document.is_none() {
            let Some(file) = self.file.as_ref() else {
                return;
            };
            let title = title(ctx.locale(), &file.name);
            let settled = write::act(
                ctx,
                act::docs::Upload {
                    blob: file.blob.clone(),
                    title,
                    media_type: if file.media_type.is_empty() {
                        "application/octet-stream".to_owned()
                    } else {
                        file.media_type.clone()
                    },
                    size: i64::try_from(file.byte_size).ok(),
                    ..Default::default()
                },
                &self.upload_key,
            );
            if !settled.committed {
                self.failed(ctx.locale(), settled.refusal);
                return;
            }
            self.document = settled.output_text("id");
            if self.document.is_none() {
                self.failed(ctx.locale(), words::attachment_failed(ctx.locale()));
                return;
            }
        }
        let Some(id) = self.document.as_ref() else {
            return;
        };
        let settled = write::act(
            ctx,
            act::agenda::Attach {
                from: owner.to_owned(),
                to: id.clone(),
            },
            &write::key(&["attach", owner, id], write::fresh()),
        );
        if !settled.committed {
            self.failed(ctx.locale(), settled.refusal);
            return;
        }
        *self = Self {
            status: Some(wire::StatusLine {
                sentence: words::attachment_added(ctx.locale()),
                ..Default::default()
            }),
            ..Self::default()
        };
    }

    pub fn view(
        &self,
        locale: Locale,
        rows: Vec<wire::AgendaAttachmentRow>,
    ) -> wire::AgendaAttachments {
        wire::AgendaAttachments {
            heading: words::attachments_heading(locale),
            add_label: words::attachment_add(locale),
            remove_label: words::attachment_remove(locale),
            rows,
            status: self.status.clone(),
            busy: self.picking,
        }
    }
}

fn title(locale: Locale, value: &str) -> String {
    if value.trim().is_empty() {
        words::attachment_untitled(locale)
    } else {
        value.trim().to_owned()
    }
}

pub fn row(locale: Locale, id: &str, name: &str, kind: &str) -> wire::AgendaAttachmentRow {
    let title = title(locale, name);
    let (app, entity) = if kind == "photo" {
        ("photos", "photo")
    } else {
        ("docs", "document")
    };
    let reference = crate::shell::row_routes::RowRef::new(app, entity, id, &title);
    let route = crate::shell::row_routes::route(&reference, &words::app_title(locale), &[]);
    wire::AgendaAttachmentRow {
        id: id.to_owned(),
        title,
        meta: if kind == "photo" {
            words::attachment_photo(locale)
        } else {
            words::attachment_document(locale)
        },
        route,
    }
}
