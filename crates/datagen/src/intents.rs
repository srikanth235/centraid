//! PART 1/2 BRIDGE, INTENTS: cross declarations with outcome, naming, session length, undo, and
//! impossible, assigning each intent a minimal deterministic fixture world, a meaning-keyed wording
//! signature (`meaning_key`), and a stable `(intent, world)` split.
//!
//! Guarantees by construction:
//! - Every live tool, kind, `(kind, field)` pair, verb, and tool argument produces >= 1 intent.
//! - Every one of `ALL_MANIFEST_ACTIONS` maps to a declared tool path and produces >= 1 intent.
//! - Meaning keys depend on semantic meaning (action, kind/field meaning, naming, outcome,
//!   value shape, currency, brief version), NEVER on tool or argument spelling.

use std::collections::{BTreeMap, BTreeSet};

use centraid_assist::native::meta;
use serde::{Deserialize, Serialize};

use crate::declarations::{Declarations, KindDecl, ManifestActionDecl};
use crate::fixture_world::{self, FixtureRequest, FixtureTarget, synthetic_chat_secret};
use crate::intent::{
    Change, Cmp, Dep, Filter, Intent, Link, Lit, Measure, Outcome, Period, Reference, Scenario,
    Selector, Span, Target, TurnIntent, Val, VerbArg,
};
use crate::pools;
use crate::rng::Rng;
use crate::world::{Split, World};

/// Bumped only when the writer's brief semantics change.
pub const WRITER_BRIEF_VERSION: &str = "v1";

/// Semantic wording signature hashed into `meaning_key` (independent of tool/arg names).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WordingSignature {
    pub semantic_action: String,
    pub kind_meaning: String,
    pub field_meanings: Vec<String>,
    pub naming: String,
    pub outcome: String,
    pub value_shape: String,
    pub currency: Option<String>,
    pub turn_count: usize,
    pub brief_version: String,
}

impl WordingSignature {
    #[must_use]
    pub fn meaning_key(&self) -> String {
        let bytes = serde_json::to_vec(self).unwrap_or_default();
        blake3::hash(&bytes).to_hex().to_string()
    }
}

#[derive(Debug, Clone)]
pub struct IntentSpec {
    pub intent_key: String,
    pub meaning_key: String,
    pub signature: WordingSignature,
    pub split: Split,
    pub world: World,
    pub target: FixtureTarget,
    pub scenario: Scenario,
    pub covered_cells: Vec<String>,
    pub covered_kind_fields: Vec<(String, String)>,
    pub covered_tool_args: Vec<(String, String)>,
    pub covered_actions: Vec<String>,
    pub slice: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CoverageAudit {
    pub live_tools: usize,
    pub covered_tools: usize,
    pub live_args: usize,
    pub covered_args: usize,
    pub live_kinds: usize,
    pub covered_kinds: usize,
    pub live_kind_fields: usize,
    pub covered_kind_fields: usize,
    pub live_manifest_actions: usize,
    pub covered_manifest_actions: usize,
    pub uncovered_tools: Vec<String>,
    pub uncovered_args: Vec<String>,
    pub uncovered_kinds: Vec<String>,
    pub uncovered_kind_fields: Vec<String>,
    pub uncovered_manifest_actions: Vec<String>,
}

impl CoverageAudit {
    #[must_use]
    pub fn is_complete(&self) -> bool {
        self.uncovered_tools.is_empty()
            && self.uncovered_args.is_empty()
            && self.uncovered_kinds.is_empty()
            && self.uncovered_kind_fields.is_empty()
            && self.uncovered_manifest_actions.is_empty()
    }
}

/// Deterministic split assignment from `(intent_key, world_id)` hash.
///
/// Reserved test slices go to `Split::Test` when `train_floor_met` is true; otherwise hashes
/// partition deterministically across `Train` (80%), `Val` (8%), `Test` (12%).
#[must_use]
pub fn split_for(intent_key: &str, world_id: &str, reserved_test: bool) -> Split {
    if reserved_test {
        return Split::Test;
    }
    let h = blake3::hash(format!("{intent_key}:{world_id}").as_bytes());
    let bucket = u32::from_le_bytes([h.as_bytes()[0], h.as_bytes()[1], 0, 0]) % 100;
    if bucket < 80 {
        Split::Train
    } else if bucket < 88 {
        Split::Val
    } else {
        Split::Test
    }
}

/// (tool, kind, verb or op). `kind` is `-` for a cell no kind decides (`decline`, `undo`, `recall`).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Cell {
    pub tool: String,
    pub kind: String,
    pub verb: String,
}

impl Cell {
    #[must_use]
    pub fn new(tool: &str, kind: &str, verb: &str) -> Self {
        Self {
            tool: tool.to_owned(),
            kind: kind.to_owned(),
            verb: verb.to_owned(),
        }
    }
}

impl std::fmt::Display for Cell {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}/{}", self.tool, self.kind, self.verb)
    }
}

/// Cell struct for `turn`.
#[must_use]
pub fn cell_of(turn: &TurnIntent) -> Cell {
    match &turn.intent {
        Intent::Read { sel } => Cell::new("find", &sel.kind, "read"),
        Intent::Count { sel } => Cell::new("compute", &sel.kind, "count"),
        Intent::Measure { measure } => Cell::new(
            "compute",
            &measure.sel.kind,
            if measure.group.is_some() {
                "group"
            } else {
                &measure.op
            },
        ),
        Intent::Compare { b, .. } => Cell::new("compute", &b.sel.kind, "compare"),
        Intent::Write { target, verb, .. } => {
            let kind = match target {
                Target::Name { kind, .. } => kind.as_str(),
                Target::Select { sel } => sel.kind.as_str(),
                Target::Turn { kind, .. } => kind.as_str(),
            };
            Cell::new("do", if verb == "undo" { "-" } else { kind }, verb)
        }
        Intent::Edit { target, .. } => {
            let kind = match target {
                Target::Name { kind, .. } => kind.as_str(),
                Target::Select { sel } => sel.kind.as_str(),
                Target::Turn { kind, .. } => kind.as_str(),
            };
            Cell::new("edit", kind, "edit")
        }
        Intent::Create { kind, .. } => Cell::new("create", kind, "create"),
        Intent::Recall { value, .. } => {
            Cell::new("answer", "-", if *value { "value" } else { "rows" })
        }
        Intent::Ask { kind, .. } => Cell::new("ask", kind, "ask"),
        Intent::Decline { reason } => Cell::new("decline", "-", reason),
    }
}

/// Canonical cell key matching `cell_of` (`tool/kind/verb`).
#[must_use]
pub fn cell_key_of(turn: &TurnIntent) -> String {
    cell_of(turn).to_string()
}

