//! PEOPLE'S IMPORT AND EXPORT (`people.import`, `people.export`; #1173, item 20), the kit's
//! transfer screen over People's two vCard commands.
//!
//! **Import is choose → preview → tap.** The picked `.vcf` text is held here while
//! `person.import_vcf` is asked with `dry_run`, which writes nothing and answers how many people
//! are new, how many match someone the vault already has (a PROPOSAL to merge: it fills blanks and
//! adds missing numbers and addresses, and replaces nothing), and how many are already there. The
//! member's tap writes; "Add new only" writes the new people and leaves every match alone. A
//! second import of the same file adds nothing.
//!
//! **Export is choose → save.** The rows are "Everyone" and each list; a tap asks
//! `person.export_vcf` and the file it answers goes to the OS save sheet (`SaveFile`).

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;

use super::Phase;
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::read;
use crate::kit::transfer::{self, TextFile, action, row};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, people as words};

const ACCEPT: [&str; 4] = ["vcf", "vcard", "text/vcard", "text/x-vcard"];

const FILES: &str = "files";
const AGAIN: &str = "again";
const IMPORT: &str = "import";
const ADD_ONLY: &str = "add-only";
const ALL: &str = "all";

#[must_use]
pub fn build_import(route: &wire::Route) -> Option<Box<dyn Screen>> {
    build(route, false)
}

#[must_use]
pub fn build_export(route: &wire::Route) -> Option<Box<dyn Screen>> {
    build(route, true)
}

fn build(route: &wire::Route, export: bool) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::Transfer(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Transfer {
        export,
        back: args.back_label.clone(),
        files: Vec::new(),
        plan: None,
        stage: Stage::Choosing,
        status: None,
        lists: Phase::Loading,
        saving: 0,
    }))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Choosing,
    Reading,
    Planned,
    Writing,
    Done,
}

#[derive(Clone, Default)]
struct Plan {
    added: u32,
    merged: u32,
    unchanged: u32,
    declined: u32,
    repeated: u32,
    proposals: Vec<String>,
}

struct Transfer {
    export: bool,
    back: String,
    files: Vec<TextFile>,
    plan: Option<Plan>,
    stage: Stage,
    status: Option<wire::StatusLine>,
    lists: Phase<wire::PeopleRoster>,
    saving: u32,
}

