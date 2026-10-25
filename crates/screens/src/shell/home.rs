//! HOME, THE GRADED SPRINGBOARD (#1135): the screen every other screen is reached
//! through. It reads one tile per app through that app's own named query
//! ([`tiles`]), grades the grid as a whole ([`policy`]), words every tile and
//! the lockup, and carries the route each tile opens.
//!
//! ## Home reads synchronously and grades once
//!
//! A tile is no longer an event: `ctx.load` answers in the same call, so every
//! tile lands in one pass and the grid is graded from all eight at once. A tile
//! that is refused is `UNKNOWN`, never `EMPTY` (see [`tiles`]); the other seven
//! still draw.
//!
//! ## What the shell tells Home, and what Home decides
//!
//! The shell holds the vault files (which vaults the phone holds, which is in
//! front), the backup line and a stranded write's ribbon. It TELLS Home those as
//! events and Home records them as given: it sorts nothing, drops no vault out of
//! the roster and does not decide that a vault it cannot identify is not there. A
//! vault change (a different id in front) throws away every tile, because each
//! was read out of the vault just left and re-labelling them under a new name
//! would be content attributed to the wrong vault. The first lockup is not a
//! change.
//!
//! A tile's tap and the search key are routes the shell pushes; a press on the
//! lockup, the switcher and the appearance key are events. What the switcher
//! asks of the shelf (switch, make, restore, forget, rename) leaves as one
//! [`wire::VaultCommand`] effect.
//!
//! ## No vault is a failed Home, not a loading one
//!
//! A phone that holds no vault has nothing for a tile to read: Home says so in a
//! sentence and draws no empty tiles.

use centraid_api_proto::core_v1 as wire;
use wire::home_event::Kind as H;
use wire::screen_event::Kind as E;

use super::policy;
use super::routes;
use super::row_routes;
use super::tiles::{self, Made};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, home as words, photos};

/// The Keychain key the member's appearance is kept under: a per-phone habit,
/// not a vault row.
const APPEARANCE_KEY: &str = "appearance";

/// The member's light or dark choice.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
enum Appearance {
    /// Follow the phone.
    #[default]
    System,
    Light,
    Dark,
}

impl Appearance {
    fn of(stored: &str) -> Self {
        match stored.trim() {
            "light" => Self::Light,
            "dark" => Self::Dark,
            _ => Self::System,
        }
    }

    /// What is written: nothing for "follow the phone".
    fn stored(self) -> &'static str {
        match self {
            Self::System => "",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    /// Whether the app is dark right now.
    fn dark(self, phone_dark: bool) -> bool {
        match self {
            Self::System => phone_dark,
            Self::Light => false,
            Self::Dark => true,
        }
    }

    /// The choice the key makes: the other of the two. A choice that lands where
    /// the phone already is goes back to following it.
    fn toggled(self, phone_dark: bool) -> Self {
        let to_dark = !self.dark(phone_dark);
        if to_dark == phone_dark {
            Self::System
        } else if to_dark {
            Self::Dark
        } else {
            Self::Light
        }
    }
}

/// The step after a vault was picked in the sheet.
enum Ask {
    None,
    Forget {
        vault_id: String,
    },
    Rename {
        vault_id: String,
        name: String,
        failed: bool,
    },
}

struct Home {
    /// One per app, in [`policy::ORDER`].
    tiles: Vec<(String, Made)>,
    read: bool,
    /// The one in front, the roster in the shelf's order, and whether the phone
    /// holds none: all told.
    vault: Option<wire::ShellVault>,
    vaults: Vec<wire::ShellVault>,
    none: bool,
    backup: Option<wire::HomeBackupLine>,
    status: Option<wire::HomeStatus>,
    sheet_open: bool,
    ask: Ask,
    outcome: String,
    appearance: Appearance,
    phone_dark: bool,
}

/// The registry factory.
#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    Some(Box::new(Home {
        tiles: policy::ORDER
            .iter()
            .map(|app| ((*app).to_owned(), tiles::loading()))
            .collect(),
        read: false,
        vault: None,
        vaults: Vec::new(),
        none: false,
        backup: None,
        status: None,
        sheet_open: false,
        ask: Ask::None,
        outcome: String::new(),
        appearance: Appearance::System,
        phone_dark: false,
    }))
}

