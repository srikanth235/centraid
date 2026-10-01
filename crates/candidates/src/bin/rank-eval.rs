//! Zero-skill recall eval for [`centraid_candidates::rank`]: after ONE search
//! of each raw request, are all expected rows on screen (the hits, their inline
//! links, and rows answered earlier in the session)?
//!
//! ```text
//! rank-eval WORLD.json CORPUS_DIR [K] [--ids IDS.json] [--dump OUT.jsonl] [-v]
//! ```
//!
//! `CORPUS_DIR` holds `dump.jsonl` (and optionally `nb.out`): tool-loop peek
//! outputs, one JSON object per line, the rows under `"rows"`. `--dump` writes
//! each searched turn's view ids (`{"session", "turn", "view"}`), for holding
//! the port to the `ranker.py` prototype turn for turn.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::Write as _;
use std::path::Path;

use centraid_candidates::rank::{Ranker, view_ids};
use centraid_evalsuite::VaultRow;
use serde_json::Value;

fn read_json(p: &Path) -> Result<Value, String> {
    let s = std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?;
    serde_json::from_str(&s).map_err(|e| format!("{}: {e}", p.display()))
}

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        x => x.to_string(),
    }
}

fn to_row(v: &Value) -> VaultRow {
    VaultRow {
        id: text(&v["id"]),
        entity: text(&v["entity"]),
        app: text(&v["app"]),
        label: text(&v["label"]),
        date: v["date"].as_str().map(str::to_owned),
        live: v["live"].as_bool().unwrap_or(true),
        extra: v["extra"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(k, x)| (k.clone(), text(x)))
            .collect(),
    }
}

fn handles(e: &Value, h: &serde_json::Map<String, Value>) -> Vec<String> {
    let strs = |v: &Value| -> Vec<String> {
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| x.as_str().map(str::to_owned))
            .collect()
    };
    let writes: Vec<&Value> = match e["type"].as_str() {
        Some("ids") => return strs(&e["ids"]),
        Some("write") => vec![e],
        Some("write_set") => e["writes"].as_array().into_iter().flatten().collect(),
        _ => vec![],
    };
    writes
        .iter()
        .flat_map(|w| w["args"].as_object().into_iter().flatten())
        .filter_map(|(_, v)| v.as_str().filter(|s| h.contains_key(*s)).map(str::to_owned))
        .collect()
}

