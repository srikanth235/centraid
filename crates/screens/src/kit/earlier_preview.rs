//! THE FULL PREVIEW OF ONE EARLIER VERSION (#1185): the record as it was, read-only, drawn the way
//! the app's own page words it, under a banner that says which version it is. It is the same
//! screen name as the list (`<app>.earlier`) opened on a version ([`wire::EarlierPreviewRoute`]),
//! so every app has it with no registration of its own, and the app's [`EarlierSpec`] words it.
//!
//! - **The banner** says when the version became the record ("As it was on Tue 27 October ·
//!   20:40", with who made it when a phone store did), what replaced it ("Changed on Wed 4
//!   November · 09:12 to ..."), and that nothing is saved until Restore.
//! - **The body** is the version's whole state, worded by the spec ([`EarlierSpec::parts`]): the
//!   first piece is the heading, each other a line under it. A sealed value (Locker) is dots: a
//!   Reveal lives on the list, and a shut wall draws the app's gate and reads nothing.
//! - **Restore** asks nothing, as the list's does: it is a commit like any edit, `history.restore_version`,
//!   taken back by `history.undo`. The page then closes and the list beneath says "Earlier version
//!   restored" with Undo (handed down through [`Undo`]). **Close** just closes.
//! - **A failed read** is the shared failed state with Try again, never an empty record.

use centraid_api_proto::core_v1 as wire;
use serde_json::Value;
use wire::app_query_response::Answer;
use wire::earlier_preview_event::Kind as K;
use wire::screen_event::Kind as E;

use super::act as kit_act;
use super::earlier::{self, EarlierSpec, Field, Look, Names};
use super::read::{self, Page, Reading};
use super::undo::Undo;
use crate::catalog::{act, load};
use crate::screen::{Ctx, Screen};
use crate::strings::{fill, history as words};

/// The registry's factory for a preview of `spec`'s app.
pub(super) fn build(
    spec: &'static EarlierSpec,
    args: &wire::EarlierPreviewRoute,
) -> Option<Box<dyn Screen>> {
    // A record or a version with no number names nothing.
    if args.entity_id.is_empty() || args.seq <= 0 {
        return None;
    }
    Some(Box::new(Preview {
        spec,
        entity_id: args.entity_id.clone(),
        seq: args.seq,
        back_label: args.back_label.clone(),
        page: Page::loading(),
        undo: Undo::default(),
        names: Names::new(),
        done: false,
    }))
}

struct Preview {
    spec: &'static EarlierSpec,
    entity_id: String,
    seq: i64,
    back_label: String,
    page: Page<wire::EarlierRecord>,
    /// The line a refusal or a restore says; a restore hands it to the list beneath.
    undo: Undo,
    /// What the spec's `know` hook read with the record.
    names: Names,
    /// The shell pops this screen: closed, or restored.
    done: bool,
}

fn fields(record: &[wire::EarlierField]) -> Vec<Field> {
    record
        .iter()
        .map(|field| Field {
            name: field.field.clone(),
            value: earlier::json(&field.value_json),
        })
        .collect()
}

impl Preview {
    fn walled(&self, ctx: &Ctx) -> Option<wire::AppQueryDenial> {
        self.spec.gate.and_then(|wall| (wall.closed)(ctx))
    }

    fn reload(&mut self, ctx: &Ctx) {
        // A shut wall is a wipe: nothing read before it stays, and nothing is read behind it.
        if let Some(denial) = self.walled(ctx) {
            self.names = Names::new();
            self.undo.clear();
            self.page = Page::Refused(denial);
            return;
        }
        if let Some(know) = self.spec.know {
            self.names = know(ctx, &self.entity_id);
        }
        let reading = read::read(
            ctx,
            load::shell::EarlierRecord {
                entity_id: self.entity_id.clone(),
                seq: self.seq,
            },
            |answer| match answer {
                Answer::EarlierRecord(record) => Some(record),
                _ => None,
            },
        );
        // The titles of the lists, albums and items the version names by id.
        if let Reading::Data(record) = &reading {
            for named in &record.names {
                self.names
                    .entry(named.id.clone())
                    .or_insert_with(|| named.title.clone());
            }
        }
        let kept = std::mem::replace(&mut self.page, Page::loading());
        self.page = kept
            .refreshing()
            .after(reading, ctx.locale(), |_: &wire::EarlierRecord| false);
    }

