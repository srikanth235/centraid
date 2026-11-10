//! THE KIT'S ONE EARLIER-VERSIONS SCREEN (#1185): every record keeps its earlier values at the
//! vault's commit door, and this is the one place a member reads and restores them, the app a
//! [`EarlierSpec`] (law 2): `people.earlier` and every other app's `<app>.earlier` are this machine
//! over their own spec.
//!
//! - **The entry** is [`foot`]: one [`wire::EarlierEntry`] a detail view embeds at its foot,
//!   "Earlier versions   2 ›", with the route to push. A record with nothing earlier has none, and a
//!   count that did not land says so ([`Foot::status`]) instead of drawing no entry as if there
//!   were nothing.
//! - **The list** is `shell.earlier-versions`, newest first, a keyset page at a time ("Show more").
//!   The first row is the record as it is, tagged "Current"; each other row is the record as it
//!   was, dated when it became so, with Restore. The app words each row's values in ONE line
//!   ([`EarlierSpec::line`]) from the fields that changed, in the page's own formatting.
//! - **Restore asks nothing**: it is a commit like any edit, so it is itself a version and is undone
//!   by restoring again. It ends in "Earlier version restored" with Undo, which is
//!   `history.undo`. A refusal is the core's sentence over the list.
//! - **Who made a change** reads in the member's words: a change a phone's store made says "From
//!   your phone", "From the folder", "From Apple Health" or "From a statement"; the member's own
//!   say nothing.
//! - **A failed read** is the shared failed state, never an empty list. A data change reloads the
//!   first page; pages the member had opened are not kept.

use centraid_api_proto::core_v1 as wire;
use std::collections::BTreeMap;

use serde_json::Value;
use wire::app_query_response::Answer;
use wire::earlier_event::Kind as K;
use wire::screen_event::Kind as E;

use super::act as kit_act;
use super::civil::{self, HourCycle};
use super::read::{self, Reading};
use crate::catalog::{act, load};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, history as words, shared};

/// A sentence in a locale.
pub type Words = fn(Locale) -> String;

/// One field a version held (or the record holds now): the vault's name for it
/// (`entity.title`, `person.role`, `contact_point[<key>].value`, `attendee[<person>]`) and its value
/// as the vault keeps it, `null` where there was none.
#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    pub name: String,
    pub value: Value,
}

/// What a formatter needs of the phone it words for: the member's language, 12 or 24 hour clock
/// and zone, and the names the app's `know` hook found for ids a version names.
pub struct Look<'a> {
    pub locale: Locale,
    pub cycle: HourCycle,
    /// The phone's own zone.
    pub zone: &'a str,
    /// The phone's region (`US`, `GB`), which decides units.
    pub region: &'a str,
    /// Names by id (a guest, a category), read with the list; empty when the spec has no hook.
    pub names: &'a Names,
}

/// Names by id, as an app's `know` hook reads them.
pub type Names = BTreeMap<String, String>;

/// ONE APP'S EARLIER VERSIONS, as the parameter the one screen takes.
pub struct EarlierSpec {
    /// `people`: the app, and the prefix of the screen name `people.earlier`.
    pub app: &'static str,
    /// What the app's records are called in "When this {noun} changes ...".
    pub noun: Words,
    /// The gate drawn when the vault will not let the app read.
    pub denied: fn(Locale, &wire::AppQueryDenial) -> wire::Denied,
    /// The ONE line a set of fields reads as, worded as the app's own detail screen words them: the
    /// fields a version held, or the ones the record holds now. Empty when none of them is
    /// something the screen shows.
    pub line: fn(&Look, &[Field]) -> String,
    /// Reads the names a line needs for the ids a record's versions hold (a guest's, a category's)
    /// as the record's page names them; `None` where the fields carry their own words.
    pub know: Option<fn(&Ctx, &str) -> Names>,
}

