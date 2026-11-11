//! SETTINGS (#1173): the appearance the member chooses, where the vault, the backup and the
//! recovery key stand, and the version.
//!
//! | Section | What it holds |
//! |---|---|
//! | Appearance | System, Light or Dark: one choice, kept in the Keychain under the key Home reads |
//! | Units | Phone's setting, Metric or Imperial: one switch for every app, kept on the phone ([`quantity::set_op`]); Phone's setting (nothing stored) follows the region |
//! | Vault | how many vaults this phone holds; a tap opens Home's vault switcher |
//! | Backup | the one honest line ([`crate::backup::line`]) and the Backup page behind it; "Export everything", every app but Locker as one archive ([`super::export`]) |
//! | Recovery key | where the key is ([`crate::backup::key`]) and the page that shows it |
//! | About | the version |
//!
//! **The appearance has one store.** Home's key `appearance` holds `""`, `"light"` or `"dark"`;
//! Settings writes the same three values to the same key and, once the Keychain says it stuck,
//! wakes Home, which draws the scheme it names. There is no second copy to drift.
//!
//! **No refused save is silent.** Every row that writes is a [`Row`], and each names its own
//! "Couldn't save your <thing>. Try again." sentence; [`Settings::refuse`] shows it on the status
//! line, the old value stays selected, and the next pick or visit clears it.
//!
//! The pages the rows open are Backup's (`backup.home`, `words.show`); the words are theirs too.
//! "Download settings" opens its own sheet, the transfer rule Home's gear draws, from the same store.
//! Home's entry point to this page is [`super::routes::settings`].

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;
use wire::settings_event::Kind as S;

use crate::backup::{self, key::KeyCustody, line, reading};
use crate::catalog::load;
use crate::custody::secrets::{self as secrets, VaultSecrets};
use crate::kit::quantity::{self, UnitsPref};
use crate::kit::read::Reading;
use crate::passes::{Rules, TransferRule, rule};
use crate::screen::{Ctx, Screen};
use crate::strings::{home as home_words, settings as words};

/// The id of the row that shows the vaults.
const VAULTS_ROW: &str = "vaults";

/// The id of the row that opens the download settings sheet.
const DOWNLOAD_ROW: &str = "download-settings";

/// The Keychain key the appearance is kept under: Home's, the same three values.
/// The units choice that stores nothing, so the phone's region decides.
const PHONE_UNITS: &str = "phone";
const APPEARANCE_KEY: &str = "appearance";

/// The registry factory.
pub fn build(secrets: &VaultSecrets) -> impl Fn(&wire::Route) -> Option<Box<dyn Screen>> + 'static {
    let secrets = secrets.clone();
    move |_route| Some(Box::new(Settings::new(secrets.clone())))
}

/// The member's choice. `System` follows the phone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Appearance {
    System,
    Light,
    Dark,
}

impl Appearance {
    const ALL: [Self; 3] = [Self::System, Self::Light, Self::Dark];

    fn id(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    fn of_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|each| each.id() == id)
    }

    /// What the Keychain holds: nothing for "follow the phone".
    fn stored(self) -> &'static str {
        match self {
            Self::System => "",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    fn of_stored(stored: &str) -> Self {
        match stored.trim() {
            "light" => Self::Light,
            "dark" => Self::Dark,
            _ => Self::System,
        }
    }
}

/// Every Settings row that writes. A write the platform refuses is never silent: each row names its
/// own sentence here, and [`Settings::refuse`] is the one place that shows it. The `match` has no
/// wildcard, so a new writing row cannot be added without its sentence.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Row {
    /// The transfer rule: the pass service is told when it stuck.
    Rule,
    /// The units: every other open screen draws again when it stuck.
    Units,
    /// The appearance: kept in the Keychain, then Home draws the scheme it names.
    Appearance,
}

impl Row {
    pub const ALL: [Self; 3] = [Self::Rule, Self::Units, Self::Appearance];

    /// What the member is told when this row's save was refused.
    pub fn refused(self, locale: crate::strings::Locale) -> String {
        match self {
            Self::Rule => words::settings_rule_refused(locale),
            Self::Units => words::settings_units_refused(locale),
            Self::Appearance => words::settings_appearance_refused(locale),
        }
    }
}

