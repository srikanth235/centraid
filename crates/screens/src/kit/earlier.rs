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
//! - **A secret a version held** (Locker's replaced password; only an app with a [`Wall`]) is
//!   drawn as dots with a Reveal on its row ([`wire::EarlierSecret`]), never worded in the line. A
//!   Reveal asks the wall's owner check ([`Wall::open`]), shows the value for its life, and a
//!   Conceal, the timer, leaving and a relock take it away again.
//! - **A failed read** is the shared failed state, never an empty list. A data change reloads the
//!   first page; pages the member had opened are not kept.

use centraid_api_proto::core_v1 as wire;
use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::Value;
use wire::app_query_response::Answer;
use wire::earlier_event::Kind as K;
use wire::screen_event::Kind as E;

use super::act as kit_act;
use super::civil::{self, HourCycle};
use super::quantity::UnitsPref;
use super::read::{self, Note, Page, Reading};
use super::secret::Secrets;
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
    /// The member's units (their choice, else the phone's region).
    pub units: UnitsPref,
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
    /// A wall the app's records sit behind (Locker's lock) and the sealed values it keeps: while
    /// it is shut the screen reads nothing, draws the app's `denied` gate and restores nothing;
    /// `None` where the app has no wall.
    pub gate: Option<&'static Wall>,
}

/// A wall the app's records sit behind, and the secrets of its versions.
///
/// A version of a record behind a wall may hold SEALED values (Locker's password): the vault
/// keeps them as ciphertext and the list shows each as dots. A tap on Reveal opens that version's
/// cell through the wall's own owner check ([`Wall::open`]), for a short life, and the value
/// is gone again on Conceal, on the timer, on leaving and on a relock.
pub struct Wall {
    /// `Some(denial)` while the wall is shut.
    pub closed: fn(&Ctx) -> Option<wire::AppQueryDenial>,
    /// The sealed values among the fields a version held, one per secret.
    pub secrets: fn(&Look, &[Field]) -> Vec<Secret>,
    /// Open one of a version's secrets (`entity_id`, `seq`, the secret's `key`): its plaintext
    /// and how long it may stay on screen, `Err(None)` when the wall shut under the ask, or
    /// `Err(Some(sentence))` for any other refusal, in the member's words.
    pub open: fn(&Ctx, &str, i64, &str) -> Opened,
}

/// What [`Wall::open`] answers: the plaintext and its life on screen, or the refusal.
pub type Opened = Result<(String, Duration), Option<String>>;

/// One sealed value a version held, as the app names it.
#[derive(Clone, Debug, PartialEq)]
pub struct Secret {
    /// What a Reveal sends back to name it.
    pub key: String,
    /// "Password".
    pub label: String,
    /// Whether it can be shown at all: a one-time-code seed never is.
    pub revealable: bool,
}

/// What a sealed value is drawn as, for every value and length alike.
pub const MASKED: &str = "••••••••";

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
        listing: Page::loading(),
        status: None,
        undo: false,
        names: Names::new(),
        secrets: Secrets::default(),
        effects: Vec::new(),
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
    /// Where the record came from, "From contacts.vcf", read with the count and drawn under the
    /// entry (#1185). Absent for an item the member typed, and when the read did not land.
    pub origin: Option<wire::OriginLine>,
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
    let origin = crate::kit::origin::read(ctx, entity_id);
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
            origin,
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
        origin,
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

/// The versions listed so far, and the cursor of the page below them.
struct Listing {
    versions: Vec<Version>,
    next: Option<i64>,
}

struct Earlier {
    spec: &'static EarlierSpec,
    entity_id: String,
    back_label: String,
    listing: Page<Listing>,
    /// A refusal's sentence, or "Earlier version restored" with Undo, until the next attempt.
    status: Option<wire::StatusLine>,
    /// Whether the status line's Undo is a restore's.
    undo: bool,
    /// What the spec's `know` hook read with the list.
    names: Names,
    /// The sealed values on screen, keyed `<seq>:<key>`.
    secrets: Secrets,
    /// Effects a change of state owes the shell (a shield that falls) until the event ends.
    effects: Vec<wire::Effect>,
}