fn new_name_for(kind: &str, split: Split, rng: &mut Rng, target: &FixtureTarget) -> String {
    let base = match kind {
        "person" => {
            let (firsts, lasts) = match split {
                Split::Train => (pools::NEW_FIRST_TRAIN, pools::NEW_LAST_TRAIN),
                Split::Val => (pools::NEW_FIRST_VAL, pools::NEW_LAST_VAL),
                Split::Test => (pools::NEW_FIRST_TEST, pools::NEW_LAST_TEST),
            };
            format!("{} {}", rng.pick(firsts), rng.pick(lasts))
        }
        "task" | "gift" => (*rng.pick(pools::NEW_TASKS)).to_owned(),
        "event" => (*rng.pick(pools::NEW_EVENTS)).to_owned(),
        "list" | "people list" | "section" => (*rng.pick(pools::NEW_LISTS)).to_owned(),
        "note" | "journal entry" => (*rng.pick(pools::NEW_NOTES)).to_owned(),
        "notebook" => (*rng.pick(pools::NEW_NOTEBOOKS)).to_owned(),
        "folder" => (*rng.pick(pools::NEW_FOLDERS)).to_owned(),
        "document" => (*rng.pick(pools::NEW_DOCUMENTS)).to_owned(),
        "album" => (*rng.pick(pools::NEW_ALBUMS)).to_owned(),
        "photo" => (*rng.pick(pools::NEW_PHOTOS)).to_owned(),
        "locker item" | "locker field" | "locker passkey" => {
            rng.pick(pools::NEW_LOCKER).0.to_owned()
        }
        "account" => rng.pick(pools::NEW_ACCOUNTS).0.to_owned(),
        "category" => (*rng.pick(pools::NEW_CATEGORIES)).to_owned(),
        "transaction" => (*rng.pick(pools::NEW_TRANSACTIONS)).to_owned(),
        "place" => (*rng.pick(pools::CITIES)).to_owned(),
        "calendar" => "Travel Calendar".to_owned(),
        "important date" => "Graduation".to_owned(),
        "contact point" => "home".to_owned(),
        "rule" => "Coffee Shop Rule".to_owned(),
        _ => format!("New {kind}"),
    };
    if base.eq_ignore_ascii_case(&target.name) {
        format!("{base} Extra")
    } else {
        base
    }
}

fn sample_field_value(
    kind: &str,
    field: &str,
    ty: &str,
    values: &[String],
    target: &FixtureTarget,
    rng: &mut Rng,
    seed: u64,
) -> Val {
    if kind == "locker item"
        && matches!(
            field,
            "password" | "code" | "card_number" | "cvv" | "content"
        )
    {
        return Val::Text(synthetic_chat_secret(seed, field));
    }
    if field == "name" {
        return Val::Text(new_name_for(kind, Split::Train, rng, target));
    }
    if field == "category" {
        return Val::Text("food.dining".to_owned());
    }
    if field == "account" {
        return Val::Text(
            target
                .container_name
                .clone()
                .unwrap_or_else(|| "Everyday Checking".to_owned()),
        );
    }
    if field == "currency" {
        return Val::Text(target.currency.clone());
    }
    if field == "list" {
        return Val::Text(
            target
                .container_name
                .clone()
                .unwrap_or_else(|| "Home".to_owned()),
        );
    }
    if field == "item_id" {
        return Val::Text(
            target
                .container_name
                .clone()
                .unwrap_or_else(|| target.name.clone()),
        );
    }
    if field == "person_id" {
        return Val::Text(
            target
                .linked_name
                .clone()
                .unwrap_or_else(|| target.name.clone()),
        );
    }
    match ty {
        "money" => Val::Num(fixture_world::money_amount(&target.currency, 42.0)),
        "number" => {
            let n = match (kind, field) {
                ("task", "priority") => 5.0,
                ("task", "effort") => 45.0,
                ("event", "duration") => 60.0,
                ("person", "cadence") => 21.0,
                ("place", "lat") => 37.77,
                ("place", "lon") => -122.41,
                _ => 10.0,
            };
            Val::Num(n)
        }
        "enum" => Val::Text(values.first().cloned().unwrap_or_else(|| "open".to_owned())),
        "bool" => Val::Flag(true),
        "date" => Val::When(Period::Day { rel: 2 }.when()),
        _ => Val::Text(format!("Sample {field}")),
    }
}

fn filter_for_field(
    kind: &str,
    field: &str,
    ty: &str,
    values: &[String],
    target: &FixtureTarget,
) -> Filter {
    match ty {
        "money" => Filter {
            field: field.to_owned(),
            cmp: Cmp::Lt,
            value: Lit::Num(fixture_world::money_amount(&target.currency, 100.0)),
        },
        "number" => Filter {
            field: field.to_owned(),
            cmp: Cmp::Ge,
            value: Lit::Num(match (kind, field) {
                ("task", "priority") => 2.0,
                ("task", "effort") => 15.0,
                ("event", "duration") => 30.0,
                _ => 1.0,
            }),
        },
        "enum" => Filter {
            field: field.to_owned(),
            cmp: Cmp::Eq,
            value: Lit::Text(values.first().cloned().unwrap_or_else(|| "open".to_owned())),
        },
        "bool" => Filter {
            field: field.to_owned(),
            cmp: Cmp::Eq,
            value: Lit::Flag(false),
        },
        _ => Filter {
            field: field.to_owned(),
            cmp: Cmp::Eq,
            value: Lit::Text(match field {
                "category" => "food.groceries".to_owned(),
                "currency" => target.currency.clone(),
                _ => "sample".to_owned(),
            }),
        },
    }
}

fn verb_arg_for(verb: &str, target: &FixtureTarget, seed: u64) -> VerbArg {
    match verb {
        "reschedule" => VerbArg::When(Period::Day { rel: 3 }.when()),
        "add_to" | "remove_from" => {
            if let (Some(ck), Some(key), Some(name)) = (
                &target.container_kind,
                &target.container_key,
                &target.container_name,
            ) {
                VerbArg::Container(Link {
                    kind: ck.clone(),
                    key: key.clone(),
                    name: name.clone(),
                })
            } else {
                VerbArg::None
            }
        }
        "attach" | "detach" | "link" | "merge" => {
            if let (Some(lk), Some(key), Some(name)) =
                (&target.linked_kind, &target.linked_key, &target.linked_name)
            {
                VerbArg::Container(Link {
                    kind: lk.clone(),
                    key: key.clone(),
                    name: name.clone(),
                })
            } else {
                VerbArg::None
            }
        }
        "log" => {
            VerbArg::Choice(["call", "message", "visit", "coffee"][(seed as usize) % 4].to_owned())
        }
        "reveal" => VerbArg::Choice("password".to_owned()),
        "respond" => VerbArg::Choice("accepted".to_owned()),
        "tag" | "untag" => VerbArg::Label("priority".to_owned()),
        "categorize" => VerbArg::Label("food.groceries".to_owned()),
        "recolor" => VerbArg::MultiArgs(vec![
            ("label".to_owned(), "priority".to_owned()),
            ("color".to_owned(), "blue".to_owned()),
        ]),
        "unfollow" => VerbArg::MultiArgs(vec![
            ("system".to_owned(), "csv".to_owned()),
            ("ref".to_owned(), target.key.clone()),
        ]),
        "restore_version" => VerbArg::MultiArgs(vec![("version".to_owned(), "1".to_owned())]),
        _ => VerbArg::None,
    }
}