fn effect(kind: wire::effect::Kind) -> wire::Effect {
    wire::Effect { kind: Some(kind) }
}

fn command(kind: wire::vault_command::Kind) -> wire::Effect {
    effect(wire::effect::Kind::VaultCommand(wire::VaultCommand {
        kind: Some(kind),
    }))
}

fn select(tab: &str) -> wire::Effect {
    effect(wire::effect::Kind::SelectTab(wire::SelectTab {
        tab: tab.to_owned(),
    }))
}

/// The Backup place: the runtime selects the `backup` tab, which the standard
/// runtime registers (`backup::routes::home`). Opening it twice is a no-op.
fn open_backup() -> Vec<wire::Effect> {
    vec![select(super::band::BACKUP)]
}

impl Home {
    /// Read every tile, in one pass. Nothing to read on a phone with no vault.
    fn reload(&mut self, ctx: &Ctx) {
        self.read = true;
        if self.none {
            return;
        }
        self.tiles = policy::ORDER
            .iter()
            .map(|app| ((*app).to_owned(), tiles::read(ctx, app)))
            .collect();
    }

    /// A different vault in front: every tile was read out of the one just left.
    ///
    /// By id when both lockups have one, because two vaults may share a display
    /// name and a member who founded "Personal" twice is not a member whose
    /// switch should silently do nothing. By name when they do not, because an
    /// unidentified lockup is still a lockup, and treating every gateway or
    /// reachability update as a switch would reload Home on a flicker. The FIRST
    /// lockup is no switch: a Home that knew no vault was not looking at another.
    fn vault_changed(&self, told: &wire::home_event::VaultsTold) -> bool {
        let (Some(before), Some(after)) = (self.vault.as_ref(), told.vault.as_ref()) else {
            return false;
        };
        if !before.vault_id.is_empty() && !after.vault_id.is_empty() {
            before.vault_id != after.vault_id
        } else {
            before.name != after.name
        }
    }

    fn vault_named(&self, vault_id: &str) -> Option<&wire::ShellVault> {
        self.vaults.iter().find(|vault| vault.vault_id == vault_id)
    }

