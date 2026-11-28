//! THE REGISTRY TEST (L7), in the place of `crates/xtask/src/promises.rs`: the kind registry and
//! the action catalogue held to the vault's own tables and to the rules of app-plane §4, §7 and §8.
//!
//! It fails a kind missing any of §8's declarations, an action with no inverse and no
//! `outlined`/`owner` class, an action neither `Direct` nor `Handoff`, a screen-only action; and
//! (in `read_registry.rs`) the failures of a read.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use centraid_domain::action::{
    ACTION_VERBS, ActionDecl, Chat, Confirm, Handoff, Inverse, MAX_TARGETS, SYSTEM_COMMANDS,
    SYSTEM_VERBS, Target, Ty,
};
use centraid_domain::chat;
use centraid_domain::kind::{Export, Footer, KindDecl, Share, Shown, Trash, Versions};
use centraid_domain::read::Shape;
use centraid_domain::{ACTIONS, KINDS, READS};
use centraid_vault::model::{KIND_SPECS, Kind};
use common::World;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

fn root() -> std::path::PathBuf {
    centraid_ontology::scratch::repo_root()
}

/// What the founded vault says about its kinds.
struct Facts {
    linkable: BTreeSet<String>,
    top: BTreeMap<String, bool>,
    homes: BTreeMap<String, BTreeSet<String>>,
    sourced: BTreeSet<String>,
    arrives: BTreeSet<String>,
    captured: BTreeSet<String>,
    trashable: BTreeSet<String>,
}

fn facts(world: &World) -> Facts {
    let connection =
        Connection::open_with_flags(world.vault.path(), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("the vault file");
    let words = |sql: &str| -> Vec<(String, String)> {
        let text = |row: &rusqlite::Row<'_>, at: usize| -> rusqlite::Result<String> {
            Ok(match row.get::<_, rusqlite::types::Value>(at)? {
                rusqlite::types::Value::Integer(number) => number.to_string(),
                rusqlite::types::Value::Text(text) => text,
                other => panic!("{other:?}"),
            })
        };
        connection
            .prepare(sql)
            .expect("a statement")
            .query_map([], |row| Ok((text(row, 0)?, text(row, 1)?)))
            .expect("rows")
            .map(Result::unwrap)
            .collect()
    };
    let mut homes: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (kind, home) in words("SELECT kind, home_kind FROM home_shape") {
        homes.entry(kind).or_default().insert(home);
    }
    let captured = words("SELECT kind, home_kind FROM home_shape WHERE kind = 'photo'")
        .into_iter()
        .map(|(_, home)| home)
        .collect();
    Facts {
        linkable: words("SELECT code, linkable FROM entity_kind WHERE linkable = 1")
            .into_iter()
            .map(|(code, _)| code)
            .collect(),
        top: words("SELECT code, may_be_top FROM entity_kind")
            .into_iter()
            .map(|(code, top)| (code, top == "1"))
            .collect(),
        homes,
        sourced: words("SELECT entity_kind, system FROM source_shape")
            .into_iter()
            .map(|(kind, _)| kind)
            .collect(),
        arrives: words("SELECT entity_kind, via FROM arrival_via_kind")
            .into_iter()
            .map(|(kind, _)| kind)
            .collect(),
        captured,
        trashable: KIND_SPECS
            .iter()
            .filter(|spec| spec.has_trash)
            .map(|spec| spec.name.to_owned())
            .collect(),
    }
}

fn ids() -> BTreeSet<&'static str> {
    KINDS.iter().map(|kind| kind.id).collect()
}

fn read_named(name: &str) -> Option<&'static centraid_domain::ReadDecl> {
    READS.iter().find(|read| read.name == name)
}

fn shown() -> Shown<'static> {
    Shown {
        noun: "note",
        title: "Dal",
        text: Some("Soak the lentils."),
    }
}

