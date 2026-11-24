//! Proof that schema evolution is cheap (Requirement 10).
//!
//! Asserts strictly on counts (never wall-clock durations):
//! 1. Renaming 1 arg -> 0 writer prompts & targets rebuilt/pass.
//! 2. Adding 1 live field -> writer prompts only for its deficit.
//! 3. Changing 1 field's meaning -> 0 new writer prompts & old examples invalidated.

use std::collections::BTreeMap;

use centraid_datagen::Catalog;
use centraid_datagen::declarations::{
    ArgClass, ArgDecl, ChangeKind, Declarations, FieldDecl, KindDecl, OpDecl, ToolDecl, ValueMaker,
    VerbDecl, classify_diff,
};
use centraid_datagen::deficit::{PlanConfig, compute_plan};
use centraid_datagen::fixture_world::{self, FixtureRequest};
use centraid_datagen::intent::{Intent, Outcome, Reference, Scenario, Selector, Span, TurnIntent};
use centraid_datagen::intents::{IntentSpec, WordingSignature};
use centraid_datagen::phrasing_cache::{
    CacheEntry, CacheScope, CachedVariant, PhrasingCache, ReaderCheck, VariantStatus, variant_id,
};
use centraid_datagen::world::Split;

fn fixture_decls() -> Declarations {
    let due_field = FieldDecl {
        name: "due".into(),
        ty: "date".into(),
        unit: None,
        values: Vec::new(),
        value_maker: ValueMaker::Date,
        live: true,
        wording_hint: "due date".into(),
        meaning_key: "field:task:primary_date".into(),
    };
    let priority_field = FieldDecl {
        name: "priority".into(),
        ty: "number".into(),
        unit: Some("1..9".into()),
        values: Vec::new(),
        value_maker: ValueMaker::Number {
            unit: Some("1..9".into()),
            min: 1.0,
            max: 9.0,
        },
        live: true,
        wording_hint: "priority 1..9".into(),
        meaning_key: "field:task:priority_numeric".into(),
    };
    Declarations {
        apps: vec!["reminders".into()],
        tools: vec![ToolDecl {
            name: "create".into(),
            ty: "tool".into(),
            value_maker: ValueMaker::ToolAction,
            live: true,
            wording_hint: "create task".into(),
            meaning_key: "tool:create".into(),
            args: vec![
                ArgDecl {
                    name: "kind".into(),
                    ty: "string".into(),
                    value_maker: ValueMaker::KindName,
                    live: true,
                    wording_hint: "kind".into(),
                    meaning_key: "arg:semantic.entity_kind".into(),
                    required: true,
                    enum_values: Vec::new(),
                },
                ArgDecl {
                    name: "due".into(),
                    ty: "date".into(),
                    value_maker: ValueMaker::Date,
                    live: true,
                    wording_hint: "due date".into(),
                    meaning_key: "arg:field.create.primary_date".into(),
                    required: false,
                    enum_values: Vec::new(),
                },
                ArgDecl {
                    name: "priority".into(),
                    ty: "number".into(),
                    value_maker: ValueMaker::Number {
                        unit: Some("1..9".into()),
                        min: 1.0,
                        max: 9.0,
                    },
                    live: true,
                    wording_hint: "priority".into(),
                    meaning_key: "arg:field.create.priority_numeric".into(),
                    required: false,
                    enum_values: Vec::new(),
                },
            ],
        }],
        kinds: vec![KindDecl {
            name: "task".into(),
            plural: "tasks".into(),
            app: "reminders".into(),
            date: Some("due".into()),
            fields: vec![due_field, priority_field],
            links: Vec::new(),
            verbs: vec!["create".into()],
            trash: true,
            container: false,
            ty: "kind".into(),
            value_maker: ValueMaker::KindName,
            live: true,
            wording_hint: "tasks".into(),
            meaning_key: "kind:reminders:task".into(),
        }],
        verbs: vec![VerbDecl {
            name: "complete".into(),
            arg: ArgClass::None,
            choices: Vec::new(),
            kinds: vec!["task".into()],
            ty: "verb".into(),
            value_maker: ValueMaker::VerbName,
            live: true,
            wording_hint: "complete task".into(),
            meaning_key: "verb:complete".into(),
        }],
        ops: vec![OpDecl {
            name: "count".into(),
            ty: "op".into(),
            value_maker: ValueMaker::OpName,
            live: true,
            wording_hint: "count".into(),
            meaning_key: "op:count".into(),
        }],
        manifest_actions: Vec::new(),
        lists: BTreeMap::new(),
        titles: BTreeMap::new(),
        sealed: Vec::new(),
    }
}

