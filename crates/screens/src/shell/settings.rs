//! SETTINGS (#1173): the appearance the member chooses, where the vault, the backup and the
//! recovery key stand, and the version.
//!
//! | Section | What it holds |
//! |---|---|
//! | Appearance | System, Light or Dark: one choice, kept in the Keychain under the key Home reads |
//! | Vault | how many vaults this phone holds |
//! | Backup | the one honest line ([`crate::backup::line`]) and the Backup page behind it |
//! | Recovery key | where the key is ([`crate::backup::key`]) and the page that shows it |
//! | About | the version |
//!
//! **The appearance has one store.** Home's key `appearance` holds `""`, `"light"` or `"dark"`;
//! Settings writes the same three values to the same key and then wakes Home, which reads the key
//! again and draws the scheme it names. There is no second copy to drift.
//!
//! The pages the rows open are Backup's (`backup.home`, `words.show`); the words are theirs too.
//! Home's entry point to this page is [`super::routes::settings`].

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;
use wire::settings_event::Kind as S;

use crate::backup::{self, key::KeyCustody, line, reading};
use crate::catalog::load;
use crate::custody::secrets::VaultSecrets;
use crate::kit::read::Reading;
use crate::screen::{Ctx, Screen};
use crate::strings::{home as home_words, settings as words};

/// The Keychain key the appearance is kept under: Home's, the same three values.
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

struct Settings {
    secrets: VaultSecrets,
    /// `None` until the Keychain has answered: the page is loading, never a guess.
    appearance: Option<Appearance>,
    standing: Option<reading::Standing>,
    synced: Option<wire::SyncedSecretsStatus>,
    /// The name of the vault in front, whose first letter is the vault row's avatar.
    vault_name: Option<String>,
}

impl Settings {
    fn new(secrets: VaultSecrets) -> Self {
        Self {
            secrets,
            appearance: None,
            standing: None,
            synced: None,
            vault_name: None,
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
            sections: vec![
                wire::SettingsSection {
                    key: "vault".to_owned(),
                    title: words::settings_vault(locale),
                    rows: vec![{
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
                    )],
                },
                wire::SettingsSection {
                    key: "backup".to_owned(),
                    title: words::settings_backup(locale),
                    rows: vec![
                        row(
                            "backup",
                            words::settings_backup(locale),
                            self.backup_meta(ctx),
                            "Cloud",
                            Some(backup::routes::home()),
                            "",
                            String::new(),
                        ),
                        // THE ONE TRANSFER RULE, read from the store the Backup page and Home's
                        // gear write; it is changed on the Backup page this row opens.
                        row(
                            "download-settings",
                            words::settings_download_settings(locale),
                            String::new(),
                            "Download",
                            Some(backup::routes::home()),
                            "neutral",
                            rule.short(locale),
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
                // A Keychain that cannot answer leaves the phone's own scheme: the choice shows
                // as System rather than the page waiting for ever.
                Some(wire::effect_result::Outcome::Failed(_)) if self.appearance.is_none() => {
                    self.appearance = Some(Appearance::System);
                }
                Some(wire::effect_result::Outcome::SyncedStatus(status)) => {
                    self.synced = Some(status);
                }
                _ => {}
            },
            Some(E::Settings(settings)) => {
                if let Some(S::AppearancePicked(picked)) = settings.kind
                    && let Some(chosen) = Appearance::of_id(&picked.id)
                    && self.appearance != Some(chosen)
                {
                    self.appearance = Some(chosen);
                    // HOME OWNS THE STORE AND THE SCHEME: it keeps the choice in the Keychain
                    // and draws what it names.
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
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let content = match self.appearance {
            None => wire::settings_state::Content::Loading(wire::Loading { first_load: true }),
            Some(appearance) => wire::settings_state::Content::Data(self.data(ctx, appearance)),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Settings(wire::SettingsState {
                title: words::settings_title(locale),
                back_label: home_words::band_home(locale),
                content: Some(content),
            })),
            ..wire::ViewState::default()
        }
    }
}

fn effect(kind: wire::effect::Kind) -> wire::Effect {
    wire::Effect { kind: Some(kind) }
}
