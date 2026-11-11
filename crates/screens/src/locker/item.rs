//! ONE ITEM (#1047): metadata plainly, and each secret as a sealed row with a
//! verb. **Reveal** asks the core through the session: the item is stamped as
//! used before the value exists, the value lives in this screen's
//! [`Secrets`] for the core's window with a countdown, and it is gone on
//! Conceal, on leave and on relock. **Copy** is a reveal whose value goes to the
//! clipboard — sensitive, with a deadline the shell keeps — and never onto the
//! screen.
//!
//! **A one-time-code seed is never revealed** (Q-1047-16). Its row offers
//! **Show code** and **Copy code**: the core makes the code the seed makes now,
//! the item stamped first, and the row shows it with its seconds and a countdown. A
//! code that rolls while shown is followed once, so a tap made with two seconds
//! left still leaves a whole code to type; then it conceals.
//!
//! **Custom fields, the passkey and when it was last used (#1047 T2, #1146).** A sealed
//! custom field reveals and copies exactly as the item's own secrets do; a
//! field is added, edited and removed one at a time on the field sheet
//! (`locker.set_field` is one field per command), and a sealed one's value is
//! sealed by the core on Save. A passkey shows its metadata, is renamed and
//! removed, and its key has no verb at all — the core refuses it too
//! (`KEY_NOT_SHOWN`). The Details section says when the core last opened one of
//! the item's secrets, or that it never has; the Locker keeps no history behind
//! that line.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::locker_item_event::Kind as I;
use wire::screen_event::Kind as E;

use super::routes;
use super::shared::{self, Opened, Phase, Refused};
use super::types::{self, SEED};
use super::wall::{CLIPBOARD_LIFE, Change, Wall};
use crate::catalog::{act, load};
use crate::kit::act::{self as kit_act, Settled};
use crate::kit::civil;
use crate::kit::earlier;
use crate::kit::links::{self, Kind, Links, Outcome};
use crate::kit::read::{self, Reading};
use crate::kit::secret::Secrets;
use crate::kit::undo::Undo;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, links as link_words, locker as words, shared as kit_words};

/// The product's reveal window, in seconds (`REVEAL_WINDOW_MS`).
const REVEAL_SECONDS: u32 = 30;

const DOTS: &str = "••••••••••";
const CODE_MASK: &str = "••• •••";
const FIELD: &str = "field:";
const TICK: &str = "tick";

/// The vault's "leave this secret alone" (`SEALED_PLACEHOLDER`).
pub(super) const PLACEHOLDER: &str = "«sealed»";

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::LockerItem(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Item::new(args.clone())))
}

struct Loaded {
    item: Option<wire::LockerItem>,
    /// The core's today, for "last used today".
    today: String,
}

/// Which confirm is up.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Confirming {
    Purge,
    Field,
    Passkey,
}

/// A revealed value's life: what the screen counts down.
struct Shown {
    column: String,
    seconds_left: u32,
    /// A one-time code: its step, and whether the roll is followed once.
    code: Option<Code>,
}

struct Code {
    period: u32,
    follow: bool,
}

/// The custom-field sheet while it is open.
struct FieldSheet {
    /// The field being edited, or empty for a new one.
    editing: String,
    section: String,
    label: String,
    value: String,
    sealed: bool,
    /// A one-time-code field: sealed, and kept as that kind when rewritten.
    otp: bool,
}

struct Item {
    route: wire::LockerItemRoute,
    wall: Wall,
    secrets: Secrets,
    loaded: Phase<Loaded>,
    shown: Option<Shown>,
    /// The status line and what its Undo reverses (the kit's one door). A line never carries a
    /// secret: it names the field, never the value.
    undo: Undo,
    confirming: Option<Confirming>,
    memo: Option<String>,
    field: Option<FieldSheet>,
    passkey_name: Option<String>,
    /// A chat card's member action, run once after the first load under an open
    /// Locker.
    follow: String,
    /// The Linked to section's picker (#1173).
    links: Links,
    /// The vault's owner, read once an item links to a person, so the row can say "You".
    owner_id: Option<String>,
    /// The entry to the item's earlier versions (#1185), read only while the Locker is open.
    earlier: earlier::Foot,
}

impl Item {
    fn new(route: wire::LockerItemRoute) -> Self {
        Self {
            follow: route.follow.clone(),
            route,
            wall: Wall::default(),
            secrets: Secrets::view_shielded(),
            loaded: Phase::Loading,
            shown: None,
            undo: Undo::default(),
            confirming: None,
            memo: None,
            field: None,
            passkey_name: None,
            links: Links::new(&[Kind::Account, Kind::Place, Kind::Person]),
            owner_id: None,
            earlier: earlier::Foot::default(),
        }
    }

    fn item(&self) -> Option<&wire::LockerItem> {
        self.loaded.data().and_then(|loaded| loaded.item.as_ref())
    }

    // --- reads ---------------------------------------------------------------

    fn reload(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if !self.wall.is_open() || self.route.item_id.is_empty() {
            return Vec::new();
        }
        let item = read::read(
            ctx,
            load::locker::Item {
                item_id: self.route.item_id.clone(),
            },
            |answer| match answer {
                Answer::LockerItem(detail) => Some((detail.item, detail.today)),
                _ => None,
            },
        );
        if let Reading::Data((Some(found), _)) = &item
            && found.links.iter().any(|link| link.kind == "person")
        {
            self.owner_id = self
                .links
                .people(ctx)
                .iter()
                .find(|person| person.is_owner)
                .map(|person| person.id.clone());
        }
        self.earlier = match &item {
            Reading::Data((Some(found), _)) => {
                earlier::foot(ctx, super::EARLIER, &self.route.item_id, &found.title)
            }
            _ => earlier::Foot::default(),
        };
        self.loaded = match item {
            Reading::Data((item, today)) => Phase::Ready(Loaded { item, today }),
            Reading::Denied(denial) => Phase::Denied(denial),
            Reading::Failed => Phase::Failed,
        };
        // THE ITEM MOVED UNDER A REVEAL (an edit, a trash): the revealed value
        // is for the item as it was, so it goes.
        let mut effects = Vec::new();
        if let Some(shown) = &self.shown {
            let keep = self
                .item()
                .is_some_and(|item| !item.trashed && stored_secret(item, &shown.column));
            if !keep {
                let column = shown.column.clone();
                self.shown = None;
                ctx.cancel_timer(TICK);
                effects.extend(self.secrets.hide(ctx, &column));
            }
        }
        effects
    }

    /// Run what the opener asked, once: a chat card's `reveal:password`.
    fn followed(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.follow.is_empty() || self.item().is_none() {
            return Vec::new();
        }
        let follow = std::mem::take(&mut self.follow);
        let (action, column) = follow.split_once(':').unwrap_or((follow.as_str(), ""));
        match action {
            "reveal" => self.verb(ctx, column, "reveal"),
            "code" => self.verb(ctx, SEED, "code"),
            _ => Vec::new(),
        }
    }