    fn on_home(&mut self, event: H, ctx: &Ctx) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        match event {
            H::Backup(_) => return open_backup(),
            H::Status(_) => return self.status_pressed(),
            H::Appearance(_) => {
                self.appearance = self.appearance.toggled(self.phone_dark);
                return vec![keychain_set(self.appearance.stored())];
            }
            H::PhoneSchemeTold(told) => self.phone_dark = told.dark,
            H::Vault(_) => self.sheet_open = true,
            H::VaultPicked(picked) => {
                self.sheet_open = false;
                self.ask = Ask::None;
                // Choosing the vault already open is a dismissal and nothing else:
                // re-opening the same file would throw away every tile that had
                // landed, to arrive back at the same rows.
                let open = self.vault.as_ref().map(|vault| vault.vault_id.as_str());
                if !picked.vault_id.is_empty() && open != Some(picked.vault_id.as_str()) {
                    return vec![command(wire::vault_command::Kind::SwitchTo(
                        picked.vault_id,
                    ))];
                }
            }
            H::SheetClosed(_) => {
                self.sheet_open = false;
                self.ask = Ask::None;
            }
            H::Shown(_) => self.reload(ctx),
            H::Make(_) => {
                self.outcome.clear();
                return vec![command(wire::vault_command::Kind::Make(true))];
            }
            H::Restore(_) => {
                self.outcome.clear();
                return vec![command(wire::vault_command::Kind::Restore(true))];
            }
            H::ForgetAsked(asked) => {
                self.ask = Ask::Forget {
                    vault_id: asked.vault_id,
                };
            }
            H::RenameAsked(asked) => {
                // A vault that moved is read-only and offers no rename.
                if let Some(vault) = self
                    .vault_named(&asked.vault_id)
                    .filter(|vault| vault.state() != wire::HomeVaultState::Frozen)
                {
                    self.ask = Ask::Rename {
                        vault_id: asked.vault_id.clone(),
                        name: vault.name.clone(),
                        failed: false,
                    };
                }
            }
            H::RenameTyped(typed) => {
                if let Ask::Rename { name, failed, .. } = &mut self.ask {
                    *name = typed.name;
                    *failed = false;
                }
            }
            H::AskConfirmed(_) => return self.ask_confirmed(),
            H::AskDismissed(_) => self.ask = Ask::None,
            H::VaultsTold(told) => {
                let switched = self.vault_changed(&told);
                let was_none = self.none;
                self.vault = told.vault.clone();
                self.vaults = told.vaults;
                self.none = told.none;
                if switched {
                    self.sheet_open = false;
                    self.ask = Ask::None;
                    self.tiles = policy::ORDER
                        .iter()
                        .map(|app| ((*app).to_owned(), tiles::loading()))
                        .collect();
                }
                // Founding a vault leaves the failed Home (its tiles ask to be read),
                // and a switch reads again; any other change of roster or lockup
                // leaves the tiles as read.
                if switched || !self.read || was_none != self.none {
                    self.reload(ctx);
                }
            }
            H::BackupTold(told) => self.backup = told.line,
            H::StatusTold(told) => self.status = told.status,
            H::OutcomeTold(told) => {
                self.outcome = told.status_line;
                if told.rename_failed {
                    if let Ask::Rename { failed, .. } = &mut self.ask {
                        *failed = true;
                    } else {
                        self.outcome = words::vaults_rename_failed(locale);
                    }
                }
            }
        }
        Vec::new()
    }

    fn status_pressed(&self) -> Vec<wire::Effect> {
        use wire::home_status::Destination as D;
        let Some(status) = &self.status else {
            return Vec::new();
        };
        match status.destination() {
            D::Backup => open_backup(),
            D::Phone | D::Notifications => {
                vec![command(wire::vault_command::Kind::Open(status.destination))]
            }
            D::Unspecified | D::None => Vec::new(),
        }
    }

    fn ask_confirmed(&mut self) -> Vec<wire::Effect> {
        match std::mem::replace(&mut self.ask, Ask::None) {
            Ask::None => Vec::new(),
            Ask::Forget { vault_id } => {
                self.sheet_open = false;
                vec![command(wire::vault_command::Kind::Forget(vault_id))]
            }
            Ask::Rename {
                vault_id,
                name,
                failed,
            } => {
                let name = name.trim().to_owned();
                if name.is_empty() {
                    // Nothing to save: the sheet stays.
                    self.ask = Ask::Rename {
                        vault_id,
                        name,
                        failed,
                    };
                    return Vec::new();
                }
                vec![command(wire::vault_command::Kind::Rename(
                    wire::vault_command::Rename { vault_id, name },
                ))]
            }
        }
    }

    // -- the view -------------------------------------------------------------

    fn dress(&self, locale: Locale, app: &str, made: &Made) -> wire::HomeTile {
        let name = app_name(locale, app);
        let open = fill(&words::open_app(locale), &[("name", &name)]);
        wire::HomeTile {
            app_id: app.to_owned(),
            name,
            status: made.status as i32,
            count: made.count,
            count_label: made.count_label.clone(),
            size: policy::size_of(app) as i32,
            wide: policy::is_wide(app),
            empty_copy: empty_copy(locale, app),
            body: made
                .body
                .clone()
                .map(|kind| wire::HomeTileBody { kind: Some(kind) }),
            accessibility_label: spoken(&open, made),
            open_label: open,
            route: tile_route(app, made),
        }
    }

    fn data(&self, locale: Locale) -> wire::HomeData {
        let tiles: Vec<wire::HomeTile> = self
            .tiles
            .iter()
            .map(|(app, made)| self.dress(locale, app, made))
            .collect();
        let springboard = policy::springboard(&tiles);
        wire::HomeData {
            springboard: springboard as i32,
            grid_rows: policy::rows(&tiles),
            every_tile_unreadable: policy::every_tile_unreadable(&tiles),
            day_one_title: words::home_day_one_title(locale),
            day_one_body: words::home_day_one_body(locale),
            tiles,
        }
    }

    fn bar(&self, locale: Locale) -> wire::HomeBar {
        let dark = self.appearance.dark(self.phone_dark);
        let vault = match &self.vault {
            Some(vault) => finish_vault(locale, vault),
            None => wire::HomeVault {
                name: photos::vault_none_yet(locale),
                initial: initial_of(&photos::vault_none_yet(locale)),
                accessibility_label: photos::vault_none_yet(locale),
                ..Default::default()
            },
        };
        // The backup's status stands in the line only for a vault that has not
        // moved: a moved vault says so itself.
        let backup = self
            .backup
            .clone()
            .filter(|_| vault.state() != wire::HomeVaultState::Frozen);
        wire::HomeBar {
            vault: Some(vault),
            backup,
            search_label: words::home_search_placeholder(locale),
            search_route: Some(routes::search()),
            transfer_rules_label: photos::transfer_settings_label(locale),
            appearance_icon: if dark { "Sun" } else { "Moon" }.to_owned(),
            appearance_label: if dark {
                words::appearance_to_light(locale)
            } else {
                words::appearance_to_dark(locale)
            },
            switch_spoken: words::vault_switch_spoken(locale),
            backup_open_spoken: words::backup_status_open(locale),
        }
    }

    fn sheet(&self, locale: Locale) -> Option<wire::HomeVaultSheet> {
        if !self.sheet_open {
            return None;
        }
        let ask = match &self.ask {
            Ask::None => None,
            Ask::Forget { vault_id } => {
                let named = self
                    .vault_named(vault_id)
                    .map(|vault| vault.name.trim().to_owned())
                    .unwrap_or_default();
                let name = if named.is_empty() {
                    words::vaults_forget_this(locale)
                } else {
                    named
                };
                Some(wire::HomeVaultAsk {
                    kind: Some(wire::home_vault_ask::Kind::Forget(
                        wire::home_vault_ask::Forget {
                            vault_id: vault_id.clone(),
                            title: fill(&words::vaults_forget_title(locale), &[("name", &name)]),
                            body: words::vaults_forget_body(locale),
                            confirm_label: words::vaults_forget(locale),
                            cancel_label: crate::strings::shared::kit_cancel(locale),
                        },
                    )),
                })
            }
            Ask::Rename {
                vault_id,
                name,
                failed,
            } => Some(wire::HomeVaultAsk {
                kind: Some(wire::home_vault_ask::Kind::Rename(
                    wire::home_vault_ask::Rename {
                        vault_id: vault_id.clone(),
                        title: words::vaults_rename_title(locale),
                        field_label: words::vaults_rename_field(locale),
                        name: name.clone(),
                        save_label: words::vaults_rename_save(locale),
                        can_save: !name.trim().is_empty(),
                        failure: if *failed {
                            words::vaults_rename_failed(locale)
                        } else {
                            String::new()
                        },
                    },
                )),
            }),
        };
        let open = self.vault.as_ref().map(|vault| vault.vault_id.clone());
        Some(wire::HomeVaultSheet {
            title: words::vaults_title(locale),
            // ONE VAULT keeps the sentence (switching is not a choice of one, but
            // forgetting still is). Zero never reaches this sheet: a phone with
            // none opens onto the way to make one.
            one_line: if self.vaults.len() == 1 {
                words::vaults_one(locale)
            } else {
                String::new()
            },
            // THE ROSTER IS DRAWN AS THE SHELF LISTS IT: the order is the shelf's.
            vaults: self
                .vaults
                .iter()
                .map(|vault| finish_vault(locale, vault))
                .collect(),
            active_vault_id: open.unwrap_or_default(),
            current_label: words::vaults_current(locale),
            make_label: words::vaults_make(locale),
            make_spoken: words::vaults_make_spoken(locale),
            restore_label: words::restore_first_action(locale),
            forget_label: words::vaults_forget(locale),
            rename_label: words::vaults_rename(locale),
            ask,
            status_line: self.outcome.clone(),
        })
    }
}

