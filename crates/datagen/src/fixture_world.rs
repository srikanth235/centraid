//! PART 2, SMALL DETERMINISTIC FIXTURE WORLDS: each intent gets the smallest deterministic
//! world it needs (referenced rows + look-alike distractors), never a whole-vault copy.
//!
//! Money worlds mix `INR`, `USD`, `EUR`, `GBP`, `AED`, `SGD` with ~40% `INR` base currency.
//! Locker rows carry presence-only `"sealed": [...]` markers on disk; synthetic secrets typed
//! by the member in Chat use safe clearly-synthetic tokens (never stored sealed values).

use jiff::ToSpan;
use jiff::civil::Date;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::declarations::CURRENCIES;
use crate::pools;
use crate::rng::Rng;
use crate::text::twin;
use crate::world::{Persona, Split, World, neighbourhood_hash_of};

const BASE_TODAY: &str = "2026-09-27";

/// Choose a currency deterministically with ~40% `INR` and the rest spread across `USD`, `EUR`, `GBP`, `AED`, `SGD`.
#[must_use]
pub fn currency_for_seed(seed: u64) -> &'static str {
    let bucket = seed % 100;
    if bucket < 40 {
        "INR"
    } else {
        let non_inr = &CURRENCIES[1..];
        non_inr[((bucket - 40) as usize) % non_inr.len()]
    }
}

/// Format a minor/major money amount appropriate for `currency` (INR amounts scaled ~80x USD).
#[must_use]
pub fn money_amount(currency: &str, usd_base: f64) -> f64 {
    let scaled = if currency == "INR" {
        (usd_base * 80.0).round()
    } else {
        (usd_base * 100.0).round() / 100.0
    };
    scaled.max(1.0)
}

/// Safe synthetic secret typed by the member in Chat (allowed per `safety.md`, never a stored sealed value).
#[must_use]
pub fn synthetic_chat_secret(seed: u64, field: &str) -> String {
    let suffix = 1000 + (seed % 8999);
    match field {
        "code" | "otp_seed" => format!("SYNTH-OTP-{suffix}"),
        "card_number" => format!("4111-0000-0000-{suffix}"),
        "cvv" => format!("{:03}", 100 + (seed % 899)),
        _ => format!("synth-{field}-{suffix}"),
    }
}

/// Deterministic civil day spread across weekdays and month boundaries by `split` and `seed`.
#[must_use]
pub fn today_for(split: Split, seed: u64) -> Date {
    let base: Date = BASE_TODAY.parse().unwrap_or_default();
    let shift = match split {
        Split::Train => 0,
        Split::Val => 3,
        Split::Test => 11,
    };
    let offset = ((seed as i64).abs() + shift) % 330;
    base.checked_add(offset.days()).unwrap_or(base)
}

/// Metadata about the primary row and distractor/container rows placed in a fixture world.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixtureTarget {
    pub kind: String,
    pub key: String,
    pub name: String,
    pub nickname: Option<String>,
    pub misspelling: Option<String>,
    pub distractor_key: Option<String>,
    pub distractor_name: Option<String>,
    pub container_kind: Option<String>,
    pub container_key: Option<String>,
    pub container_name: Option<String>,
    pub linked_kind: Option<String>,
    pub linked_key: Option<String>,
    pub linked_name: Option<String>,
    pub currency: String,
    pub today: String,
}

/// Options controlling what minimal rows a fixture world builds for an intent.
#[derive(Debug, Clone)]
pub struct FixtureRequest<'a> {
    pub split: Split,
    pub seed: u64,
    pub kind: &'a str,
    pub verb: Option<&'a str>,
    pub field: Option<&'a str>,
    pub currency: Option<&'a str>,
    /// Create a look-alike/exact-name distractor (for `ask`, `name`, `nickname`, or `ambiguity`).
    pub with_distractor: bool,
    /// Make the distractor an exact name twin so `find`/`do` triggers `ask` (ambiguous).
    pub exact_ambiguity: bool,
    /// Put a trashed row in the world (for `restore` / `purge` / `trashed=true` / `empty_trash`).
    pub trashed_target: bool,
    /// Seed a second row with different field value so filters select only the target.
    pub filter_contrast: bool,
}