/// The name a shown secret goes by in [`Secrets`]: the version's, and the secret's.
fn token(seq: i64, key: &str) -> String {
    format!("{seq}:{key}")
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

    /// The wall's refusal while the app's records are behind one that is shut.
    fn walled(&self, ctx: &Ctx) -> Option<wire::AppQueryDenial> {
        self.spec.gate.and_then(|wall| (wall.closed)(ctx))
    }

    /// The secrets a version held, as the app's wall names them.
    fn secrets_of(&self, look: &Look, version: &Version) -> Vec<Secret> {
        self.spec
            .gate
            .map_or_else(Vec::new, |wall| (wall.secrets)(look, &version.before))
    }

    /// Reveal one secret of a version: asked of the core, which opens the cell behind the owner
    /// check. A wall that shut is a wipe; a refusal is its sentence over the list.
    fn reveal(&mut self, ctx: &Ctx, seq: i64, key: &str) {
        let Some(wall) = self.spec.gate else { return };
        if self.walled(ctx).is_some() {
            self.reload(ctx);
            return;
        }
        let Some(Listing { versions, .. }) = self.listing.data() else {
            return;
        };
        let look = Look {
            locale: ctx.locale(),
            cycle: ctx.hour_cycle(),
            zone: ctx.zone(),
            units: ctx.units(),
            names: &self.names,
        };
        // Only a secret this version held, and one that can be shown at all.
        let offered = versions
            .iter()
            .find(|version| version.seq == seq && seq > 0)
            .is_some_and(|version| {
                (wall.secrets)(&look, &version.before)
                    .iter()
                    .any(|secret| secret.key == key && secret.revealable)
            });
        if !offered {
            return;
        }
        match (wall.open)(ctx, &self.entity_id, seq, key) {
            Ok((value, life)) => {
                self.status = None;
                self.effects.extend(self.secrets.hide_all(ctx));
                self.effects
                    .extend(self.secrets.show(ctx, &token(seq, key), &value, life));
            }
            // The wall shut under the ask: the screen draws its gate and holds nothing.
            Err(None) => self.reload(ctx),
            Err(Some(sentence)) => {
                self.status = Some(wire::StatusLine {
                    sentence,
                    action_label: String::new(),
                    refused: true,
                });
            }
        }
    }

    fn conceal(&mut self, ctx: &Ctx, seq: i64, key: &str) {
        let effects = self.secrets.hide(ctx, &token(seq, key));
        self.effects.extend(effects);
    }

    fn reload(&mut self, ctx: &Ctx) {
        // Nothing revealed outlives a change of what is listed or a shut wall.
        let hidden = self.secrets.hide_all(ctx);
        self.effects.extend(hidden);
        // A shut wall is a wipe: nothing read before it stays, and nothing is read behind it.
        if let Some(denial) = self.walled(ctx) {
            self.names = Names::new();
            self.status = None;
            self.undo = false;
            self.listing = Page::Refused(denial);
            return;
        }
        if let Some(know) = self.spec.know {
            self.names = know(ctx, &self.entity_id);
        }
        let reading = match self.page(ctx, None) {
            Reading::Data((versions, next)) => Reading::Data(Listing { versions, next }),
            Reading::Denied(denial) => Reading::Denied(denial),
            Reading::Failed => Reading::Failed,
        };
        let kept = std::mem::replace(&mut self.listing, Page::loading());
        self.listing = kept
            .refreshing()
            .after(reading, ctx.locale(), |listing| listing.versions.is_empty());
    }

    /// The next page, under the rows shown; a read that does not land keeps them and says so.
    fn more(&mut self, ctx: &Ctx) {
        let Some(Listing {
            next: Some(next), ..
        }) = self.listing.data()
        else {
            return;
        };
        let next = *next;
        if self.walled(ctx).is_some() {
            self.reload(ctx);
            return;
        }
        match self.page(ctx, Some(next)) {
            Reading::Data((more, after)) => {
                if let Page::Ready { data, note } = &mut self.listing {
                    data.versions.extend(more);
                    data.next = after;
                    *note = None;
                }
            }
            // What loaded stays, under the one sentence.
            _ => {
                let kept = std::mem::replace(&mut self.listing, Page::loading());
                self.listing = kept.noted(Some(Note::more_failed(ctx.locale())));
            }
        }
    }

    fn shown(&self, seq: i64) -> bool {
        self.listing
            .data()
            .is_some_and(|listing| listing.versions.iter().any(|version| version.seq == seq))
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
        if self.walled(ctx).is_some() {
            self.reload(ctx);
            return;
        }
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
        if self.walled(ctx).is_some() {
            self.reload(ctx);
            return;
        }
        if !std::mem::take(&mut self.undo) {
            return;
        }
        let settled = self.write(
            ctx,
            act::shell::UndoChange {
                earlier_version_id: self.entity_id.clone(),
                seq: None,
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
        secrets: Vec<wire::EarlierSecret>,
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
            secrets,
        }
    }

    /// The sealed values a version held, drawn as dots until one is revealed.
    fn secret_rows(&self, look: &Look, version: &Version) -> Vec<wire::EarlierSecret> {
        let locale = look.locale;
        self.secrets_of(look, version)
            .into_iter()
            .map(|secret| {
                let shown = self.secrets.value(&token(version.seq, &secret.key));
                let spoken = if shown.is_some() {
                    fill(&words::secret_revealed(locale), &[("label", &secret.label)])
                } else {
                    fill(&words::secret_hidden(locale), &[("label", &secret.label)])
                };
                wire::EarlierSecret {
                    key: secret.key,
                    masked: MASKED.to_owned(),
                    value: shown.unwrap_or_default().to_owned(),
                    revealed: shown.is_some(),
                    reveal_label: if secret.revealable {
                        words::reveal(locale)
                    } else {
                        String::new()
                    },
                    conceal_label: if secret.revealable {
                        words::conceal(locale)
                    } else {
                        String::new()
                    },
                    accessibility_label: spoken,
                    label: secret.label,
                }
            })
            .collect()
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
                Vec::new(),
            ));
        }
        for version in versions {
            rows.push(self.row(
                look,
                Self::when(locale, cycle, &version.since_local, &version.since_by),
                &version.before,
                version.seq,
                false,
                self.secret_rows(look, version),
            ));
        }
        rows
    }
}