impl Screen for Home {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                self.reload(ctx);
                // The appearance is a per-phone habit kept in the Keychain.
                return vec![keychain_get()];
            }
            Some(E::DataChanged(_) | E::EnvironmentChanged(_) | E::Lifecycle(_)) => {
                self.reload(ctx);
            }
            Some(E::EffectResult(result)) => {
                if let Some(wire::effect_result::Outcome::Keychain(value)) = result.outcome {
                    self.appearance = if value.found {
                        Appearance::of(&String::from_utf8_lossy(&value.value))
                    } else {
                        Appearance::System
                    };
                }
            }
            Some(E::Home(home)) => {
                if let Some(kind) = home.kind {
                    return self.on_home(kind, ctx);
                }
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::home_state::Content;
        let locale = ctx.locale();
        let content = if self.none {
            Content::Failure(wire::Failure {
                sentence: words::home_no_vault(locale),
                remedy: String::new(),
            })
        } else if self.read {
            Content::Data(Box::new(self.data(locale)))
        } else {
            Content::Loading(wire::Loading { first_load: true })
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Home(Box::new(wire::HomeState {
                bar: Some(self.bar(locale)),
                status: self.status.clone(),
                content: Some(content),
                sheet: self.sheet(locale),
                scheme: match self.appearance {
                    Appearance::System => wire::HomeScheme::System,
                    Appearance::Light => wire::HomeScheme::Light,
                    Appearance::Dark => wire::HomeScheme::Dark,
                } as i32,
                loading_label: words::home_loading(locale),
            }))),
            ..wire::ViewState::default()
        }
    }
}