fn fixture_pool(decls: &Declarations) -> Vec<IntentSpec> {
    let mut specs = Vec::new();
    let task_kind = decls.kind("task").expect("task");
    for (idx, field) in task_kind.fields.iter().enumerate() {
        let req = FixtureRequest::simple(Split::Train, (idx as u64) + 1, "task");
        let (world, target) = fixture_world::build(&req);
        let sig = WordingSignature {
            semantic_action: "read_tasks".into(),
            kind_meaning: task_kind.meaning_key.clone(),
            field_meanings: vec![field.meaning_key.clone()],
            naming: "filters".into(),
            outcome: "done".into(),
            value_shape: field.ty.clone(),
            currency: None,
            turn_count: 1,
            brief_version: "v1".into(),
        };
        let mk = sig.meaning_key();
        specs.push(IntentSpec {
            intent_key: format!("fx-{idx}"),
            meaning_key: mk.clone(),
            signature: sig,
            split: Split::Train,
            world: world.clone(),
            target,
            scenario: Scenario {
                id: format!("fx-{idx}"),
                world: world.id.clone(),
                span: Span::Single,
                turns: vec![TurnIntent {
                    intent: Intent::Read {
                        sel: Selector::of("task"),
                    },
                    reference: Reference::Select,
                    outcome: Outcome::Done,
                    dep: None,
                    apps: vec!["reminders".into()],
                    field: Some(field.name.clone()),
                    fields: vec![field.name.clone()],
                    currency: None,
                    slice: "single".into(),
                    meaning_key: mk,
                    chained: false,
                }],
                tags: Vec::new(),
                intent_key: format!("fx-{idx}"),
            },
            covered_cells: vec!["find/task/read".into()],
            covered_kind_fields: vec![("task".into(), field.name.clone())],
            covered_tool_args: vec![("create".into(), field.name.clone())],
            covered_actions: Vec::new(),
            slice: "single".into(),
        });
    }
    specs
}

fn seed_passing_cache(cache: &PhrasingCache, specs: &[IntentSpec]) {
    for spec in specs {
        let msgs = vec![format!("show tasks for {}", spec.intent_key)];
        cache
            .put(CacheEntry {
                meaning_key: spec.meaning_key.clone(),
                brief_version: "v1".into(),
                scope: CacheScope::Train,
                signature: spec.signature.clone(),
                variants: vec![CachedVariant {
                    id: variant_id(&spec.meaning_key, &msgs),
                    messages: msgs,
                    style: "terse".into(),
                    writer: "test-writer".into(),
                    reader: None,
                    reader_check: ReaderCheck::ResolverSettled,
                    world_id: spec.world.id.clone(),
                    world_neighbourhood_hash: spec.world.neighbourhood_hash.clone(),
                    currency_ok: true,
                    oracle_ok: true,
                    status: VariantStatus::Passing,
                }],
            })
            .expect("cache put");
    }
}

#[test]
fn renaming_one_arg_requires_zero_writer_prompts_and_rebuilds_targets() {
    let prev = fixture_decls();
    let mut curr = prev.clone();
    // Rename `due` -> `deadline` and reorder args on `create`, keeping the same `meaning_key`!
    curr.kinds[0].fields[0].name = "deadline".into();
    curr.tools[0].args[1].name = "deadline".into();
    curr.tools[0].args.swap(1, 2);

    let diff = classify_diff(&prev, &curr);
    assert_eq!(diff.by_kind(ChangeKind::Added).len(), 0);
    assert_eq!(diff.by_kind(ChangeKind::ChangedMeaning).len(), 0);
    assert_eq!(diff.by_kind(ChangeKind::Removed).len(), 0);
    assert!(diff.by_kind(ChangeKind::Rename).len() >= 2);

    let tmp = tempfile::tempdir().expect("tempdir");
    let train_cache = PhrasingCache::open(tmp.path(), CacheScope::Train).expect("train");
    let heldout_cache = PhrasingCache::open(tmp.path(), CacheScope::Heldout).expect("heldout");
    let pool = fixture_pool(&curr);
    seed_passing_cache(&train_cache, &pool);

    let catalog = Catalog::from_declarations(&curr);
    let cfg = PlanConfig {
        refresh_rate: 0.0,
        train_floor: 1,
        train_target: 2,
        val_target: 0,
        test_target: 0,
        ..PlanConfig::default()
    };
    let plan = compute_plan(
        &curr,
        Some(&prev),
        &catalog,
        &pool,
        &train_cache,
        &heldout_cache,
        &cfg,
    )
    .expect("plan");

    assert_eq!(
        plan.total_writer_prompts(),
        0,
        "renaming/reordering an arg must trigger 0 writer prompts"
    );
    assert!(
        plan.targets_to_rebuild > 0,
        "renamed targets must be scheduled for runtime target rebuild"
    );
}