/// Everything wrong with one kind's row, as sentences. An empty answer is a kind that keeps every
/// promise of §8.
fn kind_problems(kind: &KindDecl, facts: &Facts) -> Vec<String> {
    let mut found = Vec::new();
    let mut need = |holds: bool, what: &str| {
        if !holds {
            found.push(format!("{}: {what}", kind.id));
        }
    };
    need(
        !kind.noun.trim().is_empty(),
        "P9: no noun for trash and Undo",
    );
    need(!kind.plural.trim().is_empty(), "P9: no plural for a count");
    need(!kind.app.trim().is_empty(), "no app");
    // Trash.
    let trashable = facts.trashable.contains(kind.id);
    match kind.trash {
        Trash::Listed(read) => {
            need(trashable, "P9: it lists a Trash its kind does not have");
            match read_named(read) {
                Some(decl) => {
                    need(
                        decl.shape == Shape::PagedList,
                        "P9: its Trash read is not a PagedList",
                    );
                    need(
                        decl.sql.contains(&format!("'{}'", kind.id)),
                        "P9: its Trash read does not name it",
                    );
                    need(
                        decl.sql.contains("trashed_by IS NULL"),
                        "P9: its Trash read lists a capture alone",
                    );
                }
                None => need(false, "P9: its Trash read is not a registered read"),
            }
        }
        Trash::Purged(why) => {
            need(!trashable, "P9: it has a trash and lists none");
            need(
                !why.trim().is_empty(),
                "P9: it is purged outright and says no why",
            );
        }
    }
    // Holder.
    if let Some(holder) = kind.holder {
        need(
            !holder.holds.is_empty() && !holder.counts.is_empty(),
            "N11: a holder holds nothing or counts nothing",
        );
        for count in holder.counts {
            match read_named(count) {
                Some(decl) => need(
                    decl.shape == Shape::Aggregate,
                    "N11: a held count is not an Aggregate read",
                ),
                None => need(false, "N11: its held-count read is not registered"),
            }
        }
        for held in holder.holds {
            need(
                KINDS.iter().any(|row| row.id == *held),
                "N11: it holds a kind that is not declared",
            );
        }
    }
    // Versions, export, share.
    match kind.versions {
        Versions::Kept(format) => need(
            !format(&shown()).trim().is_empty(),
            "P1: its earlier-versions formatter says nothing",
        ),
        Versions::None(why) => need(
            !why.trim().is_empty(),
            "P1: it keeps no versions and says no why",
        ),
    }
    match kind.export {
        Export::File { header, format } => {
            need(
                header.starts_with("centraid.")
                    && header
                        .rsplit_once(".v")
                        .is_some_and(|(_, version)| version.parse::<u32>().is_ok()),
                "D12: its export header carries no format version",
            );
            need(
                !format(&shown()).trim().is_empty(),
                "P4: its export formatter says nothing",
            );
        }
        Export::Within(host) => need(
            host == "vault" || ids().contains(host),
            "P4: it exports inside a kind that is not declared",
        ),
    }
    match kind.share {
        Share::Payload(format) => need(
            !format(&shown()).trim().is_empty(),
            "P4: its share formatter says nothing",
        ),
        Share::Never(why) => need(
            !why.trim().is_empty(),
            "P4: it is never shared and says no why",
        ),
    }
    if kind.id == "locker_item" {
        need(
            matches!(kind.share, Share::Never(_)),
            "P4: a Locker item cannot be shared",
        );
    }
    // Home shape, held to `home_shape` and `entity_kind`.
    let sits: BTreeSet<String> = kind
        .home
        .sits_in
        .iter()
        .map(|home| (*home).to_owned())
        .collect();
    need(
        sits == facts.homes.get(kind.id).cloned().unwrap_or_default(),
        "P8: where it may sit is not what home_shape says",
    );
    need(
        Some(&kind.home.top) == facts.top.get(kind.id),
        "P8: whether it may stand at the top is not what entity_kind says",
    );
    need(
        kind.home.capture == facts.captured.contains(kind.id),
        "S12: whether a capture may be homed in it is not what home_shape says",
    );
    // Footers, held to the vault's own tables.
    let has = |footer: Footer| kind.footers.contains(&footer);
    need(
        has(Footer::Attachments) == kind.home.capture,
        "P8: Attachments are the kinds that take a capture",
    );
    need(
        has(Footer::Linked) == facts.linkable.contains(kind.id),
        "P8: Linked are the linkable kinds",
    );
    need(
        has(Footer::MentionedIn) == facts.linkable.contains(kind.id),
        "P8: MentionedIn are the linkable kinds",
    );
    need(
        has(Footer::Says) == facts.sourced.contains(kind.id),
        "P3: Says are the followed kinds",
    );
    need(
        has(Footer::Origin) == (facts.sourced.contains(kind.id) || facts.arrives.contains(kind.id)),
        "P8: Origin are the kinds that arrive from outside",
    );
    found
}

