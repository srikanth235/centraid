//! PEOPLE'S IMPORT (`people.import`; #1173, item 20), the kit's transfer screen over People's
//! vCard import. The export is the kit's one export screen (`export.rs`).
//!
//! **Import is choose → preview → tap.** The picked `.vcf` text is held here while
//! `person.import_vcf` is asked with `dry_run`, which writes nothing and answers how many people
//! are new, how many match someone the vault already has (a PROPOSAL to merge: it fills blanks and
//! adds missing numbers and addresses, and replaces nothing), and how many are already there. The
//! member's tap writes; "Add new only" writes the new people and leaves every match alone. A
//! second import of the same file adds nothing.

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;

use crate::catalog::act;
use crate::kit::act as kit_act;
use crate::kit::transfer::{self, TextFile, action, row};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, people as words};

const ACCEPT: [&str; 4] = ["vcf", "vcard", "text/vcard", "text/x-vcard"];

const FILES: &str = "files";
const AGAIN: &str = "again";
const IMPORT: &str = "import";
const ADD_ONLY: &str = "add-only";

#[must_use]
pub fn build_import(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::Transfer(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Transfer {
        back: args.back_label.clone(),
        files: Vec::new(),
        plan: None,
        stage: Stage::Choosing,
        status: None,
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
    back: String,
    files: Vec<TextFile>,
    plan: Option<Plan>,
    stage: Stage,
    status: Option<wire::StatusLine>,
}

/// The `import-vcf` request for the picked cards: the dry run and the write say the same
/// arrival, the file's name, so the vault records one origin for them.
fn import_request(
    files: &[TextFile],
    dry_run: Option<bool>,
    merge: Option<bool>,
) -> act::people::ImportVcf {
    let label = transfer::arrival_name(files);
    act::people::ImportVcf {
        cards: files
            .iter()
            .map(|file| file.text.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        dry_run,
        merge,
        arrived_system: label
            .is_some()
            .then_some(act::people::ImportVcfArrivedSystem::Vcard),
        arrived_label: label,
    }
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

    fn picked(&mut self, ctx: &Ctx, picked: &wire::BytesPicked) {
        if picked.cancelled {
            return;
        }
        self.files = transfer::picked_files(picked);
        self.status = None;
        self.stage = Stage::Reading;
        let key = kit_act::key(&["person.import_vcf", "dry"], kit_act::fresh());
        let settled = kit_act::act(ctx, import_request(&self.files, Some(true), None), &key);
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
        let settled = kit_act::act(ctx, import_request(&self.files, None, Some(merge)), &key);
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

    fn rows_and_actions(
        &self,
        locale: Locale,
    ) -> (Vec<wire::TransferRow>, Vec<wire::TransferAction>, String) {
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
            Some(E::Transfer(tapped)) => match tapped.key.as_str() {
                FILES if self.stage != Stage::Writing => Self::pick(),
                AGAIN if self.stage == Stage::Planned => {
                    self.stage = Stage::Choosing;
                    self.plan = None;
                    self.files.clear();
                    Vec::new()
                }
                IMPORT if self.stage == Stage::Planned => {
                    self.write(ctx, true);
                    Vec::new()
                }
                ADD_ONLY if self.stage == Stage::Planned => {
                    self.write(ctx, false);
                    Vec::new()
                }
                _ => Vec::new(),
            },
            Some(E::EffectResult(result)) => {
                if let Some(wire::effect_result::Outcome::BytesPicked(ref picked)) = result.outcome
                {
                    self.picked(ctx, picked);
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
                title: words::transfer_import_title(locale),
                back_label: self.back.clone(),
                headline,
                lede: words::transfer_import_lede(locale),
                rows,
                actions,
                busy: matches!(self.stage, Stage::Reading | Stage::Writing),
                status: self.status.clone(),
            })),
            ..wire::ViewState::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dry_run_and_the_write_carry_the_same_arrival() {
        let files = vec![TextFile {
            path: "Backups/contacts.vcf".to_owned(),
            text: "BEGIN:VCARD".to_owned(),
        }];
        for request in [
            import_request(&files, Some(true), None),
            import_request(&files, None, Some(true)),
        ] {
            let request: wire::ActRequest = request.into();
            let text = |key: &str| match &request.input[key].kind {
                Some(wire::value::Kind::Text(text)) => text.clone(),
                other => panic!("{key}: {other:?}"),
            };
            assert_eq!(text("arrived_system"), "vcard");
            assert_eq!(text("arrived_label"), "contacts.vcf");
        }
        let none: wire::ActRequest = import_request(&[], None, None).into();
        assert!(!none.input.contains_key("arrived_system"));
    }
}