#[test]
fn adding_one_live_field_prompts_only_for_its_deficit() {
    let prev = fixture_decls();
    let mut curr = prev.clone();
    curr.kinds[0].fields.push(FieldDecl {
        name: "notes".into(),
        ty: "text".into(),
        unit: None,
        values: Vec::new(),
        value_maker: ValueMaker::Text {
            pool: "task.notes".into(),
        },
        live: true,
        wording_hint: "task notes".into(),
        meaning_key: "field:task:notes".into(),
    });
    curr.tools[0].args.push(ArgDecl {
        name: "notes".into(),
        ty: "string".into(),
        value_maker: ValueMaker::Text {
            pool: "task.notes".into(),
        },
        live: true,
        wording_hint: "task notes".into(),
        meaning_key: "arg:field.create.notes".into(),
        required: false,
        enum_values: Vec::new(),
    });

    let diff = classify_diff(&prev, &curr);
    assert_eq!(diff.by_kind(ChangeKind::Added).len(), 2);

    let tmp = tempfile::tempdir().expect("tempdir");
    let train_cache = PhrasingCache::open(tmp.path(), CacheScope::Train).expect("train");
    let heldout_cache = PhrasingCache::open(tmp.path(), CacheScope::Heldout).expect("heldout");
    // Seed cache ONLY for the previous declarations' pool!
    seed_passing_cache(&train_cache, &fixture_pool(&prev));

    let curr_pool = fixture_pool(&curr);
    let catalog = Catalog::from_declarations(&curr);
    let cfg = PlanConfig {
        refresh_rate: 0.0,
        train_floor: 1,
        train_target: 3,
        val_target: 0,
        test_target: 0,
        ..PlanConfig::default()
    };
    let plan = compute_plan(
        &curr,
        Some(&prev),
        &catalog,
        &curr_pool,
        &train_cache,
        &heldout_cache,
        &cfg,
    )
    .expect("plan");

    assert_eq!(
        plan.total_writer_prompts(),
        1,
        "only the 1 newly added field's deficit should emit a writer prompt"
    );
    assert_eq!(plan.train_writer_prompts[0].intent_key, "fx-2");
}

#[test]
fn changing_one_field_meaning_produces_zero_new_writer_prompts_and_invalidates_old() {
    let prev = fixture_decls();
    let mut curr = prev.clone();
    // Change `priority` from numeric 1..9 to enum low|med|high with a new semantic meaning_key!
    curr.kinds[0].fields[1].ty = "enum".into();
    curr.kinds[0].fields[1].unit = None;
    curr.kinds[0].fields[1].values = vec!["low".into(), "med".into(), "high".into()];
    curr.kinds[0].fields[1].value_maker = ValueMaker::Enum {
        values: vec!["low".into(), "med".into(), "high".into()],
    };
    curr.kinds[0].fields[1].meaning_key = "field:task:priority_bucket".into();
    curr.tools[0].args[2].ty = "string".into();
    curr.tools[0].args[2].enum_values = vec!["low".into(), "med".into(), "high".into()];
    curr.tools[0].args[2].meaning_key = "arg:field.create.priority_bucket".into();

    let diff = classify_diff(&prev, &curr);
    assert!(
        !diff.by_kind(ChangeKind::ChangedMeaning).is_empty(),
        "expected ChangedMeaning classification"
    );

    let tmp = tempfile::tempdir().expect("tempdir");
    let train_cache = PhrasingCache::open(tmp.path(), CacheScope::Train).expect("train");
    let heldout_cache = PhrasingCache::open(tmp.path(), CacheScope::Heldout).expect("heldout");
    let prev_pool = fixture_pool(&prev);
    seed_passing_cache(&train_cache, &prev_pool);

    let catalog = Catalog::from_declarations(&curr);
    let cfg = PlanConfig {
        refresh_rate: 0.0,
        train_floor: 1,
        train_target: 2,
        val_target: 0,
        test_target: 0,
        ..PlanConfig::default()
    };
    let plan = compute_plan(
        &curr,
        Some(&prev),
        &catalog,
        &prev_pool,
        &train_cache,
        &heldout_cache,
        &cfg,
    )
    .expect("plan");

    assert_eq!(
        plan.total_writer_prompts(),
        0,
        "ChangedMeaning must emit 0 new writer prompts"
    );
    assert!(
        plan.invalidated_keys_count > 0,
        "ChangedMeaning must invalidate affected examples"
    );
}