#[test]
fn every_kind_keeps_every_promise_its_row_declares() {
    let world = World::new("registry-kinds");
    let facts = facts(&world);
    let declared: Vec<&str> = KINDS.iter().map(|kind| kind.id).collect();
    let vault: Vec<&str> = KIND_SPECS.iter().map(|spec| spec.name).collect();
    assert_eq!(declared.len(), ids().len(), "a kind is declared twice");
    assert_eq!(
        ids(),
        vault.iter().copied().collect::<BTreeSet<_>>(),
        "one row per vault entity kind"
    );
    let problems: Vec<String> = KINDS
        .iter()
        .flat_map(|kind| kind_problems(kind, &facts))
        .collect();
    assert!(problems.is_empty(), "{problems:#?}");
    // Holders are the vault's: what is a home, an account (its lines) and a person (its touches).
    let holders: BTreeSet<&str> = KINDS
        .iter()
        .filter(|kind| kind.holder.is_some())
        .map(|kind| kind.id)
        .collect();
    let mut expected: BTreeSet<&str> = facts
        .homes
        .values()
        .flatten()
        .map(String::as_str)
        .filter(|home| !matches!(*home, "tag" | "category" | "workout_kind" | "touch_kind"))
        .collect();
    expected.extend(["account", "person"]);
    assert_eq!(holders, expected, "a delete names what it takes with it");
    for kind in KINDS {
        for home in kind.home.sits_in {
            if let Some(holder) = KINDS
                .iter()
                .find(|row| row.id == *home)
                .and_then(|row| row.holder)
            {
                assert!(
                    holder.holds.contains(&kind.id),
                    "{home} holds {} and does not say so",
                    kind.id
                );
            }
        }
    }
}

#[test]
fn a_kind_missing_a_promise_fails_the_registry() {
    let world = World::new("registry-kinds-red");
    let facts = facts(&world);
    let note = *KINDS.iter().find(|kind| kind.id == "note").expect("a note");
    assert!(kind_problems(&note, &facts).is_empty());
    let nameless = KindDecl { noun: "", ..note };
    assert!(
        kind_problems(&nameless, &facts)
            .iter()
            .any(|text| text.contains("P9: no noun"))
    );
    let lost = KindDecl {
        trash: Trash::Listed("notes.nowhere"),
        ..note
    };
    assert!(
        kind_problems(&lost, &facts)
            .iter()
            .any(|text| text.contains("Trash read"))
    );
    let unsure = KindDecl {
        holder: None,
        footers: &[],
        ..note
    };
    assert!(
        !kind_problems(&unsure, &facts).is_empty(),
        "its footers are the vault's"
    );
    let silent = KindDecl {
        export: Export::Within("nowhere"),
        ..note
    };
    assert!(
        kind_problems(&silent, &facts)
            .iter()
            .any(|text| text.contains("exports inside"))
    );
    let item = *KINDS
        .iter()
        .find(|kind| kind.id == "locker_item")
        .expect("an item");
    let shared = KindDecl {
        share: Share::Payload(centraid_domain::kind::plain),
        ..item
    };
    assert!(
        kind_problems(&shared, &facts)
            .iter()
            .any(|text| text.contains("cannot be shared"))
    );
    let held = KindDecl {
        home: centraid_domain::kind::Home {
            top: false,
            ..note.home
        },
        ..note
    };
    assert!(
        kind_problems(&held, &facts)
            .iter()
            .any(|text| text.contains("stand at the top"))
    );
}

