//! Derives `onto.json`, the ranker's ontology tables (`src/rank.rs`), at build
//! time — mechanically, from the same sources the grammar is derived from, so
//! the table is never a hand copy:
//!
//! * `crates/evalsuite/grammar/derive/derived.json` — kinds, FK links, join
//!   tables, column shapes and enums;
//! * `crates/evalsuite/grammar/derive/terminals.json` — kind names (the
//!   grammar's naming layer) and reader fields;
//! * `crates/apps/*/manifest.json` — app names, taglines, `derivedFields`;
//! * `src/exec.rs` `EDGES` — the executor's link walks (reader-field edges the
//!   DDL does not hold as foreign keys).
//!
//! Output tables (written to `$OUT_DIR/onto.json`, keys sorted):
//!
//! * `kinds[entity] = {names, apps, words, intent, byDoor, subkinds}`
//! * `links = [{from, field, to, how, role, weight, source}]`, `how` one of
//!   `id | ids | titles | prefix`
//! * `fields[entity] = {column: {shape, values?}}`
//! * `cohorts = [{entity, field}]`
//!
//! JSON objects are read with their key order kept ([`J`]): several steps are
//! first-wins or last-wins over that order.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Value, json};

/// A JSON value whose objects keep their key order.
#[derive(Clone, Debug)]
enum J {
    Null,
    Bool(bool),
    Num(serde_json::Number),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl<'de> Deserialize<'de> for J {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = J;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("json")
            }
            fn visit_bool<E>(self, v: bool) -> Result<J, E> {
                Ok(J::Bool(v))
            }
            fn visit_i64<E>(self, v: i64) -> Result<J, E> {
                Ok(J::Num(v.into()))
            }
            fn visit_u64<E>(self, v: u64) -> Result<J, E> {
                Ok(J::Num(v.into()))
            }
            fn visit_f64<E>(self, v: f64) -> Result<J, E> {
                Ok(serde_json::Number::from_f64(v).map_or(J::Null, J::Num))
            }
            fn visit_str<E>(self, v: &str) -> Result<J, E> {
                Ok(J::Str(v.to_owned()))
            }
            fn visit_string<E>(self, v: String) -> Result<J, E> {
                Ok(J::Str(v))
            }
            fn visit_unit<E>(self) -> Result<J, E> {
                Ok(J::Null)
            }
            fn visit_none<E>(self) -> Result<J, E> {
                Ok(J::Null)
            }
            fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<J, D::Error> {
                J::deserialize(d)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<J, A::Error> {
                let mut v = Vec::new();
                while let Some(x) = a.next_element()? {
                    v.push(x);
                }
                Ok(J::Arr(v))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<J, A::Error> {
                let mut v = Vec::new();
                while let Some((k, x)) = a.next_entry()? {
                    v.push((k, x));
                }
                Ok(J::Obj(v))
            }
        }
        d.deserialize_any(V)
    }
}

static NULL: J = J::Null;

impl J {
    fn get(&self, k: &str) -> &J {
        match self {
            J::Obj(v) => v.iter().find(|(x, _)| x == k).map_or(&NULL, |(_, x)| x),
            _ => &NULL,
        }
    }
    fn s(&self) -> &str {
        match self {
            J::Str(s) => s,
            _ => "",
        }
    }
    fn arr(&self) -> &[J] {
        match self {
            J::Arr(v) => v,
            _ => &[],
        }
    }
    fn obj(&self) -> &[(String, J)] {
        match self {
            J::Obj(v) => v,
            _ => &[],
        }
    }
    /// Python truthiness.
    fn truthy(&self) -> bool {
        match self {
            J::Null => false,
            J::Bool(b) => *b,
            J::Num(n) => n.as_f64().is_some_and(|x| x != 0.0),
            J::Str(s) => !s.is_empty(),
            J::Arr(v) => !v.is_empty(),
            J::Obj(v) => !v.is_empty(),
        }
    }
    fn value(&self) -> Value {
        match self {
            J::Null => Value::Null,
            J::Bool(b) => Value::Bool(*b),
            J::Num(n) => Value::Number(n.clone()),
            J::Str(s) => Value::String(s.clone()),
            J::Arr(v) => Value::Array(v.iter().map(J::value).collect()),
            J::Obj(v) => Value::Object(v.iter().map(|(k, x)| (k.clone(), x.value())).collect()),
        }
    }
}