#[allow(clippy::too_many_lines)]
fn main() -> Result<(), String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let flag = |f: &str| {
        argv.iter()
            .position(|a| a == f)
            .and_then(|i| argv.get(i + 1))
    };
    let valued: HashSet<usize> = ["--ids", "--dump"]
        .iter()
        .filter_map(|f| argv.iter().position(|a| a == f).map(|i| i + 1))
        .collect();
    let args: Vec<&String> = argv
        .iter()
        .enumerate()
        .filter(|(i, a)| !a.starts_with('-') && !valued.contains(i))
        .map(|(_, a)| a)
        .collect();
    let [world, corpus, rest @ ..] = args.as_slice() else {
        return Err(
            "usage: rank-eval WORLD.json CORPUS_DIR [K] [--ids IDS.json] [--dump OUT] [-v]".into(),
        );
    };
    let k: usize = rest.first().and_then(|x| x.parse().ok()).unwrap_or(6);
    let world = read_json(Path::new(world.as_str()))?;
    let ids: Option<HashSet<String>> = match flag("--ids") {
        Some(p) => Some(
            read_json(Path::new(p))?
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect(),
        ),
        None => None,
    };
    let mut rows = Vec::new();
    for f in ["dump.jsonl", "nb.out"] {
        let p = Path::new(corpus.as_str()).join(f);
        let Ok(s) = std::fs::read_to_string(&p) else {
            continue;
        };
        for line in s.lines().filter(|l| !l.trim().is_empty()) {
            let v: Value =
                serde_json::from_str(line).map_err(|e| format!("{}: {e}", p.display()))?;
            rows.extend(v["rows"].as_array().into_iter().flatten().map(to_row));
        }
    }
    let today = world["today"].as_str().ok_or("world has no today")?;
    let r = Ranker::new(&rows, today).with_k(k);
    let empty = serde_json::Map::new();
    let h = world["handles"].as_object().unwrap_or(&empty);
    let resolve = |name: &str| -> BTreeSet<String> {
        let d = &h[name];
        r.pool()
            .iter()
            .filter(|x| {
                d["entity"].as_str() == Some(x.entity.as_str())
                    && d["label"].as_str() == Some(x.label.as_str())
                    && d["state"].as_str().is_none_or(|s| x.live == (s == "live"))
            })
            .map(|x| x.id.clone())
            .collect()
    };
    let mut dump = match flag("--dump") {
        Some(p) => Some(std::fs::File::create(p).map_err(|e| format!("{p}: {e}"))?),
        None => None,
    };
    // category -> (turns, all on screen, summed recall)
    let mut res: BTreeMap<String, (usize, usize, f64)> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut miss = Vec::new();
    for s in world["sessions"].as_array().into_iter().flatten() {
        let sid = text(&s["id"]);
        if ids.as_ref().is_some_and(|x| !x.contains(&sid)) {
            continue;
        }
        let (mut ctx, mut hist, mut seen): (Vec<String>, Vec<Vec<String>>, BTreeSet<String>) =
            (vec![], vec![], BTreeSet::new());
        for (ti, t) in s["turns"].as_array().into_iter().flatten().enumerate() {
            let want: BTreeSet<String> = handles(&t["expected"], h)
                .iter()
                .flat_map(|x| resolve(x))
                .collect();
            let req = text(&t["request"]);
            if !want.is_empty() {
                let last: Vec<Vec<String>> = hist.iter().take(2).cloned().collect();
                let hits = r.search(&req, &ctx, &last);
                let own = view_ids(&hits);
                if let Some(f) = dump.as_mut() {
                    let line = serde_json::json!({"session": sid, "turn": ti, "view": own});
                    writeln!(f, "{line}").map_err(|e| e.to_string())?;
                }
                let view: BTreeSet<&String> = own.iter().chain(&seen).collect();
                let got = want.iter().filter(|x| view.contains(x)).count();
                let cat = text(&s["category"]);
                if !res.contains_key(&cat) {
                    order.push(cat.clone());
                }
                let c = res.entry(cat).or_default();
                c.0 += 1;
                c.1 += usize::from(got == want.len());
                #[allow(clippy::cast_precision_loss)]
                {
                    c.2 += got as f64 / want.len() as f64;
                }
                if got < want.len() {
                    let lost: Vec<&str> = want
                        .iter()
                        .filter(|x| !view.contains(x))
                        .filter_map(|x| r.name(x))
                        .take(4)
                        .collect();
                    let top: Vec<&str> =
                        hits.iter().take(4).map(|x| x.row.label.as_str()).collect();
                    miss.push(format!("({sid}, {ti}, {req:?}, {lost:?}, {top:?})"));
                }
                hist.insert(0, want.iter().cloned().collect());
            }
            ctx.push(req);
            seen.extend(want);
        }
    }
    let tot = res
        .values()
        .fold((0, 0, 0.0), |a, v| (a.0 + v.0, a.1 + v.1, a.2 + v.2));
    #[allow(clippy::cast_precision_loss)]
    let (all, rec) = (
        100.0 * tot.1 as f64 / tot.0.max(1) as f64,
        100.0 * tot.2 / tot.0.max(1) as f64,
    );
    println!(
        "K={k} turns {}  all-on-screen {} ({all:.1}%)  row recall {rec:.0}%",
        tot.0, tot.1
    );
    order.sort_by_key(|c| std::cmp::Reverse(res[c].0));
    for c in &order {
        let v = res[c];
        #[allow(clippy::cast_precision_loss)]
        let rc = 100.0 * v.2 / v.0 as f64;
        println!("  {c:24} {:3}/{:<3} recall {rc:.0}%", v.1, v.0);
    }
    if argv.iter().any(|a| a == "-v") {
        for m in miss {
            println!("{m}");
        }
    }
    Ok(())
}
