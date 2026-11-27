//! THE SHELL FRAME ON ROOMS (app-plane §5.1): the Home placeholder, Settings and Backup. Settings
//! and Backup are `SYSTEM_PLACE` rooms of section and row blocks only. Their sentences are the
//! catalogue's: the backup line is the backup plane's own (`backup::line`), read from the core's
//! backup status, and the choices Settings keeps live in the device store under the registry's
//! `settings.*` keys.

use centraid_api_proto::core_v1 as wire;
use serde_json::{Value, json};

use super::blocks::{self, Confirm, glyph};
use super::form::{self, Explicit, Save};
use super::frame::room;
use super::screen::{Build, Event, Input, Outcome, Registry, RoomScreen};
use super::selector::Handler;
use crate::backup::{line, reading};
use crate::strings::{
    Locale, backup as backup_words, home as home_words, pairing as pairing_words, room as words,
    settings as settings_words, shared,
};

pub const HOME: &str = "home";
pub const SETTINGS: &str = "settings";
pub const SETTINGS_RECOVERY: &str = "settings/recovery-key";
pub const BACKUP: &str = "backup";
pub const BACKUP_PAIR: &str = "backup/pair";

const EN: Locale = Locale::En;

const BACKUP_TABLES: [&str; 2] = ["backup", "blob"];

pub const APPEARANCE_KEY: &str = "settings.appearance";
pub const UNITS_KEY: &str = "settings.units";
pub const DETAILS_KEY: &str = "settings.details";

#[must_use]
pub fn registry() -> Registry {
    Registry::new()
        .exact(SETTINGS, || Box::new(Settings))
        .exact(SETTINGS_RECOVERY, || Box::new(RecoveryKeyConfirm))
        .exact(BACKUP, || Box::new(Backup))
        .exact(BACKUP_PAIR, || Box::new(BackupPair))
        .merge(super::follow::registry())
        .merge(super::people::registry())
        .merge(super::money::registry())
        .merge(super::calendar::registry())
        .merge(super::reminders::registry())
        .merge(super::notes::registry())
        .merge(super::docs::registry())
        .merge(super::photos::registry())
        .merge(super::health::registry())
        .merge(super::locker::registry())
        .merge(super::chat::registry())
        .merge(super::home::registry())
}

fn stored(build: &Build<'_>, key: &str, default: &str) -> String {
    build
        .door
        .device_get(key)
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            value
                .get("value")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| default.to_owned())
}

fn status_of(door: &dyn super::door::Door) -> Result<wire::BackupStatusResponse, String> {
    let response = door
        .call(&wire::Request {
            kind: Some(wire::request::Kind::BackupStatus(
                wire::BackupStatusRequest {},
            )),
        })
        .map_err(|refused| refused.0)?;
    match response.kind {
        Some(wire::response::Kind::BackupStatus(status)) => Ok(status),
        _ => Err(words::backup_not_ready(EN)),
    }
}

pub(super) fn the_line(
    door: &dyn super::door::Door,
) -> Result<(wire::BackupLine, reading::Reading, i64), String> {
    let status = status_of(door)?;
    let reading = reading::Reading::from_wire(&status);
    let now = door.now_ms();
    Ok((
        line::line(EN, Some(&reading), reading.frozen, false, now),
        reading,
        now,
    ))
}

fn tone_of(tone: i32) -> wire::RoomTone {
    match wire::backup_line::Tone::try_from(tone) {
        Ok(wire::backup_line::Tone::Urgent) => wire::RoomTone::Warning,
        Ok(wire::backup_line::Tone::Attention) => wire::RoomTone::Seam,
        _ => wire::RoomTone::Neutral,
    }
}

fn choice_row(
    b: &mut Build<'_>,
    id: &str,
    label: &str,
    options: &[(&str, String)],
    selected: &str,
) -> wire::RoomBlock {
    let options = options
        .iter()
        .map(|(value, text)| blocks::option(value, text, *value == selected))
        .collect();
    blocks::choice_block(blocks::choice(
        &mut b.sel,
        &format!("choice/{id}"),
        label,
        wire::RoomChoiceStyle::Segmented,
        false,
        options,
        id,
    ))
}

struct Settings;

