//! ADD OR EDIT AN ITEM (#1047) — with an EXPLICIT SAVE (R-1047-L5): a secret
//! saved on a pause mid-typing is a wrong secret, so this editor is the kit's
//! exception to autosave, for the same reason Money's editor is.
//!
//! **The draft is sent whole** (`locker.edit-item` REWRITES the type's columns,
//! it does not patch them): every plain field as typed, and every secret either
//! as typed or — left empty over a stored one — as the vault's placeholder,
//! which means "leave it alone". The core seals what was typed before the vault
//! sees it; nothing here holds `K` or ciphertext, and the typed secret lives in
//! this struct only until the save commits, the editor closes, or the Locker
//! relocks.
//!
//! **The compromised flag** (R-1047-F7) is a toggle row the member sets on a
//! leaked secret, so Review lists the item for changing; nothing else produces
//! it. It is sent only when it CHANGED from what the vault holds, so an edit
//! that leaves it alone and carries a new password lets the vault's rule clear
//! it (a rotation answers the flag), and the row's note says so as it happens.
//!
//! **A one-time-code seed** is the setup key or the `otpauth://` link a site
//! showed (Q-1047-16). It is checked here with the app crate's own rule
//! (`totp::seed_of`) so a refusal is said on the field; the core reads it again
//! and seals it as base32.
//!
//! **The tags are the vault's** (#1135): the words that changed are `tag.add`
//! and `tag.remove`, run after the item itself commits, never a field of the
//! item's command.

use std::collections::{BTreeMap, BTreeSet};

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::locker_editor_event::Kind as K;
use wire::screen_event::Kind as E;

use super::generator::{self, Entropy, system_entropy};
use super::handoff;
use super::item::PLACEHOLDER;
use super::shared::{self, Phase};
use super::types::{self, SEED};
use super::wall::{Change, Wall};
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, locker as words};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::LockerEditor(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Editor::new(args.clone(), system_entropy())))
}

/// A factory whose generate draws from `entropy`; tests inject a fixed stream.
pub fn build_with(
    entropy: impl Fn() -> Entropy + Send + Sync + 'static,
) -> impl Fn(&wire::Route) -> Option<Box<dyn Screen>> + Send + Sync + 'static {
    move |route| {
        let Some(wire::route::Args::LockerEditor(args)) = &route.args else {
            return None;
        };
        Some(Box::new(Editor::new(args.clone(), entropy())) as Box<dyn Screen>)
    }
}

/// What the member is typing.
#[derive(Clone, PartialEq, Eq)]
struct Form {
    type_id: String,
    /// `title` and the type's columns, as typed.
    values: BTreeMap<String, String>,
    tags: String,
    compromised: bool,
}

impl Form {
    fn blank(type_id: &str) -> Self {
        Self {
            type_id: type_id.to_owned(),
            values: BTreeMap::new(),
            tags: String::new(),
            compromised: false,
        }
    }

    fn value(&self, key: &str) -> &str {
        self.values.get(key).map_or("", String::as_str)
    }
}

struct Editor {
    route: wire::LockerEditorRoute,
    wall: Wall,
    entropy: Entropy,
    item_id: String,
    adding: bool,
    /// The item as the vault holds it, on EDIT.
    stored: Phase<wire::LockerItem>,
    form: Option<Form>,
    confirm_discard: bool,
    finished: bool,
    status: Option<wire::StatusLine>,
}

impl Editor {
    fn new(route: wire::LockerEditorRoute, entropy: Entropy) -> Self {
        let adding = route.mode != wire::LockerEditorMode::Edit as i32;
        Self {
            item_id: route.item_id.clone(),
            adding,
            route,
            wall: Wall::default(),
            entropy,
            stored: Phase::Loading,
            form: None,
            confirm_discard: false,
            finished: false,
            status: None,
        }
    }

    // --- the form --------------------------------------------------------------

    fn item(&self) -> Option<&wire::LockerItem> {
        self.stored.data()
    }