struct Settings {
    secrets: VaultSecrets,
    /// `None` until the Keychain has answered: the page is loading, never a guess.
    appearance: Option<Appearance>,
    standing: Option<reading::Standing>,
    synced: Option<wire::SyncedSecretsStatus>,
    /// The name of the vault in front, whose first letter is the vault row's avatar.
    vault_name: Option<String>,
    /// The vault row was pressed: Home draws the switcher, so this page is done.
    finished: bool,
    /// THE DOWNLOAD SETTINGS SHEET is open.
    transfer_open: bool,
    /// The writes to the device store that are out, oldest first: the answers come back in the
    /// same order, and each says what to do when it lands.
    keeping: std::collections::VecDeque<(Row, Vec<wire::SecretOp>)>,
    /// The appearance writes to the Keychain that are out, oldest first, each with the number the
    /// runtime gave its effect (`None` until [`Screen::effects_numbered`] says). The choice shows
    /// and Home draws it only once the Keychain's answer to THAT effect says it stuck.
    keeping_appearance: std::collections::VecDeque<(Option<u64>, Appearance)>,
    /// Where the appearance write sits in the effects the last update returned.
    asking_appearance: Option<usize>,
    /// The sentence for a write the platform refused; the next pick or visit clears it.
    refused: Option<String>,
}

impl Settings {
    fn new(secrets: VaultSecrets) -> Self {
        Self {
            secrets,
            appearance: None,
            standing: None,
            synced: None,
            vault_name: None,
            finished: false,
            transfer_open: false,
            keeping: std::collections::VecDeque::new(),
            keeping_appearance: std::collections::VecDeque::new(),
            asking_appearance: None,
            refused: None,
        }
    }

    fn read(&mut self, ctx: &Ctx) {
        // A refresh that fails keeps what was read; the Backup row then says what it knew.
        if let Reading::Data(standing) = reading::load(ctx) {
            self.standing = Some(standing);
        }
        if let Ok(loaded) = ctx.load(load::shell::Holdings {}.into())
            && let Some(wire::app_query_response::Answer::Holdings(held)) =
                loaded.answer.and_then(|answer| answer.answer)
        {
            self.vault_name = held
                .vaults
                .iter()
                .find(|vault| vault.foreground)
                .map(|vault| vault.name.clone());
        }
    }

    /// The device store answered the rule's write. THE PASS SERVICE READS THE SAME CACHE, so the
    /// answer is folded in before it is told: a rule that stuck is a new constraint on every window
    /// the OS holds (Home's gear and the Backup page do the same).
    fn write_kept(&mut self, batched: &wire::SecretBatched, ctx: &Ctx) {
        let Some((kept, ops)) = self.keeping.pop_front() else {
            return;
        };
        self.secrets.absorb(&ops, &batched.answers);
        // A write the platform refused changed nothing in the cache, so the page keeps showing
        // what is stored.
        if batched.answers.len() < ops.len() || !batched.answers.iter().all(|answer| answer.ok) {
            self.refuse(kept, ctx);
        } else {
            match kept {
                Row::Rule => self
                    .secrets
                    .conductor()
                    .ask(ctx, wire::pass_asked::Ask::RuleChanged),
                Row::Units => ctx.redraw_all(),
                // Appearance goes through the Keychain, not a secret batch.
                Row::Appearance => {}
            }
        }
    }

    /// THE ONE PLACE A REFUSED SAVE IS SHOWN: the row's own sentence, on the status line. The old
    /// value stays selected because nothing was changed; the next pick or visit clears the line.
    fn refuse(&mut self, row: Row, ctx: &Ctx) {
        self.refused = Some(row.refused(ctx.locale()));
    }

    /// Whether `effect_id` is the answer to an appearance write that is out.
    fn is_appearance_write(&self, effect_id: u64) -> bool {
        self.keeping_appearance
            .iter()
            .any(|(id, _)| *id == Some(effect_id))
    }

    /// The Keychain answered the appearance write numbered `effect_id`. A choice that stuck is
    /// shown and Home is woken to draw it; one that did not changes nothing.
    fn appearance_kept(&mut self, effect_id: u64, stuck: bool, ctx: &Ctx) {
        let Some(at) = self
            .keeping_appearance
            .iter()
            .position(|(id, _)| *id == Some(effect_id))
        else {
            return;
        };
        let Some((_, chosen)) = self.keeping_appearance.remove(at) else {
            return;
        };
        if !stuck {
            self.refuse(Row::Appearance, ctx);
            return;
        }
        self.appearance = Some(chosen);
        // HOME OWNS THE SCHEME: it reads the choice from the one key, which now holds it.
        ctx.post(
            super::HOME,
            wire::ScreenEvent {
                kind: Some(E::Home(wire::HomeEvent {
                    kind: Some(wire::home_event::Kind::AppearanceChosen(
                        wire::home_event::AppearanceChosen {
                            stored: chosen.stored().to_owned(),
                        },
                    )),
                })),
            },
        );
    }