/// The registry factory for `spec`'s screen.
#[must_use]
pub fn build(spec: &'static EarlierSpec, route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::Earlier(args)) = &route.args else {
        return None;
    };
    // A record with no id names nothing.
    if args.entity_id.is_empty() {
        return None;
    }
    Some(Box::new(Earlier {
        spec,
        entity_id: args.entity_id.clone(),
        back_label: args.back_label.clone(),
        phase: Phase::Loading,
        status: None,
        undo: false,
        names: Names::new(),
    }))
}

/// The route to `screen` (the app's `<app>.earlier`) for a record; `back` names the page it is
/// pushed from.
#[must_use]
pub fn route(screen: &str, entity_id: &str, back: &str) -> wire::Route {
    wire::Route {
        sheet: false,
        screen: screen.to_owned(),
        args: Some(wire::route::Args::Earlier(wire::EarlierRoute {
            entity_id: entity_id.to_owned(),
            back_label: back.to_owned(),
        })),
    }
}

/// What a detail page's foot came to: the entry, or the fact that the count was not read.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Foot {
    /// Absent when the record holds no earlier version, or the count was not read.
    pub entry: Option<wire::EarlierEntry>,
    unread: bool,
}

impl Foot {
    /// The one sentence for a count that was not read; `None` when it was.
    #[must_use]
    pub fn status(&self, locale: Locale) -> Option<wire::StatusLine> {
        self.unread.then(|| wire::StatusLine {
            sentence: words::entry_unread_status(locale),
            action_label: String::new(),
            refused: false,
        })
    }
}

/// The entry for `entity_id`'s page: how many earlier versions it holds, and the route to them.
pub fn foot(ctx: &Ctx, screen: &str, entity_id: &str, back: &str) -> Foot {
    if entity_id.is_empty() {
        return Foot::default();
    }
    let reading = read::read(
        ctx,
        load::shell::EarlierCount {
            entity_id: entity_id.to_owned(),
        },
        |answer| match answer {
            Answer::EarlierCount(counted) => Some(counted.count),
            _ => None,
        },
    );
    let Reading::Data(count) = reading else {
        return Foot {
            entry: None,
            unread: true,
        };
    };
    let locale = ctx.locale();
    Foot {
        entry: (count > 0).then(|| wire::EarlierEntry {
            label: words::entry_label(locale),
            count_label: count.to_string(),
            route: Some(route(screen, entity_id, back)),
            accessibility_label: fill(&words::entry_spoken(locale), &[("n", &count.to_string())]),
        }),
        unread: false,
    }
}

/// `Wed 4 November · 09:12` for a civil minute the core read in the member's zone; empty when it
/// stated none (no time is invented).
#[must_use]
pub fn dated(locale: Locale, cycle: HourCycle, local: &str) -> String {
    let day = local.get(..10).map(|day| civil::day_month(locale, day));
    [
        day.unwrap_or_default(),
        civil::clock_for(locale, local, cycle),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" · ")
}

/// Who made a change, in the member's words; empty for the member.
#[must_use]
pub fn from(locale: Locale, system: &str) -> String {
    match system {
        "" => String::new(),
        "contacts" | "calendar" => words::from_phone(locale),
        "files" => words::from_folder(locale),
        "health" => words::from_health(locale),
        "statement" => words::from_statement(locale),
        _ => words::from_import(locale),
    }
}

/// One loaded version, its values parsed.
struct Version {
    seq: i64,
    replaced_local: String,
    since_local: String,
    replaced_by: String,
    since_by: String,
    before: Vec<Field>,
    after: Vec<Field>,
}

enum Phase {
    Loading,
    Failed,
    Denied(wire::AppQueryDenial),
    Ready {
        versions: Vec<Version>,
        next: Option<i64>,
    },
}

struct Earlier {
    spec: &'static EarlierSpec,
    entity_id: String,
    back_label: String,
    phase: Phase,
    /// A refusal's sentence, or "Earlier version restored" with Undo, until the next attempt.
    status: Option<wire::StatusLine>,
    /// Whether the status line's Undo is a restore's.
    undo: bool,
    /// What the spec's `know` hook read with the list.
    names: Names,
}

fn json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