/// WHERE A TILE'S TAP GOES: the app's home. Notes opens its shelf when it has
/// notes and a new note when it has none, and nothing while it is unread; a tile
/// that is still reading opens nothing.
fn tile_route(app: &str, made: &Made) -> Option<wire::Route> {
    use wire::HomeTileStatus as Status;
    match (app, made.status) {
        (_, Status::Loading) => None,
        ("notes", Status::Empty) => Some(crate::notes::routes::new_note()),
        ("notes", Status::Unknown) => None,
        _ => row_routes::app_home(app),
    }
}

fn keychain_get() -> wire::Effect {
    effect(wire::effect::Kind::Keychain(wire::KeychainOp {
        op: wire::keychain_op::Op::Get as i32,
        key: APPEARANCE_KEY.to_owned(),
        value: Vec::new(),
    }))
}

fn keychain_set(value: &str) -> wire::Effect {
    effect(wire::effect::Kind::Keychain(wire::KeychainOp {
        op: wire::keychain_op::Op::Set as i32,
        key: APPEARANCE_KEY.to_owned(),
        value: value.as_bytes().to_vec(),
    }))
}

fn app_name(locale: Locale, app: &str) -> String {
    match app {
        "agenda" => words::app_agenda(locale),
        "docs" => words::app_docs(locale),
        "health" => words::app_health(locale),
        "locker" => words::app_locker(locale),
        "money" => words::app_money(locale),
        "notes" => words::app_notes(locale),
        "people" => words::app_people(locale),
        "photos" => words::app_photos(locale),
        other => other.to_owned(),
    }
}

/// What an empty tile says to do.
fn empty_copy(locale: Locale, app: &str) -> String {
    match app {
        "agenda" => words::tile_empty_agenda(locale),
        "docs" => words::tile_empty_docs(locale),
        "health" => words::tile_empty_health(locale),
        "locker" => words::tile_empty_locker(locale),
        "money" => words::tile_empty_money(locale),
        "notes" => words::tile_empty_notes(locale),
        "people" => words::tile_empty_people(locale),
        "photos" => words::tile_empty_photos(locale),
        _ => String::new(),
    }
}