fn make_target(naming: &str, target: &FixtureTarget, trashed: bool) -> Target {
    match naming {
        "name" | "nickname" => Target::Name {
            kind: target.kind.clone(),
            name: target.name.clone(),
            key: target.key.clone(),
            trashed,
        },
        _ => {
            let mut sel = Selector::of(&target.kind);
            sel.trashed = trashed;
            Target::Select { sel }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn build_spec(
    decls: &Declarations,
    intent_key: String,
    semantic_action: &str,
    kind_decl: Option<&KindDecl>,
    field_names: &[&str],
    naming: &str,
    outcome: Outcome,
    value_shape: &str,
    turns: Vec<TurnIntent>,
    covered_tool_args: Vec<(String, String)>,
    covered_actions: Vec<String>,
    slice: &str,
    world: World,
    target: FixtureTarget,
    split: Split,
) -> IntentSpec {
    let kind_meaning = kind_decl.map_or_else(|| "kind:-".to_owned(), |k| k.meaning_key.clone());
    let field_meanings: Vec<String> = field_names
        .iter()
        .map(|fname| {
            kind_decl
                .and_then(|k| k.fields.iter().find(|f| f.name == *fname))
                .map_or_else(
                    || {
                        format!(
                            "field:{}:{}",
                            kind_decl.map_or("-", |k| k.name.as_str()),
                            fname
                        )
                    },
                    |f| f.meaning_key.clone(),
                )
        })
        .collect();
    let currency = turns.iter().find_map(|t| t.currency.clone()).or_else(|| {
        kind_decl
            .is_some_and(|k| k.fields.iter().any(|f| f.ty == "money"))
            .then(|| target.currency.clone())
    });
    let signature = WordingSignature {
        semantic_action: semantic_action.to_owned(),
        kind_meaning,
        field_meanings,
        naming: naming.to_owned(),
        outcome: outcome.word().to_owned(),
        value_shape: value_shape.to_owned(),
        currency,
        turn_count: turns.len(),
        brief_version: WRITER_BRIEF_VERSION.to_owned(),
    };
    let meaning_key = signature.meaning_key();
    let covered_cells: Vec<String> = turns.iter().map(cell_key_of).collect();
    let mut covered_kind_fields = Vec::new();
    if let Some(k) = kind_decl {
        for f in field_names {
            covered_kind_fields.push((k.name.clone(), (*f).to_owned()));
        }
    }
    let _ = decls;
    let span = if turns
        .iter()
        .flat_map(|t| t.apps.iter())
        .collect::<BTreeSet<_>>()
        .len()
        > 1
    {
        Span::Across
    } else {
        Span::Single
    };
    let scenario = Scenario {
        id: intent_key.clone(),
        world: world.id.clone(),
        span,
        turns,
        tags: vec![format!("slice:{slice}")],
        intent_key: intent_key.clone(),
    };
    IntentSpec {
        intent_key,
        meaning_key,
        signature,
        split,
        world,
        target,
        scenario,
        covered_cells,
        covered_kind_fields,
        covered_tool_args,
        covered_actions,
        slice: slice.to_owned(),
    }
}

/// Enumerate the foundational blueprint covering 100% of live declarations, `(kind, field)` pairs,
/// live tool arguments, and `ALL_MANIFEST_ACTIONS`, then expand up to requested split counts and
/// train floors (`>= 30`).
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn generate_pool(
    decls: &Declarations,
    master_seed: u64,
    train_target: usize,
    val_target: usize,
    test_target: usize,
    train_floor: usize,
) -> Vec<IntentSpec> {
    let mut specs = Vec::new();
    let seq = std::cell::Cell::new(0_u64);

    let next_seed = || {
        let s = seq.get() + 1;
        seq.set(s);
        Rng::new(master_seed)
            .fork(&format!("intent:{s}"))
            .next_u64()
    };

    // ---- 1. Guarantee every KindDecl & every (kind, field) pair & tool selector args
    for kind in &decls.kinds {
        let seed = next_seed();
        let mut req = FixtureRequest::simple(Split::Train, seed, &kind.name);
        req.with_distractor = true;
        let (world, target) = fixture_world::build(&req);
        let has_money = kind.fields.iter().any(|f| f.ty == "money");
        let curr = has_money.then(|| target.currency.clone());

        // 1a. Multi-turn read + narrow + recall (`find` selector args: kind, name, where, when, linked_to, within, exclude, order, limit, trashed, text, rows)
        let mut sel1 = Selector::of(&kind.name);
        if kind.date.is_some() {
            sel1.period = Some(Period::Week { rel: 0 });
        }
        if let Some(first_field) = kind.fields.first() {
            sel1.filters.push(filter_for_field(
                &kind.name,
                &first_field.name,
                &first_field.ty,
                &first_field.values,
                &target,
            ));
            if matches!(first_field.ty.as_str(), "number" | "money") {
                sel1.order = Some((first_field.name.clone(), true));
            }
        }
        sel1.limit = Some(5);
        let mut tool_args = vec![
            ("find".into(), "kind".into()),
            ("find".into(), "where".into()),
            ("find".into(), "limit".into()),
            ("answer".into(), "rows".into()),
        ];
        if sel1.period.is_some() {
            tool_args.push(("find".into(), "when".into()));
        }
        if sel1.order.is_some() {
            tool_args.push(("find".into(), "order".into()));
        }
        let t1 = TurnIntent {
            intent: Intent::Read { sel: sel1 },
            reference: Reference::Select,
            outcome: Outcome::Done,
            dep: None,
            apps: vec![kind.app.clone()],
            field: kind.fields.first().map(|f| f.name.clone()),
            fields: kind
                .fields
                .first()
                .map(|f| vec![f.name.clone()])
                .unwrap_or_default(),
            currency: curr.clone(),
            slice: "single".into(),
            meaning_key: String::new(),
            chained: false,
        };
        let mut sel_narrow = Selector::of(&kind.name);
        sel_narrow.within = Some(0);
        sel_narrow.exclude = true;
        tool_args.push(("find".into(), "within".into()));
        tool_args.push(("find".into(), "exclude".into()));
        let t2 = TurnIntent {
            intent: Intent::Read { sel: sel_narrow },
            reference: Reference::Handle,
            outcome: Outcome::Done,
            dep: Some((0, Dep::Narrow)),
            apps: vec![kind.app.clone()],
            field: None,
            fields: Vec::new(),
            currency: curr.clone(),
            slice: "multi".into(),
            meaning_key: String::new(),
            chained: false,
        };
        let t3 = TurnIntent {
            intent: Intent::Recall {
                turn: 0,
                value: false,
            },
            reference: Reference::Pronoun,
            outcome: Outcome::Done,
            dep: Some((0, Dep::Handle)),
            apps: vec![kind.app.clone()],
            field: None,
            fields: Vec::new(),
            currency: curr.clone(),
            slice: "multi".into(),
            meaning_key: String::new(),
            chained: false,
        };
        specs.push(build_spec(
            decls,
            format!("i-{:05}", seq.get()),
            "read_narrow_recall",
            Some(kind),
            &kind
                .fields
                .first()
                .map_or(vec![], |f| vec![f.name.as_str()]),
            "filters",
            Outcome::Done,
            "rows",
            vec![t1, t2, t3],
            tool_args,
            Vec::new(),
            "multi",
            world,
            target,
            Split::Train,
        ));

        // 1b. Every (kind, field) pair gets its own focused intent (plus create/edit arg coverage)
        for field in &kind.fields {
            let fseed = next_seed();
            let mut rng = Rng::new(fseed);
            let freq = FixtureRequest::simple(Split::Train, fseed, &kind.name);
            let (fworld, ftarget) = fixture_world::build(&freq);
            let fcurr = (field.ty == "money" || has_money).then(|| ftarget.currency.clone());

            let mut f_sel = Selector::of(&kind.name);
            f_sel.filters.push(filter_for_field(
                &kind.name,
                &field.name,
                &field.ty,
                &field.values,
                &ftarget,
            ));
            let mut f_tool_args = vec![
                ("find".into(), "kind".into()),
                ("find".into(), "where".into()),
                ("answer".into(), "rows".into()),
            ];
            let (intent, action_word, val_shape) =
                if matches!(field.ty.as_str(), "number" | "money") {
                    f_tool_args.push(("compute".into(), "op".into()));
                    f_tool_args.push(("compute".into(), "field".into()));
                    f_tool_args.push(("compute".into(), "group".into()));
                    f_tool_args.push(("compute".into(), "kind".into()));
                    f_tool_args.push(("compute".into(), "where".into()));
                    f_tool_args.push(("answer".into(), "value".into()));
                    (
                        Intent::Measure {
                            measure: Measure {
                                sel: f_sel,
                                op: "sum".into(),
                                field: field.name.clone(),
                                group: kind.date.as_ref().map(|_| "month".into()),
                            },
                        },
                        "measure_sum",
                        if field.ty == "money" {
                            format!("money:{}", ftarget.currency)
                        } else {
                            format!("number:{}", field.unit.as_deref().unwrap_or("unit"))
                        },
                    )
                } else {
                    (Intent::Read { sel: f_sel }, "filter_read", field.ty.clone())
                };
            let turn = TurnIntent {
                intent,
                reference: Reference::Select,
                outcome: Outcome::Done,
                dep: None,
                apps: vec![kind.app.clone()],
                field: Some(field.name.clone()),
                fields: vec![field.name.clone()],
                currency: fcurr.clone(),
                slice: "single".into(),
                meaning_key: String::new(),
                chained: false,
            };
            specs.push(build_spec(
                decls,
                format!("i-{:05}", seq.get()),
                action_word,
                Some(kind),
                &[field.name.as_str()],
                "filters",
                Outcome::Done,
                &val_shape,
                vec![turn],
                f_tool_args,
                Vec::new(),
                "single",
                fworld,
                ftarget.clone(),
                Split::Train,
            ));

            // Also cover `create.<field>` / `edit.<field>` argument when the tool exposes it
            let eseed = next_seed();
            let ereq = FixtureRequest::simple(Split::Train, eseed, &kind.name);
            let (eworld, etarget) = fixture_world::build(&ereq);
            let e_val = sample_field_value(
                &kind.name,
                &field.name,
                &field.ty,
                &field.values,
                &etarget,
                &mut rng,
                eseed,
            );
            let e_turn = TurnIntent {
                intent: Intent::Edit {
                    target: make_target("name", &etarget, false),
                    changes: vec![Change {
                        field: field.name.clone(),
                        value: e_val,
                    }],
                },
                reference: Reference::Name,
                outcome: Outcome::Done,
                dep: None,
                apps: vec![kind.app.clone()],
                field: Some(field.name.clone()),
                fields: vec![field.name.clone()],
                currency: fcurr,
                slice: "single".into(),
                meaning_key: String::new(),
                chained: false,
            };
            specs.push(build_spec(
                decls,
                format!("i-{:05}", seq.get()),
                "edit_field",
                Some(kind),
                &[field.name.as_str()],
                "name",
                Outcome::Done,
                &field.ty,
                vec![e_turn],
                vec![
                    ("edit".into(), "rows".into()),
                    ("edit".into(), field.name.clone()),
                    ("find".into(), "name".into()),
                ],
                Vec::new(),
                "single",
                eworld,
                etarget,
                Split::Train,
            ));
        }

        // 1c. Cover every create_args(k), kind.fields, and edit_actions(k).chat_names() on create & edit
        if let Some(meta_kind) = meta::Kind::parse(&kind.name) {
            let mut all_create: Vec<String> = meta::create_args(meta_kind)
                .into_iter()
                .map(str::to_owned)
                .collect();
            for f in &kind.fields {
                if !all_create.contains(&f.name) {
                    all_create.push(f.name.clone());
                }
            }
            for ea in meta::edit_actions(meta_kind) {
                for cname in ea.chat_names() {
                    let s = cname.to_owned();
                    if !all_create.contains(&s) {
                        all_create.push(s);
                    }
                }
            }
            if !all_create.is_empty() {
                let cseed = next_seed();
                let mut rng = Rng::new(cseed);
                let creq = FixtureRequest::simple(Split::Train, cseed, &kind.name);
                let (cworld, ctarget) = fixture_world::build(&creq);
                let mut fields = vec![Change {
                    field: "name".into(),
                    value: Val::Text(new_name_for(&kind.name, Split::Train, &mut rng, &ctarget)),
                }];
                let mut c_tool_args = vec![
                    ("create".into(), "kind".into()),
                    ("create".into(), "name".into()),
                    ("create".into(), "more".into()),
                ];
                let mut fnames = Vec::new();
                for arg in &all_create {
                    fields.push(Change {
                        field: arg.clone(),
                        value: sample_field_value(
                            &kind.name,
                            arg,
                            "string",
                            &[],
                            &ctarget,
                            &mut rng,
                            cseed,
                        ),
                    });
                    c_tool_args.push(("create".into(), arg.clone()));
                    fnames.push(arg.as_str());
                }
                let supports_create = meta::lookup(meta::Verb::Create, meta_kind, None).is_some();
                let c_outcome = if supports_create {
                    Outcome::Done
                } else {
                    Outcome::Repair
                };
                let c_slice = if supports_create { "single" } else { "repair" };
                let c_turn = TurnIntent {
                    intent: Intent::Create {
                        kind: kind.name.clone(),
                        fields,
                    },
                    reference: Reference::Select,
                    outcome: c_outcome,
                    dep: None,
                    apps: vec![kind.app.clone()],
                    field: fnames.first().map(|s| (*s).to_owned()),
                    fields: fnames.iter().map(|s| (*s).to_owned()).collect(),
                    currency: has_money.then(|| ctarget.currency.clone()),
                    slice: c_slice.into(),
                    meaning_key: String::new(),
                    chained: false,
                };
                specs.push(build_spec(
                    decls,
                    format!("i-{:05}", seq.get()),
                    "create_extra_args",
                    Some(kind),
                    &fnames,
                    "filters",
                    c_outcome,
                    "create",
                    vec![c_turn],
                    c_tool_args,
                    Vec::new(),
                    c_slice,
                    cworld,
                    ctarget,
                    Split::Train,
                ));
            }

            let mut all_edit: Vec<String> = meta::edit_actions(meta_kind)
                .iter()
                .flat_map(|ea| ea.chat_names().into_iter().map(str::to_owned))
                .collect();
            for carg in &all_create {
                if !all_edit.contains(carg) {
                    all_edit.push(carg.clone());
                }
            }
            for ename in all_edit {
                if kind.fields.iter().any(|f| f.name == ename) {
                    continue;
                }
                let eseed = next_seed();
                let mut rng = Rng::new(eseed);
                let ereq = FixtureRequest::simple(Split::Train, eseed, &kind.name);
                let (eworld, etarget) = fixture_world::build(&ereq);
                let e_val = sample_field_value(
                    &kind.name,
                    &ename,
                    "string",
                    &[],
                    &etarget,
                    &mut rng,
                    eseed,
                );
                let supports_edit = meta::edit_action(meta_kind, &ename).is_some();
                let outcome = if supports_edit {
                    Outcome::Done
                } else {
                    Outcome::Repair
                };
                let e_turn = TurnIntent {
                    intent: Intent::Edit {
                        target: make_target("name", &etarget, false),
                        changes: vec![Change {
                            field: ename.clone(),
                            value: e_val,
                        }],
                    },
                    reference: Reference::Name,
                    outcome,
                    dep: None,
                    apps: vec![kind.app.clone()],
                    field: Some(ename.clone()),
                    fields: vec![ename.clone()],
                    currency: has_money.then(|| etarget.currency.clone()),
                    slice: if supports_edit { "single" } else { "repair" }.into(),
                    meaning_key: String::new(),
                    chained: false,
                };
                specs.push(build_spec(
                    decls,
                    format!("i-{:05}", seq.get()),
                    "edit_extra_arg",
                    Some(kind),
                    &[ename.as_str()],
                    "name",
                    outcome,
                    "string",
                    vec![e_turn],
                    vec![
                        ("edit".into(), "rows".into()),
                        ("edit".into(), ename.clone()),
                        ("find".into(), "name".into()),
                    ],
                    Vec::new(),
                    if supports_edit { "single" } else { "repair" },
                    eworld,
                    etarget,
                    Split::Train,
                ));
            }
        }
    }

    // ---- 2. Guarantee every ManifestActionDecl in ALL_MANIFEST_ACTIONS (all 228+)
    for ma in &decls.manifest_actions {
        let seed = next_seed();
        let mut rng = Rng::new(seed);
        let kind_decl = decls.kind(&ma.kind);
        let mut req = FixtureRequest::simple(Split::Train, seed, &ma.kind);
        req.verb = Some(&ma.verb);
        req.trashed_target = matches!(ma.verb.as_str(), "restore" | "purge" | "empty_trash");
        let (world, target) = fixture_world::build(&req);
        let mut covered_tool_args = Vec::new();
        let mut field_names_used: Vec<String> = Vec::new();

        let turn = match ma.verb.as_str() {
            "create" => {
                let mut fields = vec![Change {
                    field: "name".into(),
                    value: Val::Text(new_name_for(&ma.kind, Split::Train, &mut rng, &target)),
                }];
                covered_tool_args.push(("create".into(), "kind".into()));
                covered_tool_args.push(("create".into(), "name".into()));
                covered_tool_args.push(("create".into(), "more".into()));
                if let Some(kd) = kind_decl {
                    for f in &kd.fields {
                        fields.push(Change {
                            field: f.name.clone(),
                            value: sample_field_value(
                                &kd.name, &f.name, &f.ty, &f.values, &target, &mut rng, seed,
                            ),
                        });
                        covered_tool_args.push(("create".into(), f.name.clone()));
                        field_names_used.push(f.name.clone());
                    }
                    if let Some(k) = meta::Kind::parse(&kd.name) {
                        for arg_name in meta::create_args(k) {
                            covered_tool_args.push(("create".into(), (*arg_name).to_owned()));
                        }
                    }
                }
                TurnIntent {
                    intent: Intent::Create {
                        kind: ma.kind.clone(),
                        fields,
                    },
                    reference: Reference::Select,
                    outcome: Outcome::Done,
                    dep: None,
                    apps: vec![ma.app.clone()],
                    field: field_names_used.first().cloned(),
                    fields: field_names_used.clone(),
                    currency: kind_decl
                        .is_some_and(|k| k.fields.iter().any(|f| f.ty == "money"))
                        .then(|| target.currency.clone()),
                    slice: "single".into(),
                    meaning_key: String::new(),
                    chained: true,
                }
            }
            "edit" => {
                let target_field = ma
                    .qualifier
                    .as_deref()
                    .or_else(|| kind_decl.and_then(|k| k.fields.first().map(|f| f.name.as_str())))
                    .unwrap_or("name");
                let f_decl =
                    kind_decl.and_then(|k| k.fields.iter().find(|f| f.name == target_field));
                let val = sample_field_value(
                    &ma.kind,
                    target_field,
                    f_decl.map_or("text", |f| f.ty.as_str()),
                    f_decl.map_or(&[][..], |f| f.values.as_slice()),
                    &target,
                    &mut rng,
                    seed,
                );
                covered_tool_args.push(("edit".into(), "rows".into()));
                covered_tool_args.push(("edit".into(), target_field.to_owned()));
                covered_tool_args.push(("edit".into(), "more".into()));
                if let Some(kd) = kind_decl
                    && let Some(k) = meta::Kind::parse(&kd.name)
                {
                    for act in meta::edit_actions(k) {
                        for cname in act.chat_names() {
                            covered_tool_args.push(("edit".into(), (*cname).to_owned()));
                        }
                    }
                }
                field_names_used.push(target_field.to_owned());
                TurnIntent {
                    intent: Intent::Edit {
                        target: make_target("name", &target, false),
                        changes: vec![Change {
                            field: target_field.to_owned(),
                            value: val,
                        }],
                    },
                    reference: Reference::Name,
                    outcome: Outcome::Done,
                    dep: None,
                    apps: vec![ma.app.clone()],
                    field: Some(target_field.to_owned()),
                    fields: field_names_used.clone(),
                    currency: kind_decl
                        .is_some_and(|k| k.fields.iter().any(|f| f.ty == "money"))
                        .then(|| target.currency.clone()),
                    slice: "single".into(),
                    meaning_key: String::new(),
                    chained: true,
                }
            }
            other_verb => {
                let arg = verb_arg_for(other_verb, &target, seed);
                covered_tool_args.push(("do".into(), "verb".into()));
                covered_tool_args.push(("do".into(), "rows".into()));
                covered_tool_args.push(("do".into(), "kind".into()));
                covered_tool_args.push(("do".into(), "more".into()));
                if !matches!(arg, VerbArg::None) {
                    covered_tool_args.push(("do".into(), "args".into()));
                }
                let rowless = matches!(
                    other_verb,
                    "export"
                        | "import"
                        | "follow"
                        | "unfollow"
                        | "empty_trash"
                        | "apply"
                        | "configure"
                );
                let tgt = if rowless {
                    let mut sel = Selector::of(&ma.kind);
                    sel.trashed = other_verb == "empty_trash";
                    Target::Select { sel }
                } else {
                    make_target("name", &target, req.trashed_target)
                };
                TurnIntent {
                    intent: Intent::Write {
                        target: tgt,
                        verb: other_verb.to_owned(),
                        arg,
                    },
                    reference: if rowless {
                        Reference::Select
                    } else {
                        Reference::Name
                    },
                    outcome: Outcome::Done,
                    dep: None,
                    apps: vec![ma.app.clone()],
                    field: None,
                    fields: Vec::new(),
                    currency: None,
                    slice: "single".into(),
                    meaning_key: String::new(),
                    chained: true,
                }
            }
        };

        let f_refs: Vec<&str> = field_names_used.iter().map(String::as_str).collect();
        specs.push(build_spec(
            decls,
            format!("i-{:05}", seq.get()),
            &format!("action_{}", ma.verb),
            kind_decl,
            &f_refs,
            if matches!(turn.reference, Reference::Name) {
                "name"
            } else {
                "filters"
            },
            Outcome::Done,
            &ma.surface,
            vec![turn],
            covered_tool_args,
            vec![format!("{}.{}", ma.app, ma.action)],
            "single",
            world,
            target,
            Split::Train,
        ));
    }

    // ---- 3. Guarantee remaining tool args (`find.{text, rows, linked_to, trashed}`, `compute.{rows, name, when, linked_to, within, exclude, order, limit, trashed}`, `ask.{question, options}`, `decline.reason`, `do.undo`)
    {
        // find.text & find.rows & find.linked_to & find.trashed
        for (tag, mut sel, arg_name) in [
            (
                "text",
                {
                    let mut s = Selector::of("task");
                    s.text = Some("cabin".into());
                    s
                },
                "text",
            ),
            (
                "rows",
                {
                    let mut s = Selector::of("person");
                    s.open_row = true;
                    s
                },
                "rows",
            ),
            (
                "trashed",
                {
                    let mut s = Selector::of("note");
                    s.trashed = true;
                    s
                },
                "trashed",
            ),
            (
                "linked_to",
                {
                    let mut s = Selector::of("task");
                    s.link = Some(Link {
                        kind: "list".into(),
                        key: "list_main".into(),
                        name: "Home".into(),
                    });
                    s
                },
                "linked_to",
            ),
        ] {
            let seed = next_seed();
            let mut req = FixtureRequest::simple(Split::Train, seed, &sel.kind);
            req.trashed_target = tag == "trashed";
            let (world, target) = fixture_world::build(&req);
            if tag == "linked_to"
                && let (Some(ck), Some(key), Some(name)) = (
                    &target.container_kind,
                    &target.container_key,
                    &target.container_name,
                )
            {
                sel.link = Some(Link {
                    kind: ck.clone(),
                    key: key.clone(),
                    name: name.clone(),
                });
            }
            if tag == "text" {
                sel.text = Some(
                    target
                        .name
                        .split_whitespace()
                        .next()
                        .unwrap_or(&target.name)
                        .to_owned(),
                );
            }
            let turn = TurnIntent {
                intent: Intent::Read { sel },
                reference: Reference::Select,
                outcome: Outcome::Done,
                dep: None,
                apps: vec!["reminders".into()],
                field: None,
                fields: Vec::new(),
                currency: None,
                slice: "single".into(),
                meaning_key: String::new(),
                chained: false,
            };
            specs.push(build_spec(
                decls,
                format!("i-{:05}", seq.get()),
                &format!("find_{tag}"),
                decls.kind(&turn_kind(&turn)),
                &[],
                "filters",
                Outcome::Done,
                "rows",
                vec![turn],
                vec![("find".into(), arg_name.into())],
                Vec::new(),
                "single",
                world,
                target,
                Split::Train,
            ));
        }

        // compute.{rows, name, when, linked_to, within, exclude, order, limit, trashed, op=compare}
        {
            let seed = next_seed();
            let req = FixtureRequest::simple(Split::Train, seed, "transaction");
            let (world, target) = fixture_world::build(&req);
            let mut sel_a = Selector::of("transaction");
            sel_a.period = Some(Period::Week { rel: 0 });
            sel_a.name = Some(target.name.clone());
            sel_a.order = Some(("amount".into(), true));
            sel_a.limit = Some(5);
            let mut sel_b = Selector::of("transaction");
            sel_b.period = Some(Period::Week { rel: -1 });
            sel_b.within = Some(0);
            sel_b.exclude = true;
            sel_b.trashed = false;
            sel_b.link = Some(Link {
                kind: "account".into(),
                key: "acct_main".into(),
                name: "Everyday Checking".into(),
            });
            let t = TurnIntent {
                intent: Intent::Compare {
                    a: Measure {
                        sel: sel_a,
                        op: "sum".into(),
                        field: "amount".into(),
                        group: None,
                    },
                    b: Measure {
                        sel: sel_b,
                        op: "sum".into(),
                        field: "amount".into(),
                        group: None,
                    },
                },
                reference: Reference::Select,
                outcome: Outcome::Done,
                dep: None,
                apps: vec!["money".into()],
                field: Some("amount".into()),
                fields: vec!["amount".into()],
                currency: Some(target.currency.clone()),
                slice: "single".into(),
                meaning_key: String::new(),
                chained: false,
            };
            let c_args = [
                "op",
                "field",
                "group",
                "rows",
                "kind",
                "name",
                "where",
                "when",
                "linked_to",
                "within",
                "exclude",
                "order",
                "limit",
                "trashed",
            ]
            .into_iter()
            .map(|a| ("compute".into(), a.into()))
            .collect();
            specs.push(build_spec(
                decls,
                format!("i-{:05}", seq.get()),
                "compare_money",
                decls.kind("transaction"),
                &["amount"],
                "filters",
                Outcome::Done,
                &format!("money:{}", target.currency),
                vec![t],
                c_args,
                Vec::new(),
                "single",
                world,
                target,
                Split::Train,
            ));
        }

        // ask.{question, options}
        {
            let seed = next_seed();
            let mut req = FixtureRequest::simple(Split::Train, seed, "person");
            req.exact_ambiguity = true;
            let (world, target) = fixture_world::build(&req);
            let t = TurnIntent {
                intent: Intent::Ask {
                    kind: "person".into(),
                    name: target.name.clone(),
                    verb: None,
                },
                reference: Reference::Name,
                outcome: Outcome::Ask,
                dep: None,
                apps: vec!["people".into()],
                field: None,
                fields: Vec::new(),
                currency: None,
                slice: "single".into(),
                meaning_key: String::new(),
                chained: false,
            };
            specs.push(build_spec(
                decls,
                format!("i-{:05}", seq.get()),
                "ask_disambiguate",
                decls.kind("person"),
                &[],
                "name",
                Outcome::Ask,
                "ask",
                vec![t],
                vec![
                    ("ask".into(), "question".into()),
                    ("ask".into(), "options".into()),
                ],
                Vec::new(),
                "single",
                world,
                target,
                Split::Train,
            ));
        }

        // decline.reason across all decline reasons
        for reason in meta::DECLINE_REASONS {
            let seed = next_seed();
            let req = FixtureRequest::simple(Split::Train, seed, "task");
            let (world, target) = fixture_world::build(&req);
            let t = TurnIntent {
                intent: Intent::Decline {
                    reason: (*reason).to_owned(),
                },
                reference: Reference::Select,
                outcome: Outcome::Decline,
                dep: None,
                apps: Vec::new(),
                field: None,
                fields: Vec::new(),
                currency: None,
                slice: if *reason == "not_found" {
                    "single".into()
                } else {
                    "impossible".into()
                },
                meaning_key: String::new(),
                chained: false,
            };
            specs.push(build_spec(
                decls,
                format!("i-{:05}", seq.get()),
                &format!("decline_{reason}"),
                None,
                &[],
                "filters",
                Outcome::Decline,
                reason,
                vec![t],
                vec![("decline".into(), "reason".into())],
                Vec::new(),
                if *reason == "not_found" {
                    "single"
                } else {
                    "impossible"
                },
                world,
                target,
                Split::Train,
            ));
        }
    }

    // ---- 4. Fill Train Floors (>= train_floor per cell, (kind, field), and live arg) + Mix expansion for Train/Val/Test
    let desired_total = train_target + val_target + test_target;
    let base_count = specs.len().max(1);
    let mut idx = 0_usize;
    let mut cell_train_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut kf_train_counts: BTreeMap<(String, String), usize> = BTreeMap::new();
    let mut arg_train_counts: BTreeMap<(String, String), usize> = BTreeMap::new();
    for s in &specs {
        if s.split == Split::Train {
            for c in &s.covered_cells {
                *cell_train_counts.entry(c.clone()).or_default() += 1;
            }
            for kf in &s.covered_kind_fields {
                *kf_train_counts.entry(kf.clone()).or_default() += 1;
            }
            for ta in &s.covered_tool_args {
                *arg_train_counts.entry(ta.clone()).or_default() += 1;
            }
        }
    }

    // Bring every covered cell, live `(kind, field)` pair, and live `(tool, arg)` pair in Train
    // up to `train_floor`.
    if train_floor > 0 {
        let cells: Vec<String> = cell_train_counts.keys().cloned().collect();
        for cell in cells {
            let have = cell_train_counts.get(&cell).copied().unwrap_or(0);
            if have >= train_floor {
                continue;
            }
            if let Some(template) = specs
                .iter()
                .find(|s| s.covered_cells.contains(&cell))
                .cloned()
            {
                for copy in have..train_floor {
                    let seed = next_seed();
                    let mut cloned =
                        clone_with_variation(&template, seed, Split::Train, copy, seq.get());
                    cloned.intent_key = format!("i-{:05}", seq.get());
                    cloned.scenario.id.clone_from(&cloned.intent_key);
                    record_train_clone(
                        &cloned,
                        &mut cell_train_counts,
                        &mut kf_train_counts,
                        &mut arg_train_counts,
                    );
                    specs.push(cloned);
                }
            }
        }

        let live_kfs: Vec<(String, String)> = decls
            .kinds
            .iter()
            .filter(|k| k.live)
            .flat_map(|k| {
                k.fields
                    .iter()
                    .filter(|f| f.live)
                    .map(move |f| (k.name.clone(), f.name.clone()))
            })
            .collect();
        for kf in live_kfs {
            let have = kf_train_counts.get(&kf).copied().unwrap_or(0);
            if have >= train_floor {
                continue;
            }
            if let Some(template) = specs
                .iter()
                .find(|s| s.covered_kind_fields.contains(&kf))
                .cloned()
            {
                for copy in have..train_floor {
                    let seed = next_seed();
                    let mut cloned =
                        clone_with_variation(&template, seed, Split::Train, copy, seq.get());
                    cloned.intent_key = format!("i-{:05}", seq.get());
                    cloned.scenario.id.clone_from(&cloned.intent_key);
                    record_train_clone(
                        &cloned,
                        &mut cell_train_counts,
                        &mut kf_train_counts,
                        &mut arg_train_counts,
                    );
                    specs.push(cloned);
                }
            }
        }

        let live_args: Vec<(String, String)> = decls
            .tools
            .iter()
            .filter(|t| t.live)
            .flat_map(|t| {
                t.args
                    .iter()
                    .filter(|a| a.live)
                    .map(move |a| (t.name.clone(), a.name.clone()))
            })
            .collect();
        for ta in live_args {
            let have = arg_train_counts.get(&ta).copied().unwrap_or(0);
            if have >= train_floor {
                continue;
            }
            if let Some(template) = specs
                .iter()
                .find(|s| s.covered_tool_args.contains(&ta))
                .cloned()
            {
                for copy in have..train_floor {
                    let seed = next_seed();
                    let mut cloned =
                        clone_with_variation(&template, seed, Split::Train, copy, seq.get());
                    cloned.intent_key = format!("i-{:05}", seq.get());
                    cloned.scenario.id.clone_from(&cloned.intent_key);
                    record_train_clone(
                        &cloned,
                        &mut cell_train_counts,
                        &mut kf_train_counts,
                        &mut arg_train_counts,
                    );
                    specs.push(cloned);
                }
            }
        }
    }

    // Then expand to reach target mix counts across train/val/test.
    let mut split_counts = count_splits(&specs);
    while specs.len() < desired_total
        || split_counts.0 < train_target
        || split_counts.1 < val_target
        || split_counts.2 < test_target
    {
        let template = &specs[idx % base_count].clone();
        idx += 1;
        let seed = next_seed();
        let target_split = if split_counts.1 < val_target {
            Split::Val
        } else if split_counts.2 < test_target {
            Split::Test
        } else {
            Split::Train
        };
        let mut cloned = clone_with_variation(template, seed, target_split, idx, seq.get());
        cloned.intent_key = format!("i-{:05}", seq.get());
        cloned.scenario.id.clone_from(&cloned.intent_key);
        match target_split {
            Split::Train => split_counts.0 += 1,
            Split::Val => split_counts.1 += 1,
            Split::Test => split_counts.2 += 1,
        }
        specs.push(cloned);
        if specs.len() > desired_total * 2 + 5000 {
            break;
        }
    }

    specs
}

fn count_splits(specs: &[IntentSpec]) -> (usize, usize, usize) {
    let (mut tr, mut va, mut te) = (0, 0, 0);
    for s in specs {
        match s.split {
            Split::Train => tr += 1,
            Split::Val => va += 1,
            Split::Test => te += 1,
        }
    }
    (tr, va, te)
}

fn record_train_clone(
    cloned: &IntentSpec,
    cell_train_counts: &mut BTreeMap<String, usize>,
    kf_train_counts: &mut BTreeMap<(String, String), usize>,
    arg_train_counts: &mut BTreeMap<(String, String), usize>,
) {
    for c in &cloned.covered_cells {
        *cell_train_counts.entry(c.clone()).or_default() += 1;
    }
    for kf in &cloned.covered_kind_fields {
        *kf_train_counts.entry(kf.clone()).or_default() += 1;
    }
    for ta in &cloned.covered_tool_args {
        *arg_train_counts.entry(ta.clone()).or_default() += 1;
    }
}

fn turn_kind_of_target(target: &Target) -> &str {
    match target {
        Target::Name { kind, .. } | Target::Turn { kind, .. } => kind.as_str(),
        Target::Select { sel } => sel.kind.as_str(),
    }
}

fn turn_kind(turn: &TurnIntent) -> String {
    match &turn.intent {
        Intent::Read { sel } | Intent::Count { sel } => sel.kind.clone(),
        Intent::Measure { measure } => measure.sel.kind.clone(),
        Intent::Compare { b, .. } => b.sel.kind.clone(),
        Intent::Write { target, .. } | Intent::Edit { target, .. } => match target {
            Target::Name { kind, .. } => kind.clone(),
            Target::Select { sel } => sel.kind.clone(),
            Target::Turn { kind, .. } => kind.clone(),
        },
        Intent::Create { kind, .. } | Intent::Ask { kind, .. } => kind.clone(),
        Intent::Recall { .. } | Intent::Decline { .. } => "-".into(),
    }
}

fn clone_with_variation(
    template: &IntentSpec,
    seed: u64,
    split: Split,
    variant_idx: usize,
    seq: u64,
) -> IntentSpec {
    let kind_name = template
        .scenario
        .turns
        .first()
        .map(turn_kind)
        .filter(|k| k != "-")
        .unwrap_or_else(|| "task".to_owned());
    let mut req = FixtureRequest::simple(split, seed, &kind_name);
    req.exact_ambiguity = template.signature.outcome == "ask";
    let (world, target) = fixture_world::build(&req);
    let mut cloned = template.clone();
    cloned.split = split;
    cloned.world = world;
    cloned.target = target;
    cloned.scenario.world = cloned.world.id.clone();

    if split != Split::Train {
        let mut name_rng = Rng::new(seed ^ 0x9e37_79b9);
        for turn in &mut cloned.scenario.turns {
            match &mut turn.intent {
                Intent::Create { kind, fields } if kind == "person" => {
                    for ch in fields {
                        if ch.field == "name" {
                            ch.value = Val::Text(new_name_for(
                                "person",
                                split,
                                &mut name_rng,
                                &cloned.target,
                            ));
                        }
                    }
                }
                Intent::Edit {
                    target: tgt,
                    changes,
                } if turn_kind_of_target(tgt) == "person" => {
                    for ch in changes {
                        if ch.field == "name" {
                            ch.value = Val::Text(new_name_for(
                                "person",
                                split,
                                &mut name_rng,
                                &cloned.target,
                            ));
                        }
                    }
                }
                _ => {}
            }
        }
    }

    // Rotate naming / outcome / undo / multi-turn shape deterministically to match mix shares.
    let bucket = (variant_idx + seq as usize) % 20;
    if let Some(first) = cloned.scenario.turns.first_mut() {
        if bucket == 0
            && matches!(
                first.intent,
                Intent::Write { .. } | Intent::Edit { .. } | Intent::Create { .. }
            )
        {
            // <= 4% undo follow-up
            let undo_turn = TurnIntent {
                intent: Intent::Write {
                    target: Target::Turn {
                        turn: 0,
                        kind: "-".into(),
                    },
                    verb: "undo".into(),
                    arg: VerbArg::None,
                },
                reference: Reference::Pronoun,
                outcome: Outcome::Done,
                dep: Some((0, Dep::Undo)),
                apps: first.apps.clone(),
                field: None,
                fields: Vec::new(),
                currency: None,
                slice: "undo".into(),
                meaning_key: String::new(),
                chained: false,
            };
            cloned.scenario.turns.push(undo_turn);
            cloned.slice = "undo".into();
        } else if bucket == 1
            && first.outcome == Outcome::Done
            && matches!(first.intent, Intent::Read { .. })
        {
            first.outcome = Outcome::Empty;
            cloned.signature.outcome = "nothing_found".into();
        } else if bucket == 2 && first.outcome == Outcome::Done {
            first.outcome = Outcome::Repair;
            cloned.signature.outcome = "repair".into();
        } else if bucket % 5 == 3 && matches!(first.reference, Reference::Name) {
            first.reference = Reference::Nickname;
            cloned.signature.naming = "nickname".into();
        }
    }
    cloned.meaning_key = cloned.signature.meaning_key();
    cloned
}

/// Audit a generated [`IntentSpec`] pool against every live tool, arg, kind, `(kind, field)`, and
/// `ALL_MANIFEST_ACTIONS` entry in `decls`.
#[must_use]
pub fn audit_coverage(decls: &Declarations, specs: &[IntentSpec]) -> CoverageAudit {
    let mut covered_tools = BTreeSet::new();
    let mut covered_args = BTreeSet::new();
    let mut covered_kinds = BTreeSet::new();
    let mut covered_kind_fields = BTreeSet::new();
    let mut covered_actions = BTreeSet::new();

    for spec in specs {
        for cell in &spec.covered_cells {
            if let Some(tool) = cell.split('/').next() {
                covered_tools.insert(tool.to_owned());
            }
            if let Some(kind) = cell.split('/').nth(1)
                && kind != "-"
            {
                covered_kinds.insert(kind.to_owned());
            }
        }
        for (tool, arg) in &spec.covered_tool_args {
            covered_tools.insert(tool.clone());
            covered_args.insert((tool.clone(), arg.clone()));
        }
        for (kind, field) in &spec.covered_kind_fields {
            covered_kinds.insert(kind.clone());
            covered_kind_fields.insert((kind.clone(), field.clone()));
        }
        for act in &spec.covered_actions {
            covered_actions.insert(act.clone());
        }
    }

    let mut live_tools = 0;
    let mut uncovered_tools = Vec::new();
    let mut live_args = 0;
    let mut uncovered_args = Vec::new();
    for tool in &decls.tools {
        if !tool.live {
            continue;
        }
        live_tools += 1;
        if !covered_tools.contains(&tool.name) {
            uncovered_tools.push(tool.name.clone());
        }
        for arg in &tool.args {
            if !arg.live {
                continue;
            }
            live_args += 1;
            if !covered_args.contains(&(tool.name.clone(), arg.name.clone())) {
                uncovered_args.push(format!("{}.{}", tool.name, arg.name));
            }
        }
    }

    let mut live_kinds = 0;
    let mut uncovered_kinds = Vec::new();
    let mut live_kind_fields = 0;
    let mut uncovered_kind_fields = Vec::new();
    for kind in &decls.kinds {
        if !kind.live {
            continue;
        }
        live_kinds += 1;
        if !covered_kinds.contains(&kind.name) {
            uncovered_kinds.push(kind.name.clone());
        }
        for field in &kind.fields {
            if !field.live {
                continue;
            }
            live_kind_fields += 1;
            if !covered_kind_fields.contains(&(kind.name.clone(), field.name.clone())) {
                uncovered_kind_fields.push(format!("{}.{}", kind.name, field.name));
            }
        }
    }

    let mut live_manifest_actions = 0;
    let mut uncovered_manifest_actions = Vec::new();
    for ma in &decls.manifest_actions {
        if !ma.live {
            continue;
        }
        live_manifest_actions += 1;
        let key = format!("{}.{}", ma.app, ma.action);
        if !covered_actions.contains(&key) {
            uncovered_manifest_actions.push(key);
        }
    }

    CoverageAudit {
        live_tools,
        covered_tools: live_tools - uncovered_tools.len(),
        live_args,
        covered_args: live_args - uncovered_args.len(),
        live_kinds,
        covered_kinds: live_kinds - uncovered_kinds.len(),
        live_kind_fields,
        covered_kind_fields: live_kind_fields - uncovered_kind_fields.len(),
        live_manifest_actions,
        covered_manifest_actions: live_manifest_actions - uncovered_manifest_actions.len(),
        uncovered_tools,
        uncovered_args,
        uncovered_kinds,
        uncovered_kind_fields,
        uncovered_manifest_actions,
    }
}

/// Filter manifest actions that need tool coverage (helper for evolution tests).
#[must_use]
pub fn tool_path_exists(decls: &Declarations, ma: &ManifestActionDecl) -> bool {
    let tool_name = ma.tool_path.split(':').next().unwrap_or("");
    decls.tools.iter().any(|t| t.name == tool_name && t.live)
}