    /// Apply what the wall did to the page under it.
    fn walled(&mut self, ctx: &Ctx, step: super::wall::Step) -> Vec<wire::Effect> {
        let mut effects = step.effects;
        match step.change {
            Change::Opened => {
                effects.extend(self.reload(ctx));
                effects.extend(self.followed(ctx));
            }
            Change::Closed => effects.extend(self.wipe(ctx)),
            Change::None => {}
        }
        effects
    }

    /// A RELOCK IS A WIPE: every answer, every revealed value and every sheet
    /// goes, and the screen is its blank until the Locker opens again.
    fn wipe(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        self.loaded = Phase::Loading;
        self.shown = None;
        self.undo.clear();
        self.confirming = None;
        self.memo = None;
        self.field = None;
        self.passkey_name = None;
        self.links.close();
        self.owner_id = None;
        self.earlier = earlier::Foot::default();
        ctx.cancel_timer(TICK);
        let mut effects = self.secrets.hide_all(ctx);
        effects.extend(self.secrets.clear_clip(ctx));
        effects
    }

    /// A session step answered LOCKED: idle ended it under this page.
    fn locked(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        match self.wall.expired() {
            Change::Closed => self.wipe(ctx),
            _ => Vec::new(),
        }
    }

    // --- writes --------------------------------------------------------------

    /// One write through the kit's door: the line says `said` (with Undo when the core can take
    /// it back), or the refusal.
    fn submit(
        &mut self,
        ctx: &Ctx,
        tag: &str,
        request: impl Into<wire::ActRequest>,
        said: impl FnOnce(Locale) -> String,
    ) -> Settled {
        let key = kit_act::key(&[tag, &self.route.item_id], kit_act::fresh());
        self.undo.act(ctx, request, &key, said)
    }

    fn id(&self) -> String {
        self.route.item_id.clone()
    }

    // --- verbs ---------------------------------------------------------------

    fn verb(&mut self, ctx: &Ctx, key: &str, verb: &str) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        let Some(item) = self.item().cloned() else {
            return Vec::new();
        };
        let stored = stored_secret(&item, key);
        match verb {
            "edit" if key.starts_with(FIELD) && !item.trashed => {
                self.open_field(&item, key.trim_start_matches(FIELD));
                Vec::new()
            }
            "rename" if key == "passkey:name" && item.passkey.is_some() && !item.trashed => {
                self.passkey_name = item
                    .passkey
                    .as_ref()
                    .map(|passkey| passkey.display_name.clone());
                Vec::new()
            }
            "open" => plain_value(&item, key)
                .map(|url| {
                    vec![wire::Effect {
                        kind: Some(wire::effect::Kind::OpenUrl(wire::OpenUrl {
                            url: openable(&url),
                        })),
                    }]
                })
                .unwrap_or_default(),
            "conceal" => {
                self.shown = None;
                ctx.cancel_timer(TICK);
                self.secrets.hide(ctx, key)
            }
            // A SHOWN CODE COPIES WITHOUT A SECOND STAMP, for the reveal's
            // reason, and lives on the clipboard only as long as it is good.
            "copy_code" if stored && self.shown_code(key).is_some() => {
                let left = self.shown.as_ref().map_or(1, |shown| shown.seconds_left);
                let code = self.secrets.value(key).unwrap_or_default().to_owned();
                self.undo.say(words::code_copied(locale));
                self.secrets
                    .copy(ctx, &code, Duration::from_secs(u64::from(left.max(1))))
            }
            "code" | "copy_code" if stored && (key == SEED || is_code_field(&item, key)) => {
                self.code(ctx, key, verb == "copy_code", verb == "code")
            }
            // A REVEALED VALUE COPIES WITHOUT A SECOND STAMP: it is already
            // revealed, and the item already says it was used.
            "copy" if stored && key != SEED && self.secrets.value(key).is_some() => {
                let value = self.secrets.value(key).unwrap_or_default().to_owned();
                self.undo.say(copied_secret(locale, &item, key));
                self.secrets.copy(ctx, &value, CLIPBOARD_LIFE)
            }
            // THE SEED ITSELF IS NOT SHOWN OR COPIED from this page: its row
            // makes codes.
            "reveal" | "copy" if stored && key != SEED && !is_code_field(&item, key) => {
                self.reveal(ctx, &item, key, verb == "copy")
            }
            // A PLAIN VALUE COPIES AS ITSELF — it is metadata, never stamped.
            "copy" => match plain_value(&item, key) {
                Some(value) => {
                    self.undo.say(fill(
                        &words::copied_plain(locale),
                        &[("field", &types::label(locale, key))],
                    ));
                    vec![shared::plain_copy(&value)]
                }
                None => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    fn shown_code(&self, key: &str) -> Option<&Shown> {
        self.shown
            .as_ref()
            .filter(|shown| shown.column == key && shown.code.is_some())
    }

    fn reveal(
        &mut self,
        ctx: &Ctx,
        item: &wire::LockerItem,
        key: &str,
        copy: bool,
    ) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        let field_id = key.strip_prefix(FIELD).unwrap_or("");
        match shared::reveal(ctx, &item.item_id, key, field_id, copy, 0) {
            Err(Refused::Locked) => self.locked(ctx),
            Err(Refused::Said(sentence)) => {
                self.undo.refuse(sentence);
                Vec::new()
            }
            Ok(Opened { value, life }) if copy => {
                let _ = life;
                self.undo.say(copied_secret(locale, item, key));
                self.secrets.copy(ctx, &value, CLIPBOARD_LIFE)
            }
            Ok(Opened { value, life }) => {
                self.undo.clear();
                let mut effects = self.secrets.hide_all(ctx);
                let seconds = u32::try_from(life.as_secs())
                    .unwrap_or(REVEAL_SECONDS)
                    .clamp(1, REVEAL_SECONDS);
                effects.extend(self.secrets.show(
                    ctx,
                    key,
                    &value,
                    Duration::from_secs(u64::from(seconds)),
                ));
                self.shown = Some(Shown {
                    column: key.to_owned(),
                    seconds_left: seconds,
                    code: None,
                });
                ctx.start_timer(TICK, Duration::from_secs(1));
                effects
            }
        }
    }

    /// The code the seed makes now: shown with its life, or copied.
    fn code(&mut self, ctx: &Ctx, key: &str, copy: bool, follow: bool) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        let id = self.id();
        // The login's own seed, or a one-time-code field's (`field:<id>`).
        let field_id = key.strip_prefix(FIELD).unwrap_or("");
        match shared::totp(ctx, &id, field_id, copy) {
            Err(Refused::Locked) => self.locked(ctx),
            Err(Refused::Said(sentence)) => {
                self.undo.refuse(sentence);
                Vec::new()
            }
            Ok(code) if copy => {
                self.undo.say(words::code_copied(locale));
                self.secrets.copy(
                    ctx,
                    &code.code,
                    Duration::from_secs(u64::from(code.remaining)),
                )
            }
            Ok(code) => {
                self.undo.clear();
                let mut effects = self.secrets.hide_all(ctx);
                // The kit's own hide is the safety net a second past the roll,
                // after the tick that follows it.
                effects.extend(self.secrets.show(
                    ctx,
                    key,
                    &code.code,
                    Duration::from_secs(u64::from(code.remaining) + 1),
                ));
                self.shown = Some(Shown {
                    column: key.to_owned(),
                    seconds_left: code.remaining,
                    code: Some(Code {
                        period: code.period,
                        follow,
                    }),
                });
                ctx.start_timer(TICK, Duration::from_secs(1));
                effects
            }
        }
    }

