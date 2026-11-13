//! THE HAND-OFF: prompts answered by subagents instead of `claude -p`.
//!
//! `datagen messages --collect DIR` (or `build --collect DIR`) writes each prompt the LLM cache lacks to
//! `DIR/{writer,reader}/{train,val,test}/<hash>.json` as `{model, hash, prompt}`. [`split`] cuts those into shards of a few
//! prompts for subagents to answer; [`join`] reads the answers back and puts them in the cache with [`crate::llm::put`].
//! Then the generator runs again, and again, until nothing is pending and a last run with `--offline` builds the version.
//!
//! ```text
//! <out>/train/<role>-train/shard-NNNN/NNN.prompt.txt      the prompt text, nothing else
//! <out>/heldout/<role>-{val,test}/shard-NNNN/NNN.prompt.txt
//! <out>/index/<role>-<split>.json                         shard and number to hash and model
//! ```
//!
//! Whoever writes training data never opens val or test, so the two never share a parent: a subagent is handed
//! `<out>/train` or `<out>/heldout`, never `<out>`. The index, which holds every hash and model name, is outside both, and
//! no shard folder holds a hash or a model name. The answer goes in `NNN.answer.txt` beside its prompt.
//!
//! Nothing here prints the text of a prompt or an answer of val or test: counts only.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::llm::{json_of, prompt_hash, put};

/// The roles of a prompt, as `messages --collect` names the folders.
pub const ROLES: [&str; 2] = ["writer", "reader"];

/// The splits, as the same folders name them.
pub const SPLITS: [&str; 3] = ["train", "val", "test"];

/// Prompts in a shard unless `--per` says otherwise.
pub const PER_SHARD: usize = 8;

/// The folder of the index, beside the two roots and in neither.
pub const INDEX: &str = "index";

/// The root a split's shards are under: a subagent is handed one root, so train and held-out never share one.
#[must_use]
pub fn root_of(split: &str) -> &'static str {
    if split == "train" { "train" } else { "heldout" }
}

fn group(role: &str, split: &str) -> String {
    format!("{role}-{split}")
}

fn shard_name(shard: usize) -> String {
    format!("shard-{shard:04}")
}

fn number(n: usize) -> String {
    format!("{n:03}")
}

/// What one prompt of the index is: the hash it is cached under and the model that answers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub hash: String,
    pub model: String,
}

/// The index of one role and split: shard name, then number, to the entry.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Index {
    pub role: String,
    pub split: String,
    pub shards: BTreeMap<String, BTreeMap<String, Entry>>,
}

/// How many prompts and shards a role and split was cut into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cut {
    pub role: &'static str,
    pub split: &'static str,
    pub prompts: usize,
    pub shards: usize,
}

/// What `split` wrote.
#[derive(Debug, Clone, Default)]
pub struct Split {
    pub cuts: Vec<Cut>,
}

impl Split {
    /// Counts only, one line for each of the six role and split folders.
    #[must_use]
    pub fn text(&self) -> String {
        let mut out = String::new();
        for c in &self.cuts {
            out.push_str(&format!(
                "{} {}: {} prompts in {} shards under {}\n",
                c.role,
                c.split,
                c.prompts,
                c.shards,
                root_of(c.split)
            ));
        }
        out
    }
}