    /// The units row: the STORED choice, or Phone's setting when none is stored (the effective
    /// reading every screen's `Ctx::units` makes follows the region then).
    fn units(&self, locale: crate::strings::Locale) -> wire::SettingsUnits {
        let shown = quantity::stored(&self.secrets);
        let choice = |id: &str, each: Option<UnitsPref>, label: String| wire::SettingsChoice {
            id: id.to_owned(),
            label,
            selected: each == shown,
        };
        wire::SettingsUnits {
            title: words::settings_units(locale),
            choices: vec![
                choice(PHONE_UNITS, None, words::settings_units_phone(locale)),
                choice(
                    UnitsPref::Metric.stored(),
                    Some(UnitsPref::Metric),
                    words::settings_units_metric(locale),
                ),
                choice(
                    UnitsPref::Imperial.stored(),
                    Some(UnitsPref::Imperial),
                    words::settings_units_imperial(locale),
                ),
            ],
            note: words::settings_units_note(locale),
        }
    }

    /// The sheet behind the Download settings row, while it is open: the rule as the device store
    /// holds it, in the order the Backup page lists the choices.
    fn transfer_sheet(&self, locale: crate::strings::Locale) -> Option<wire::HomeTransferSheet> {
        if !self.transfer_open {
            return None;
        }
        let kept = Rules::read(&self.secrets).rule;
        Some(wire::HomeTransferSheet {
            title: rule::title(locale),
            subtitle: rule::subtitle(locale),
            choices: TransferRule::ALL
                .iter()
                .map(|choice| wire::BackupRuleChoice {
                    stored: choice.stored().to_owned(),
                    sentence: choice.sentence(locale),
                    picked: *choice == kept,
                })
                .collect(),
        })
    }

    fn backup_meta(&self, ctx: &Ctx) -> String {
        self.standing.as_ref().map_or_else(String::new, |standing| {
            line::line(
                ctx.locale(),
                Some(&standing.reading),
                standing.reading.frozen,
                standing.now_ms,
            )
            .sentence
        })
    }