    /// One second of a revealed value's life; at zero it is concealed — or, for
    /// a code shown first, the next code is asked for once.
    fn tick(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(shown) = &mut self.shown else {
            return Vec::new();
        };
        if self.secrets.value(&shown.column).is_none() {
            self.shown = None;
            return Vec::new();
        }
        shown.seconds_left = shown.seconds_left.saturating_sub(1);
        if shown.seconds_left > 0 {
            ctx.start_timer(TICK, Duration::from_secs(1));
            return Vec::new();
        }
        let follow = shown.code.as_ref().is_some_and(|code| code.follow);
        let column = shown.column.clone();
        self.shown = None;
        let mut effects = self.secrets.hide(ctx, &column);
        if follow {
            effects.extend(self.code(ctx, &column, false, false));
        }
        effects
    }

    // --- actions -------------------------------------------------------------

    fn action(&mut self, ctx: &Ctx, key: &str) -> Vec<wire::Effect> {
        let Some(item) = self.item().cloned() else {
            return Vec::new();
        };
        let id = self.id();
        match key {
            "star" if item.starred => self.submit(
                ctx,
                "unstar-item",
                act::locker::UnstarItem { locker_item_id: id },
                words::unstarred_said,
            ),
            "star" => self.submit(
                ctx,
                "star-item",
                act::locker::StarItem { locker_item_id: id },
                words::starred_said,
            ),
            "archive" if item.archived => self.submit(
                ctx,
                "unarchive-item",
                act::locker::UnarchiveItem { locker_item_id: id },
                words::unarchived_said,
            ),
            "archive" => self.submit(
                ctx,
                "archive-item",
                act::locker::ArchiveItem { locker_item_id: id },
                words::archived_said,
            ),
            "trash" => self.submit(
                ctx,
                "trash-item",
                act::locker::TrashItem { locker_item_id: id },
                |locale| crate::kit::trash::moved_to_trash(locale, &item.title),
            ),
            "restore" => self.submit(
                ctx,
                "restore-item",
                act::locker::RestoreItem { locker_item_id: id },
                words::restored,
            ),
            "add_field" => {
                if !item.trashed {
                    self.open_field(&item, "");
                }
                return Vec::new();
            }
            "remove_passkey" => {
                if item.passkey.is_some() {
                    self.confirming = Some(Confirming::Passkey);
                }
                return Vec::new();
            }
            "purge" => {
                self.confirming = Some(Confirming::Purge);
                return Vec::new();
            }
            // THE ITEM'S OWN SITE, where the member changes the password. The
            // core opens nothing but the address it already stores.
            "change_password" => {
                return change_password_url(&item)
                    .map(|url| {
                        vec![wire::Effect {
                            kind: Some(wire::effect::Kind::OpenUrl(wire::OpenUrl { url })),
                        }]
                    })
                    .unwrap_or_default();
            }
            _ => return Vec::new(),
        };
        self.reload(ctx)
    }

    fn confirmed(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(confirming) = self.confirming.take() else {
            return Vec::new();
        };
        let id = self.id();
        match confirming {
            Confirming::Field => {
                let Some(field_id) = self.field.as_ref().map(|field| field.editing.clone()) else {
                    return Vec::new();
                };
                let settled = self.submit(
                    ctx,
                    "remove-field",
                    act::locker::RemoveField {
                        item_id: id,
                        field_id,
                    },
                    words::field_removed,
                );
                if settled.committed {
                    self.field = None;
                }
            }
            Confirming::Passkey => {
                self.submit(
                    ctx,
                    "clear-passkey",
                    act::locker::ClearPasskey { item_id: id },
                    words::passkey_removed,
                );
            }
            Confirming::Purge => {
                // Erased for good: the core knows no inverse, so the line has no verb.
                self.submit(
                    ctx,
                    "purge-item",
                    act::locker::PurgeItem { locker_item_id: id },
                    words::purged,
                );
            }
        }
        self.reload(ctx)
    }

    // --- the memo and the sheets ---------------------------------------------

    fn memo_saved(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let (Some(item), Some(text)) = (self.item().cloned(), self.memo.clone()) else {
            return Vec::new();
        };
        if text.trim() == item.memo.trim() {
            self.memo = None;
            return Vec::new();
        }
        let id = self.id();
        let settled = self.submit(
            ctx,
            "set-memo",
            act::locker::SetMemo {
                item_id: id,
                note: text,
            },
            words::memo_saved,
        );
        if settled.committed {
            self.memo = None;
        }
        self.reload(ctx)
    }

    fn open_field(&mut self, item: &wire::LockerItem, field_id: &str) {
        let existing = item.fields.iter().find(|field| field.field_id == field_id);
        if !field_id.is_empty() && existing.is_none() {
            return;
        }
        self.field = Some(FieldSheet {
            editing: field_id.to_owned(),
            section: existing
                .map(|field| field.section.clone())
                .unwrap_or_default(),
            label: existing
                .map(|field| field.label.clone())
                .unwrap_or_default(),
            // A SEALED VALUE IS NEVER SHOWN BACK: editing one starts empty.
            value: existing
                .filter(|field| !field.sealed)
                .map(|field| field.value.clone())
                .unwrap_or_default(),
            sealed: existing.is_some_and(|field| field.sealed),
            otp: existing.is_some_and(|field| field.kind == "otp"),
        });
    }

    fn field_saved(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let (Some(item), Some(sheet)) = (self.item().cloned(), self.field.as_ref()) else {
            return Vec::new();
        };
        if sheet.label.trim().is_empty() {
            return Vec::new();
        }
        let existing = item
            .fields
            .iter()
            .find(|field| field.field_id == sheet.editing);
        // A new field's id is minted here, because a sealed value's ciphertext
        // is bound to its row's id and the core seals it before the row exists.
        let Some(field_id) = existing
            .map(|field| field.field_id.clone())
            .or_else(shared::mint_id)
        else {
            return Vec::new();
        };
        let value = if sheet.sealed
            && existing.is_some_and(|field| field.present)
            && sheet.value.is_empty()
        {
            PLACEHOLDER.to_owned()
        } else {
            sheet.value.clone()
        };
        let section = sheet.section.trim().to_owned();
        let position = existing.map_or_else(
            || {
                i64::try_from(
                    item.fields
                        .iter()
                        .filter(|field| field.section == section)
                        .count(),
                )
                .unwrap_or(0)
            },
            |field| field.position,
        );
        let kind = if sheet.otp {
            act::locker::SetFieldKind::Otp
        } else if sheet.sealed {
            act::locker::SetFieldKind::Sealed
        } else {
            act::locker::SetFieldKind::Text
        };
        let label = sheet.label.trim().to_owned();
        let request = act::locker::SetField {
            item_id: item.item_id.clone(),
            kind,
            label,
            field_id: Some(field_id),
            position: Some(position),
            section: Some(section),
            value: Some(value),
        };
        let settled = self.submit(ctx, "set-field", request, words::field_saved);
        if settled.committed {
            self.field = None;
        }
        self.reload(ctx)
    }