impl RoomScreen for Settings {
    fn key(&self) -> String {
        SETTINGS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        b.watch(&BACKUP_TABLES);
        let appearance = stored(b, APPEARANCE_KEY, "system");
        let units = stored(b, UNITS_KEY, "phone");
        let details = stored(b, DETAILS_KEY, "on");

        let appearance_block = choice_row(
            b,
            "appearance",
            &settings_words::settings_appearance(EN),
            &[
                ("system", settings_words::settings_appearance_system(EN)),
                ("light", settings_words::settings_appearance_light(EN)),
                ("dark", settings_words::settings_appearance_dark(EN)),
            ],
            &appearance,
        );
        let units_block = choice_row(
            b,
            "units",
            &settings_words::settings_units(EN),
            &[
                ("phone", settings_words::settings_units_phone(EN)),
                ("metric", settings_words::settings_units_metric(EN)),
                ("imperial", settings_words::settings_units_imperial(EN)),
            ],
            &units,
        );
        let details_block = choice_row(
            b,
            "details",
            &settings_words::settings_details(EN),
            &[
                ("on", settings_words::settings_details_on(EN)),
                ("off", settings_words::settings_details_off(EN)),
            ],
            &details,
        );
        let backup_meta = the_line(b.door)
            .map(|(line, ..)| line.sentence)
            .unwrap_or_default();
        let backup_row = blocks::row(
            &mut b.sel,
            "row/backup",
            &settings_words::settings_backup(EN),
            Handler::Open(BACKUP.to_owned()),
        )
        .meta(&backup_meta)
        .into_block();
        let recovery_key_row = blocks::row(
            &mut b.sel,
            "row/recovery-key",
            &settings_words::settings_recovery_key(EN),
            Handler::Open(SETTINGS_RECOVERY.to_owned()),
        )
        .meta(&settings_words::settings_show_recovery_key(EN))
        .into_block();
        let version = blocks::facts(vec![blocks::fact(
            &settings_words::settings_version(EN),
            &words::settings_version_value(EN),
            wire::RoomFactKind::Text,
        )]);

        let sections = vec![
            blocks::section(
                &mut b.sel,
                "section/appearance",
                &settings_words::settings_appearance(EN),
            )
            .block(appearance_block)
            .block(blocks::prose(&settings_words::settings_appearance_note(EN)))
            .into_block(),
            blocks::section(
                &mut b.sel,
                "section/units",
                &settings_words::settings_units(EN),
            )
            .block(units_block)
            .block(blocks::prose(&settings_words::settings_units_note(EN)))
            .into_block(),
            blocks::section(
                &mut b.sel,
                "section/notifications",
                &settings_words::settings_notifications(EN),
            )
            .block(details_block)
            .block(blocks::prose(&settings_words::settings_details_note(EN)))
            .into_block(),
            blocks::section(
                &mut b.sel,
                "section/backup",
                &settings_words::settings_backup(EN),
            )
            .block(backup_row)
            .block(recovery_key_row)
            .into_block(),
            blocks::section(
                &mut b.sel,
                "section/about",
                &settings_words::settings_about(EN),
            )
            .block(version)
            .into_block(),
        ];
        room(wire::RoomKind::SystemPlace, SETTINGS)
            .title(&settings_words::settings_title(EN))
            .back(&mut b.sel, &home_words::band_home(EN))
            .ready(sections)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        let Input::Option(choice) = input else {
            return Outcome::default();
        };
        let (key, refused) = match tag {
            "appearance" => (
                APPEARANCE_KEY,
                settings_words::settings_appearance_refused(EN),
            ),
            "units" => (UNITS_KEY, settings_words::settings_units_refused(EN)),
            "details" => (DETAILS_KEY, settings_words::settings_details_refused(EN)),
            _ => return Outcome::default(),
        };
        match e
            .door
            .device_put(key, &json!({ "v": 1, "value": choice }).to_string())
        {
            Ok(()) => Outcome::default(),
            Err(_) => Outcome::refuse(&refused),
        }
    }
}

struct Backup;