fn read(p: &Path) -> J {
    println!("cargo:rerun-if-changed={}", p.display());
    let s = std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    serde_json::from_str(&s).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

const STOP: &str = "a an the of to for your you as and or with from by in on its it is be all each every one own \
personal vault projection projected canonical nothing stored here data app";
const GENERIC: [&str; 5] = ["item", "thing", "important", "other", "custom"];

fn stem(w: &str) -> String {
    if w.len() > 4 && w.ends_with("ies") {
        return format!("{}y", &w[..w.len() - 3]);
    }
    if w.len() > 3 && w.ends_with('s') && !w.ends_with("ss") {
        return w[..w.len() - 1].to_owned();
    }
    w.to_owned()
}

fn words(s: &str) -> Vec<String> {
    let stop: HashSet<&str> = STOP.split_whitespace().collect();
    s.to_lowercase()
        .replace('_', " ")
        .split(|c: char| !c.is_ascii_lowercase())
        .filter(|w| !w.is_empty() && !stop.contains(w))
        .map(stem)
        .collect()
}

fn dedupe(v: &mut Vec<String>) {
    let mut seen = HashSet::new();
    v.retain(|x| seen.insert(x.clone()));
}

#[derive(Default)]
struct Kind {
    names: Vec<String>,
    apps: Vec<String>,
    words: Vec<String>,
    intent: Vec<String>,
    by_door: Vec<(String, Vec<String>)>,
    subkinds: Vec<String>,
}

struct Link {
    from: String,
    field: String,
    to: String,
    how: &'static str,
    source: &'static str,
}

/// `v['door'] in where` — `where` is a source path string (substring test) or a list.
fn door_in(door: &str, wh: &J) -> bool {
    match wh {
        J::Str(s) => s.contains(door),
        J::Arr(v) => v.iter().any(|x| x.s() == door),
        J::Obj(v) => v.iter().any(|(k, _)| k == door),
        _ => false,
    }
}

#[allow(clippy::too_many_lines)]
fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let repo = manifest_dir.join("../..");
    let d = repo.join("crates/evalsuite/grammar/derive");
    let derived = read(&d.join("derived.json"));
    let terms = read(&d.join("terminals.json"));
    let apps_dir = repo.join("crates/apps");
    println!("cargo:rerun-if-changed={}", apps_dir.display());
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&apps_dir)
        .expect("crates/apps")
        .filter_map(Result::ok)
        .map(|e| e.path().join("manifest.json"))
        .filter(|p| p.exists())
        .collect();
    paths.sort();
    let manifests: Vec<(String, J)> = paths
        .iter()
        .map(|p| {
            let m = read(p);
            (m.get("id").s().to_owned(), m)
        })
        .collect();

    // ------------------------------------------------------------ kinds
    let kind_names: Vec<(&str, &J)> = terms
        .get("kinds")
        .obj()
        .iter()
        .filter(|(_, v)| v.get("entity").s() != "*")
        .map(|(k, v)| (k.as_str(), v))
        .collect();
    let entity_of_kind: HashMap<&str, &str> = kind_names
        .iter()
        .map(|(k, v)| (*k, v.get("entity").s()))
        .collect();
    let mut primary: HashMap<&str, &str> = HashMap::new();
    for sd in derived.get("searchDomains").arr() {
        primary.insert(sd.get("app").s(), sd.get("entity").s());
    }
    let mut kinds: BTreeMap<String, Kind> = BTreeMap::new();
    for (name, v) in &kind_names {
        let ent = v.get("entity").s();
        let door = v.get("door").s();
        let k = kinds.entry(ent.to_owned()).or_default();
        k.names.push((*name).to_owned());
        let ws = words(name);
        match k.by_door.iter_mut().find(|(d, _)| d == door) {
            Some((_, l)) => l.extend(ws.iter().cloned()),
            None => k.by_door.push((door.to_owned(), ws.clone())),
        }
        k.apps.push(door.to_owned());
        for w in ws {
            k.words.push(w.clone());
            if !GENERIC.contains(&w.as_str()) {
                k.intent.push(w);
            }
        }
        let tail = ent.split('.').nth(1).unwrap_or("");
        k.words.extend(words(tail));
    }
    for (key, cols) in derived.get("predicates").obj() {
        let ent = key.split('@').next().unwrap_or("");
        let Some(k) = kinds.get_mut(ent) else {
            continue;
        };
        for col in ["type", "kind"] {
            let c = cols.get(col);
            if c.get("shape").s() == "enum" && c.get("checkValues").truthy() {
                for val in c.get("checkValues").arr() {
                    let ws = words(val.s());
                    k.words.extend(ws.iter().cloned());
                    k.subkinds.extend(ws);
                }
            }
        }
    }
    let claimed: HashSet<String> = kinds
        .values()
        .flat_map(|k| k.intent.iter().cloned())
        .collect();
    let mut tag_count: HashMap<String, usize> = HashMap::new();
    let mut tags: Vec<(String, BTreeSet<String>)> = Vec::new();
    let split = regex::Regex::new(r"\bas a projection\b|\bprojected\b|[.:;(]").expect("re");
    for (app, m) in &manifests {
        let desc = m.get("description").s();
        let first = split.find(desc).map_or(desc, |x| &desc[..x.start()]);
        let mut ws: BTreeSet<String> = words(first).into_iter().collect();
        ws.extend(words(m.get("name").s()));
        for w in &ws {
            *tag_count.entry(w.clone()).or_default() += 1;
        }
        match tags.iter_mut().find(|(a, _)| a == app) {
            Some((_, t)) => *t = ws,
            None => tags.push((app.clone(), ws)),
        }
    }
    for (app, ws) in &tags {
        let Some(ent) = primary.get(app.as_str()) else {
            continue;
        };
        let k = kinds.entry((*ent).to_owned()).or_default();
        for w in ws {
            if tag_count[w] > 1 {
                continue;
            }
            k.words.push(w.clone());
            if !claimed.contains(w) && !GENERIC.contains(&w.as_str()) {
                k.intent.push(w.clone());
            }
        }
    }
    for k in kinds.values_mut() {
        dedupe(&mut k.names);
        dedupe(&mut k.apps);
        dedupe(&mut k.words);
        dedupe(&mut k.intent);
        dedupe(&mut k.subkinds);
        for (_, l) in &mut k.by_door {
            dedupe(l);
        }
    }
    let mut sub_count: HashMap<String, usize> = HashMap::new();
    for k in kinds.values() {
        for w in k.subkinds.iter().collect::<HashSet<_>>() {
            *sub_count.entry(w.clone()).or_default() += 1;
        }
    }
    for k in kinds.values_mut() {
        k.subkinds.retain(|w| {
            !claimed.contains(w) && !GENERIC.contains(&w.as_str()) && sub_count[w] == 1
        });
    }

    // ------------------------------------------------------------ links
    let mut table_ent: HashMap<&str, &str> = HashMap::new();
    for k in derived.get("kinds").arr() {
        table_ent
            .entry(k.get("table").s())
            .or_insert(k.get("entity").s());
    }
    let mut alias: HashMap<String, Vec<String>> = HashMap::new();
    for (_, v) in &kind_names {
        if v.get("ontologyEntity").truthy() {
            alias
                .entry(v.get("ontologyEntity").s().to_owned())
                .or_default()
                .push(v.get("entity").s().to_owned());
        }
    }
    let row_ents: HashSet<&str> = entity_of_kind.values().copied().collect();
    let mut links: Vec<Link> = Vec::new();
    let add = |links: &mut Vec<Link>, frm: &str, field: &str, to: &str, how, source| {
        let fs: Vec<&str> = std::iter::once(frm)
            .chain(alias.get(frm).into_iter().flatten().map(String::as_str))
            .collect();
        let ts: Vec<&str> = std::iter::once(to)
            .chain(alias.get(to).into_iter().flatten().map(String::as_str))
            .collect();
        for f in &fs {
            for t in &ts {
                if row_ents.contains(f) && row_ents.contains(t) {
                    links.push(Link {
                        from: (*f).to_owned(),
                        field: field.to_owned(),
                        to: (*t).to_owned(),
                        how,
                        source,
                    });
                }
            }
        }
    };
    for l in derived.get("links").arr() {
        let frm = l.get("from").get("entity").s();
        let to = l.get("to").get("entity").s();
        let via = l.get("via").s();
        match l.get("direction").s() {
            "down the FK" => {
                let mut it = via.split('.');
                let (table, col) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
                if table_ent.get(table) == Some(&frm) {
                    add(&mut links, frm, col, to, "id", "fk");
                }
            }
            "through a join table" => {
                let suffix = via.rsplit('_').next().unwrap_or("");
                add(&mut links, frm, &format!("{suffix}:"), to, "prefix", "join");
            }
            _ => {}
        }
    }
    let exec = manifest_dir.join("src/exec.rs");
    println!("cargo:rerun-if-changed={}", exec.display());
    let src = std::fs::read_to_string(&exec).expect("exec.rs");
    let body = &src[src.find("pub const EDGES").expect("EDGES")..];
    let body = &body[..body.find("];").expect("EDGES end")];
    let edge = regex::Regex::new(r#"e\(\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]*)",\s*How::(\w+)"#)
        .expect("re");
    for c in edge.captures_iter(body) {
        let (frm, kname, field, how) = (&c[1], &c[2], &c[3], &c[4]);
        let Some(&to) = entity_of_kind.get(kname) else {
            continue;
        };
        if field.is_empty() {
            continue;
        }
        match how {
            "Out" => add(&mut links, frm, field, to, "id", "edges"),
            "ListOut" => add(&mut links, frm, field, to, "ids", "edges"),
            "TitlesOut" => add(&mut links, frm, field, to, "titles", "edges"),
            "Back" => add(&mut links, to, field, frm, "id", "edges"),
            "ListBack" => add(&mut links, to, field, frm, "ids", "edges"),
            "TitlesBack" => add(&mut links, to, field, frm, "titles", "edges"),
            "Obligations" => {
                add(&mut links, frm, field, "tally.obligation", "ids", "edges");
                let other = if field.contains("_me") {
                    field.replace("_me", "_them")
                } else {
                    field.to_owned()
                };
                add(&mut links, frm, &other, "tally.obligation", "ids", "edges");
            }
            "Counterparty" => {
                for col in ["to_party", "from_party"] {
                    add(&mut links, frm, col, to, "id", "edges");
                }
            }
            _ => {}
        }
    }
    // reader fields: target from the field's name or its declared inputs
    let mut kind_by_word: HashMap<String, &str> = HashMap::new();
    for (name, v) in &kind_names {
        let ent = v.get("entity").s();
        for w in words(name) {
            kind_by_word.entry(w).or_insert(ent);
        }
        kind_by_word
            .entry(stem(ent.split('.').nth(1).unwrap_or("")))
            .or_insert(ent);
    }
    let mut declared: HashMap<&str, &J> = HashMap::new();
    for (_, m) in &manifests {
        for d in m.get("derivedFields").arr() {
            declared.insert(d.get("field").s(), d);
        }
    }
    let reader = terms.get("readerFields").obj();
    let owners_of = |field: &str, wh: &J| -> Vec<String> {
        if let Some(d) = declared.get(field) {
            return vec![d.get("entity").s().to_owned()];
        }
        let s: BTreeSet<String> = kind_names
            .iter()
            .filter(|(_, v)| door_in(v.get("door").s(), wh))
            .map(|(_, v)| v.get("entity").s().to_owned())
            .collect();
        s.into_iter().collect()
    };
    for (field, wh) in reader {
        let d = declared.get(field.as_str());
        let ws = words(field);
        if field.ends_with("_minor") {
            continue;
        }
        let owners = owners_of(field, wh);
        let kbw = |w: &str| kind_by_word.get(w).copied();
        let last = ws.last().map(String::as_str);
        let second = if ws.len() >= 2 {
            Some(ws[ws.len() - 2].as_str())
        } else {
            None
        };
        let (to, how): (Option<&str>, &str) = if field.ends_with("_ids") {
            (second.and_then(kbw), "ids")
        } else if last == Some("title") || (last.and_then(kbw).is_some() && field.ends_with('s')) {
            let w = if last == Some("title") { second } else { last };
            (w.and_then(kbw), "titles")
        } else if let Some(t) = last.and_then(kbw) {
            (Some(t), "titles")
        } else if let Some(d) = d.filter(|d| d.get("inputs").truthy()) {
            let own = d.get("entity").s();
            (
                d.get("inputs").arr().iter().map(J::s).find(|i| *i != own),
                "ids",
            )
        } else {
            (None, "")
        };
        if let Some(to) = to {
            for o in &owners {
                if o != to {
                    add(&mut links, o, field, to, how, "reader");
                }
            }
        }
    }
    let mut seen = HashSet::new();
    links.retain(|l| seen.insert((l.from.clone(), l.field.clone(), l.to.clone())));
    let links_json: Vec<Value> = links
        .iter()
        .map(|l| {
            let role = if l.to == "core.party" {
                "party"
            } else if l.how == "prefix" {
                "member"
            } else {
                "belongs"
            };
            let weight = match role {
                "belongs" => 0.8,
                "party" => 0.4,
                _ => 0.3,
            };
            json!({"from": l.from, "field": l.field, "to": l.to, "how": l.how,
                   "source": l.source, "role": role, "weight": weight})
        })
        .collect();

    // ------------------------------------------------------------ fields
    let mut fields: BTreeMap<String, Vec<(String, Value)>> = BTreeMap::new();
    let set_default =
        |fields: &mut BTreeMap<String, Vec<(String, Value)>>, e: &str, col: &str, v: Value| {
            let f = fields.entry(e.to_owned()).or_default();
            if !f.iter().any(|(c, _)| c == col) {
                f.push((col.to_owned(), v));
            }
        };
    for (key, cols) in derived.get("predicates").obj() {
        let ent = key.split('@').next().unwrap_or("");
        let fs: Vec<String> = std::iter::once(ent.to_owned())
            .chain(alias.get(ent).into_iter().flatten().cloned())
            .collect();
        for f in &fs {
            for (col, c) in cols.obj() {
                let mut sh = c.get("shape").value();
                if c.get("housekeeping").truthy() && !col.ends_with("_at") {
                    continue;
                }
                let cv = c.get("checkValues");
                if sh == json!("integer") && matches!(cv, J::Arr(v) if v.is_empty()) {
                    sh = json!("flag");
                }
                if sh == json!("reference") {
                    sh = json!("ref");
                }
                let mut e = serde_json::Map::new();
                e.insert("shape".into(), sh);
                if cv.truthy() {
                    e.insert("values".into(), cv.value());
                }
                set_default(&mut fields, f, col, Value::Object(e));
            }
        }
    }
    for (field, wh) in reader {
        let f = field.as_str();
        let sh = if f.ends_with("_minor") {
            "money"
        } else if f.ends_with("_ids") {
            "ids"
        } else if f.ends_with("_at") || f.ends_with("_on") || f == "next_occurrence" {
            "date"
        } else if ["favorite", "starred", "pinned", "trashed"].contains(&f) {
            "flag"
        } else {
            "text"
        };
        for o in owners_of(f, wh) {
            set_default(&mut fields, &o, f, json!({"shape": sh}));
        }
    }
    let mut cohorts = Vec::new();
    for (field, wh) in reader {
        let os: BTreeSet<&str> = kind_names
            .iter()
            .filter(|(_, v)| door_in(v.get("door").s(), wh))
            .map(|(_, v)| v.get("entity").s())
            .collect();
        for o in os {
            let fo = fields.entry(o.to_owned()).or_default();
            let text = fo
                .iter()
                .find(|(c, _)| c == field)
                .is_some_and(|(_, v)| v.get("shape") == Some(&json!("text")));
            if text && !links.iter().any(|l| &l.field == field) {
                cohorts.push(json!({"entity": o, "field": field}));
            }
        }
    }

    let kinds_json: serde_json::Map<String, Value> = kinds
        .iter()
        .map(|(e, k)| {
            let by_door: serde_json::Map<String, Value> = k
                .by_door
                .iter()
                .map(|(d, l)| (d.clone(), json!(l)))
                .collect();
            (
                e.clone(),
                json!({"names": k.names, "apps": k.apps, "words": k.words, "intent": k.intent,
                       "byDoor": by_door, "subkinds": k.subkinds}),
            )
        })
        .collect();
    let fields_json: serde_json::Map<String, Value> = fields
        .into_iter()
        .map(|(e, cols)| (e, Value::Object(cols.into_iter().collect())))
        .collect();
    let out = json!({"$generatedBy": "crates/candidates/build.rs", "kinds": kinds_json,
                     "links": links_json, "fields": fields_json, "cohorts": cohorts});
    let dest = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("onto.json");
    std::fs::write(dest, serde_json::to_string_pretty(&out).expect("json"))
        .expect("write onto.json");
}