#[test]
fn a_formatter_makes_finished_plain_text() {
    let note = KINDS.iter().find(|kind| kind.id == "note").expect("a note");
    let Share::Payload(share) = note.share else {
        panic!("a note is shared");
    };
    assert_eq!(share(&shown()), "Dal\n\nSoak the lentils.");
    let Versions::Kept(earlier) = note.versions else {
        panic!("a note keeps versions");
    };
    assert_eq!(earlier(&shown()), "Earlier versions of this note");
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

fn verb_of(command: &str) -> &str {
    command.split_once('.').map_or(command, |(_, verb)| verb)
}

fn schemas(world: &World) -> BTreeMap<String, Value> {
    world
        .registry
        .names()
        .into_iter()
        .map(|name| {
            let schema = world
                .registry
                .get(name)
                .expect("a command")
                .schema()
                .clone();
            (name.to_owned(), schema)
        })
        .collect()
}

#[test]
fn the_action_verbs_and_the_system_verbs_are_the_vaults_verbs() {
    let world = World::new("registry-verbs");
    let vault: BTreeSet<&str> = world.registry.names().into_iter().map(verb_of).collect();
    let actions: BTreeSet<&str> = ACTION_VERBS.into_iter().collect();
    let system: BTreeSet<&str> = SYSTEM_VERBS.into_iter().collect();
    assert_eq!(actions.len(), 76);
    assert_eq!(system.len(), 22);
    assert!(
        actions.is_disjoint(&system),
        "a verb is an action's or a system's, never both"
    );
    let both: BTreeSet<&str> = actions.union(&system).copied().collect();
    assert_eq!(
        both, vault,
        "a new vault verb is classified: an action verb, or a system verb"
    );
}

#[test]
fn every_command_with_an_action_verb_is_an_action_and_no_system_command_is() {
    let world = World::new("registry-commands");
    let commands: BTreeSet<&str> = world.registry.names().into_iter().collect();
    let verbs: BTreeSet<&str> = ACTION_VERBS.into_iter().collect();
    let wanted: BTreeSet<&str> = commands
        .iter()
        .copied()
        .filter(|command| verbs.contains(verb_of(command)) && !SYSTEM_COMMANDS.contains(command))
        .collect();
    let wrapped: BTreeSet<&str> = ACTIONS.iter().map(|action| action.command).collect();
    assert_eq!(wanted.len(), 124);
    assert_eq!(wrapped, wanted);
    for action in ACTIONS {
        assert_eq!(
            format!("{}.{}", action.kind, action.verb),
            action.command,
            "an action's name is the command's"
        );
    }
    let mut names = BTreeSet::new();
    for action in ACTIONS {
        assert!(
            names.insert(action.name()),
            "{} is declared twice",
            action.name()
        );
    }
}

fn ty_of(schema: &Value) -> Ty {
    if let Some(words) = schema.get("enum").and_then(Value::as_array) {
        let words: Vec<&str> = words.iter().filter_map(Value::as_str).collect();
        return Ty::OneOf(Box::leak(
            words
                .into_iter()
                .map(|word| &*Box::leak(word.to_owned().into_boxed_str()))
                .collect::<Vec<&'static str>>()
                .into_boxed_slice(),
        ));
    }
    let kind = match schema.get("type") {
        Some(Value::String(kind)) => kind.clone(),
        Some(Value::Array(kinds)) => kinds
            .iter()
            .filter_map(Value::as_str)
            .find(|kind| *kind != "null")
            .unwrap_or("string")
            .to_owned(),
        _ => panic!("untyped field {schema}"),
    };
    match kind.as_str() {
        "string" => Ty::Text,
        "integer" => Ty::Int,
        "number" => Ty::Num,
        "boolean" => Ty::Bool,
        "array" => Ty::List,
        "object" => Ty::Object,
        other => panic!("unknown type {other}"),
    }
}

#[test]
fn every_actions_input_is_its_commands_own_input_type() {
    let world = World::new("registry-inputs");
    let schemas = schemas(&world);
    for action in ACTIONS {
        let schema = &schemas[action.command];
        let properties = schema["properties"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        let required: BTreeSet<&str> = schema["required"]
            .as_array()
            .map(|names| names.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let declared: BTreeSet<&str> = action.input.iter().map(|field| field.name).collect();
        assert_eq!(
            declared,
            properties
                .keys()
                .map(String::as_str)
                .collect::<BTreeSet<_>>(),
            "{}: its input has the command's fields",
            action.name()
        );
        for field in action.input {
            assert_eq!(
                field.ty,
                ty_of(&properties[field.name]),
                "{}.{}",
                action.name(),
                field.name
            );
            if field.minted {
                assert!(
                    matches!(field.name, "id" | "item_id" | "new_item_id"),
                    "{}.{}: only an id is minted",
                    action.name(),
                    field.name
                );
            } else {
                assert_eq!(
                    field.required,
                    required.contains(field.name),
                    "{}.{}",
                    action.name(),
                    field.name
                );
            }
        }
        if action.target == Target::Set {
            assert!(
                action.input.iter().any(|field| field.name == "ids"),
                "{}: a set action takes ids",
                action.name()
            );
        }
    }
    assert_eq!(MAX_TARGETS, 500);
}

/// Everything wrong with one action, as sentences.
fn action_problems(
    action: &ActionDecl,
    all: &[ActionDecl],
    verbs: &BTreeSet<String>,
) -> Vec<String> {
    let mut found = Vec::new();
    let mut need = |holds: bool, what: &str| {
        if !holds {
            found.push(format!("{}: {what}", action.name()));
        }
    };
    match action.inverse {
        Inverse::Pair(name) => need(
            all.iter().any(|row| row.name() == name),
            "its inverse is not an action",
        ),
        Inverse::Restore => {}
        Inverse::None => need(
            action.confirm != Confirm::None,
            "it has no inverse and no outlined or owner class",
        ),
    }
    match action.chat {
        Chat::Direct(say) | Chat::Card(_, say) => {
            need(
                verbs.contains(say.verb),
                "it says a verb verbs.json does not have",
            );
            need(
                !say.kinds.is_empty(),
                "it is Direct and says nothing on any kind: screen-only",
            );
            for kind in say.kinds {
                need(
                    chat::KINDS
                        .iter()
                        .any(|row| row.id == *kind && row.writable),
                    "it says a kind the model has no word for",
                );
            }
        }
        Chat::Handoff(_) => {}
    }
    for with in action.with {
        need(
            all.iter().any(|row| row.command == *with),
            "it runs a command that is not an action",
        );
    }
    found
}

fn verbs_json() -> BTreeSet<String> {
    let text =
        std::fs::read_to_string(root().join("contracts/assist/verbs.json")).expect("verbs.json");
    let json: Value = serde_json::from_str(&text).expect("JSON");
    json["verbs"]
        .as_array()
        .expect("verbs")
        .iter()
        .map(|verb| verb["name"].as_str().expect("a name").to_owned())
        .collect()
}

#[test]
fn every_action_has_an_inverse_or_asks_first_and_chat_reaches_it() {
    let verbs = verbs_json();
    let problems: Vec<String> = ACTIONS
        .iter()
        .flat_map(|action| action_problems(action, ACTIONS, &verbs))
        .collect();
    assert!(problems.is_empty(), "{problems:#?}");
}

#[test]
fn an_action_with_no_inverse_and_no_class_or_that_is_screen_only_fails() {
    let verbs = verbs_json();
    let trash = ACTIONS
        .iter()
        .find(|a| a.command == "entity.trash")
        .expect("trash");
    assert!(action_problems(trash, ACTIONS, &verbs).is_empty());
    let bare = ActionDecl {
        inverse: Inverse::None,
        ..*trash
    };
    assert!(
        action_problems(&bare, ACTIONS, &verbs)
            .iter()
            .any(|text| text.contains("no inverse"))
    );
    let asking = ActionDecl {
        inverse: Inverse::None,
        confirm: Confirm::Outlined,
        ..*trash
    };
    assert!(action_problems(&asking, ACTIONS, &verbs).is_empty());
    let lost = ActionDecl {
        inverse: Inverse::Pair("entity.nowhere"),
        ..*trash
    };
    assert!(
        action_problems(&lost, ACTIONS, &verbs)
            .iter()
            .any(|text| text.contains("not an action"))
    );
    let screen_only = ActionDecl {
        chat: Chat::Direct(centraid_domain::action::Say {
            verb: "delete",
            kinds: &[],
            qualifier: None,
            names: &[],
            fixed: &[],
            filled: &[],
        }),
        ..*trash
    };
    assert!(
        action_problems(&screen_only, ACTIONS, &verbs)
            .iter()
            .any(|text| text.contains("screen-only"))
    );
    let unsaid = ActionDecl {
        chat: Chat::Direct(centraid_domain::action::Say {
            verb: "obliterate",
            kinds: &["note"],
            qualifier: None,
            names: &[],
            fixed: &[],
            filled: &[],
        }),
        ..*trash
    };
    assert!(
        action_problems(&unsaid, ACTIONS, &verbs)
            .iter()
            .any(|text| text.contains("verbs.json"))
    );
}

#[test]
fn what_chat_says_names_one_action_and_each_action_one_verb() {
    let mut said: BTreeMap<(&str, &str, Option<&str>), String> = BTreeMap::new();
    for action in ACTIONS {
        if let Some(say) = action.says() {
            for kind in say.kinds {
                if let Some(other) = said.insert((say.verb, kind, say.qualifier), action.name()) {
                    panic!(
                        "`{} {kind}` is said by {other} and {}",
                        say.verb,
                        action.name()
                    );
                }
            }
        }
    }
}

#[test]
fn the_confirm_classes_and_the_chat_surfaces_are_the_catalogues_rules() {
    let named = |wanted: &[&str]| -> BTreeSet<String> {
        wanted.iter().map(|name| (*name).to_owned()).collect()
    };
    let by = |keep: &dyn Fn(&ActionDecl) -> bool| -> BTreeSet<String> {
        ACTIONS
            .iter()
            .filter(|action| keep(action))
            .map(ActionDecl::name)
            .collect()
    };
    let handoff = |reason: Handoff| by(&|action| action.handoff() == Some(reason));
    assert_eq!(
        handoff(Handoff::PickFile),
        named(&[
            "document.add",
            "document.replace",
            "photo.add",
            "note.import",
            "person.import_vcf",
            "person.import_csv",
            "txn.add/csv",
            "event.propose/ics",
        ])
    );
    assert_eq!(handoff(Handoff::Reveal), named(&["locker.totp_code"]));
    assert_eq!(
        handoff(Handoff::OwnerCheck),
        named(&[
            "txn.export_csv",
            "vault.export_all",
            "event.export_ics",
            "task.export_ics",
            "note.export",
            "document.export_zip",
            "photo.export_zip",
            "person.export_vcf",
            "person.export_csv",
            "health.export_csv",
            "locker.export",
        ])
    );
    assert_eq!(
        handoff(Handoff::Destructive),
        named(&[
            "entity.purge",
            "entity.empty_trash",
            "concept.merge",
            "person.merge",
            "place.merge",
            "account.edit/currency",
            "thread.clear",
        ])
    );
    // Every export asks the OS owner check, and every purge, merge and currency change asks first.
    for action in ACTIONS {
        let verb = action.verb;
        if verb.starts_with("export") {
            assert_eq!(action.confirm, Confirm::Owner, "{}", action.name());
            assert_eq!(action.inverse, Inverse::None, "{}", action.name());
        }
        if matches!(verb, "purge" | "empty_trash" | "merge") {
            assert_eq!(action.confirm, Confirm::Outlined, "{}", action.name());
            assert_eq!(action.inverse, Inverse::None, "{}", action.name());
        }
    }
    // Undo is the runtime's own: no catalogue row is `history.undo`.
    assert!(
        ACTIONS
            .iter()
            .all(|action| action.command != "history.undo")
    );
    // A set is one of the shared verbs.
    assert_eq!(
        by(&|action| action.target == Target::Set),
        named(&[
            "entity.trash",
            "entity.restore",
            "entity.move",
            "flag.set/starred",
            "flag.set/pinned",
            "flag.set/archived",
            "flag.clear/starred",
            "flag.clear/pinned",
            "flag.clear/archived",
            "tag.add",
            "tag.remove",
            "txn.categorize",
        ])
    );
}

#[test]
fn pairs_take_each_other_back() {
    let by_name: BTreeMap<String, &ActionDecl> = ACTIONS
        .iter()
        .map(|action| (action.name(), action))
        .collect();
    // A creator is taken back by trashing, or for a label purging, what the commit made; every
    // other pair is a pair both ways, or an action that is its own inverse.
    let creators = ["entity.trash", "entity.purge", "edge.remove"];
    for action in ACTIONS {
        if let Inverse::Pair(back) = action.inverse {
            if creators.contains(&back) {
                continue;
            }
            let other = by_name[back];
            assert!(
                matches!(other.inverse, Inverse::Pair(name) if name == action.name())
                    || back == action.name(),
                "{} is taken back by {back}, which does not take it back",
                action.name()
            );
        }
    }
    let currency = by_name["account.edit/currency"];
    assert_eq!(currency.confirm, Confirm::Outlined);
    assert_eq!(currency.inverse, Inverse::Pair("account.edit/currency"));
    assert!(currency.chat_is_a_card());
}

#[test]
fn tag_catalogue_matches_the_kinds_allowed_by_the_tagged_wildcard() {
    let mut expected: Vec<&str> = centraid_domain::chat::KINDS
        .iter()
        .filter(|kind| kind.writable && Kind::parse(kind.entity).is_some_and(Kind::is_link_end))
        .map(|kind| kind.id)
        .collect();
    expected.sort_unstable();
    for name in ["tag.add", "tag.remove"] {
        let action = ACTIONS
            .iter()
            .find(|action| action.name() == name)
            .expect("tag action");
        let mut actual: Vec<&str> = action
            .says()
            .expect("tag action is in the catalogue")
            .kinds
            .to_vec();
        actual.sort_unstable();
        assert_eq!(actual, expected, "{name} follows Kind::is_link_end");
    }
    let move_kinds = ACTIONS
        .iter()
        .find(|action| action.name() == "entity.move")
        .and_then(|action| action.says())
        .expect("move action")
        .kinds;
    assert!(move_kinds.contains(&"event"));
}

trait Card {
    fn chat_is_a_card(&self) -> bool;
}

impl Card for ActionDecl {
    fn chat_is_a_card(&self) -> bool {
        self.handoff() == Some(Handoff::Destructive)
    }
}

// ---------------------------------------------------------------------------------------------
// Undo, against a live vault
// ---------------------------------------------------------------------------------------------

/// Run an action's inverse by name, over the ids it was run on.
fn inverse_of(action: &str) -> &'static ActionDecl {
    let found = ACTIONS
        .iter()
        .find(|row| row.name() == action)
        .expect("an action");
    let Inverse::Pair(back) = found.inverse else {
        panic!("{action} has no paired inverse");
    };
    ACTIONS
        .iter()
        .find(|row| row.name() == back)
        .expect("its inverse")
}

#[test]
fn undo_pairs_put_a_whole_set_back_in_one_commit() {
    let world = World::new("registry-undo-set");
    let book = world.notebook("Recipes");
    let notes: Vec<String> = (0..3)
        .map(|at| world.note(&format!("Note {at}"), &book))
        .collect();
    let state = |id: &str| -> bool {
        let connection =
            Connection::open_with_flags(world.vault.path(), OpenFlags::SQLITE_OPEN_READ_ONLY)
                .expect("a file");
        connection
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM entity WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .expect("a row")
    };
    let trash = ACTIONS
        .iter()
        .find(|row| row.name() == "entity.trash")
        .expect("trash");
    world.ok(trash.command, json!({ "ids": notes }));
    assert!(notes.iter().all(|id| state(id)));
    world.ok(inverse_of("entity.trash").command, json!({ "ids": notes }));
    assert!(notes.iter().all(|id| !state(id)));
    // A set that includes one the vault refuses writes nothing.
    let refused = world.run(
        trash.command,
        json!({ "ids": [notes[0].clone(), "nobody"] }),
    );
    assert_ne!(refused.status, centraid_vault::CommandStatus::Executed);
    assert!(!state(&notes[0]), "atomic: none was written");
}

#[test]
fn the_flag_tag_edge_and_task_pairs_run_both_ways() {
    let world = World::new("registry-undo-pairs");
    let book = world.notebook("Recipes");
    let note = world.note("Dal", &book);
    let other = world.made("person.add", json!({ "title": "Neha Rao" }));
    let connection = || {
        Connection::open_with_flags(world.vault.path(), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("a file")
    };
    let starred = |id: &str| -> bool {
        connection()
            .query_row(
                "SELECT starred_at IS NOT NULL FROM entity WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .expect("a row")
    };
    world.ok(
        "flag.set",
        json!({ "ids": [note.clone()], "flag": "starred" }),
    );
    assert!(starred(&note));
    assert_eq!(inverse_of("flag.set/starred").command, "flag.clear");
    world.ok(
        inverse_of("flag.set/starred").command,
        json!({ "ids": [note.clone()], "flag": "starred" }),
    );
    assert!(!starred(&note));
    let tagged = || -> i64 {
        connection()
            .query_row(
                "SELECT count(*) FROM edge WHERE from_id = ?1 AND rel = 'tagged'",
                [&note],
                |row| row.get(0),
            )
            .expect("a count")
    };
    world.ok(
        "tag.add",
        json!({ "ids": [note.clone()], "label": "dinner" }),
    );
    assert_eq!(tagged(), 1);
    world.ok(
        inverse_of("tag.add").command,
        json!({ "ids": [note.clone()], "label": "dinner" }),
    );
    assert_eq!(tagged(), 0);
    let related = || -> i64 {
        connection()
            .query_row(
                "SELECT count(*) FROM edge WHERE from_id = ?1 AND to_id = ?2 AND rel = 'about'",
                [&note, &other],
                |row| row.get(0),
            )
            .expect("a count")
    };
    let edge = json!({ "from": note, "to": other, "rel": "about" });
    world.ok("edge.add", edge.clone());
    assert_eq!(related(), 1);
    world.ok(inverse_of("edge.add").command, edge);
    assert_eq!(related(), 0);
    let task = world.made("task.add", json!({ "title": "Buy lentils" }));
    let done = || -> bool {
        connection()
            .query_row(
                "SELECT done_at IS NOT NULL FROM task WHERE id = ?1",
                [&task],
                |row| row.get(0),
            )
            .expect("a row")
    };
    world.ok("task.complete", json!({ "id": task }));
    assert!(done());
    world.ok(inverse_of("task.complete").command, json!({ "id": task }));
    assert!(!done());
}

#[test]
fn a_currency_change_is_its_own_inverse_and_an_earlier_version_rescales_too() {
    let world = World::new("registry-currency");
    let account = world.made(
        "account.add",
        json!({ "title": "Everyday", "type": "checking", "currency": "USD", "opening_minor": 12_300, "opening_on": "2026-01-01" }),
    );
    let figure = || -> (String, i64) {
        let connection =
            Connection::open_with_flags(world.vault.path(), OpenFlags::SQLITE_OPEN_READ_ONLY)
                .expect("a file");
        connection
            .query_row(
                "SELECT currency, opening_minor FROM account WHERE id = ?1",
                [&account],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("a row")
    };
    assert_eq!(figure(), ("USD".to_owned(), 12_300));
    let change = ACTIONS
        .iter()
        .find(|row| row.name() == "account.edit/currency")
        .expect("the currency change");
    world.ok(change.command, json!({ "id": account, "currency": "JPY" }));
    assert_eq!(
        figure(),
        ("JPY".to_owned(), 123),
        "every figure kept in the account is rescaled"
    );
    // Undo: the inverse account.edit, carrying the old currency.
    let back = inverse_of("account.edit/currency");
    assert_eq!(back.command, "account.edit");
    world.ok(back.command, json!({ "id": account, "currency": "USD" }));
    assert_eq!(figure(), ("USD".to_owned(), 12_300));
    // Restoring an earlier version that changes the currency goes through the same rescale.
    world.ok(change.command, json!({ "id": account, "currency": "JPY" }));
    assert_eq!(figure().0, "JPY");
    let restore = ACTIONS
        .iter()
        .find(|row| row.name() == "history.restore_version")
        .expect("a restore");
    let earliest = {
        let connection =
            Connection::open_with_flags(world.vault.path(), OpenFlags::SQLITE_OPEN_READ_ONLY)
                .expect("a file");
        connection
            .query_row(
                "SELECT min(seq) FROM revision WHERE entity_id = ?1",
                [&account],
                |row| row.get::<_, i64>(0),
            )
            .expect("a revision")
    };
    world.ok(restore.command, json!({ "id": account, "seq": earliest }));
    assert_eq!(
        figure(),
        ("USD".to_owned(), 12_300),
        "never a bare column write"
    );
    // A relabel that would lose a fraction is refused, and writes nothing.
    world.ok(
        "account.set_opening",
        json!({ "id": account, "opening_minor": 12_345, "opening_on": "2026-01-01" }),
    );
    let refused = world.run(change.command, json!({ "id": account, "currency": "JPY" }));
    assert_ne!(refused.status, centraid_vault::CommandStatus::Executed);
    assert_eq!(figure(), ("USD".to_owned(), 12_345));
}