fn parsed(version: wire::EarlierVersion) -> Version {
    let side = |after: bool| {
        version
            .field_changes
            .iter()
            .map(|change| Field {
                name: change.field.clone(),
                value: json(if after {
                    &change.after_json
                } else {
                    &change.before_json
                }),
            })
            .collect()
    };
    Version {
        seq: version.seq,
        before: side(false),
        after: side(true),
        replaced_local: version.replaced_local,
        since_local: version.since_local,
        replaced_by: version.store_system,
        since_by: version.since_store_system,
    }
}

impl Earlier {
    fn page(&self, ctx: &Ctx, after: Option<i64>) -> Reading<(Vec<Version>, Option<i64>)> {
        let mut request: wire::LoadRequest = load::shell::EarlierVersions {
            entity_id: self.entity_id.clone(),
        }
        .into();
        request.after = after.map(|seq| seq.to_string()).unwrap_or_default();
        match read::read(ctx, request, |answer| match answer {
            Answer::EarlierVersions(page) => Some(page),
            _ => None,
        }) {
            Reading::Data(page) => {
                Reading::Data((page.versions.into_iter().map(parsed).collect(), page.next))
            }
            Reading::Denied(denial) => Reading::Denied(denial),
            Reading::Failed => Reading::Failed,
        }
    }

    fn reload(&mut self, ctx: &Ctx) {
        if let Some(know) = self.spec.know {
            self.names = know(ctx, &self.entity_id);
        }
        self.phase = match self.page(ctx, None) {
            Reading::Data((versions, next)) => Phase::Ready { versions, next },
            Reading::Denied(denial) => Phase::Denied(denial),
            Reading::Failed => Phase::Failed,
        };
    }

    /// The next page, under the rows shown; a read that does not land keeps them and says so.
    fn more(&mut self, ctx: &Ctx) {
        let Phase::Ready {
            next: Some(next), ..
        } = &self.phase
        else {
            return;
        };
        let next = *next;
        match self.page(ctx, Some(next)) {
            Reading::Data((more, after)) => {
                if let Phase::Ready { versions, next } = &mut self.phase {
                    versions.extend(more);
                    *next = after;
                }
            }
            _ => {
                self.status = Some(wire::StatusLine {
                    sentence: shared::read_failed(ctx.locale()),
                    action_label: String::new(),
                    refused: true,
                });
            }
        }
    }

    fn shown(&self, seq: i64) -> bool {
        matches!(&self.phase, Phase::Ready { versions, .. } if versions.iter().any(|version| version.seq == seq))
    }