    fn passkey_saved(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let (Some(item), Some(name)) = (self.item().cloned(), self.passkey_name.clone()) else {
            return Vec::new();
        };
        let Some(passkey) = item.passkey.clone() else {
            return Vec::new();
        };
        let name = name.trim().to_owned();
        if name == passkey.display_name {
            self.passkey_name = None;
            return Vec::new();
        }
        // RENAME: the passkey's metadata round-trips and its key stays as the
        // placeholder.
        let settled = self.submit(
            ctx,
            "set-passkey",
            act::locker::SetPasskey {
                item_id: item.item_id,
                rp_id: passkey.rp_id,
                algorithm: Some(passkey.algorithm),
                credential_id: Some(passkey.credential_id),
                display_name: Some(name),
                private_key: Some(PLACEHOLDER.to_owned()),
                user_handle: Some(passkey.user_handle),
            },
            words::passkey_renamed,
        );
        if settled.committed {
            self.passkey_name = None;
        }
        self.reload(ctx)
    }

    /// One event of the Linked to section or its picker: a link is written or taken off, and the
    /// page reads again. No link carries a sealed value; the command refuses one.
    fn link_event(&mut self, event: &wire::LinkEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        let Some(item) = self.item().filter(|item| !item.trashed).cloned() else {
            return Vec::new();
        };
        let linked: Vec<String> = item.links.iter().map(|link| link.id.clone()).collect();
        let from = self.id();
        match self.links.update(event, &linked, ctx) {
            Outcome::Add { id, .. } => {
                self.submit(
                    ctx,
                    "add-link",
                    act::locker::AddLink {
                        from,
                        rel: act::locker::AddLinkRel::About,
                        to: id,
                    },
                    link_words::saved,
                );
            }
            Outcome::Remove { id } => {
                let Some(link) = item.links.iter().find(|link| link.id == id) else {
                    return Vec::new();
                };
                let rel = if link.relation == "with" {
                    act::locker::RemoveLinkRel::With
                } else {
                    act::locker::RemoveLinkRel::About
                };
                self.submit(
                    ctx,
                    "remove-link",
                    act::locker::RemoveLink { from, rel, to: id },
                    link_words::removed,
                );
            }
            Outcome::Moved => return Vec::new(),
        }
        self.reload(ctx)
    }

    /// The Linked to section: an account, a place, a person, each row saying which.
    fn link_section(&self, locale: Locale, item: &wire::LockerItem) -> wire::LinkSection {
        let rows = item
            .links
            .iter()
            .map(|link| {
                let meta = match (link.kind.as_str(), link.relation.as_str()) {
                    ("account", _) => link_words::kind_account(locale),
                    ("place", _) => link_words::kind_place(locale),
                    (_, "with") => link_words::kind_with(locale),
                    _ => link_words::kind_person(locale),
                };
                let is_person = link.kind == "person";
                wire::LinkRow {
                    id: link.id.clone(),
                    title: if self.owner_id.as_deref() == Some(link.id.as_str()) {
                        link_words::you(locale)
                    } else {
                        link.title.clone()
                    },
                    meta,
                    route: is_person.then(|| links::person_route(&link.id, &link.title)),
                    remove_label: fill(&link_words::remove(locale), &[("name", &link.title)]),
                    selected: false,
                }
            })
            .collect();
        let mut section = self.links.section(
            locale,
            link_words::section_linked(locale),
            rows,
            String::new(),
        );
        if item.trashed {
            section.adds.clear();
        }
        section
    }

    fn event(&mut self, event: wire::LockerItemEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        match event.kind {
            Some(I::Link(link)) => self.link_event(&link, ctx),
            Some(I::Verb(verb)) => self.verb(ctx, &verb.key, &verb.verb),
            Some(I::Action(action)) => self.action(ctx, &action.key),
            Some(I::Confirmed(_)) => self.confirmed(ctx),
            Some(I::Dismissed(_)) => {
                self.confirming = None;
                Vec::new()
            }
            Some(I::StatusActed(_)) => {
                if self.undo.acted(ctx) {
                    return self.reload(ctx);
                }
                Vec::new()
            }
            Some(I::MemoOpened(_)) => {
                if let Some(item) = self.item().filter(|item| !item.trashed) {
                    self.memo = Some(item.memo.clone());
                }
                Vec::new()
            }
            Some(I::MemoTyped(typed)) => {
                if self.memo.is_some() {
                    self.memo = Some(typed.text);
                }
                Vec::new()
            }
            Some(I::MemoSaved(_)) => self.memo_saved(ctx),
            Some(I::MemoClosed(_)) => {
                self.memo = None;
                Vec::new()
            }
            Some(I::FieldTyped(typed)) => {
                if let Some(sheet) = &mut self.field {
                    match typed.key.as_str() {
                        "section" => sheet.section = typed.value,
                        "label" => sheet.label = typed.value,
                        "value" => sheet.value = typed.value,
                        _ => {}
                    }
                }
                Vec::new()
            }
            // THE KIND IS CHOSEN ONCE, on a new field, as an item's type is.
            Some(I::FieldKind(picked)) => {
                if let Some(sheet) = self.field.as_mut().filter(|sheet| sheet.editing.is_empty()) {
                    match picked.key.as_str() {
                        "text" => sheet.sealed = false,
                        "sealed" => sheet.sealed = true,
                        _ => {}
                    }
                }
                Vec::new()
            }
            Some(I::FieldSaved(_)) => self.field_saved(ctx),
            Some(I::FieldRemoved(_)) => {
                if self
                    .field
                    .as_ref()
                    .is_some_and(|sheet| !sheet.editing.is_empty())
                {
                    self.confirming = Some(Confirming::Field);
                }
                Vec::new()
            }
            Some(I::FieldClosed(_)) => {
                self.field = None;
                Vec::new()
            }
            Some(I::PasskeyNameTyped(typed)) => {
                if self.passkey_name.is_some() {
                    self.passkey_name = Some(typed.text);
                }
                Vec::new()
            }
            Some(I::PasskeyNameSaved(_)) => self.passkey_saved(ctx),
            Some(I::PasskeyNameClosed(_)) => {
                self.passkey_name = None;
                Vec::new()
            }
            Some(I::Refreshed(_)) => self.reload(ctx),
            None => {
                let _ = locale;
                Vec::new()
            }
        }
    }

    // --- views ---------------------------------------------------------------