    /// Restore asks nothing; the list beneath says what it did, with Undo.
    fn restore(&mut self, ctx: &Ctx) {
        if self.walled(ctx).is_some() {
            self.reload(ctx);
            return;
        }
        if self.page.data().is_none() {
            return;
        }
        let request: wire::ActRequest = act::shell::RestoreVersion {
            earlier_version_id: self.entity_id.clone(),
            seq: self.seq,
        }
        .into();
        let revert: wire::ActRequest = act::shell::UndoChange {
            earlier_version_id: self.entity_id.clone(),
            seq: None,
        }
        .into();
        let key = kit_act::key(&[&request.action, &self.seq.to_string()], kit_act::fresh());
        let settled = self
            .undo
            .act_reverting(ctx, request, revert, &key, words::restored);
        if !settled.committed {
            // The core's sentence over the preview; the page stays.
            return;
        }
        let wrote = serde_json::from_slice::<Value>(&settled.output)
            .ok()
            .and_then(|out| out.get("restored").and_then(Value::as_bool))
            .unwrap_or(true);
        if !wrote {
            self.undo.say(words::restored_already(ctx.locale()));
        }
        self.undo.hand_down(ctx);
        self.done = true;
    }

    fn look<'a>(&'a self, ctx: &'a Ctx, whole: bool) -> Look<'a> {
        Look {
            locale: ctx.locale(),
            cycle: ctx.hour_cycle(),
            zone: ctx.zone(),
            units: ctx.units(),
            names: &self.names,
            whole,
        }
    }

    fn data(&self, ctx: &Ctx, record: &wire::EarlierRecord) -> wire::EarlierPreviewData {
        let locale = ctx.locale();
        let cycle = ctx.hour_cycle();
        let when = |local: &str, system: &str, actor: &str| {
            [
                earlier::dated(locale, cycle, local),
                earlier::from(locale, system, actor),
            ]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ")
        };
        let since = when(
            &record.since_local,
            &record.since_store_system,
            &record.since_actor,
        );
        let headline = if since.is_empty() {
            words::preview_as_it_was_undated(locale)
        } else {
            fill(&words::preview_as_it_was(locale), &[("when", &since)])
        };
        // What the version became: the new values of the fields the replacing change moved.
        let moved: Vec<Field> = record
            .field_changes
            .iter()
            .map(|change| Field {
                name: change.field.clone(),
                value: earlier::json(&change.after_json),
            })
            .collect();
        let line = self.spec.line(&self.look(ctx, false), &moved);
        let replaced = when(&record.replaced_local, &record.store_system, &record.actor);
        let changed = match (replaced.is_empty(), line.trim().is_empty()) {
            (false, false) => fill(
                &words::preview_changed(locale),
                &[("when", &replaced), ("line", &line)],
            ),
            (false, true) => fill(&words::preview_changed_on(locale), &[("when", &replaced)]),
            (true, false) => fill(&words::preview_changed_undated(locale), &[("line", &line)]),
            (true, true) => String::new(),
        };
        let mut shown = (self.spec.parts)(&self.look(ctx, true), &fields(&record.fields))
            .into_iter()
            .filter(|piece| !piece.trim().is_empty());
        let heading = shown.next().unwrap_or_else(|| words::other_details(locale));
        let note = words::preview_note(locale);
        wire::EarlierPreviewData {
            accessibility_label: fill(
                &words::preview_spoken(locale),
                &[("headline", &headline), ("note", &note)],
            ),
            banner_headline: headline,
            banner_changed: changed,
            banner_note: note,
            heading,
            details: shown.collect(),
            restore_label: words::preview_restore(locale),
            close_label: words::preview_close(locale),
        }
    }
}

impl Screen for Preview {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Left(_)) => self.undo.clear(),
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
            }
            Some(E::EarlierPreview(preview)) => match preview.kind {
                Some(K::Refreshed(_)) => self.reload(ctx),
                Some(K::Restore(_)) => self.restore(ctx),
                Some(K::Close(_)) => self.done = true,
                None => {}
            },
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let data = self.page.data().map(|record| self.data(ctx, record));
        let page = self.page.wire(
            locale,
            |denial| (self.spec.denied)(locale, denial),
            wire::EmptyState::default,
        );
        wire::ViewState {
            kind: Some(wire::view_state::Kind::EarlierPreview(
                wire::EarlierPreviewView {
                    app_id: self.spec.app.to_owned(),
                    title: words::preview_title(locale),
                    back_label: self.back_label.clone(),
                    page: Some(page),
                    data,
                    status: self.undo.status(),
                    done: self.done,
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