fn pending_of(dir: &Path) -> Result<Vec<(String, Entry, String)>> {
    let mut out = Vec::new();
    let Ok(read) = std::fs::read_dir(dir) else {
        return Ok(out);
    };
    for file in read {
        let path = file?.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let value: Value = serde_json::from_str(
            &std::fs::read_to_string(&path).with_context(|| path.display().to_string())?,
        )
        .with_context(|| format!("{} is not a pending prompt", path.display()))?;
        let field = |k: &str| {
            value[k]
                .as_str()
                .map(str::to_owned)
                .with_context(|| format!("{} has no `{k}`", path.display()))
        };
        out.push((
            field("hash")?,
            Entry {
                hash: field("hash")?,
                model: field("model")?,
            },
            field("prompt")?,
        ));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Cut the prompts `--collect` wrote under `pending` into shards of `per` prompts under `out`, in hash order.
///
/// # Errors
///
/// `per` of nothing, an `out` that already holds something (a round is cut into a folder of its own), a pending file that
/// is not `{model, hash, prompt}`, or a file that cannot be written.
pub fn split(pending: &Path, out: &Path, per: usize) -> Result<Split> {
    if per == 0 {
        bail!("--per takes at least 1 prompt to a shard");
    }
    if out.exists() && std::fs::read_dir(out)?.next().is_some() {
        bail!(
            "{} is not empty: cut each round into a folder of its own",
            out.display()
        );
    }
    let mut result = Split::default();
    for role in ROLES {
        for split_name in SPLITS {
            let prompts = pending_of(&pending.join(role).join(split_name))?;
            let mut index = Index {
                role: role.to_owned(),
                split: split_name.to_owned(),
                shards: BTreeMap::new(),
            };
            let base = out.join(root_of(split_name)).join(group(role, split_name));
            for (s, chunk) in prompts.chunks(per).enumerate() {
                let dir = base.join(shard_name(s));
                std::fs::create_dir_all(&dir)?;
                let shard = index.shards.entry(shard_name(s)).or_default();
                for (n, (_, entry, prompt)) in chunk.iter().enumerate() {
                    std::fs::write(dir.join(format!("{}.prompt.txt", number(n))), prompt)?;
                    shard.insert(number(n), entry.clone());
                }
            }
            std::fs::create_dir_all(out.join(INDEX))?;
            std::fs::write(
                out.join(INDEX)
                    .join(format!("{}.json", group(role, split_name))),
                serde_json::to_string_pretty(&index)?,
            )?;
            result.cuts.push(Cut {
                role,
                split: split_name,
                prompts: prompts.len(),
                shards: index.shards.len(),
            });
        }
    }
    Ok(result)
}

/// What `join` did with the answers of one role and split.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Counts {
    pub role: &'static str,
    pub split: &'static str,
    /// Answers put in the cache.
    pub put: usize,
    /// Answers whose prompt already had an entry, which is kept.
    pub there: usize,
    /// Answers refused: empty, no JSON object, or a prompt that no longer hashes to the index's hash.
    pub refused: usize,
    /// Prompts with no answer file.
    pub missing: usize,
    /// Why each was refused or missing, as `shard/number: why`: the train split only, and never any text.
    pub lines: Vec<String>,
}

/// What `join` did.
#[derive(Debug, Clone, Default)]
pub struct Joined {
    pub counts: Vec<Counts>,
}

impl Joined {
    /// Whether anything was refused or missing.
    #[must_use]
    pub fn incomplete(&self) -> bool {
        self.counts.iter().any(|c| c.refused > 0 || c.missing > 0)
    }

    /// Counts for each role and split; the train split also lists what was refused or missing, by shard and number and
    /// the reason. Val and test are counts only.
    #[must_use]
    pub fn text(&self) -> String {
        let mut out = String::new();
        for c in &self.counts {
            out.push_str(&format!(
                "{} {}: {} put, {} already there, {} refused, {} missing\n",
                c.role, c.split, c.put, c.there, c.refused, c.missing
            ));
            for line in &c.lines {
                out.push_str(&format!("  {line}\n"));
            }
        }
        out
    }
}

/// Put the answers beside the prompts of `shards` (the `--out` of [`split`]) into the LLM cache `cache`, under the hash and
/// model of the index. An answer that is missing, empty, holds no JSON object, or whose prompt file no longer hashes to the
/// index's hash is not put. The good ones are put whatever else was refused.
///
/// # Errors
///
/// An index that cannot be read, or a cache that cannot be written.
pub fn join(shards: &Path, cache: &Path) -> Result<Joined> {
    let mut joined = Joined::default();
    for role in ROLES {
        for split_name in SPLITS {
            let path = shards
                .join(INDEX)
                .join(format!("{}.json", group(role, split_name)));
            let mut counts = Counts {
                role,
                split: split_name,
                put: 0,
                there: 0,
                refused: 0,
                missing: 0,
                lines: Vec::new(),
            };
            if let Ok(text) = std::fs::read_to_string(&path) {
                let index: Index = serde_json::from_str(&text)
                    .with_context(|| format!("{} is not an index", path.display()))?;
                let base: PathBuf = shards
                    .join(root_of(split_name))
                    .join(group(role, split_name));
                for (shard, prompts) in &index.shards {
                    for (n, entry) in prompts {
                        let stem = base.join(shard).join(n);
                        let at = format!("{}/{shard}/{n}", group(role, split_name));
                        let say = |counts: &mut Counts, why: &str| {
                            if split_name == "train" {
                                counts.lines.push(format!("{at}: {why}"));
                            }
                        };
                        let Ok(answer) = std::fs::read_to_string(stem.with_extension("answer.txt"))
                        else {
                            counts.missing += 1;
                            say(&mut counts, "no answer");
                            continue;
                        };
                        let answer = answer.trim();
                        if answer.is_empty() {
                            counts.refused += 1;
                            say(&mut counts, "the answer is empty");
                            continue;
                        }
                        if json_of(answer).is_err() {
                            counts.refused += 1;
                            say(&mut counts, "the answer holds no JSON object");
                            continue;
                        }
                        let hashes = std::fs::read_to_string(stem.with_extension("prompt.txt"))
                            .is_ok_and(|prompt| prompt_hash(&entry.model, &prompt) == entry.hash);
                        if !hashes {
                            counts.refused += 1;
                            say(
                                &mut counts,
                                "the prompt is missing or changed: it no longer hashes to the index's hash",
                            );
                            continue;
                        }
                        if put(cache, &entry.model, &entry.hash, answer)? {
                            counts.put += 1;
                        } else {
                            counts.there += 1;
                        }
                    }
                }
            }
            joined.counts.push(counts);
        }
    }
    Ok(joined)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{Cache, Llm};

    struct Never;
    impl Llm for Never {
        fn model(&self) -> &str {
            "m-train"
        }
        fn complete(&self, _: &str) -> Result<String> {
            bail!("no call is made")
        }
    }

    /// A pending file as `--collect` writes it.
    fn pending(dir: &Path, role: &str, split: &str, model: &str, prompt: &str) -> String {
        let hash = prompt_hash(model, prompt);
        let folder = dir.join(role).join(split);
        std::fs::create_dir_all(&folder).expect("dir");
        std::fs::write(
            folder.join(format!("{hash}.json")),
            serde_json::json!({"model": model, "hash": hash, "prompt": prompt}).to_string(),
        )
        .expect("write");
        hash
    }

    fn all_files(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).expect("read") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                out.extend(all_files(&path));
            } else {
                out.push(path);
            }
        }
        out.sort();
        out
    }

    /// Three prompts for each role and split, models named for the split.
    fn collected(dir: &Path) -> Vec<(String, String, String, String)> {
        let mut made = Vec::new();
        for role in ROLES {
            for split in SPLITS {
                for i in 0..3 {
                    let model = format!("m-{split}");
                    let prompt = format!("PROMPT {role} {split} number {i} \u{e9}");
                    let hash = pending(dir, role, split, &model, &prompt);
                    made.push((role.to_owned(), split.to_owned(), hash, model));
                }
            }
        }
        made
    }

    #[test]
    fn split_lays_prompts_in_shards_by_root_and_keeps_hashes_and_models_out_of_them() {
        let dir = tempfile::tempdir().expect("dir");
        let (pend, out) = (dir.path().join("pending"), dir.path().join("out"));
        let made = collected(&pend);
        let cut = split(&pend, &out, 2).expect("splits");
        assert_eq!(cut.cuts.len(), 6);
        assert!(cut.cuts.iter().all(|c| c.prompts == 3 && c.shards == 2));
        // the layout: two shards of two and one prompt, one root for train and one for held-out
        let mut shards: Vec<String> = all_files(&out)
            .into_iter()
            .filter(|p| p.extension().is_some_and(|e| e == "txt"))
            .map(|p| {
                p.strip_prefix(&out)
                    .expect("under out")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        shards.sort();
        assert_eq!(shards.len(), 18);
        assert!(shards.contains(&"train/writer-train/shard-0000/000.prompt.txt".to_owned()));
        assert!(shards.contains(&"train/writer-train/shard-0000/001.prompt.txt".to_owned()));
        assert!(shards.contains(&"train/writer-train/shard-0001/000.prompt.txt".to_owned()));
        assert!(!shards.contains(&"train/writer-train/shard-0001/001.prompt.txt".to_owned()));
        assert!(shards.contains(&"heldout/reader-test/shard-0001/000.prompt.txt".to_owned()));
        assert!(shards.contains(&"heldout/reader-val/shard-0000/000.prompt.txt".to_owned()));
        // no train file under heldout, no held-out file under train
        for rel in &shards {
            let (root, rest) = rel.split_once('/').expect("a root");
            assert!(matches!(root, "train" | "heldout"), "{rel}");
            assert_eq!(
                rest.contains("-train/"),
                root == "train",
                "{rel} is under the wrong root"
            );
            assert_eq!(
                rest.contains("-val/") || rest.contains("-test/"),
                root == "heldout",
                "{rel} is under the wrong root"
            );
        }
        // the text of a prompt is the file, exactly
        assert!(
            std::fs::read_to_string(out.join("train/writer-train/shard-0000/000.prompt.txt"))
                .expect("read")
                .starts_with("PROMPT writer train number ")
        );
        // nothing a subagent is handed names a hash or a model: not a file name, not a byte of a file
        for root in ["train", "heldout"] {
            for path in all_files(&out.join(root)) {
                let name = path.to_string_lossy().into_owned();
                let body = std::fs::read_to_string(&path).expect("read");
                assert!(!name.contains("m-t") && !body.contains("m-t"), "{name}");
                for (_, _, hash, _) in &made {
                    assert!(!name.contains(hash) && !body.contains(hash), "{name}");
                }
                assert!(body.starts_with("PROMPT "), "{name} holds only the prompt");
            }
        }
        // the index is outside both roots and maps shard and number to hash and model, in hash order
        let index: Index = serde_json::from_str(
            &std::fs::read_to_string(out.join("index/writer-val.json")).expect("index"),
        )
        .expect("json");
        assert_eq!(
            (index.role.as_str(), index.split.as_str()),
            ("writer", "val")
        );
        let mut wanted: Vec<&(String, String, String, String)> = made
            .iter()
            .filter(|(r, s, _, _)| r == "writer" && s == "val")
            .collect();
        wanted.sort_by(|a, b| a.2.cmp(&b.2));
        let listed: Vec<&Entry> = index.shards.values().flat_map(BTreeMap::values).collect();
        assert_eq!(listed.len(), 3);
        for (entry, want) in listed.iter().zip(wanted) {
            assert_eq!((&entry.hash, &entry.model), (&want.2, &want.3));
        }
        // a round is cut into a folder of its own
        assert!(split(&pend, &out, 2).is_err());
        assert!(split(&pend, &dir.path().join("again"), 0).is_err());
    }

    #[test]
    fn join_puts_good_answers_and_refuses_and_lists_the_rest_without_text() {
        let dir = tempfile::tempdir().expect("dir");
        let (pend, out, cache) = (
            dir.path().join("pending"),
            dir.path().join("out"),
            dir.path().join("cache"),
        );
        collected(&pend);
        split(&pend, &out, 8).expect("splits");
        let answer = |group: &str, root: &str, n: usize, text: &str| {
            std::fs::write(
                out.join(root)
                    .join(group)
                    .join("shard-0000")
                    .join(format!("{n:03}.answer.txt")),
                text,
            )
            .expect("answer");
        };
        // writer train: a good answer in a fence, an empty one, one with no JSON and one never written
        answer(
            "writer-train",
            "train",
            0,
            "```json\n{\"sessions\": []}\n```",
        );
        answer("writer-train", "train", 1, "  \n");
        answer("writer-train", "train", 2, "I could not do it");
        // reader train: a good one, a tampered prompt (the answer is fine, the prompt changed) and one missing
        answer("reader-train", "train", 0, "{\"sessions\": []}");
        answer("reader-train", "train", 1, "{\"sessions\": []}");
        std::fs::write(
            out.join("train/reader-train/shard-0000/001.prompt.txt"),
            "PROMPT edited",
        )
        .expect("tamper");
        // held-out: every writer-val answer is good, the writer-test ones are missing
        for n in 0..3 {
            answer("writer-val", "heldout", n, "{\"sessions\": [1]}");
        }
        let joined = join(&out, &cache).expect("joins");
        let of = |role: &str, split: &str| {
            joined
                .counts
                .iter()
                .find(|c| c.role == role && c.split == split)
                .expect("counts")
        };
        let w = of("writer", "train");
        assert_eq!((w.put, w.there, w.refused, w.missing), (1, 0, 2, 0));
        let r = of("reader", "train");
        assert_eq!((r.put, r.there, r.refused, r.missing), (1, 0, 1, 1));
        assert_eq!(of("writer", "val").put, 3);
        assert_eq!(of("writer", "test").missing, 3);
        assert!(joined.incomplete());
        // what the train lines say, and that the held-out ones say nothing
        let text = joined.text();
        assert!(text.contains("writer-train/shard-0000/001: the answer is empty"));
        assert!(text.contains("writer-train/shard-0000/002: the answer holds no JSON object"));
        assert!(text.contains("reader-train/shard-0000/001: the prompt is missing or changed"));
        assert!(text.contains("reader-train/shard-0000/002: no answer"));
        assert!(text.contains("writer val: 3 put, 0 already there, 0 refused, 0 missing"));
        assert!(text.contains("writer test: 0 put, 0 already there, 0 refused, 3 missing"));
        assert!(!text.contains("writer-val/") && !text.contains("writer-test/"));
        assert!(!text.contains("PROMPT") && !text.contains("sessions"));
        // the good ones are in the cache under the index's hash and model, as a completed call would have put them
        let model_hash = |role: &str, split: &str, n: usize| {
            let index: Index = serde_json::from_str(
                &std::fs::read_to_string(out.join(format!("index/{role}-{split}.json")))
                    .expect("index"),
            )
            .expect("json");
            index.shards["shard-0000"][&format!("{n:03}")].clone()
        };
        let good = model_hash("writer", "train", 0);
        let prompt =
            std::fs::read_to_string(out.join("train/writer-train/shard-0000/000.prompt.txt"))
                .expect("prompt");
        assert_eq!(good.hash, prompt_hash(&good.model, &prompt));
        let hit = Cache::open(&Never, &cache, true).expect("cache");
        assert_eq!(good.model, "m-train");
        assert_eq!(
            hit.complete(&prompt).expect("a hit with no call"),
            "```json\n{\"sessions\": []}\n```"
        );
        assert_eq!(hit.counts(), (0, 1));
        let path = cache
            .join(&good.hash[..2])
            .join(format!("{}.json", good.hash));
        assert!(path.exists());
        let tampered = model_hash("reader", "train", 1);
        assert!(
            !cache
                .join(&tampered.hash[..2])
                .join(format!("{}.json", tampered.hash))
                .exists(),
            "a tampered prompt is not put"
        );
    }

    #[test]
    fn join_keeps_an_entry_already_in_the_cache_and_counts_it() {
        let dir = tempfile::tempdir().expect("dir");
        let (pend, out, cache) = (
            dir.path().join("pending"),
            dir.path().join("out"),
            dir.path().join("cache"),
        );
        let hash = pending(&pend, "writer", "train", "m-train", "PROMPT one");
        split(&pend, &out, 8).expect("splits");
        std::fs::write(
            out.join("train/writer-train/shard-0000/000.answer.txt"),
            "{\"new\": true}",
        )
        .expect("answer");
        assert!(put(&cache, "m-train", &hash, "{\"old\": true}").expect("put"));
        let joined = join(&out, &cache).expect("joins");
        let w = joined
            .counts
            .iter()
            .find(|c| c.role == "writer" && c.split == "train")
            .expect("counts");
        assert_eq!((w.put, w.there, w.refused, w.missing), (0, 1, 0, 0));
        assert!(!joined.incomplete(), "a kept entry is not a failure");
        let text = std::fs::read_to_string(cache.join(&hash[..2]).join(format!("{hash}.json")))
            .expect("entry");
        assert!(
            text.contains("old") && !text.contains("new"),
            "never overwritten"
        );
    }
}