impl<'a> FixtureRequest<'a> {
    #[must_use]
    pub fn simple(split: Split, seed: u64, kind: &'a str) -> Self {
        Self {
            split,
            seed,
            kind,
            verb: None,
            field: None,
            currency: None,
            with_distractor: true,
            exact_ambiguity: false,
            trashed_target: false,
            filter_contrast: true,
        }
    }
}

fn misspell(rng: &mut Rng, name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    if chars.len() >= 5 {
        for i in 1..chars.len() - 1 {
            if chars[i].is_alphabetic() && chars[i + 1].is_alphabetic() && chars[i] != chars[i + 1]
            {
                let mut swapped = chars;
                swapped.swap(i, i + 1);
                return swapped.into_iter().collect();
            }
        }
    }
    let _ = rng;
    format!("{name}x")
}

/// Build the smallest deterministic fixture world needed for `req`.
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn build(req: &FixtureRequest<'_>) -> (World, FixtureTarget) {
    let mut rng = Rng::new(req.seed).fork(&format!("fixture:{}:{}", req.split.name(), req.kind));
    let today = today_for(req.split, req.seed);
    let today_s = today.to_string();
    let yesterday_s = today.checked_sub(1.days()).unwrap_or(today).to_string();
    let tomorrow_s = today.checked_add(1.days()).unwrap_or(today).to_string();
    let last_week_s = today.checked_sub(7.days()).unwrap_or(today).to_string();
    let month_s = format!("{:04}-{:02}", today.year(), today.month());

    let me_first = match req.split {
        Split::Train => pools::ME_TRAIN,
        Split::Val => pools::ME_VAL,
        Split::Test => pools::ME_TEST,
    };
    let me = format!("{} {}", rng.pick(me_first), rng.pick(pools::LAST));
    let currency = req
        .currency
        .unwrap_or_else(|| currency_for_seed(req.seed))
        .to_owned();
    let world_id = format!(
        "w-{}-{}-{:08x}",
        req.split.name(),
        req.kind.replace(' ', "_"),
        (req.seed & 0xffff_ffff) as u32
    );

    let mut doc = Map::new();
    doc.insert("me".into(), json!(me));
    doc.insert("seed".into(), json!(world_id));
    doc.insert("today".into(), json!(today_s));
    doc.insert("epoch".into(), json!(format!("{last_week_s}T08:00")));
    doc.insert("currency".into(), json!(currency));

    // Always seed one primary person (used by people, tasks, events, contact_points, important_dates, gifts, links).
    let p_first = *rng.pick(pools::FIRST);
    let p_last = *rng.pick(pools::LAST);
    let person_name = format!("{p_first} {p_last}");
    let person_nick = format!("{}y", p_first.chars().take(3).collect::<String>());
    let mut person_row = json!({
        "key": "p_main",
        "name": person_name,
        "role": *rng.pick(pools::ROLES),
        "nickname": person_nick,
        "met": *rng.pick(pools::MET),
        "cadence": 14,
        "starred": req.verb == Some("unstar"),
        "last_contacted": format!("{yesterday_s}T11:00"),
        "last_contacted_kind": "call",
    });
    if req.trashed_target && req.kind == "person" {
        person_row["trashed"] = json!(format!("{yesterday_s}T09:00"));
    }
    let mut people = vec![person_row];
    if req.with_distractor && (req.kind == "person" || req.exact_ambiguity) {
        let d_name = if req.exact_ambiguity && req.kind == "person" {
            person_name.clone()
        } else {
            let other_last = pools::LAST
                .iter()
                .find(|l| **l != p_last)
                .copied()
                .unwrap_or("Mehta");
            format!("{p_first} {other_last}")
        };
        people.push(json!({
            "key": "p_dist",
            "name": d_name,
            "role": "colleague",
            "cadence": 30,
            "starred": false,
            "last_contacted": format!("{last_week_s}T10:00"),
            "last_contacted_kind": "message",
        }));
    }
    doc.insert("people".into(), json!(people));

    // Primary container rows when needed by tasks, notes, documents, photos, sections, or themselves.
    let list_name = rng.pick(pools::LIST_NAMES).0;
    let list_row = json!({"key": "list_main", "name": list_name, "area": "Household", "color": "blue", "icon": "List"});
    let nb_name = *rng.pick(pools::NOTEBOOKS);
    let nb_row = json!({"key": "nb_main", "name": nb_name});
    let folder_name = *rng.pick(pools::FOLDERS);
    let folder_row = json!({"key": "folder_main", "name": folder_name});
    let album_name = *rng.pick(pools::ALBUMS);
    let mut album_row = json!({"key": "album_main", "name": album_name});
    if req.trashed_target && req.kind == "album" {
        album_row["trashed"] = json!(format!("{yesterday_s}T09:00"));
    }

    let mut target = FixtureTarget {
        kind: req.kind.to_owned(),
        key: String::new(),
        name: String::new(),
        nickname: None,
        misspelling: None,
        distractor_key: None,
        distractor_name: None,
        container_kind: None,
        container_key: None,
        container_name: None,
        linked_kind: Some("person".to_owned()),
        linked_key: Some("p_main".to_owned()),
        linked_name: Some(person_name.clone()),
        currency: currency.clone(),
        today: today_s.clone(),
    };

    match req.kind {
        "person" => {
            target.key = "p_main".to_owned();
            target.name = person_name.clone();
            target.nickname = Some(person_nick);
            target.misspelling = Some(misspell(&mut rng, &person_name));
            if req.with_distractor {
                target.distractor_key = Some("p_dist".to_owned());
                target.distractor_name = doc["people"][1]["name"].as_str().map(str::to_owned);
            }
        }
        "list" => {
            let mut rows = vec![list_row];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    list_name.to_owned()
                } else {
                    "Errands".to_owned()
                };
                rows.push(json!({"key": "list_dist", "name": d_name, "area": "Career", "color": "petrol", "icon": "Flag"}));
                target.distractor_key = Some("list_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("lists".into(), json!(rows));
            target.key = "list_main".to_owned();
            target.name = list_name.to_owned();
            target.misspelling = Some(misspell(&mut rng, list_name));
        }
        "notebook" => {
            let mut rows = vec![nb_row];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    nb_name.to_owned()
                } else {
                    twin(&mut rng, nb_name)
                };
                rows.push(json!({"key": "nb_dist", "name": d_name}));
                target.distractor_key = Some("nb_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("notebooks".into(), json!(rows));
            target.key = "nb_main".to_owned();
            target.name = nb_name.to_owned();
            target.misspelling = Some(misspell(&mut rng, nb_name));
        }
        "folder" => {
            let mut rows = vec![folder_row];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    folder_name.to_owned()
                } else {
                    twin(&mut rng, folder_name)
                };
                rows.push(json!({"key": "folder_dist", "name": d_name}));
                target.distractor_key = Some("folder_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("folders".into(), json!(rows));
            target.key = "folder_main".to_owned();
            target.name = folder_name.to_owned();
            target.misspelling = Some(misspell(&mut rng, folder_name));
        }
        "album" => {
            let mut rows = vec![album_row];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    album_name.to_owned()
                } else {
                    twin(&mut rng, album_name)
                };
                rows.push(json!({"key": "album_dist", "name": d_name}));
                target.distractor_key = Some("album_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("albums".into(), json!(rows));
            target.key = "album_main".to_owned();
            target.name = album_name.to_owned();
            target.misspelling = Some(misspell(&mut rng, album_name));
        }
        "calendar" => {
            let name = "Personal Calendar";
            let mut rows = vec![
                json!({"key": "cal_main", "name": name, "color": "indigo", "icon": "Calendar"}),
            ];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    name.to_owned()
                } else {
                    "Work Calendar".to_owned()
                };
                rows.push(json!({"key": "cal_dist", "name": d_name, "color": "mustard", "icon": "Folder"}));
                target.distractor_key = Some("cal_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("calendars".into(), json!(rows));
            target.key = "cal_main".to_owned();
            target.name = name.to_owned();
            target.misspelling = Some(misspell(&mut rng, name));
        }
        "people list" => {
            let name = "Close Friends";
            let mut rows = vec![json!({"key": "pl_main", "name": name})];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    name.to_owned()
                } else {
                    "Family Circle".to_owned()
                };
                rows.push(json!({"key": "pl_dist", "name": d_name}));
                target.distractor_key = Some("pl_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("people_lists".into(), json!(rows));
            target.key = "pl_main".to_owned();
            target.name = name.to_owned();
            target.misspelling = Some(misspell(&mut rng, name));
        }
        "section" => {
            doc.insert("lists".into(), json!([list_row]));
            let name = "Urgent";
            let mut rows =
                vec![json!({"key": "sec_main", "name": name, "list": "list_main", "position": 1})];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    name.to_owned()
                } else {
                    "Backlog".to_owned()
                };
                rows.push(
                    json!({"key": "sec_dist", "name": d_name, "list": "list_main", "position": 2}),
                );
                target.distractor_key = Some("sec_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("sections".into(), json!(rows));
            target.key = "sec_main".to_owned();
            target.name = name.to_owned();
            target.container_kind = Some("list".to_owned());
            target.container_key = Some("list_main".to_owned());
            target.container_name = Some(list_name.to_owned());
            target.misspelling = Some(misspell(&mut rng, name));
        }
        "place" => {
            let name = *rng.pick(pools::CITIES);
            let mut rows = vec![
                json!({"key": "place_main", "name": name, "address": format!("12 Oak St, {name}")}),
            ];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    name.to_owned()
                } else {
                    "Porto Harbor".to_owned()
                };
                rows.push(json!({"key": "place_dist", "name": d_name, "address": format!("9 River Rd, {d_name}")}));
                target.distractor_key = Some("place_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("places".into(), json!(rows));
            target.key = "place_main".to_owned();
            target.name = name.to_owned();
            target.misspelling = Some(misspell(&mut rng, name));
        }
        "contact point" => {
            let val = format!(
                "{}.{}@example.org",
                p_first.to_lowercase(),
                p_last.to_lowercase()
            );
            let mut rows = vec![json!({
                "key": "cp_main",
                "person": "p_main",
                "channel": "email",
                "value": val,
                "label": "work",
                "preferred": true,
            })];
            if req.with_distractor {
                rows.push(json!({
                    "key": "cp_dist",
                    "person": "p_main",
                    "channel": "phone",
                    "value": "+1-555-0142",
                    "label": "mobile",
                    "preferred": false,
                }));
                target.distractor_key = Some("cp_dist".to_owned());
                target.distractor_name = Some("mobile".to_owned());
            }
            doc.insert("contact_points".into(), json!(rows));
            target.key = "cp_main".to_owned();
            target.name = "work".to_owned();
            target.misspelling = Some("wrko".to_owned());
        }
        "important date" => {
            let name = "Anniversary";
            let mut rows = vec![json!({
                "key": "imp_main",
                "person": "p_main",
                "name": name,
                "month_day": "05-14",
                "reminder_on": true,
            })];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    name.to_owned()
                } else {
                    "Work Anniversary".to_owned()
                };
                rows.push(json!({
                    "key": "imp_dist",
                    "person": "p_main",
                    "name": d_name,
                    "month_day": "09-20",
                    "reminder_on": false,
                }));
                target.distractor_key = Some("imp_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("important_dates".into(), json!(rows));
            target.key = "imp_main".to_owned();
            target.name = name.to_owned();
            target.misspelling = Some(misspell(&mut rng, name));
        }
        "gift" => {
            let name = "Ceramic coffee mug";
            let mut rows = vec![json!({"key": "gift_main", "person": "p_main", "name": name})];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    name.to_owned()
                } else {
                    "Linen scarf".to_owned()
                };
                rows.push(json!({"key": "gift_dist", "person": "p_main", "name": d_name}));
                target.distractor_key = Some("gift_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("gifts".into(), json!(rows));
            target.key = "gift_main".to_owned();
            target.name = name.to_owned();
            target.misspelling = Some(misspell(&mut rng, name));
        }
        "journal entry" => {
            let mut rows = vec![json!({
                "key": "je_main",
                "mood": "calm",
                "body": "Quiet morning walk before work.",
                "date": today_s,
            })];
            if req.with_distractor {
                rows.push(json!({
                    "key": "je_dist",
                    "mood": "focused",
                    "body": "Finished reading the quarterly plan.",
                    "date": yesterday_s,
                }));
                target.distractor_key = Some("je_dist".to_owned());
                target.distractor_name = Some("focused".to_owned());
            }
            doc.insert("journal_entries".into(), json!(rows));
            target.key = "je_main".to_owned();
            target.name = "calm".to_owned();
            target.misspelling = Some("clma".to_owned());
        }
        "event" => {
            let raw = *rng.pick(pools::EVENT_TEMPLATES);
            let city = *rng.pick(pools::CITIES);
            let name = raw.replace("{p}", &person_name).replace("{c}", city);
            let mut ev = json!({
                "key": "ev_main",
                "name": name,
                "start": format!("{tomorrow_s}T10:00"),
                "end": format!("{tomorrow_s}T11:00"),
                "description": "Scheduled session",
                "attendees": ["p_main"],
                "cancelled": req.verb == Some("restore"),
            });
            if req.trashed_target {
                ev["trashed"] = json!(format!("{yesterday_s}T09:00"));
            }
            let mut rows = vec![ev];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    name.clone()
                } else {
                    twin(&mut rng, &name)
                };
                rows.push(json!({
                    "key": "ev_dist",
                    "name": d_name,
                    "start": format!("{last_week_s}T15:00"),
                    "end": format!("{last_week_s}T16:30"),
                    "description": "Earlier meetup",
                    "cancelled": false,
                }));
                target.distractor_key = Some("ev_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("events".into(), json!(rows));
            target.key = "ev_main".to_owned();
            target.name = name.clone();
            target.misspelling = Some(misspell(&mut rng, &name));
        }
        "task" => {
            doc.insert("lists".into(), json!([list_row]));
            let raw = *rng.pick(pools::TASK_TEMPLATES);
            let city = *rng.pick(pools::CITIES);
            let name = raw.replace("{p}", &person_name).replace("{c}", city);
            let status = if req.verb == Some("reopen") {
                "done"
            } else {
                "open"
            };
            let mut t_row = json!({
                "key": "task_main",
                "name": name,
                "due": format!("{tomorrow_s}T09:00"),
                "status": status,
                "effort": 30,
                "priority": 3,
                "description": "Handle before noon",
                "list": "list_main",
                "starred": req.verb == Some("unstar"),
            });
            if status == "done" {
                t_row["completed"] = json!(format!("{yesterday_s}T18:00"));
            }
            if req.trashed_target {
                t_row["trashed"] = json!(format!("{yesterday_s}T09:00"));
            }
            let mut rows = vec![t_row];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    name.clone()
                } else {
                    twin(&mut rng, &name)
                };
                rows.push(json!({
                    "key": "task_dist",
                    "name": d_name,
                    "due": format!("{last_week_s}T14:00"),
                    "status": "done",
                    "completed": format!("{last_week_s}T16:00"),
                    "effort": 15,
                    "priority": 1,
                    "list": "list_main",
                }));
                target.distractor_key = Some("task_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("tasks".into(), json!(rows));
            target.key = "task_main".to_owned();
            target.name = name.clone();
            target.container_kind = Some("list".to_owned());
            target.container_key = Some("list_main".to_owned());
            target.container_name = Some(list_name.to_owned());
            target.misspelling = Some(misspell(&mut rng, &name));
        }
        "note" => {
            doc.insert("notebooks".into(), json!([nb_row]));
            let name = *rng.pick(pools::NOTE_TITLES);
            let mut n_row = json!({
                "key": "note_main",
                "name": name,
                "body": "Keep steps simple and clear.",
                "notebook": "nb_main",
                "pinned": false,
                "starred": req.verb == Some("unstar"),
            });
            if req.trashed_target {
                n_row["trashed"] = json!(format!("{yesterday_s}T09:00"));
            }
            let mut rows = vec![n_row];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    name.to_owned()
                } else {
                    twin(&mut rng, name)
                };
                rows.push(json!({
                    "key": "note_dist",
                    "name": d_name,
                    "body": "Draft notes from earlier.",
                    "notebook": "nb_main",
                    "pinned": true,
                }));
                target.distractor_key = Some("note_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("notes".into(), json!(rows));
            target.key = "note_main".to_owned();
            target.name = name.to_owned();
            target.container_kind = Some("notebook".to_owned());
            target.container_key = Some("nb_main".to_owned());
            target.container_name = Some(nb_name.to_owned());
            target.misspelling = Some(misspell(&mut rng, name));
        }
        "document" => {
            doc.insert("folders".into(), json!([folder_row]));
            let name = *rng.pick(pools::DOC_TITLES);
            let mut d_row = json!({
                "key": "doc_main",
                "name": name,
                "text": "Summary statement for annual records.",
                "folder": "folder_main",
                "starred": req.verb == Some("unstar"),
            });
            if req.trashed_target {
                d_row["trashed"] = json!(format!("{yesterday_s}T09:00"));
            }
            let mut rows = vec![d_row];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    name.to_owned()
                } else {
                    twin(&mut rng, name)
                };
                rows.push(json!({
                    "key": "doc_dist",
                    "name": d_name,
                    "text": "Archived reference copy.",
                    "folder": "folder_main",
                }));
                target.distractor_key = Some("doc_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("documents".into(), json!(rows));
            target.key = "doc_main".to_owned();
            target.name = name.to_owned();
            target.container_kind = Some("folder".to_owned());
            target.container_key = Some("folder_main".to_owned());
            target.container_name = Some(folder_name.to_owned());
            target.misspelling = Some(misspell(&mut rng, name));
        }
        "photo" => {
            doc.insert("albums".into(), json!([album_row]));
            let name = *rng.pick(pools::PHOTO_TITLES);
            let mut p_row = json!({
                "key": "photo_main",
                "name": name,
                "taken": format!("{yesterday_s}T17:30"),
                "albums": ["album_main"],
                "people": ["p_main"],
                "starred": req.verb == Some("unstar"),
            });
            if req.trashed_target {
                p_row["trashed"] = json!(format!("{yesterday_s}T09:00"));
            }
            let mut rows = vec![p_row];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    name.to_owned()
                } else {
                    twin(&mut rng, name)
                };
                rows.push(json!({
                    "key": "photo_dist",
                    "name": d_name,
                    "taken": format!("{last_week_s}T12:00"),
                }));
                target.distractor_key = Some("photo_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("photos".into(), json!(rows));
            target.key = "photo_main".to_owned();
            target.name = name.to_owned();
            target.container_kind = Some("album".to_owned());
            target.container_key = Some("album_main".to_owned());
            target.container_name = Some(album_name.to_owned());
            target.misspelling = Some(misspell(&mut rng, name));
        }
        "locker item" => {
            let name = rng.pick(pools::LOCKER_ITEMS).0;
            let mut l_row = json!({
                "key": "lock_main",
                "name": name,
                "type": "login",
                "username": format!("{}.user", p_first.to_lowercase()),
                "url": "https://portal.example.test",
                "notes": "Recovery backup on file",
                "starred": req.verb == Some("unstar"),
                "sealed": ["password", "code"],
            });
            if req.trashed_target {
                l_row["trashed"] = json!(format!("{yesterday_s}T09:00"));
            }
            let mut rows = vec![l_row];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    name.to_owned()
                } else {
                    twin(&mut rng, name)
                };
                rows.push(json!({
                    "key": "lock_dist",
                    "name": d_name,
                    "type": "card",
                    "sealed": ["card_number", "cvv"],
                }));
                target.distractor_key = Some("lock_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("locker".into(), json!(rows));
            target.key = "lock_main".to_owned();
            target.name = name.to_owned();
            target.misspelling = Some(misspell(&mut rng, name));
        }
        "locker field" => {
            let item_name = rng.pick(pools::LOCKER_ITEMS).0;
            doc.insert(
                "locker".into(),
                json!([{
                    "key": "lock_main",
                    "name": item_name,
                    "type": "login",
                    "username": "member.demo",
                    "sealed": ["password"],
                }]),
            );
            let mut rows = vec![json!({
                "key": "lf_main",
                "item": "lock_main",
                "name": "Account Tier",
                "field_kind": "text",
                "value": "Standard",
                "section": "Details",
                "position": 1,
            })];
            if req.with_distractor {
                rows.push(json!({
                    "key": "lf_dist",
                    "item": "lock_main",
                    "name": "Branch Code",
                    "field_kind": "text",
                    "value": "North",
                    "section": "Details",
                    "position": 2,
                }));
                target.distractor_key = Some("lf_dist".to_owned());
                target.distractor_name = Some("Branch Code".to_owned());
            }
            doc.insert("locker_fields".into(), json!(rows));
            target.key = "lf_main".to_owned();
            target.name = "Account Tier".to_owned();
            target.container_kind = Some("locker item".to_owned());
            target.container_key = Some("lock_main".to_owned());
            target.container_name = Some(item_name.to_owned());
            target.misspelling = Some("Accont Tier".to_owned());
        }
        "locker passkey" => {
            let item_name = rng.pick(pools::LOCKER_ITEMS).0;
            doc.insert(
                "locker".into(),
                json!([{
                    "key": "lock_main",
                    "name": item_name,
                    "type": "login",
                    "username": "member.demo",
                    "sealed": ["password"],
                }]),
            );
            doc.insert(
                "locker_passkeys".into(),
                json!([{
                    "key": "pk_main",
                    "item": "lock_main",
                    "rp_id": "portal.example.test",
                    "user_handle": "member.demo",
                    "display_name": item_name,
                }]),
            );
            target.key = "pk_main".to_owned();
            target.name = item_name.to_owned();
            target.container_kind = Some("locker item".to_owned());
            target.container_key = Some("lock_main".to_owned());
            target.container_name = Some(item_name.to_owned());
            target.misspelling = Some(misspell(&mut rng, item_name));
        }
        "account" => {
            let name = "Everyday Checking";
            let mut rows = vec![json!({
                "key": "acct_main",
                "name": name,
                "kind": "checking",
                "currency": currency,
            })];
            if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    name.to_owned()
                } else {
                    "Reserve Savings".to_owned()
                };
                let alt_curr = if currency == "INR" { "USD" } else { "INR" };
                rows.push(json!({
                    "key": "acct_dist",
                    "name": d_name,
                    "kind": "savings",
                    "currency": alt_curr,
                }));
                target.distractor_key = Some("acct_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("accounts".into(), json!(rows));
            target.key = "acct_main".to_owned();
            target.name = name.to_owned();
            target.misspelling = Some(misspell(&mut rng, name));
        }
        "transaction" => {
            let amt1 = money_amount(&currency, 28.0);
            let amt2 = money_amount(&currency, 64.0);
            let acct_name = "Everyday Checking";
            doc.insert(
                "accounts".into(),
                json!([{
                    "key": "acct_main",
                    "name": acct_name,
                    "kind": "checking",
                    "currency": currency,
                }]),
            );
            let merchant = rng.pick(pools::MERCHANTS).0;
            let mut tx_row = json!({
                "key": "tx_main",
                "account": "acct_main",
                "date": yesterday_s,
                "amount": -amt1,
                "name": merchant,
                "description": format!("{} POS", merchant.to_uppercase()),
                "category": "food.groceries",
            });
            if req.verb == Some("unlink")
                && let Some(obj) = tx_row.as_object_mut()
            {
                obj.remove("category");
            }
            let mut rows = vec![tx_row];
            if req.verb == Some("unlink") {
                rows.push(json!({
                    "key": "tx_pair",
                    "account": "acct_main",
                    "date": yesterday_s,
                    "amount": amt1,
                    "name": "Savings transfer",
                    "description": "INTERNAL TRANSFER",
                }));
                doc.insert(
                    "transfers".into(),
                    json!([{"a": "tx_main", "b": "tx_pair"}]),
                );
            } else if req.with_distractor {
                let d_name = if req.exact_ambiguity {
                    merchant.to_owned()
                } else {
                    "Metro Transit".to_owned()
                };
                rows.push(json!({
                    "key": "tx_dist",
                    "account": "acct_main",
                    "date": last_week_s,
                    "amount": -amt2,
                    "name": d_name,
                    "description": "TRANSIT PASS",
                    "category": "transport.transit",
                }));
                target.distractor_key = Some("tx_dist".to_owned());
                target.distractor_name = Some(d_name);
            }
            doc.insert("transactions".into(), json!(rows));
            target.key = "tx_main".to_owned();
            target.name = merchant.to_owned();
            target.container_kind = Some("account".to_owned());
            target.container_key = Some("acct_main".to_owned());
            target.container_name = Some(acct_name.to_owned());
            target.misspelling = Some(misspell(&mut rng, merchant));
        }
        "daily figure" => {
            doc.insert(
                "health_days".into(),
                json!([
                    {"day": yesterday_s, "metric": "steps", "value": 8200.0},
                    {"day": yesterday_s, "metric": "active_energy_kcal", "value": 430.0},
                    {"day": yesterday_s, "metric": "exercise_min", "value": 40.0},
                    {"day": yesterday_s, "metric": "sleep_min", "value": 455.0},
                    {"day": yesterday_s, "metric": "resting_hr_bpm", "value": 61.0},
                    {"day": yesterday_s, "metric": "weight_kg", "value": 70.2},
                    {"day": last_week_s, "metric": "steps", "value": 6100.0},
                    {"day": last_week_s, "metric": "active_energy_kcal", "value": 310.0},
                    {"day": last_week_s, "metric": "exercise_min", "value": 25.0},
                    {"day": last_week_s, "metric": "sleep_min", "value": 420.0},
                    {"day": last_week_s, "metric": "resting_hr_bpm", "value": 63.0},
                    {"day": last_week_s, "metric": "weight_kg", "value": 70.5}
                ]),
            );
            target.key = "df_main".to_owned();
            target.name = "steps".to_owned();
        }
        "workout" => {
            doc.insert(
                "workouts".into(),
                json!([
                    {
                        "key": "wo_main",
                        "kind": "running",
                        "starts": format!("{yesterday_s}T07:00:00"),
                        "ends": format!("{yesterday_s}T07:35:00"),
                        "workout": {
                            "duration_s": 2100,
                            "distance_m": 5200.0,
                            "energy_kcal": 340.0,
                            "avg_hr_bpm": 152,
                            "elevation_gain_m": 42.0
                        }
                    },
                    {
                        "key": "wo_dist",
                        "kind": "cycling",
                        "starts": format!("{last_week_s}T08:00:00"),
                        "ends": format!("{last_week_s}T08:50:00"),
                        "workout": {
                            "duration_s": 3000,
                            "distance_m": 16000.0,
                            "energy_kcal": 480.0,
                            "avg_hr_bpm": 138,
                            "elevation_gain_m": 120.0
                        }
                    }
                ]),
            );
            target.key = "wo_main".to_owned();
            target.name = "running".to_owned();
            target.distractor_key = Some("wo_dist".to_owned());
            target.distractor_name = Some("cycling".to_owned());
        }
        "category" => {
            let name = "Pet Supplies";
            let mut rows = vec![json!({"key": "cat_main", "name": name})];
            if req.with_distractor {
                rows.push(json!({"key": "cat_dist", "name": "Hobby Gear"}));
                target.distractor_key = Some("cat_dist".to_owned());
                target.distractor_name = Some("Hobby Gear".to_owned());
            }
            doc.insert("categories".into(), json!(rows));
            target.key = "cat_main".to_owned();
            target.name = name.to_owned();
            target.misspelling = Some(misspell(&mut rng, name));
        }
        "rule" => {
            let mut rows = vec![json!({
                "key": "rule_main",
                "match": "contains",
                "text": "CORNER BAKERY",
                "category": "food.dining",
                "display_name": "Corner Bakery rule",
                "position": 1,
            })];
            if req.with_distractor {
                rows.push(json!({
                    "key": "rule_dist",
                    "match": "contains",
                    "text": "METRO RAIL",
                    "category": "transport.transit",
                    "display_name": "Metro Rail rule",
                    "position": 2,
                }));
                target.distractor_key = Some("rule_dist".to_owned());
                target.distractor_name = Some("Metro Rail rule".to_owned());
            }
            doc.insert("rules".into(), json!(rows));
            target.key = "rule_main".to_owned();
            target.name = "Corner Bakery rule".to_owned();
            target.misspelling = Some("Conrer Bakery rule".to_owned());
        }
        "budget" => {
            let amt = money_amount(&currency, 350.0);
            doc.insert(
                "budgets".into(),
                json!([
                    {
                        "month": month_s,
                        "category": "food.groceries",
                        "amount": amt,
                        "carry": true
                    },
                    {
                        "month": month_s,
                        "category": "food.dining",
                        "amount": money_amount(&currency, 180.0),
                        "carry": false
                    }
                ]),
            );
            target.key = "budget_main".to_owned();
            target.name = "Groceries".to_owned();
        }
        _ => {}
    }

    let doc_val = Value::Object(doc);
    let neighbourhood_hash = neighbourhood_hash_of(&doc_val);
    let world = World {
        id: world_id,
        split: req.split,
        seed: req.seed,
        persona: Persona { me, currency },
        today: today_s,
        doc: doc_val,
        neighbourhood_hash,
    };
    (world, target)
}