impl Screen for Earlier {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            // Nothing revealed outlives the screen: its effects are dropped with it.
            Some(E::Left(_)) => self.secrets.conceal(),
            Some(E::TimerFired(fired)) => {
                let effects = self.secrets.fired(&fired.timer);
                self.effects.extend(effects);
            }
            Some(E::EffectResult(result)) => self.secrets.answered(ctx, &result),
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
            }
            Some(E::Earlier(earlier)) => match earlier.kind {
                Some(K::Refreshed(_)) => self.reload(ctx),
                // RESTORE ASKS NOTHING: it undoes, and undoing is not a decision.
                Some(K::Restore(tapped)) => self.restore(ctx, tapped.seq),
                Some(K::More(_)) => self.more(ctx),
                Some(K::StatusActed(_)) => self.undone(ctx),
                Some(K::Reveal(tapped)) => self.reveal(ctx, tapped.seq, &tapped.key),
                Some(K::Conceal(tapped)) => self.conceal(ctx, tapped.seq, &tapped.key),
                None => {}
            },
            _ => {}
        }
        std::mem::take(&mut self.effects)
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::earlier_view::Content as C;
        let locale = ctx.locale();
        // THE READ (#1185): a record with no earlier version is the page's own empty state.
        let content = self.listing.data().map(|listing| {
            C::Data(wire::EarlierData {
                rows: self.rows(
                    &Look {
                        locale,
                        cycle: ctx.hour_cycle(),
                        zone: ctx.zone(),
                        units: ctx.units(),
                        names: &self.names,
                    },
                    &listing.versions,
                ),
                more_label: if listing.next.is_some() {
                    shared::kit_show_more(locale)
                } else {
                    String::new()
                },
            })
        });
        let page = self.listing.wire(
            locale,
            |denial| (self.spec.denied)(locale, denial),
            || wire::EmptyState {
                headline: words::empty_headline(locale),
                body: fill(
                    &words::empty_body(locale),
                    &[("noun", &(self.spec.noun)(locale))],
                ),
                icon_key: "Clock".to_owned(),
                ..wire::EmptyState::default()
            },
        );
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Earlier(wire::EarlierView {
                app_id: self.spec.app.to_owned(),
                title: words::title(locale),
                back_label: self.back_label.clone(),
                content,
                page: Some(page),
                status: self.status.clone(),
            })),
            ..wire::ViewState::default()
        }
    }
}