    fn data(&self, ctx: &Ctx, appearance: Appearance) -> wire::SettingsData {
        let locale = ctx.locale();
        let held = ctx.vaults().map_or(1, |vaults| vaults.held().len().max(1)) as u64;
        let custody = KeyCustody::read(locale, &self.secrets, ctx.platform(), self.synced.as_ref());
        let row = |id: &str,
                   title: String,
                   meta: String,
                   icon: &str,
                   route: Option<wire::Route>,
                   tile: &str,
                   value: String| {
            let spoken = if meta.is_empty() {
                title.clone()
            } else {
                format!("{title}, {meta}")
            };
            wire::SettingsRow {
                id: id.to_owned(),
                pressable: false,
                title,
                meta,
                icon_key: icon.to_owned(),
                route,
                accessibility_label: spoken,
                tile: tile.to_owned(),
                initial: String::new(),
                value,
            }
        };
        let rule = crate::backup::rule::TransferRule::of(
            self.secrets
                .device_value(crate::backup::rule::RULE_KEY)
                .as_deref(),
        );
        wire::SettingsData {
            appearance: Some(wire::SettingsAppearance {
                title: words::settings_appearance(locale),
                choices: Appearance::ALL
                    .into_iter()
                    .map(|each| wire::SettingsChoice {
                        id: each.id().to_owned(),
                        label: match each {
                            Appearance::System => words::settings_appearance_system(locale),
                            Appearance::Light => words::settings_appearance_light(locale),
                            Appearance::Dark => words::settings_appearance_dark(locale),
                        },
                        selected: each == appearance,
                    })
                    .collect(),
                note: words::settings_appearance_note(locale),
            }),
            units: Some(self.units(locale)),
            sections: vec![
                wire::SettingsSection {
                    key: "vault".to_owned(),
                    title: words::settings_vault(locale),
                    rows: vec![
                        {
                            // THE VAULT ROW WEARS THE VAULT'S OWN ROUND INITIAL, as the lockup does,
                            // and is called by the vault's name.
                            let mut vaults = row(
                                "vaults",
                                self.vault_name
                                    .as_deref()
                                    .map(str::trim)
                                    .filter(|name| !name.is_empty())
                                    .map_or_else(
                                        || words::settings_vaults_row(locale),
                                        str::to_owned,
                                    ),
                                words::settings_vaults_held(locale, held),
                                "Lock",
                                None,
                                "initial",
                                String::new(),
                            );
                            // THE VAULT ROW OPENS HOME'S SWITCHER (the lockup's sheet): a tap is an
                            // event, and the chevron says it is a row that goes somewhere.
                            vaults.pressable = true;
                            vaults.initial = self
                                .vault_name
                                .as_deref()
                                .and_then(|name| name.trim().chars().next())
                                .map(|first| first.to_uppercase().collect())
                                .unwrap_or_else(|| "V".to_owned());
                            vaults
                        },
                        // MAKE A VAULT is the pushed page Home's switcher and the welcome open.
                        row(
                            "make-vault",
                            words::settings_make_vault(locale),
                            String::new(),
                            "Plus",
                            Some(crate::custody::routes::make()),
                            "add",
                            String::new(),
                        ),
                    ],
                },
                wire::SettingsSection {
                    key: "backup".to_owned(),
                    title: words::settings_backup(locale),
                    rows: vec![
                        row(
                            "backup",
                            words::settings_backup(locale),
                            self.backup_meta(ctx),
                            "Backup",
                            Some(backup::routes::home()),
                            "",
                            String::new(),
                        ),
                        // THE ONE TRANSFER RULE, read from the store the Backup page and Home's
                        // gear write; the sheet this row opens changes it.
                        {
                            // A SHEET OF ITS OWN: the row asks Rust to open it, and the chevron says
                            // it is a row that goes somewhere.
                            let mut download = row(
                                DOWNLOAD_ROW,
                                words::settings_download_settings(locale),
                                String::new(),
                                "Download",
                                None,
                                "neutral",
                                rule.short(locale),
                            );
                            download.pressable = true;
                            download
                        },
                        // THE STORES THE VAULT FOLLOWED ON ANOTHER PHONE, offered again (#1185).
                        row(
                            "reconnect",
                            words::settings_reconnect(locale),
                            String::new(),
                            "Backup",
                            Some(crate::follow::reconnect::route()),
                            "neutral",
                            String::new(),
                        ),
                        // EVERYTHING BUT LOCKER as one archive: the kit's export page, behind the owner
                        // check (#1185).
                        row(
                            "export",
                            words::settings_export(locale),
                            String::new(),
                            "Upload",
                            Some(crate::kit::export::entry(locale, super::EXPORT).route),
                            "neutral",
                            String::new(),
                        ),
                    ],
                },
                wire::SettingsSection {
                    key: "recovery-key".to_owned(),
                    title: words::settings_recovery_key(locale),
                    rows: vec![row(
                        "recovery-key",
                        words::settings_show_recovery_key(locale),
                        custody.sentence,
                        "Key",
                        Some(backup::routes::show_key()),
                        "amber",
                        String::new(),
                    )],
                },
            ],
            version_title: words::settings_version(locale),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            about_title: words::settings_about(locale),
        }
    }
}