/// "Open Photos, 812 photos": what a screen reader says for the tile. Health
/// speaks its figure and line; a tile with a count speaks it, and a capped one
/// says `812+`.
fn spoken(open: &str, made: &Made) -> String {
    use wire::home_tile_body::Kind;
    let said = match (&made.body, made.count) {
        (Some(Kind::Health(health)), _) => [
            [health.figure.as_str(), health.caption.as_str()]
                .iter()
                .filter(|part| !part.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join(" "),
            health.line.clone(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", "),
        (_, None) => made.count_label.clone(),
        (_, Some(count)) if count.capped => format!("{}+ {}", count.value, made.count_label),
        (_, Some(count)) => format!("{} {}", count.value, made.count_label),
    };
    let said = said.trim();
    if said.is_empty() {
        open.to_owned()
    } else {
        format!("{open}, {said}")
    }
}

fn initial_of(name: &str) -> String {
    name.trim()
        .chars()
        .next()
        .map(|c| c.to_uppercase().collect())
        .unwrap_or_default()
}

/// A vault, finished for the lockup and the switcher.
fn finish_vault(locale: Locale, vault: &wire::ShellVault) -> wire::HomeVault {
    let trimmed = vault.name.trim();
    let name = if trimmed.is_empty() {
        words::vaults_unnamed(locale)
    } else {
        trimmed.to_owned()
    };
    let state = vault.state();
    wire::HomeVault {
        vault_id: vault.vault_id.clone(),
        initial: initial_of(&name),
        accessibility_label: name.clone(),
        name,
        color: vault.color.clone(),
        state: state as i32,
        state_line: match state {
            wire::HomeVaultState::Online => photos::vault_online(locale),
            wire::HomeVaultState::Frozen => photos::vault_moved(locale),
            wire::HomeVaultState::Unspecified => String::new(),
        },
        originals_withheld: vault.originals_withheld,
        originals_line: match vault.originals_withheld {
            0 => String::new(),
            1 => photos::transfer_original_waiting_one(locale),
            n => fill(
                &photos::transfer_original_waiting_many(locale),
                &[("count", &n.to_string())],
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_appearance_key_goes_to_the_other_scheme_and_back_to_following() {
        // On a light phone: following -> dark -> following (light is the phone's).
        let a = Appearance::System.toggled(false);
        assert_eq!(a, Appearance::Dark);
        assert_eq!(a.toggled(false), Appearance::System);
        // On a dark phone: following -> light -> following.
        let b = Appearance::System.toggled(true);
        assert_eq!(b, Appearance::Light);
        assert_eq!(b.toggled(true), Appearance::System);
        // A held scheme that disagrees with the phone flips to the other held one.
        assert_eq!(Appearance::Dark.toggled(true), Appearance::Light);
        assert_eq!(Appearance::Light.toggled(false), Appearance::Dark);
    }

    #[test]
    fn a_tile_opens_its_app_and_notes_opens_a_new_note_when_it_holds_none() {
        use wire::HomeTileStatus as Status;
        let made = |status| Made {
            status,
            count: None,
            count_label: String::new(),
            body: None,
        };
        let screen = |app: &str, status| tile_route(app, &made(status)).map(|route| route.screen);
        assert_eq!(
            screen("notes", Status::Content).as_deref(),
            Some("notes.home")
        );
        assert_eq!(
            screen("notes", Status::Empty).as_deref(),
            Some("notes.editor")
        );
        // Nothing while it reads, or when it could not.
        assert_eq!(screen("notes", Status::Loading), None);
        assert_eq!(screen("notes", Status::Unknown), None);
        // Every other app opens even when it is empty or unreadable.
        assert_eq!(
            screen("agenda", Status::Empty).as_deref(),
            Some("agenda.home")
        );
        assert_eq!(
            screen("photos", Status::Unknown).as_deref(),
            Some("photos.home")
        );
        assert_eq!(screen("photos", Status::Loading), None);
    }

    #[test]
    fn the_stored_appearance_round_trips_and_an_unknown_one_follows_the_phone() {
        for a in [Appearance::Light, Appearance::Dark] {
            assert_eq!(Appearance::of(a.stored()), a);
        }
        assert_eq!(Appearance::of(""), Appearance::System);
        assert_eq!(Appearance::of("sepia"), Appearance::System);
    }

    #[test]
    fn a_vault_is_worded_from_its_facts() {
        let vault = wire::ShellVault {
            vault_id: "v1".into(),
            name: "  ".into(),
            state: wire::HomeVaultState::Frozen as i32,
            originals_withheld: 3,
            ..Default::default()
        };
        let finished = finish_vault(Locale::En, &vault);
        assert_eq!(finished.name, "Unnamed vault");
        assert_eq!(finished.initial, "U");
        assert_eq!(finished.state_line, "Moved to your other phone");
        assert_eq!(finished.originals_line, "3 originals waiting for Wi-Fi");
        let one = finish_vault(
            Locale::En,
            &wire::ShellVault {
                originals_withheld: 1,
                name: "Home".into(),
                ..Default::default()
            },
        );
        assert_eq!(one.originals_line, "1 original waiting for Wi-Fi");
        assert_eq!(one.initial, "H");
    }
}