    fn data(&self, locale: Locale, loaded: &Loaded) -> wire::LockerItemData {
        let Some(item) = &loaded.item else {
            return wire::LockerItemData {
                gone: Some(wire::EmptyState {
                    headline: words::item_gone(locale),
                    body: words::item_gone_body(locale),
                    ..wire::EmptyState::default()
                }),
                ..wire::LockerItemData::default()
            };
        };
        let kind = types::of(&item.r#type);
        let mut chips = Vec::new();
        if item.compromised {
            chips.push(chip(
                words::chip_compromised(locale),
                wire::status_chip::Tone::Net,
            ));
        }
        if item.archived {
            chips.push(chip(
                words::chip_archived(locale),
                wire::status_chip::Tone::Seam,
            ));
        }
        if item.trashed {
            chips.push(chip(
                words::chip_trashed(locale),
                wire::status_chip::Tone::Seam,
            ));
        }
        // THE VERIFICATION CODE IS ITS OWN CARD, first on the page; the type's
        // other fields follow under the type's word.
        let (code, own): (Vec<_>, Vec<_>) = self
            .own(locale, item)
            .into_iter()
            .partition(|row| row.key == SEED);
        let mut sections = vec![
            wire::LockerSection {
                title: String::new(),
                rows: code,
                note: String::new(),
            },
            wire::LockerSection {
                title: (kind.label)(locale),
                rows: own,
                note: String::new(),
            },
        ];
        if !item.addresses.is_empty() {
            sections.push(wire::LockerSection {
                title: words::addresses_head(locale),
                rows: item
                    .addresses
                    .iter()
                    .map(|address| {
                        plain_row(
                            &format!("address:{}", address.address_id),
                            words::address(locale),
                            &address.url,
                            open_copy(locale),
                        )
                    })
                    .collect(),
                note: String::new(),
            });
        }
        self.custom_sections(locale, item, &mut sections);
        if let Some(passkey) = &item.passkey {
            sections.push(passkey_section(locale, passkey, item.trashed));
        }
        sections.push(wire::LockerSection {
            title: words::details_head(locale),
            rows: details(locale, item),
            note: String::new(),
        });
        sections.retain(|section| !section.rows.is_empty());
        let actions = if item.trashed {
            vec![
                action("restore", words::restore(locale), false),
                action("purge", kit_words::trash_purge(locale), true),
            ]
        } else {
            let mut actions = vec![
                action("add_field", words::field_add(locale), false),
                action(
                    "star",
                    if item.starred {
                        words::unstar(locale)
                    } else {
                        words::star(locale)
                    },
                    false,
                ),
                action(
                    "archive",
                    if item.archived {
                        words::unarchive(locale)
                    } else {
                        words::archive(locale)
                    },
                    false,
                ),
            ];
            if item.passkey.is_some() {
                actions.push(action(
                    "remove_passkey",
                    words::passkey_remove(locale),
                    true,
                ));
            }
            actions.push(action("trash", words::trash(locale), true));
            actions
        };
        wire::LockerItemData {
            links: Some(self.link_section(locale, item)),
            earlier: self.earlier.entry.clone(),
            origin: self.earlier.origin.clone(),
            title: item.title.clone(),
            type_chip: kind.chip(locale),
            hero_initial: types::initial(&item.title),
            subtitle: subtitle(locale, &(kind.label)(locale), item, &loaded.today),
            starred: item.starred,
            star_label: if item.starred {
                words::item_starred(locale)
            } else {
                String::new()
            },
            chips,
            status_line: if item.secrets.iter().any(|secret| secret.present) {
                words::item_status(locale)
            } else {
                String::new()
            },
            sections,
            tags: item.tags.clone(),
            tags_label: if item.tags.is_empty() {
                String::new()
            } else {
                words::tags(locale)
            },
            memo: item.memo.clone(),
            memo_label: words::memo_title(locale),
            memo_action: if item.trashed {
                String::new()
            } else if item.memo.is_empty() {
                words::memo_add(locale)
            } else {
                words::memo_edit(locale)
            },
            actions,
            gone: None,
            change_password: change_password_url(item)
                .map(|_| action("change_password", words::change_password(locale), false)),
            trashed_note: if item.trashed {
                fill(
                    &words::trashed_note(locale),
                    &[("day", &day_words(locale, &item.purge_local_day))],
                )
            } else {
                String::new()
            },
        }
    }

    /// The type's own fields, in the order a member reads them.
    fn own(&self, locale: Locale, item: &wire::LockerItem) -> Vec<wire::LockerFieldRow> {
        types::of(&item.r#type)
            .columns
            .iter()
            .filter_map(|column| {
                let secret = item.secrets.iter().find(|secret| secret.column == *column);
                match secret {
                    Some(secret) if secret.present => Some(if *column == SEED {
                        self.code_row(locale, SEED, words::verification_code(locale), &[])
                    } else {
                        self.sealed_row(locale, column, types::label(locale, column), &[])
                    }),
                    Some(_) => None,
                    None => plain_value(item, column)
                        .filter(|value| !value.is_empty())
                        .map(|value| {
                            plain_row(
                                column,
                                types::label(locale, column),
                                &value,
                                if *column == "url" {
                                    open_copy(locale)
                                } else {
                                    copy_only(locale)
                                },
                            )
                        }),
                }
            })
            .collect()
    }

    fn custom_sections(
        &self,
        locale: Locale,
        item: &wire::LockerItem,
        sections: &mut Vec<wire::LockerSection>,
    ) {
        let editable = !item.trashed;
        let mut order: Vec<String> = Vec::new();
        for field in &item.fields {
            let title = if field.section.is_empty() {
                words::fields_head(locale)
            } else {
                field.section.clone()
            };
            if !order.contains(&title) {
                order.push(title);
            }
        }
        for title in order {
            let rows = item
                .fields
                .iter()
                .filter(|field| {
                    let own = if field.section.is_empty() {
                        words::fields_head(locale)
                    } else {
                        field.section.clone()
                    };
                    own == title && (field.present || editable)
                })
                .map(|field| {
                    let key = format!("{FIELD}{}", field.field_id);
                    let edit = if editable {
                        vec![verb("edit", words::edit(locale))]
                    } else {
                        Vec::new()
                    };
                    if field.kind == "otp" && field.present {
                        self.code_row(locale, &key, field.label.clone(), &edit)
                    } else if field.sealed && field.present {
                        self.sealed_row(locale, &key, field.label.clone(), &edit)
                    } else if field.sealed {
                        wire::LockerFieldRow {
                            key,
                            label: field.label.clone(),
                            note: words::field_empty(locale),
                            verbs: edit,
                            accessibility_label: format!(
                                "{}, {}",
                                field.label,
                                words::field_empty(locale)
                            ),
                            ..wire::LockerFieldRow::default()
                        }
                    } else {
                        let mut verbs = if field.value.is_empty() {
                            Vec::new()
                        } else {
                            copy_only(locale)
                        };
                        verbs.extend(edit);
                        plain_row(&key, field.label.clone(), &field.value, verbs)
                    }
                })
                .collect();
            sections.push(wire::LockerSection {
                title,
                rows,
                note: String::new(),
            });
        }
    }

    /// A SEALED VALUE'S ROW — an item cell, or a custom field: the mask with
    /// Reveal and Copy (and `more`, a field's Edit), revealed with Copy and
    /// Conceal and its countdown.
    fn sealed_row(
        &self,
        locale: Locale,
        key: &str,
        label: String,
        more: &[wire::LockerVerb],
    ) -> wire::LockerFieldRow {
        if let (Some(value), Some(shown)) = (
            self.secrets.value(key),
            self.shown.as_ref().filter(|shown| shown.column == key),
        ) {
            return wire::LockerFieldRow {
                key: key.to_owned(),
                label: label.clone(),
                value: value.to_owned(),
                sealed: true,
                revealed: true,
                note: fill(
                    &words::revealed_note(locale),
                    &[("seconds", &shown.seconds_left.to_string())],
                ),
                verbs: vec![
                    verb("copy", words::copy(locale)),
                    verb("conceal", words::conceal(locale)),
                ],
                accessibility_label: format!("{label}, {}", words::revealed(locale)),
                monospace: true,
                ..wire::LockerFieldRow::default()
            };
        }
        let mut verbs = vec![
            verb("reveal", words::reveal(locale)),
            verb("copy", words::copy(locale)),
        ];
        verbs.extend(more.iter().cloned());
        wire::LockerFieldRow {
            key: key.to_owned(),
            label: label.clone(),
            sealed: true,
            mask: DOTS.to_owned(),
            note: words::sealed_note(locale),
            verbs,
            accessibility_label: format!("{label}, {}", words::sealed(locale)),
            monospace: true,
            ..wire::LockerFieldRow::default()
        }
    }

    /// A ONE-TIME CODE'S ROW: the code, grouped, with its seconds and a
    /// countdown while shown; a mask with Show code and Copy code otherwise.
    fn code_row(
        &self,
        locale: Locale,
        key: &str,
        label: String,
        more: &[wire::LockerVerb],
    ) -> wire::LockerFieldRow {
        if let (Some(code), Some(shown)) = (self.secrets.value(key), self.shown_code(key)) {
            let grouped = if code.chars().count() == 6 {
                format!(
                    "{} {}",
                    code.chars().take(3).collect::<String>(),
                    code.chars().skip(3).collect::<String>()
                )
            } else {
                code.to_owned()
            };
            return wire::LockerFieldRow {
                key: key.to_owned(),
                label: label.clone(),
                value: grouped.clone(),
                sealed: true,
                revealed: true,
                note: fill(
                    &words::code_note(locale),
                    &[("seconds", &shown.seconds_left.to_string())],
                ),
                verbs: vec![
                    verb("copy_code", words::copy(locale)),
                    verb("conceal", words::conceal(locale)),
                ],
                accessibility_label: format!("{label}, {grouped}"),
                monospace: true,
                countdown: Some(wire::LockerCountdown {
                    seconds_left: shown.seconds_left,
                    period: shown.code.as_ref().map_or(0, |code| code.period),
                }),
                ..wire::LockerFieldRow::default()
            };
        }
        wire::LockerFieldRow {
            key: key.to_owned(),
            label: label.clone(),
            sealed: true,
            mask: CODE_MASK.to_owned(),
            note: words::otp_note(locale),
            verbs: {
                let mut verbs = vec![
                    verb("code", words::show_code(locale)),
                    verb("copy_code", words::copy_code(locale)),
                ];
                verbs.extend(more.iter().cloned());
                verbs
            },
            accessibility_label: format!("{label}, {}", words::sealed(locale)),
            monospace: true,
            ..wire::LockerFieldRow::default()
        }
    }

    fn confirm(&self, locale: Locale) -> Option<wire::Confirm> {
        Some(match self.confirming? {
            Confirming::Purge => wire::Confirm {
                title: crate::kit::trash::purge_title(locale, kit_words::trash_noun_item),
                body: crate::kit::trash::purge_body(locale, Some(words::purge_lead)),
                confirm_label: kit_words::trash_purge(locale),
                destructive: true,
            },
            Confirming::Field => wire::Confirm {
                title: words::field_remove_title(locale),
                body: words::field_remove_body(locale),
                confirm_label: words::field_remove(locale),
                destructive: true,
            },
            Confirming::Passkey => wire::Confirm {
                title: words::passkey_remove_title(locale),
                body: words::passkey_remove_body(locale),
                confirm_label: words::passkey_remove(locale),
                destructive: true,
            },
        })
    }

    fn memo_sheet(&self, locale: Locale) -> Option<wire::LockerMemoSheet> {
        self.memo.as_ref().map(|text| wire::LockerMemoSheet {
            title: words::memo_title(locale),
            text: text.clone(),
            hint: words::memo_hint(locale),
            save_label: words::save(locale),
            cancel_label: words::cancel(locale),
        })
    }

    fn passkey_sheet(&self, locale: Locale) -> Option<wire::LockerMemoSheet> {
        self.passkey_name
            .as_ref()
            .map(|text| wire::LockerMemoSheet {
                title: words::passkey_rename_title(locale),
                text: text.clone(),
                hint: words::passkey_rename_hint(locale),
                save_label: words::save(locale),
                cancel_label: words::cancel(locale),
            })
    }

    fn field_sheet(&self, locale: Locale) -> Option<wire::LockerFieldSheet> {
        let sheet = self.field.as_ref()?;
        let new = sheet.editing.is_empty();
        let present = !new
            && self
                .item()
                .and_then(|item| {
                    item.fields
                        .iter()
                        .find(|field| field.field_id == sheet.editing)
                })
                .is_some_and(|field| field.present);
        let label = sheet.label.trim();
        Some(wire::LockerFieldSheet {
            title: if new {
                words::field_new_title(locale)
            } else {
                words::field_edit_title(locale)
            },
            section_label: words::field_section(locale),
            section: sheet.section.clone(),
            section_hint: words::field_section_hint(locale),
            label_label: words::field_label(locale),
            label: sheet.label.clone(),
            label_hint: words::field_label_hint(locale),
            kind_label: if new {
                words::kind(locale)
            } else {
                String::new()
            },
            kinds: if new {
                vec![
                    choice("text", words::field_kind_text(locale), !sheet.sealed),
                    choice("sealed", words::field_kind_sealed(locale), sheet.sealed),
                ]
            } else {
                Vec::new()
            },
            value_label: words::field_value(locale),
            value: sheet.value.clone(),
            value_hint: if sheet.sealed && present {
                words::kept_sealed(locale)
            } else {
                String::new()
            },
            secret: sheet.sealed,
            value_note: if sheet.sealed && present {
                words::kept_sealed(locale)
            } else if sheet.sealed {
                words::field_sealed_on_save(locale)
            } else {
                words::field_text_note(locale)
            },
            save_label: words::field_save(locale),
            cancel_label: words::cancel(locale),
            remove_label: if new {
                String::new()
            } else {
                words::field_remove(locale)
            },
            can_save: !label.is_empty(),
            blocked: if label.is_empty() {
                words::field_label_missing(locale)
            } else {
                String::new()
            },
        })
    }
}

fn chip(label: String, tone: wire::status_chip::Tone) -> wire::StatusChip {
    wire::StatusChip {
        label,
        tone: tone as i32,
    }
}

fn choice(key: &str, label: String, selected: bool) -> wire::LockerChoice {
    wire::LockerChoice {
        key: key.to_owned(),
        label,
        selected,
    }
}

fn action(key: &str, label: String, destructive: bool) -> wire::LockerAction {
    wire::LockerAction {
        key: key.to_owned(),
        label,
        destructive,
    }
}

fn verb(key: &str, label: String) -> wire::LockerVerb {
    wire::LockerVerb {
        key: key.to_owned(),
        label,
        // THE VERIFICATION CODE'S COPY is the card's one pill, as the board draws it.
        pill: key == "copy_code",
    }
}

fn copy_only(locale: Locale) -> Vec<wire::LockerVerb> {
    vec![verb("copy", words::copy(locale))]
}

fn open_copy(locale: Locale) -> Vec<wire::LockerVerb> {
    vec![
        verb("open", words::open(locale)),
        verb("copy", words::copy(locale)),
    ]
}

fn plain_row(
    key: &str,
    label: String,
    value: &str,
    verbs: Vec<wire::LockerVerb>,
) -> wire::LockerFieldRow {
    wire::LockerFieldRow {
        key: key.to_owned(),
        label: label.clone(),
        value: value.to_owned(),
        verbs,
        accessibility_label: format!("{label}, {value}"),
        ..wire::LockerFieldRow::default()
    }
}

/// THE HERO'S SECOND LINE: the type's word, then when a secret was last opened
/// ("Login · last used today"), or that none ever was.
fn subtitle(locale: Locale, kind: &str, item: &wire::LockerItem, today: &str) -> String {
    if item.trashed {
        return kind.to_owned();
    }
    if item.last_used_local_day.len() >= 10 {
        let day = &item.last_used_local_day[..10];
        let when = if day == today {
            words::used_today(locale)
        } else {
            civil::day_month(locale, day)
        };
        fill(
            &words::item_last_used(locale),
            &[("type", kind), ("when", &when)],
        )
    } else {
        fill(&words::item_never_used(locale), &[("type", kind)])
    }
}

fn day_words(locale: Locale, day: &str) -> String {
    if day.len() >= 10 {
        civil::day_month(locale, day)
    } else {
        String::new()
    }
}

fn day_row(locale: Locale, key: &str, label: String, day: &str) -> Option<wire::LockerFieldRow> {
    (day.len() >= 10).then(|| {
        let words = civil::day_month(locale, day);
        wire::LockerFieldRow {
            key: key.to_owned(),
            label: label.clone(),
            value: words.clone(),
            accessibility_label: format!("{label}, {words}"),
            ..wire::LockerFieldRow::default()
        }
    })
}

/// WHEN THE CORE LAST OPENED ONE OF THE ITEM'S SECRETS (#1146), or that it never
/// has. Always a row: "never" is an answer a member acts on (an old login nobody
/// has opened is one to retire), where a missing row reads as a missing fact.
fn last_used_row(locale: Locale, item: &wire::LockerItem) -> Option<wire::LockerFieldRow> {
    let label = words::last_used(locale);
    let value = if item.last_used_local_day.len() >= 10 {
        civil::day_month(locale, &item.last_used_local_day)
    } else {
        words::last_used_never(locale)
    };
    Some(wire::LockerFieldRow {
        key: "last_used".to_owned(),
        accessibility_label: format!("{label}, {value}"),
        label,
        value,
        ..wire::LockerFieldRow::default()
    })
}

fn details(locale: Locale, item: &wire::LockerItem) -> Vec<wire::LockerFieldRow> {
    [
        (!item.alias.is_empty()).then(|| wire::LockerFieldRow {
            key: "alias".to_owned(),
            label: words::alias(locale),
            value: item.alias.clone(),
            ..wire::LockerFieldRow::default()
        }),
        day_row(
            locale,
            "password_set",
            words::password_set(locale),
            &item.password_set_local_day,
        ),
        day_row(
            locale,
            "created",
            words::created(locale),
            &item.created_local_day,
        ),
        day_row(
            locale,
            "updated",
            words::updated(locale),
            &item.updated_local_day,
        ),
        last_used_row(locale, item),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// THE PASSKEY SLOT (L-passkey): its metadata, a Rename on its name, and its
/// key as a mask with no verb — storage only, never shown or copied.
fn passkey_section(
    locale: Locale,
    passkey: &wire::LockerPasskey,
    trashed: bool,
) -> wire::LockerSection {
    let name = if passkey.display_name.is_empty() {
        words::passkey_unnamed(locale)
    } else {
        passkey.display_name.clone()
    };
    let mut rows = vec![plain_row(
        "passkey:rp",
        words::passkey_site(locale),
        &passkey.rp_id,
        copy_only(locale),
    )];
    if !passkey.user_handle.is_empty() {
        rows.push(plain_row(
            "passkey:user",
            words::passkey_user(locale),
            &passkey.user_handle,
            copy_only(locale),
        ));
    }
    rows.push(wire::LockerFieldRow {
        key: "passkey:name".to_owned(),
        label: words::passkey_name(locale),
        value: name.clone(),
        verbs: if trashed {
            Vec::new()
        } else {
            vec![verb("rename", words::passkey_rename(locale))]
        },
        accessibility_label: format!("{}, {name}", words::passkey_name(locale)),
        ..wire::LockerFieldRow::default()
    });
    rows.extend(day_row(
        locale,
        "passkey:created",
        words::created(locale),
        &passkey.created_local_day,
    ));
    rows.push(wire::LockerFieldRow {
        key: "passkey:key".to_owned(),
        label: words::passkey_key(locale),
        sealed: passkey.has_private_key,
        mask: if passkey.has_private_key {
            DOTS.to_owned()
        } else {
            String::new()
        },
        value: if passkey.has_private_key {
            String::new()
        } else {
            words::passkey_no_key(locale)
        },
        note: words::passkey_note(locale),
        accessibility_label: format!(
            "{}, {}",
            words::passkey_key(locale),
            words::passkey_note(locale)
        ),
        ..wire::LockerFieldRow::default()
    });
    wire::LockerSection {
        title: words::passkey_head(locale),
        rows,
        note: String::new(),
    }
}

/// Whether `key` names a one-time-code field of this item, whose row makes codes and never
/// shows its seed.
fn is_code_field(item: &wire::LockerItem, key: &str) -> bool {
    key.strip_prefix(FIELD).is_some_and(|id| {
        item.fields
            .iter()
            .any(|field| field.field_id == id && field.kind == "otp")
    })
}

/// Whether `key` names a sealed value this item holds: one of its cells, or a
/// sealed field.
fn stored_secret(item: &wire::LockerItem, key: &str) -> bool {
    match key.strip_prefix(FIELD) {
        Some(id) => item
            .fields
            .iter()
            .any(|field| field.field_id == id && field.sealed && field.present),
        None => item
            .secrets
            .iter()
            .any(|secret| secret.column == key && secret.present),
    }
}

/// A plain (metadata) value by its key.
fn plain_value(item: &wire::LockerItem, key: &str) -> Option<String> {
    let own = match key {
        "username" => Some(&item.username),
        "url" => Some(&item.url),
        "notes" => Some(&item.notes),
        "cardholder" => Some(&item.cardholder),
        "expiry" => Some(&item.expiry),
        "brand" => Some(&item.brand),
        "fullname" => Some(&item.fullname),
        "email" => Some(&item.email),
        "phone" => Some(&item.phone),
        "address" => Some(&item.address),
        "network" => Some(&item.network),
        _ => None,
    };
    if let Some(value) = own {
        return Some(value.clone());
    }
    if let Some(id) = key.strip_prefix("address:") {
        return item
            .addresses
            .iter()
            .find(|address| address.address_id == id)
            .map(|address| address.url.clone());
    }
    if let Some(id) = key.strip_prefix(FIELD) {
        return item
            .fields
            .iter()
            .find(|field| field.field_id == id && !field.sealed)
            .map(|field| field.value.clone());
    }
    (key == "passkey:rp")
        .then(|| item.passkey.as_ref().map(|passkey| passkey.rp_id.clone()))
        .flatten()
}

/// Where a login's password is changed: its own address, opened as a link. A
/// trashed item, a type with no address and an empty address have none. The
/// item's `url` column leads; its first extra address is the fallback.
#[must_use]
pub fn change_password_url(item: &wire::LockerItem) -> Option<String> {
    if item.trashed || item.r#type != "login" {
        return None;
    }
    let stored = item.url.trim();
    let address = if stored.is_empty() {
        item.addresses
            .iter()
            .map(|address| address.url.trim())
            .find(|url| !url.is_empty())?
    } else {
        stored
    };
    Some(openable(address))
}

/// A stored address as a link the OS can open: one with no scheme is https.
fn openable(url: &str) -> String {
    if url.contains("://") {
        url.to_owned()
    } else {
        format!("https://{url}")
    }
}

/// A copied sealed value's sentence, naming a custom field by its own label.
fn copied_secret(locale: Locale, item: &wire::LockerItem, key: &str) -> String {
    let label = match key.strip_prefix(FIELD) {
        Some(id) => item
            .fields
            .iter()
            .find(|field| field.field_id == id)
            .map_or_else(|| words::field_value(locale), |field| field.label.clone()),
        None => types::label(locale, key),
    };
    fill(&words::copied_secret(locale), &[("field", &label)])
}

impl Screen for Item {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                let step = self.wall.appeared(ctx, false);
                let mut effects = self.walled(ctx, step);
                // The session may be open already: read what it opens.
                if self.wall.is_open() && matches!(self.loaded, Phase::Loading) {
                    effects.extend(self.reload(ctx));
                    effects.extend(self.followed(ctx));
                }
                effects
            }
            Some(E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                // THE EDITOR ABOVE CLOSED: its "Item saved" and Undo are drawn here.
                self.undo.take_handed(ctx);
                if self.wall.is_open() {
                    self.reload(ctx)
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
            Some(E::LockerItem(item)) => {
                if !self.wall.is_open() {
                    let step = self.wall.recheck(ctx);
                    return self.walled(ctx, step);
                }
                self.event(item, ctx)
            }
            Some(E::EffectResult(result)) => {
                self.secrets.answered(ctx, &result);
                let step = self.wall.answered(ctx, &result);
                self.walled(ctx, step)
            }
            Some(E::TimerFired(fired)) if fired.timer == TICK => self.tick(ctx),
            Some(E::TimerFired(fired)) => {
                let effects = self.secrets.fired(&fired.timer);
                if self.shown.as_ref().is_some_and(|shown| {
                    self.secrets.value(&shown.column).is_none() && shown.code.is_none()
                }) {
                    self.shown = None;
                }
                effects
            }
            // LEAVING CONCEALS: nothing revealed outlives the screen, and a
            // sheet with a typed secret goes with it.
            Some(E::StatusActed(_)) => {
                if self.undo.acted(ctx) {
                    return self.reload(ctx);
                }
                Vec::new()
            }
            Some(E::Left(_)) => {
                self.undo.clear();
                self.secrets.conceal();
                self.shown = None;
                self.field = None;
                self.passkey_name = None;
                self.confirming = None;
                // A pending unlock is dropped, and its prompt taken down.
                let step = self.wall.left();
                self.walled(ctx, step)
            }
            Some(E::TabHidden(_)) => {
                let step = self.wall.hidden();
                self.walled(ctx, step)
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let open = self.wall.is_open();
        let item = self.item();
        let content = open.then(|| match &self.loaded {
            Phase::Loading => {
                wire::locker_item_state::Content::Loading(wire::Loading { first_load: true })
            }
            Phase::Failed => wire::locker_item_state::Content::Failure(read::failure(locale)),
            Phase::Denied(denial) => {
                wire::locker_item_state::Content::Denied(shared::denied(locale, denial))
            }
            Phase::Ready(loaded) => {
                wire::locker_item_state::Content::Data(Box::new(self.data(locale, loaded)))
            }
        });
        let status = self.undo.status().or_else(|| self.earlier.status(locale));
        wire::ViewState {
            kind: Some(wire::view_state::Kind::LockerItem(Box::new(
                wire::LockerItemState {
                    wall: self.wall.view(locale),
                    secure: open,
                    item_id: self.route.item_id.clone(),
                    content,
                    confirm: self.confirm(locale),
                    status,
                    chrome: Some(wire::LockerItemChrome {
                        title: item.map(|item| item.title.clone()).unwrap_or_default(),
                        back_label: if self.route.parent.is_empty() {
                            words::app_name(locale)
                        } else {
                            self.route.parent.clone()
                        },
                        edit_label: if item.is_some_and(|item| !item.trashed) {
                            words::edit(locale)
                        } else {
                            String::new()
                        },
                        edit_route: item
                            .filter(|item| !item.trashed)
                            .map(|item| routes::edit(&item.item_id)),
                        retry: words::retry(locale),
                        menu_label: words::more_actions(locale),
                    }),
                    memo: self.memo_sheet(locale),
                    field_sheet: self.field_sheet(locale),
                    passkey_name: self.passkey_sheet(locale),
                    link_picker: Some(
                        self.links.picker(
                            locale,
                            &item
                                .map(|item| {
                                    item.links.iter().map(|l| l.id.clone()).collect::<Vec<_>>()
                                })
                                .unwrap_or_default(),
                        ),
                    ),
                    finished: false,
                },
            ))),
            ..wire::ViewState::default()
        }
    }
}