fn plan_of(output: &[u8]) -> Plan {
    let value: serde_json::Value = serde_json::from_slice(output).unwrap_or_default();
    Plan {
        added: transfer::count(output, "added"),
        merged: transfer::count(output, "merged"),
        unchanged: transfer::count(output, "unchanged"),
        declined: transfer::count(output, "declined"),
        repeated: transfer::count(output, "repeated"),
        proposals: value
            .get("proposals")
            .and_then(serde_json::Value::as_array)
            .map(|names| {
                names
                    .iter()
                    .filter_map(|name| name.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

impl Transfer {
    fn refuse(&mut self, sentence: String) {
        self.status = Some(wire::StatusLine {
            sentence,
            action_label: String::new(),
            refused: true,
        });
    }

    fn say(&mut self, sentence: String) {
        self.status = Some(wire::StatusLine {
            sentence,
            action_label: String::new(),
            refused: false,
        });
    }

    fn pick() -> Vec<wire::Effect> {
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::PickBytes(wire::PickBytes {
                accept: ACCEPT.iter().map(|entry| (*entry).to_owned()).collect(),
                multiple: true,
                folder: false,
            })),
        }]
    }

    fn cards(&self) -> String {
        self.files
            .iter()
            .map(|file| file.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn picked(&mut self, ctx: &Ctx, picked: &wire::BytesPicked) {
        if picked.cancelled {
            return;
        }
        self.files = transfer::picked_files(picked);
        self.status = None;
        self.stage = Stage::Reading;
        let key = kit_act::key(&["person.import_vcf", "dry"], kit_act::fresh());
        let settled = kit_act::act(
            ctx,
            act::people::ImportVcf {
                cards: self.cards(),
                dry_run: Some(true),
                merge: None,
            },
            &key,
        );
        if !settled.committed {
            self.stage = Stage::Choosing;
            self.refuse(settled.refusal);
            return;
        }
        self.plan = Some(plan_of(&settled.output));
        self.stage = Stage::Planned;
    }

    fn write(&mut self, ctx: &Ctx, merge: bool) {
        let locale = ctx.locale();
        self.stage = Stage::Writing;
        let key = kit_act::key(&["person.import_vcf"], kit_act::fresh());
        let settled = kit_act::act(
            ctx,
            act::people::ImportVcf {
                cards: self.cards(),
                dry_run: None,
                merge: Some(merge),
            },
            &key,
        );
        if settled.committed {
            let done = plan_of(&settled.output);
            let people = done.added + done.merged;
            self.say(fill(
                &words::transfer_import_done(locale),
                &[("n", &people.to_string())],
            ));
            self.stage = Stage::Done;
            self.files.clear();
            self.plan = Some(Plan {
                added: people,
                ..Plan::default()
            });
        } else {
            self.stage = Stage::Planned;
            self.refuse(settled.refusal);
        }
    }

    fn export_one(&mut self, ctx: &Ctx, key: &str) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        let request_key = kit_act::key(&["person.export_vcf", key], kit_act::fresh());
        let settled = kit_act::act(
            ctx,
            act::people::ExportVcf {
                list_id: (key != ALL).then(|| key.to_owned()),
            },
            &request_key,
        );
        let parsed = settled
            .committed
            .then(|| serde_json::from_slice::<serde_json::Value>(&settled.output).ok())
            .flatten();
        let content = parsed
            .as_ref()
            .and_then(|file| file.get("content")?.as_str())
            .and_then(|text| {
                base64::Engine::decode(&base64::engine::general_purpose::STANDARD, text).ok()
            });
        let (Some(file), Some(content)) = (parsed, content) else {
            self.refuse(if settled.refusal.is_empty() {
                words::transfer_export_failed(locale)
            } else {
                settled.refusal
            });
            return Vec::new();
        };
        self.saving = transfer::count(&settled.output, "count");
        self.stage = Stage::Writing;
        self.status = None;
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::SaveFile(wire::SaveFile {
                name: file
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("People.vcf")
                    .to_owned(),
                media_type: "text/vcard".to_owned(),
                content,
            })),
        }]
    }

    fn saved(&mut self, locale: Locale, result: &wire::EffectResult) {
        self.stage = Stage::Choosing;
        match &result.outcome {
            Some(wire::effect_result::Outcome::Done(_)) => self.say(fill(
                &words::transfer_export_done(locale),
                &[("n", &self.saving.to_string())],
            )),
            Some(wire::effect_result::Outcome::Failed(failure)) if !failure.cancelled => {
                self.refuse(words::transfer_export_failed(locale));
            }
            _ => {}
        }
    }

    fn reload(&mut self, ctx: &Ctx) {
        if self.export {
            self.lists = Phase::of(read::read(
                ctx,
                load::people::People {
                    filter: Some("all".to_owned()),
                    limit: 20,
                    sort: Some("name".to_owned()),
                },
                |answer| match answer {
                    Answer::PeopleRoster(roster) => Some(roster),
                    _ => None,
                },
            ));
        }
    }

    fn rows_and_actions(
        &self,
        locale: Locale,
    ) -> (Vec<wire::TransferRow>, Vec<wire::TransferAction>, String) {
        if self.export {
            let mut rows = vec![row(
                ALL,
                &words::transfer_export_all(locale),
                "",
                true,
                "Users",
            )];
            if let Some(roster) = self.lists.data() {
                rows.extend(
                    roster
                        .lists
                        .iter()
                        .map(|list| row(&list.list_id, &list.name, "", true, "List")),
                );
            }
            return (rows, Vec::new(), words::transfer_export_headline(locale));
        }
        let choose = vec![action(
            FILES,
            &words::transfer_choose_file_action(locale),
            true,
            true,
        )];
        match (self.stage, &self.plan) {
            (Stage::Planned | Stage::Writing, Some(plan)) if plan.added + plan.merged > 0 => {
                let mut rows = Vec::new();
                for (key, label, value) in [
                    ("added", words::transfer_row_added(locale), plan.added),
                    ("merged", words::transfer_row_merged(locale), plan.merged),
                    (
                        "same",
                        words::transfer_row_same(locale),
                        plan.unchanged + plan.repeated + plan.declined,
                    ),
                ] {
                    if value > 0 {
                        rows.push(row(key, &label, &value.to_string(), false, ""));
                    }
                }
                rows.extend(plan.proposals.iter().map(|name| {
                    row(
                        &format!("proposal:{name}"),
                        &fill(&words::transfer_row_proposal(locale), &[("name", name)]),
                        "",
                        false,
                        "",
                    )
                }));
                let planned = self.stage == Stage::Planned;
                let mut actions = vec![action(
                    IMPORT,
                    &fill(
                        &words::transfer_import_action(locale),
                        &[("n", &(plan.added + plan.merged).to_string())],
                    ),
                    true,
                    planned,
                )];
                if plan.merged > 0 && plan.added > 0 {
                    actions.push(action(
                        ADD_ONLY,
                        &words::transfer_import_add_only_action(locale),
                        false,
                        planned,
                    ));
                }
                actions.push(action(
                    AGAIN,
                    &words::transfer_choose_again_action(locale),
                    false,
                    planned,
                ));
                (rows, actions, words::transfer_import_ready(locale))
            }
            (Stage::Planned, Some(_)) => {
                (Vec::new(), choose, words::transfer_import_nothing(locale))
            }
            (Stage::Done, Some(plan)) => (
                Vec::new(),
                choose,
                fill(
                    &words::transfer_import_done(locale),
                    &[("n", &plan.added.to_string())],
                ),
            ),
            _ => (Vec::new(), choose, words::transfer_import_headline(locale)),
        }
    }
}