    fn stored_columns(&self) -> BTreeSet<String> {
        self.item()
            .map(|item| {
                item.secrets
                    .iter()
                    .filter(|secret| secret.present)
                    .map(|secret| secret.column.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn stored_flag(&self) -> bool {
        !self.adding && self.item().is_some_and(|item| item.compromised)
    }

    /// The form of a new item: the type's, empty — or carrying the generator's
    /// candidate as its password.
    fn fresh_form(&self) -> Form {
        let type_id = if types::creatable().any(|kind| kind.id == self.route.r#type) {
            self.route.r#type.as_str()
        } else {
            "login"
        };
        let mut form = Form::blank(type_id);
        if self.route.from_generator
            && let Some(password) = handoff::take()
        {
            form.values.insert("password".to_owned(), password);
        }
        form
    }

    fn form_of(item: &wire::LockerItem) -> Form {
        let mut form = Form::blank(&item.r#type);
        form.values.insert("title".to_owned(), item.title.clone());
        for column in types::of(&item.r#type).columns {
            if !types::is_secret(column) {
                let value = match *column {
                    "username" => &item.username,
                    "url" => &item.url,
                    "notes" => &item.notes,
                    "cardholder" => &item.cardholder,
                    "expiry" => &item.expiry,
                    "brand" => &item.brand,
                    "fullname" => &item.fullname,
                    "email" => &item.email,
                    "phone" => &item.phone,
                    "address" => &item.address,
                    "network" => &item.network,
                    _ => continue,
                };
                form.values.insert((*column).to_owned(), value.clone());
            }
        }
        form.tags = item.tags.join(", ");
        form.compromised = item.compromised;
        form
    }

    /// The baseline a "changed?" compares with.
    fn baseline(&self) -> Option<Form> {
        if self.adding {
            self.form.as_ref().map(|form| Form::blank(&form.type_id))
        } else {
            self.item().map(Self::form_of)
        }
    }

    fn dirty(&self) -> bool {
        let (Some(form), Some(base)) = (&self.form, self.baseline()) else {
            return false;
        };
        let typed = |form: &Form| -> Vec<(String, String)> {
            let mut pairs: Vec<_> = form
                .values
                .iter()
                .filter(|(_, value)| !value.is_empty())
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            pairs.sort();
            pairs
        };
        typed(form) != typed(&base)
            || form.tags != base.tags
            || form.compromised != base.compromised
    }

    // --- reads -------------------------------------------------------------------

    fn open(&mut self, ctx: &Ctx) {
        if !self.wall.is_open() || self.finished {
            return;
        }
        if self.adding {
            if self.form.is_none() {
                self.form = Some(self.fresh_form());
            }
            if self.item_id.is_empty() {
                self.item_id = shared::mint_id().unwrap_or_default();
            }
            return;
        }
        // A FORM ALREADY ON SCREEN IS THE MEMBER'S, and a re-read never replaces
        // what they typed.
        let reading = read::read(
            ctx,
            load::locker::Item {
                item_id: self.item_id.clone(),
            },
            |answer| match answer {
                Answer::LockerItem(detail) => Some(detail.item),
                _ => None,
            },
        );
        match reading {
            Reading::Data(Some(item)) => {
                if self.form.is_none() {
                    self.form = Some(Self::form_of(&item));
                }
                self.stored = Phase::Ready(item);
            }
            // The item is gone: nothing to edit.
            Reading::Data(None) | Reading::Failed => self.stored = Phase::Failed,
            Reading::Denied(denial) => self.stored = Phase::Denied(denial),
        }
    }

    // --- a wall step ---------------------------------------------------------------

    fn walled(&mut self, ctx: &Ctx, step: super::wall::Step) -> Vec<wire::Effect> {
        match step.change {
            Change::Opened => self.open(ctx),
            // A RELOCK CLOSES THE EDITOR. What was typed is gone — a secret
            // typed and not saved does not survive the Locker closing — and the
            // shell pops it.
            Change::Closed => {
                self.form = None;
                self.stored = Phase::Loading;
                self.finished = true;
            }
            Change::None => {}
        }
        step.effects
    }

    // --- events ---------------------------------------------------------------------

    fn edited(&mut self, change: impl FnOnce(&mut Form)) {
        if let Some(form) = &mut self.form {
            change(form);
            self.status = None;
        }
    }

    fn event(&mut self, event: wire::LockerEditorEvent, ctx: &Ctx) {
        match event.kind {
            Some(K::Type(picked)) => {
                if self.adding
                    && let Some(form) = &mut self.form
                    && types::creatable().any(|kind| kind.id == picked.key)
                {
                    // WHAT CARRIES ACROSS A TYPE IS WHAT THE NEW TYPE HAS: a
                    // login's password becomes the Wi-Fi's; its username goes,
                    // as the vault would drop it.
                    let mut next = Form::blank(&picked.key);
                    let kept: Vec<&str> = std::iter::once("title")
                        .chain(types::of(&picked.key).columns.iter().copied())
                        .collect();
                    for (key, value) in &form.values {
                        if kept.contains(&key.as_str()) {
                            next.values.insert(key.clone(), value.clone());
                        }
                    }
                    next.tags = form.tags.clone();
                    next.compromised = form.compromised;
                    *form = next;
                }
            }
            Some(K::Typed(typed)) => self.edited(|form| {
                form.values.insert(typed.key, typed.value);
            }),
            Some(K::Tags(tags)) => self.edited(|form| form.tags = tags.text),
            Some(K::Compromised(toggled)) => self.edited(|form| form.compromised = toggled.on),
            Some(K::Generate(generate)) => {
                if generate.key == "password"
                    && let Some(password) = generator::password(&self.entropy)
                {
                    self.edited(|form| {
                        form.values.insert("password".to_owned(), password);
                    });
                }
            }
            Some(K::Save(_)) => self.save(ctx),
            Some(K::Cancel(_)) => {
                if self.dirty() {
                    self.confirm_discard = true;
                } else {
                    self.close();
                }
            }
            Some(K::Confirmed(_)) => self.close(),
            Some(K::Dismissed(_)) => self.confirm_discard = false,
            Some(K::Refreshed(_)) => self.open(ctx),
            None => {}
        }
    }

    /// CLOSED IS EMPTY: the typed draft does not outlive the editor.
    fn close(&mut self) {
        self.confirm_discard = false;
        self.form = None;
        self.finished = true;
    }

    // --- validation ---------------------------------------------------------------------

    /// Why Save is not enabled, in the member's words; empty when it is.
    fn blocked(&self, locale: Locale) -> String {
        let Some(form) = &self.form else {
            return String::new();
        };
        if form.value("title").trim().is_empty() {
            return words::title_needed(locale);
        }
        self.seed_refusal(locale, form).unwrap_or_default()
    }

    fn seed_refusal(&self, _locale: Locale, form: &Form) -> Option<String> {
        let seed = form.value(SEED);
        if seed.trim().is_empty() || !types::of(&form.type_id).columns.contains(&SEED) {
            return None;
        }
        centraid_apps_locker::totp::seed_of(seed)
            .err()
            .map(|refusal| refusal.sentence().to_owned())
    }

    // --- the save ----------------------------------------------------------------------------

    fn save(&mut self, ctx: &Ctx) {
        let locale = ctx.locale();
        let Some(form) = self.form.clone() else {
            return;
        };
        if !self.blocked(locale).is_empty() || self.item_id.is_empty() {
            return;
        }
        let stored = self.stored_columns();
        let columns = types::of(&form.type_id).columns;
        // A secret left empty over a stored one means "leave it alone".
        let sent = |key: &str| -> String {
            let value = form.value(key);
            if types::is_secret(key) && value.is_empty() && stored.contains(key) {
                PLACEHOLDER.to_owned()
            } else {
                value.to_owned()
            }
        };
        let some = |key: &str| -> Option<String> { columns.contains(&key).then(|| sent(key)) };
        // SENT ONLY WHEN CHANGED: restating a held flag would pin it over the
        // vault's rule that a new password clears it (R-1047-F7).
        let compromised = (form.compromised != self.stored_flag()).then_some(form.compromised);
        let title = form.value("title").trim().to_owned();
        let key = kit_act::key(&["save-item", &self.item_id], kit_act::fresh());
        let settled = if self.adding {
            let mut request = act::locker::AddItem {
                title,
                r#type: add_type(&form.type_id),
                item_id: Some(self.item_id.clone()),
                compromised,
                ..act::locker::AddItem::default()
            };
            request.address = some("address").filter(|v| !v.is_empty());
            request.brand = some("brand").filter(|v| !v.is_empty());
            request.card_number = some("card_number").filter(|v| !v.is_empty());
            request.cardholder = some("cardholder").filter(|v| !v.is_empty());
            request.content = some("content").filter(|v| !v.is_empty());
            request.cvv = some("cvv").filter(|v| !v.is_empty());
            request.email = some("email").filter(|v| !v.is_empty());
            request.expiry = some("expiry").filter(|v| !v.is_empty());
            request.fullname = some("fullname").filter(|v| !v.is_empty());
            request.network = some("network").filter(|v| !v.is_empty());
            request.notes = some("notes").filter(|v| !v.is_empty());
            request.otp_seed = some("otp_seed").filter(|v| !v.is_empty());
            request.password = some("password").filter(|v| !v.is_empty());
            request.phone = some("phone").filter(|v| !v.is_empty());
            request.url = some("url").filter(|v| !v.is_empty());
            request.username = some("username").filter(|v| !v.is_empty());
            kit_act::act(ctx, request, &key)
        } else {
            let request = act::locker::EditItem {
                item_id: self.item_id.clone(),
                title: Some(title),
                compromised,
                address: some("address"),
                brand: some("brand"),
                card_number: some("card_number"),
                cardholder: some("cardholder"),
                content: some("content"),
                cvv: some("cvv"),
                email: some("email"),
                expiry: some("expiry"),
                fullname: some("fullname"),
                network: some("network"),
                notes: some("notes"),
                otp_seed: some("otp_seed"),
                password: some("password"),
                phone: some("phone"),
                url: some("url"),
                username: some("username"),
                ..act::locker::EditItem::default()
            };
            kit_act::act(ctx, request, &key)
        };
        if !settled.committed {
            self.status = shared::refused(settled.refusal);
            return;
        }
        // THE ITEM IS SAVED; ITS TAGS FOLLOW, one write at a time, the editor
        // open until the last.
        if !self.save_tags(ctx, &form) {
            return;
        }
        self.close();
    }

    /// The vault's `tag.add` and `tag.remove` that make the item's tags the
    /// typed ones. False on the first refusal, said on the form.
    fn save_tags(&mut self, ctx: &Ctx, form: &Form) -> bool {
        let typed = words_of(&form.tags);
        let had: Vec<String> = if self.adding {
            Vec::new()
        } else {
            self.item()
                .map(|item| item.tags.clone())
                .unwrap_or_default()
        };
        let kept: BTreeSet<String> = typed.iter().map(|tag| tag.to_lowercase()).collect();
        let before: BTreeSet<String> = had.iter().map(|tag| tag.to_lowercase()).collect();
        let id = self.item_id.clone();
        for tag in had.iter().filter(|tag| !kept.contains(&tag.to_lowercase())) {
            let key = kit_act::key(&["remove-tag", &id, tag], kit_act::fresh());
            let settled = kit_act::act(
                ctx,
                act::locker::RemoveTag {
                    locker_item_id: id.clone(),
                    label: tag.clone(),
                },
                &key,
            );
            if !settled.committed {
                self.status = shared::refused(settled.refusal);
                return false;
            }
        }
        for tag in typed
            .iter()
            .filter(|tag| !before.contains(&tag.to_lowercase()))
        {
            let key = kit_act::key(&["add-tag", &id, tag], kit_act::fresh());
            let settled = kit_act::act(
                ctx,
                act::locker::AddTag {
                    locker_item_id: id.clone(),
                    label: tag.clone(),
                },
                &key,
            );
            if !settled.committed {
                self.status = shared::refused(settled.refusal);
                return false;
            }
        }
        true
    }

    // --- the view --------------------------------------------------------------------------------

    fn data(&self, locale: Locale, form: &Form) -> wire::LockerEditorData {
        let stored = self.stored_columns();
        let seed_refusal = self.seed_refusal(locale, form);
        let mut keys = vec!["title"];
        keys.extend(types::of(&form.type_id).columns.iter().copied());
        let inputs = keys
            .into_iter()
            .map(|key| {
                let value = form.value(key);
                let secret = types::is_secret(key);
                let note = match key {
                    "password" if !value.is_empty() => {
                        generator::strength(locale, generator::typed_bits(value))
                    }
                    SEED if seed_refusal.is_some() => seed_refusal.clone().unwrap_or_default(),
                    SEED if !value.trim().is_empty() => words::sealed_on_save(locale),
                    _ if secret && stored.contains(key) && value.is_empty() => {
                        words::kept_sealed(locale)
                    }
                    SEED => words::otp_hint(locale),
                    _ if secret => words::sealed_on_save(locale),
                    _ => String::new(),
                };
                wire::LockerInputRow {
                    key: key.to_owned(),
                    label: types::label(locale, key),
                    value: value.to_owned(),
                    placeholder: match key {
                        "url" => words::placeholder_url(locale),
                        "expiry" => words::placeholder_expiry(locale),
                        "email" => words::placeholder_email(locale),
                        _ => String::new(),
                    },
                    secret,
                    kind: input_kind(key) as i32,
                    note,
                    generate_label: if key == "password" {
                        words::generate(locale)
                    } else {
                        String::new()
                    },
                }
            })
            .collect();
        let blocked = self.blocked(locale);
        let typed_password = !form.value("password").is_empty();
        wire::LockerEditorData {
            types: if self.adding {
                types::creatable()
                    .map(|kind| wire::LockerChoice {
                        key: kind.id.to_owned(),
                        label: (kind.label)(locale),
                        selected: kind.id == form.type_id,
                        detail: String::new(),
                    })
                    .collect()
            } else {
                Vec::new()
            },
            types_label: if self.adding {
                words::item_type(locale)
            } else {
                String::new()
            },
            inputs,
            tags_label: words::tags(locale),
            tags_text: form.tags.clone(),
            tags_hint: words::tags_hint(locale),
            can_save: blocked.is_empty(),
            blocked,
            compromised_label: words::compromised_toggle(locale),
            compromised: form.compromised,
            compromised_note: if !types::of(&form.type_id).columns.contains(&"password") {
                words::compromised_note_no_password(locale)
            } else if self.stored_flag() && form.compromised && typed_password {
                words::compromised_clears(locale)
            } else {
                words::compromised_note(locale)
            },
        }
    }
}

fn words_of(tags: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    tags.split(',')
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .filter(|tag| seen.insert((*tag).to_owned()))
        .map(str::to_owned)
        .collect()
}

fn input_kind(key: &str) -> wire::locker_input_row::Kind {
    use wire::locker_input_row::Kind as I;
    match key {
        "url" => I::Url,
        "email" => I::Email,
        "phone" => I::Phone,
        "card_number" | "cvv" => I::Number,
        "notes" | "content" | "address" => I::Multiline,
        _ => I::Text,
    }
}

fn add_type(id: &str) -> act::locker::AddItemType {
    use act::locker::AddItemType as T;
    match id {
        "card" => T::Card,
        "note" => T::Note,
        "identity" => T::Identity,
        "wifi" => T::Wifi,
        "password" => T::Password,
        _ => T::Login,
    }
}

impl Screen for Editor {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                let step = self.wall.appeared(ctx, false);
                let effects = self.walled(ctx, step);
                if self.wall.is_open() && self.form.is_none() {
                    self.open(ctx);
                }
                effects
            }
            // THE FORM IS THE MEMBER'S: a change event never re-reads it (its
            // own save's commit is one), and a new item has nothing to read.
            Some(E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                if self.wall.is_open() {
                    Vec::new()
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
            Some(E::LockerEditor(editor)) => {
                if self.wall.is_open() {
                    self.event(editor, ctx);
                }
                Vec::new()
            }
            Some(E::EffectResult(result)) => {
                let step = self.wall.answered(ctx, &result);
                self.walled(ctx, step)
            }
            Some(E::Left(_)) => {
                self.form = None;
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let open = self.wall.is_open();
        let content = open.then(|| match (&self.form, &self.stored) {
            (Some(form), _) => {
                wire::locker_editor_state::Content::Data(Box::new(self.data(locale, form)))
            }
            (None, Phase::Failed) => {
                wire::locker_editor_state::Content::Failure(read::failure(locale))
            }
            (None, Phase::Denied(denial)) => {
                wire::locker_editor_state::Content::Denied(shared::denied(locale, denial))
            }
            (None, _) => {
                wire::locker_editor_state::Content::Loading(wire::Loading { first_load: true })
            }
        });
        wire::ViewState {
            kind: Some(wire::view_state::Kind::LockerEditor(
                wire::LockerEditorState {
                    wall: self.wall.view(locale),
                    secure: open,
                    mode: if self.adding {
                        wire::LockerEditorMode::Add as i32
                    } else {
                        wire::LockerEditorMode::Edit as i32
                    },
                    item_id: self.item_id.clone(),
                    content,
                    confirm: self.confirm_discard.then(|| wire::Confirm {
                        title: words::discard_title(locale),
                        body: words::discard_body(locale),
                        confirm_label: words::discard(locale),
                        destructive: true,
                    }),
                    chrome: Some(wire::LockerEditorChrome {
                        title: if self.adding {
                            words::add_title(locale)
                        } else {
                            words::edit_title(locale)
                        },
                        save_label: words::save(locale),
                        cancel_label: words::cancel(locale),
                        lede: words::editor_lede(locale),
                        retry: words::retry(locale),
                    }),
                    finished: self.finished,
                    status: self.status.clone(),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