impl Screen for Settings {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                self.read(ctx);
                self.refused = None;
                return vec![
                    effect(wire::effect::Kind::Keychain(wire::KeychainOp {
                        op: wire::keychain_op::Op::Get as i32,
                        key: APPEARANCE_KEY.to_owned(),
                        value: Vec::new(),
                    })),
                    effect(wire::effect::Kind::SyncedProbe(wire::SyncedSecretsProbe {})),
                ];
            }
            Some(E::DataChanged(_) | E::EnvironmentChanged(_) | E::Lifecycle(_)) => {
                self.read(ctx);
            }
            Some(E::EffectResult(result)) => match result.outcome {
                Some(wire::effect_result::Outcome::Keychain(value)) => {
                    self.appearance = Some(if value.found {
                        Appearance::of_stored(&String::from_utf8_lossy(&value.value))
                    } else {
                        Appearance::System
                    });
                }
                // The Keychain kept the choice.
                Some(wire::effect_result::Outcome::Done(_)) => {
                    self.appearance_kept(result.effect_id, true, ctx);
                }
                // A Keychain that cannot answer leaves the phone's own scheme: the choice shows
                // as System rather than the page waiting for ever.
                Some(wire::effect_result::Outcome::Failed(_)) if self.appearance.is_none() => {
                    self.appearance = Some(Appearance::System);
                }
                // A write the Keychain refused (or could not perform) changed nothing.
                Some(wire::effect_result::Outcome::Failed(_))
                    if self.is_appearance_write(result.effect_id) =>
                {
                    self.appearance_kept(result.effect_id, false, ctx);
                }
                Some(wire::effect_result::Outcome::SyncedStatus(status)) => {
                    self.synced = Some(status);
                }
                Some(wire::effect_result::Outcome::Secrets(batched)) => {
                    self.write_kept(&batched, ctx);
                }
                _ => {}
            },
            Some(E::Settings(settings)) => {
                // THE VAULT ROW: Home's switcher is the one list of vaults, so Home is asked to
                // open it, and this page, which sits over Home, steps aside.
                if let Some(S::RowPressed(pressed)) = &settings.kind {
                    if pressed.id == DOWNLOAD_ROW {
                        self.transfer_open = true;
                        return Vec::new();
                    }
                    if pressed.id == VAULTS_ROW && !self.finished {
                        self.finished = true;
                        ctx.post(
                            super::HOME,
                            wire::ScreenEvent {
                                kind: Some(E::Home(wire::HomeEvent {
                                    kind: Some(wire::home_event::Kind::Vault(
                                        wire::home_event::VaultPressed {},
                                    )),
                                })),
                            },
                        );
                    }
                    return Vec::new();
                }
                match &settings.kind {
                    Some(S::TransferRulesClosed(_)) => {
                        self.transfer_open = false;
                        return Vec::new();
                    }
                    Some(S::TransferRuleChosen(chosen)) => {
                        // THE BACKUP PAGE'S WRITE, not a second one: the rule goes to the phone's
                        // device store as a `SecretBatch`, and its answer is what tells the pass
                        // service (`rule_kept`).
                        self.transfer_open = false;
                        self.refused = None;
                        let ops = vec![Rules::write_rule(TransferRule::of(Some(&chosen.stored)))];
                        self.keeping.push_back((Row::Rule, ops.clone()));
                        return vec![secrets::effect(ops)];
                    }
                    Some(S::UnitsPicked(picked)) => {
                        // ONE SWITCH, written to the phone's device store; the answer is folded in
                        // (`write_kept`) and only then do the other screens draw again.
                        // Phone's setting stores nothing, so the region decides again.
                        let chosen = if picked.id == PHONE_UNITS {
                            None
                        } else if let Some(chosen) = UnitsPref::of_stored(&picked.id) {
                            Some(chosen)
                        } else {
                            return Vec::new();
                        };
                        self.refused = None;
                        let ops = vec![quantity::set_op(chosen)];
                        self.keeping.push_back((Row::Units, ops.clone()));
                        return vec![secrets::effect(ops)];
                    }
                    _ => {}
                }
                if let Some(S::AppearancePicked(picked)) = settings.kind
                    && let Some(chosen) = Appearance::of_id(&picked.id)
                    && self.appearance != Some(chosen)
                {
                    // THE KEYCHAIN IS WRITTEN HERE so a refusal is seen here; the choice shows
                    // and Home draws it when the write is answered (`appearance_kept`).
                    self.refused = None;
                    self.keeping_appearance.push_back((None, chosen));
                    self.asking_appearance = Some(0);
                    return vec![effect(wire::effect::Kind::Keychain(wire::KeychainOp {
                        op: wire::keychain_op::Op::Set as i32,
                        key: APPEARANCE_KEY.to_owned(),
                        value: chosen.stored().as_bytes().to_vec(),
                    }))];
                }
            }
            _ => {}
        }
        Vec::new()
    }

    fn effects_numbered(&mut self, ids: &[Option<u64>]) {
        let Some(index) = self.asking_appearance.take() else {
            return;
        };
        if let Some(last) = self.keeping_appearance.back_mut() {
            last.0 = ids.get(index).copied().flatten();
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let content = match self.appearance {
            None => wire::settings_state::Content::Loading(wire::Loading { first_load: true }),
            Some(appearance) => {
                wire::settings_state::Content::Data(Box::new(self.data(ctx, appearance)))
            }
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Settings(wire::SettingsState {
                title: words::settings_title(locale),
                back_label: home_words::band_home(locale),
                content: Some(content),
                finished: self.finished,
                transfer_sheet: self.transfer_sheet(locale),
                status: self.refused.clone().map(|sentence| wire::StatusLine {
                    sentence,
                    action_label: String::new(),
                    refused: true,
                }),
            })),
            ..wire::ViewState::default()
        }
    }
}

fn effect(kind: wire::effect::Kind) -> wire::Effect {
    wire::Effect { kind: Some(kind) }
}