    /// One write under a key of its own; either way the list is read again. Answers the settled
    /// verdict.
    fn write(&mut self, ctx: &Ctx, request: wire::ActRequest, subject: &str) -> kit_act::Settled {
        let key = kit_act::key(&[&request.action, subject], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        self.status = (!settled.committed).then(|| wire::StatusLine {
            sentence: settled.refusal.clone(),
            action_label: String::new(),
            refused: true,
        });
        self.undo = false;
        self.reload(ctx);
        settled
    }

    /// A restore asks nothing, and says what it did with Undo.
    fn restore(&mut self, ctx: &Ctx, seq: i64) {
        if !self.shown(seq) || seq <= 0 {
            return;
        }
        let locale = ctx.locale();
        let settled = self.write(
            ctx,
            act::shell::RestoreVersion {
                earlier_version_id: self.entity_id.clone(),
                seq,
            }
            .into(),
            &seq.to_string(),
        );
        if !settled.committed {
            return;
        }
        // Restoring what the record already holds writes nothing, so there is nothing to undo.
        let wrote = serde_json::from_slice::<Value>(&settled.output)
            .ok()
            .and_then(|out| out.get("restored").and_then(Value::as_bool))
            .unwrap_or(true);
        self.undo = wrote;
        self.status = Some(if wrote {
            wire::StatusLine {
                sentence: words::restored(locale),
                action_label: shared::trash_undo(locale),
                refused: false,
            }
        } else {
            wire::StatusLine {
                sentence: words::restored_already(locale),
                action_label: String::new(),
                refused: false,
            }
        });
    }

    /// Undo of a restore: the record goes back to what the restore replaced.
    fn undone(&mut self, ctx: &Ctx) {
        if !std::mem::take(&mut self.undo) {
            return;
        }
        let settled = self.write(
            ctx,
            act::shell::UndoChange {
                earlier_version_id: self.entity_id.clone(),
            }
            .into(),
            "undo",
        );
        if settled.committed {
            self.status = Some(wire::StatusLine {
                sentence: words::undone(ctx.locale()),
                action_label: String::new(),
                refused: false,
            });
        }
    }

    /// `Wed 4 November · 09:12 · From your phone`.
    fn when(locale: Locale, cycle: HourCycle, local: &str, system: &str) -> String {
        [dated(locale, cycle, local), from(locale, system)]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ")
    }

    fn row(
        &self,
        look: &Look,
        when: String,
        fields: &[Field],
        seq: i64,
        current: bool,
    ) -> wire::EarlierRow {
        let locale = look.locale;
        let line = (self.spec.line)(look, fields);
        let value = if line.trim().is_empty() {
            words::other_details(locale)
        } else {
            line
        };
        let tag = if current {
            words::current(locale)
        } else {
            String::new()
        };
        wire::EarlierRow {
            seq,
            accessibility_label: [when.as_str(), value.as_str(), tag.as_str()]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(", "),
            label: when,
            value,
            current,
            current_label: tag,
            restore_label: if current {
                String::new()
            } else {
                shared::trash_restore(locale)
            },
        }
    }

    fn rows(&self, look: &Look, versions: &[Version]) -> Vec<wire::EarlierRow> {
        let (locale, cycle) = (look.locale, look.cycle);
        let mut rows = Vec::with_capacity(versions.len() + 1);
        // The record as it is became so when the newest version was replaced, by whoever did.
        if let Some(newest) = versions.first() {
            rows.push(self.row(
                look,
                Self::when(locale, cycle, &newest.replaced_local, &newest.replaced_by),
                &newest.after,
                0,
                true,
            ));
        }
        for version in versions {
            rows.push(self.row(
                look,
                Self::when(locale, cycle, &version.since_local, &version.since_by),
                &version.before,
                version.seq,
                false,
            ));
        }
        rows
    }
}

impl Screen for Earlier {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
            }
            Some(E::Earlier(earlier)) => match earlier.kind {
                Some(K::Refreshed(_)) => self.reload(ctx),
                // RESTORE ASKS NOTHING: it undoes, and undoing is not a decision.
                Some(K::Restore(tapped)) => self.restore(ctx, tapped.seq),
                Some(K::More(_)) => self.more(ctx),
                Some(K::StatusActed(_)) => self.undone(ctx),
                None => {}
            },
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::earlier_view::Content as C;
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Loading => C::Loading(wire::Loading { first_load: true }),
            Phase::Failed => C::Failure(read::failure(locale)),
            Phase::Denied(denial) => C::Denied((self.spec.denied)(locale, denial)),
            Phase::Ready { versions, next } => C::Data(wire::EarlierData {
                rows: self.rows(
                    &Look {
                        locale,
                        cycle: ctx.hour_cycle(),
                        zone: ctx.zone(),
                        region: ctx.region(),
                        names: &self.names,
                    },
                    versions,
                ),
                empty: Some(wire::EmptyState {
                    headline: words::empty_headline(locale),
                    body: fill(
                        &words::empty_body(locale),
                        &[("noun", &(self.spec.noun)(locale))],
                    ),
                    icon_key: "Clock".to_owned(),
                    ..wire::EmptyState::default()
                }),
                more_label: if next.is_some() {
                    shared::kit_show_more(locale)
                } else {
                    String::new()
                },
            }),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Earlier(wire::EarlierView {
                app_id: self.spec.app.to_owned(),
                title: words::title(locale),
                back_label: self.back_label.clone(),
                content: Some(content),
                status: self.status.clone(),
            })),
            ..wire::ViewState::default()
        }
    }
}