impl RoomScreen for Backup {
    fn key(&self) -> String {
        BACKUP.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        b.watch(&BACKUP_TABLES);
        let mut frame = room(wire::RoomKind::SystemPlace, BACKUP).title(&words::backup_title(EN));
        if b.depth > 1 {
            frame = frame.back(&mut b.sel, &settings_words::settings_title(EN));
        }
        let (the_line, reading, now) = match the_line(b.door) {
            Ok(read) => read,
            Err(sentence) => {
                return frame
                    .failed(&mut b.sel, &sentence, &words::backup_retry(EN))
                    .build();
            }
        };
        let mut status_row =
            blocks::still_row(&mut b.sel, "row/line", &the_line.sentence).meta(&the_line.detail);
        if tone_of(the_line.tone) != wire::RoomTone::Neutral {
            status_row = status_row.chip(blocks::chip(&the_line.status, tone_of(the_line.tone)));
        }
        let mut line_section =
            blocks::section(&mut b.sel, "section/line", &words::backup_title(EN))
                .block(status_row.into_block());
        if !reading.frozen && !reading.destinations.is_empty() {
            line_section = line_section.block(
                blocks::row(
                    &mut b.sel,
                    "row/backup-now",
                    &words::backup_back_up_now(EN),
                    Handler::Tag("backup:now".to_owned()),
                )
                .into_block(),
            );
        }
        let mut blocks_out = vec![line_section.into_block()];
        let waiting: Vec<wire::RoomBlock> = the_line
            .waiting
            .iter()
            .enumerate()
            .map(|(at, each)| {
                blocks::still_row(&mut b.sel, &format!("row/waiting/{at}"), &each.sentence)
                    .into_block()
            })
            .collect();
        if !waiting.is_empty() {
            blocks_out.push(
                blocks::section(&mut b.sel, "section/waiting", &words::backup_waiting(EN))
                    .blocks(waiting)
                    .into_block(),
            );
        }
        if reading.destinations.is_empty() {
            blocks_out.push(blocks::empty(
                glyph("Backup", ""),
                &words::backup_no_devices(EN),
                &words::backup_no_devices_body(EN),
                Some(blocks::action(
                    &mut b.sel,
                    "action/pair",
                    &backup_words::backup_add_destination(EN),
                    "Add",
                    Handler::Open(BACKUP_PAIR.to_owned()),
                )),
            ));
        } else {
            let mut devices: Vec<wire::RoomBlock> = reading
                .destinations
                .iter()
                .map(|device| {
                    let name = line::device_name(EN, device);
                    let when = device.last_ack_ms.map_or_else(
                        || words::device_never(EN),
                        |ack| {
                            crate::strings::fill(
                                &words::device_last_backup(EN),
                                &[("when", &line::ago(EN, ack, now))],
                            )
                        },
                    );
                    blocks::still_row(
                        &mut b.sel,
                        &format!("row/device/{}", device.gateway_id),
                        &name,
                    )
                    .meta(&when)
                    .into_block()
                })
                .collect();
            devices.push(
                blocks::row(
                    &mut b.sel,
                    "row/pair",
                    &backup_words::backup_add_destination(EN),
                    Handler::Open(BACKUP_PAIR.to_owned()),
                )
                .into_block(),
            );
            blocks_out.push(
                blocks::section(&mut b.sel, "section/devices", &words::backup_devices(EN))
                    .blocks(devices)
                    .into_block(),
            );
        }
        frame.ready(blocks_out).build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "backup:now" {
            let req = wire::Request {
                kind: Some(wire::request::Kind::Drain(wire::DrainRequest::default())),
            };
            return match e.door.call(&req) {
                Ok(_) => Outcome::say(&words::backup_started(EN)),
                Err(_) => Outcome::refuse(&words::backup_refused(EN)),
            };
        }
        Outcome::default()
    }
}

struct RecoveryKeyConfirm;

impl RoomScreen for RecoveryKeyConfirm {
    fn key(&self) -> String {
        SETTINGS_RECOVERY.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let confirm = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Owner,
                title: &settings_words::settings_recovery_key(EN),
                body: &shared::owner_reason_reveal(EN),
                warning: "",
                confirm_label: &settings_words::settings_show_recovery_key(EN),
                confirm: Handler::Tag("recovery:owner".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, SETTINGS_RECOVERY)
            .title(&settings_words::settings_recovery_key(EN))
            .ready(vec![confirm])
            .build()
    }

    fn on(&mut self, _: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "recovery:owner" {
            return Outcome::say(&shared::owner_reason_reveal(EN));
        }
        Outcome::default()
    }
}

struct BackupPair;

impl RoomScreen for BackupPair {
    fn key(&self) -> String {
        BACKUP_PAIR.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let payload = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "payload",
            &pairing_words::paste_label(EN),
            wire::RoomTextKind::Line,
            "",
            4096,
        )
        .focused()
        .build();
        let dirty = !b.ui.fields.value("payload").unwrap_or_default().is_empty();
        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &pairing_words::primary(EN),
                save: Handler::Tag("pair:submit".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
                save_enabled: true,
                dirty,
                drafted: false,
            },
        );
        let form_block = form::form(vec![payload], Vec::new(), Save::Explicit(save));
        room(wire::RoomKind::SystemPlace, BACKUP_PAIR)
            .title(&pairing_words::title(EN))
            .back(&mut b.sel, &words::backup_title(EN))
            .ready(vec![form_block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "pair:submit" {
            let payload =
                e.ui.fields
                    .value("payload")
                    .unwrap_or_default()
                    .trim()
                    .to_owned();
            if payload.is_empty() {
                return Outcome::refuse(&words::backup_refused(EN));
            }
            let req = wire::Request {
                kind: Some(wire::request::Kind::PairPhone(wire::PairRequest {
                    payload,
                })),
            };
            return match e.door.call(&req) {
                Ok(_) => Outcome::pop(),
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}