impl Screen for Transfer {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
                Vec::new()
            }
            Some(E::Transfer(tapped)) => match (self.export, tapped.key.as_str()) {
                (false, FILES) if self.stage != Stage::Writing => Self::pick(),
                (false, AGAIN) if self.stage == Stage::Planned => {
                    self.stage = Stage::Choosing;
                    self.plan = None;
                    self.files.clear();
                    Vec::new()
                }
                (false, IMPORT) if self.stage == Stage::Planned => {
                    self.write(ctx, true);
                    Vec::new()
                }
                (false, ADD_ONLY) if self.stage == Stage::Planned => {
                    self.write(ctx, false);
                    Vec::new()
                }
                (true, key) if self.stage != Stage::Writing && !key.is_empty() => {
                    self.export_one(ctx, key)
                }
                _ => Vec::new(),
            },
            Some(E::EffectResult(result)) => {
                match result.outcome {
                    Some(wire::effect_result::Outcome::BytesPicked(ref picked)) => {
                        self.picked(ctx, picked);
                    }
                    _ if self.export => self.saved(ctx.locale(), &result),
                    _ => {}
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let (rows, actions, headline) = self.rows_and_actions(locale);
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Transfer(wire::TransferView {
                app_id: "people".to_owned(),
                title: if self.export {
                    words::transfer_export_title(locale)
                } else {
                    words::transfer_import_title(locale)
                },
                back_label: self.back.clone(),
                headline,
                lede: if self.export {
                    words::transfer_export_lede(locale)
                } else {
                    words::transfer_import_lede(locale)
                },
                rows,
                actions,
                busy: matches!(self.stage, Stage::Reading | Stage::Writing),
                status: self.status.clone(),
            })),
            ..wire::ViewState::default()
        }
    }
}
