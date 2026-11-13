//! H8: publish checks first and uploads last. A version is laid out in two repos, the data the trainer fetches and the held-out
//! one that holds test and the cache, described by a generated card, and refused for every reason a version must not leave the machine. The
//! dry run sends nothing; the upload hands a stub transport the staged tree and the token only through its environment.

use std::path::Path;

use centraid_assist::native::prompt::{ToolsMode, tools_block, tools_for};
use centraid_datagen::contract::{self, Contract};
use centraid_datagen::publish::{self, Repo, Source};
use serde_json::{Value, json};

/// A record whose render text holds the tools block of the sig mode, as a rendered session does.
fn record(id: &str) -> String {
    let block = tools_block(&tools_for(ToolsMode::Sig));
    json!({"id": id, "render": {"text": format!("<|im_start|>system\n{block}\n\ntoday: Monday")}})
        .to_string()
}

fn zst(lines: &[&str]) -> Vec<u8> {
    let text = lines.join("\n") + "\n";
    zstd::encode_all(text.as_bytes(), 3).expect("zstd")
}

fn put(dir: &Path, rel: &str, bytes: &[u8]) -> Value {
    let path = dir.join(rel);
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    std::fs::write(&path, bytes).expect("write");
    json!({"bytes": bytes.len(), "blake3": blake3::hash(bytes).to_hex().to_string()})
}

/// A small version in the shape `datagen build` writes it.
fn version(dir: &Path, commit: &str, publishable: bool) {
    let mut files = serde_json::Map::new();
    for (rel, body) in [
        ("data/train.jsonl.zst", zst(&[&record("train-00-1")])),
        ("data/train-1000.jsonl.zst", zst(&[&record("train-00-1")])),
        ("data/val.jsonl.zst", zst(&[&record("val-00-1")])),
        ("data/noise.jsonl.zst", zst(&[&record("val-00-1~noise")])),
        ("data/test.jsonl.zst", zst(&["{\"id\":\"test-00-1\"}"])),
    ] {
        files.insert(rel.to_owned(), put(dir, rel, &body));
    }
    put(dir, "worlds/train-00.json", b"{\"people\":[]}");
    put(dir, "worlds/val-00.json", b"{\"people\":[]}");
    put(dir, "worlds/test-00.json", b"{\"people\":[]}");
    put(dir, "build/messages.txt", b"report");
    put(dir, "build/render-dropped.jsonl", b"not uploaded");
    put(dir, "build/llm-cache.jsonl.zst", &zst(&["{\"k\":\"v\"}"]));
    let contract = Contract::current(ToolsMode::Sig, "cafe1234", "ab12");
    contract::write_files(dir, &contract).expect("contract files");
    let manifest = json!({
        "version": "v0.9",
        "tools_block": {"mode": "sig"},
        "contract": contract.to_json(),
        "heldout": {"repo": publish::HELDOUT_REPO},
        "publishable": {"value": publishable, "blockers": if publishable { json!([]) } else { json!(["rendered with the test (byte-level) tokenizer"]) }},
        "catalog_hash": "cafe1234",
        "runtime_commit": commit,
        "tokenizer": {"file": "tokenizer.json", "blake3": "ab12"},
        "messages": {"writers": {"train": "w1"}, "readers": {"train": "r1"}, "styles": {"terse": {"written": 4, "complying": 3}}},
        "splits": [{"split": "train", "sessions": 1, "turns": 1, "target": 1,
            "shares": [{"share": "outcome", "unit": "turns", "lines": [{"name": "done", "requested": 65.0, "target": 65.0, "realised": 60.0, "supply": 100.0}, {"name": "other", "requested": 35.0, "target": 35.0, "realised": 40.0, "supply": 100.0}]}],
            "missed": ["repair turns: 0 of 1 wanted"]}],
        "files": files,
    });
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).expect("json"),
    )
    .expect("manifest");
}

fn good() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("dir");
    version(dir.path(), "0123456789abcdef", true);
    dir
}

fn refusal(dir: &Path) -> String {
    publish::prepare(dir, publish::EXAMPLE_REPO, None)
        .expect_err("refused")
        .to_string()
}

fn paths(list: &[&str]) -> Vec<String> {
    list.iter().map(|p| (*p).to_owned()).collect()
}

#[test]
fn a_version_is_laid_out_in_two_repos_with_test_and_the_cache_only_in_the_held_out_one() {
    let dir = good();
    let p = publish::prepare(dir.path(), publish::EXAMPLE_REPO, None).expect("prepares");
    let mut data = paths(&[
        "README.md",
        "manifest.json",
        "contract/hashes.json",
        "contract/system.txt",
        "contract/tools.json",
        "data/noise.jsonl.zst",
        "data/subsets/train-1000.jsonl.zst",
        "data/train.jsonl.zst",
        "data/val.jsonl.zst",
        "reports/messages.txt",
        "worlds/train/train-00.json",
        "worlds/val/val-00.json",
    ]);
    data.sort();
    assert_eq!(p.set(Repo::Data), data);
    let mut heldout = paths(&[
        "README.md",
        "manifest.json",
        "cache/llm-cache.jsonl.zst",
        "test/test.jsonl.zst",
        "worlds/test/test-00.json",
    ]);
    heldout.sort();
    assert_eq!(p.set(Repo::Heldout), heldout);
    assert_eq!(p.heldout_repo, publish::HELDOUT_REPO);
    // the two sets share only the manifest and the card, by name; nothing of test or the cache is in the data repo's
    for r in p.set(Repo::Data) {
        assert!(
            !r.contains("test") && !r.contains("cache") && !r.contains("render-dropped"),
            "{r} is in the data repo's set"
        );
    }
    let shared: Vec<String> = p
        .set(Repo::Data)
        .into_iter()
        .filter(|r| p.set(Repo::Heldout).contains(r))
        .collect();
    assert_eq!(shared, paths(&["README.md", "manifest.json"]));
    // the manifest is the same bytes in both
    let hash = |repo: Repo| {
        p.files
            .iter()
            .find(|f| f.repo == repo && f.remote == "manifest.json")
            .map(|f| f.blake3.clone())
    };
    assert_eq!(hash(Repo::Data), hash(Repo::Heldout));
    // a jsonl that names test sessions and the staging leftovers are in neither
    assert!(!p.files.iter().any(|f| f.remote.contains("render-dropped")));
    assert!(p.files.iter().all(|f| f.blake3.len() == 64));
}

#[test]
fn the_card_says_what_the_data_is_and_what_it_was_built_from() {
    let dir = good();
    let p = publish::prepare(dir.path(), publish::EXAMPLE_REPO, None).expect("prepares");
    let Some(Source::Text(card)) = p
        .files
        .iter()
        .find(|f| f.repo == Repo::Data && f.remote == "README.md")
        .map(|f| f.source.clone())
    else {
        panic!("no card");
    };
    for want in [
        "synthetic",
        "English",
        "cafe1234",
        "0123456789abcdef",
        "sealed",
        "done 60.0% (asked 65.0%)",
        "not hit: repair turns",
        "lakh",
        "test/test.jsonl.zst",
        "v0.9",
        "The test split is not here",
        publish::HELDOUT_REPO,
        "tools_hash",
        "prompt_hash",
        "tokenizer blake3",
        "ab12",
    ] {
        assert!(card.contains(want), "the card lacks `{want}`:\n{card}");
    }
}

#[test]
fn a_dry_run_lists_every_file_of_both_repos_with_size_and_hash_and_sends_nothing() {
    let dir = good();
    let p = publish::prepare(dir.path(), publish::EXAMPLE_REPO, None).expect("prepares");
    let text = publish::dry_run(&p, None, true, None);
    assert!(text.contains("dry run: nothing is uploaded"));
    assert!(text.contains("private"));
    assert!(text.contains(publish::DATA_REPO) && text.contains(publish::HELDOUT_REPO));
    for f in &p.files {
        assert!(
            text.contains(&f.blake3) && text.contains(&f.remote),
            "{}",
            f.remote
        );
    }
}

#[test]
fn a_file_that_does_not_match_the_manifest_is_refused() {
    let dir = good();
    std::fs::write(
        dir.path().join("data/val.jsonl.zst"),
        zst(&["{\"id\":\"changed\"}"]),
    )
    .expect("edit");
    let why = refusal(dir.path());
    assert!(
        why.contains("data/val.jsonl.zst") && why.contains("manifest"),
        "{why}"
    );
    // and one that is gone
    let dir = good();
    std::fs::remove_file(dir.path().join("data/train.jsonl.zst")).expect("rm");
    assert!(refusal(dir.path()).contains("not on disk"));
}

#[test]
fn a_dirty_tree_build_and_an_unmarked_version_are_refused() {
    let dir = tempfile::tempdir().expect("dir");
    version(dir.path(), "0123456789abcdef-dirty", true);
    assert!(refusal(dir.path()).contains("dirty tree"));
    let dir = tempfile::tempdir().expect("dir");
    version(dir.path(), "0123456789abcdef", false);
    let why = refusal(dir.path());
    assert!(
        why.contains("not marked publishable") && why.contains("byte-level"),
        "{why}"
    );
}

#[test]
fn a_sealed_placeholder_anywhere_in_the_upload_is_refused() {
    // inside a compressed data file (the manifest's hash is made to match, so it is the placeholder that is found)
    let dir = tempfile::tempdir().expect("dir");
    version(dir.path(), "0123456789abcdef", true);
    let body = zst(&["{\"id\":\"train-00-1\",\"user\":\"password placeholder:k1:password\"}"]);
    let entry = put(dir.path(), "data/train.jsonl.zst", &body);
    let mut manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.path().join("manifest.json")).expect("m"),
    )
    .expect("json");
    manifest["files"]["data/train.jsonl.zst"] = entry;
    std::fs::write(dir.path().join("manifest.json"), manifest.to_string()).expect("write");
    let why = refusal(dir.path());
    assert!(
        why.contains("data/train.jsonl.zst") && why.contains("sealed placeholder"),
        "{why}"
    );
    // inside a world
    let dir = good();
    std::fs::write(
        dir.path().join("worlds/train-00.json"),
        "{\"x\":\"placeholder:k:field\"}",
    )
    .expect("w");
    let why = refusal(dir.path());
    assert!(why.contains("train-00.json"), "{why}");
}

/// A stand-in for python. A listing call (two arguments) answers with a tree holding strays and the given tags; a commit call
/// records its arguments, its standard input, the token in its environment, the deletes file and the staged tree.
#[cfg(unix)]
fn stub(bin: &Path, record: &Path, data_tags: &str, heldout_tags: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = bin.join("stub");
    std::fs::write(
        &path,
        format!(
            "#!/bin/sh\nif [ $# -eq 2 ]; then cat > /dev/null\n  case \"$2\" in\n    */centraid-assist-heldout) echo '{{\"files\":[\".gitattributes\",\"worlds/test-00.json\"],\"tags\":[{heldout_tags}]}}';;\n    *) echo '{{\"files\":[\".gitattributes\",\"data/test.jsonl.zst\"],\"tags\":[{data_tags}]}}';;\n  esac\n  exit 0\nfi\n{{ echo \"commit $2 $3 $5\"; cat; echo \"env: $HF_TOKEN\"; echo \"deletes: $(cat \"$6\")\"; [ -f \"$4/manifest.json\" ] && echo staged; ls -R \"$4\"; }} >> {r}\necho \"done $2\"\n",
            r = record.display()
        ),
    )
    .expect("stub");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    path
}

#[cfg(unix)]
#[test]
fn an_upload_commits_each_repo_once_with_its_own_tree_and_the_token_only_through_its_environment() {
    let dir = good();
    let p = publish::prepare(dir.path(), publish::EXAMPLE_REPO, None).expect("prepares");
    let bin = tempfile::tempdir().expect("bin");
    let record = bin.path().join("record.txt");
    let stub = stub(bin.path(), &record, "\"v0.8\"", "\"v0.8\"");
    let token = "hf_secret_value_123";
    let done = publish::upload(
        &p,
        publish::EXAMPLE_REPO,
        true,
        stub.to_str().expect("path"),
        token,
    )
    .expect("uploads");
    // the held-out repo first, then the data repo
    assert_eq!(
        done,
        "done srikanth235/centraid-assist-heldout\ndone srikanth235/centraid-assist-data"
    );
    let seen = std::fs::read_to_string(&record).expect("record");
    let commits: Vec<&str> = seen.lines().filter(|l| l.starts_with("commit ")).collect();
    assert_eq!(
        commits,
        [
            "commit srikanth235/centraid-assist-heldout v0.9 private",
            "commit srikanth235/centraid-assist-data v0.9 private"
        ]
    );
    assert!(!commits.iter().any(|c| c.contains(token)));
    assert_eq!(seen.matches("env: hf_secret_value_123").count(), 2);
    let script_has_token = seen
        .lines()
        .filter(|l| !l.starts_with("env:"))
        .any(|l| l.contains(token));
    assert!(
        !script_has_token,
        "the token is on a command line or in the script"
    );
    assert_eq!(seen.matches("staged").count(), 2);
    // each repo's strays go to its commit as deletes; plumbing and the publish set do not
    assert!(
        seen.contains("deletes: [\"worlds/test-00.json\"]"),
        "{seen}"
    );
    assert!(
        seen.contains("deletes: [\"data/test.jsonl.zst\"]"),
        "{seen}"
    );
    // the staged trees are the two sets: test only in the first listing, never in the second
    let (held, data) = seen
        .split_once("commit srikanth235/centraid-assist-data")
        .expect("two");
    let listed = |tree: &str, name: &str| tree.lines().any(|l| l == name);
    assert!(listed(held, "test.jsonl.zst") && listed(held, "llm-cache.jsonl.zst"));
    assert!(!listed(data, "test.jsonl.zst") && !listed(data, "llm-cache.jsonl.zst"));
    assert!(listed(data, "train.jsonl.zst") && !listed(held, "train.jsonl.zst"));
    // a repo that is not owner/name is refused before anything runs
    assert!(publish::upload(&p, "nope", true, "false", token).is_err());
}

#[cfg(unix)]
#[test]
fn a_tag_that_exists_in_either_repo_refuses_before_anything_is_sent() {
    let dir = good();
    let p = publish::prepare(dir.path(), publish::EXAMPLE_REPO, None).expect("prepares");
    for (data_tags, heldout_tags, which) in [
        ("\"v0.9\"", "", "data repo"),
        ("", "\"v0.9\"", "held-out repo"),
    ] {
        let bin = tempfile::tempdir().expect("bin");
        let record = bin.path().join("record.txt");
        let stub = stub(bin.path(), &record, data_tags, heldout_tags);
        let err = publish::upload(
            &p,
            publish::EXAMPLE_REPO,
            true,
            stub.to_str().expect("path"),
            "hf_secret_value_123",
        )
        .expect_err("refused");
        let why = err.to_string();
        assert!(
            why.contains("nothing was sent") && why.contains(which) && why.contains("v0.9"),
            "{why}"
        );
        assert!(!record.exists(), "a commit was attempted: {why}");
    }
}

#[test]
fn a_transport_failure_is_reported_without_the_token() {
    let dir = good();
    let p = publish::prepare(dir.path(), publish::EXAMPLE_REPO, None).expect("prepares");
    let err = publish::upload(
        &p,
        publish::EXAMPLE_REPO,
        true,
        "false",
        "hf_secret_value_123",
    )
    .expect_err("fails");
    assert!(!err.to_string().contains("hf_secret_value_123"));
}

#[test]
fn the_plan_deletes_exactly_the_remote_paths_outside_the_publish_set_and_keeps_plumbing() {
    let set = paths(&[
        "manifest.json",
        "README.md",
        "data/train.jsonl.zst",
        "data/val.jsonl.zst",
        "test/test.jsonl.zst",
        "worlds/train-00.json",
        "test/worlds/test-00.json",
    ]);
    let stale = [
        "data/test.jsonl.zst",
        "worlds/test-00.json",
        "worlds/test-01.json",
        "worlds/test-02.json",
        "worlds/test-03.json",
        "worlds/test-04.json",
        "worlds/test-05.json",
        "build/llm-cache.jsonl.zst",
        "build/render-dropped.jsonl",
    ];
    // the remote holds some of the set (to be replaced), the nine strays and the LFS rules
    let mut remote = paths(&stale);
    remote.extend(paths(&[
        ".gitattributes",
        "manifest.json",
        "data/train.jsonl.zst",
    ]));
    let planned = publish::plan(&set, &remote);
    let mut want = paths(&stale);
    want.sort();
    assert_eq!(planned.deletes, want);
    assert_eq!(planned.deletes.len(), 9);
    assert!(!planned.deletes.iter().any(|d| d == ".gitattributes"));
    let mut puts = set.clone();
    puts.sort();
    assert_eq!(planned.puts, puts);
    assert!(planned.deletes.iter().all(|d| !set.contains(d)));
}

#[test]
fn an_empty_remote_and_a_remote_equal_to_the_publish_set_delete_nothing() {
    let set = paths(&[
        "manifest.json",
        "data/train.jsonl.zst",
        "test/test.jsonl.zst",
    ]);
    assert_eq!(publish::plan(&set, &[]).deletes.len(), 0);
    assert_eq!(publish::plan(&set, &[]).puts.len(), 3);
    assert_eq!(publish::plan(&set, &set).deletes.len(), 0);
    let mut with_rules = set.clone();
    with_rules.push(".gitattributes".to_owned());
    assert_eq!(publish::plan(&set, &with_rules).deletes.len(), 0);
}

#[test]
fn a_dry_run_that_knows_the_remotes_lists_the_paths_each_commit_would_remove() {
    let dir = good();
    let p = publish::prepare(dir.path(), publish::EXAMPLE_REPO, None).expect("prepares");
    let mut data = p.set(Repo::Data);
    data.extend(paths(&[".gitattributes", "data/test.jsonl.zst"]));
    let mut heldout = p.set(Repo::Heldout);
    heldout.extend(paths(&["build/llm-cache.jsonl.zst"]));
    let (data, heldout) = (
        publish::Remote {
            files: data,
            tags: vec![],
        },
        publish::Remote {
            files: heldout,
            tags: vec!["v0.9".to_owned()],
        },
    );
    let text = publish::dry_run(
        &p,
        Some(publish::EXAMPLE_REPO),
        true,
        Some((&data, &heldout)),
    );
    assert!(text.contains("remove  data/test.jsonl.zst"), "{text}");
    assert!(text.contains("remove  build/llm-cache.jsonl.zst"), "{text}");
    assert!(!text.contains("remove  .gitattributes"));
    assert_eq!(text.matches("1 path(s)").count(), 2);
    assert!(text.contains("WOULD BE REFUSED") && text.contains("v0.9"));
}

#[test]
fn the_plans_of_the_two_repos_are_pure_and_their_sets_are_disjoint_in_test_and_cache() {
    let dir = good();
    let p = publish::prepare(dir.path(), publish::EXAMPLE_REPO, None).expect("prepares");
    // the data repo's old tree held test and the cache beside train (the bug this layout prevents): both are deleted
    let old_data = paths(&[
        ".gitattributes",
        "data/test.jsonl.zst",
        "worlds/test-00.json",
        "build/llm-cache.jsonl.zst",
        "data/train.jsonl.zst",
    ]);
    let data = publish::plan(&p.set(Repo::Data), &old_data);
    assert_eq!(
        data.deletes,
        paths(&[
            "build/llm-cache.jsonl.zst",
            "data/test.jsonl.zst",
            "worlds/test-00.json"
        ])
    );
    assert_eq!(data.puts, p.set(Repo::Data));
    // the held-out repo's tree is replaced the same way
    let old_heldout = paths(&[".gitattributes", "test/test.jsonl.zst", "test/old.json"]);
    let heldout = publish::plan(&p.set(Repo::Heldout), &old_heldout);
    assert_eq!(heldout.deletes, paths(&["test/old.json"]));
    assert_eq!(heldout.puts, p.set(Repo::Heldout));
    assert_eq!(data.puts.len() + heldout.puts.len(), p.files.len());
    for put in &data.puts {
        assert!(!put.starts_with("test/") && !put.starts_with("cache/"));
    }
}

#[test]
fn a_manifest_without_a_contract_or_with_contract_files_that_do_not_hash_to_it_is_refused() {
    let strip = |dir: &Path, key: &str| {
        let mut m: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).expect("m"))
                .expect("json");
        m.as_object_mut().expect("object").remove(key);
        std::fs::write(dir.join("manifest.json"), m.to_string()).expect("write");
    };
    let dir = good();
    strip(dir.path(), "contract");
    let why = refusal(dir.path());
    assert!(
        why.contains("no contract block") && why.contains("restamp"),
        "{why}"
    );
    let dir = good();
    strip(dir.path(), "heldout");
    assert!(refusal(dir.path()).contains("no `heldout` pointer"));
    // a contract file that changed after the manifest was written
    let dir = good();
    std::fs::write(dir.path().join(contract::TOOLS), "[]").expect("w");
    assert!(refusal(dir.path()).contains("contract/tools.json: hashes to"));
    let dir = good();
    std::fs::remove_file(dir.path().join(contract::SYSTEM)).expect("rm");
    assert!(refusal(dir.path()).contains("contract/system.txt: missing"));
    // a held-out repo other than the manifest's pointer
    let dir = good();
    let err = publish::prepare(dir.path(), publish::EXAMPLE_REPO, Some("someone/else"))
        .expect_err("refused")
        .to_string();
    assert!(err.contains("points to the held-out repo"), "{err}");
    // no packed cache
    let dir = good();
    std::fs::remove_file(dir.path().join("build/llm-cache.jsonl.zst")).expect("rm");
    assert!(refusal(dir.path()).contains("packed LLM cache is missing"));
}

/// The version of `good()` as a build before the contract block made it: no block, no pointer, no `contract/`.
fn unstamped() -> tempfile::TempDir {
    let dir = good();
    let mut m: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.path().join("manifest.json")).expect("m"),
    )
    .expect("json");
    let o = m.as_object_mut().expect("object");
    o.remove("contract");
    o.remove("heldout");
    std::fs::write(dir.path().join("manifest.json"), m.to_string()).expect("write");
    std::fs::remove_dir_all(dir.path().join("contract")).expect("rm");
    dir
}

fn data_hashes(dir: &Path) -> Vec<(String, String)> {
    [
        "data/train.jsonl.zst",
        "data/val.jsonl.zst",
        "data/noise.jsonl.zst",
        "data/test.jsonl.zst",
        "data/train-1000.jsonl.zst",
        "worlds/train-00.json",
        "build/llm-cache.jsonl.zst",
    ]
    .iter()
    .map(|rel| {
        let bytes = std::fs::read(dir.join(rel)).expect("file");
        ((*rel).to_owned(), blake3::hash(&bytes).to_hex().to_string())
    })
    .collect()
}

#[test]
fn restamp_adds_the_contract_and_the_pointer_and_changes_no_data_file_and_never_reads_test() {
    let dir = unstamped();
    // the test split is garbage that is not even zstd: restamp must not open it
    let test_split = std::fs::read(dir.path().join("data/test.jsonl.zst")).expect("test");
    std::fs::write(dir.path().join("data/test.jsonl.zst"), b"not a zstd frame").expect("w");
    assert!(refusal(dir.path()).contains("no contract block"));
    let before = data_hashes(dir.path());
    let (contract, proofs) =
        contract::restamp(dir.path(), publish::HELDOUT_REPO).expect("restamps");
    assert_eq!(data_hashes(dir.path()), before, "a data file changed");
    assert_eq!(proofs.len(), 2);
    for pr in &proofs {
        assert!(["train", "val"].contains(&pr.split.as_str()));
        assert_eq!((pr.records, pr.with_block), (1, 1));
    }
    let m: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.path().join("manifest.json")).expect("m"),
    )
    .expect("json");
    assert_eq!(m["contract"], contract.to_json());
    assert_eq!(m["contract"]["tools_mode"], "sig");
    assert_eq!(m["contract"]["catalog_hash"], "cafe1234");
    assert_eq!(m["contract"]["tokenizer_blake3"], "ab12");
    assert_eq!(m["heldout"]["repo"], publish::HELDOUT_REPO);
    assert!(contract::file_problems(dir.path(), &contract).is_empty());
    // the version now publishes (with the test file as it was), and restamping again changes nothing
    std::fs::write(dir.path().join("data/test.jsonl.zst"), test_split).expect("w");
    publish::prepare(dir.path(), publish::EXAMPLE_REPO, None).expect("prepares");
    let once = std::fs::read(dir.path().join("manifest.json")).expect("m");
    contract::restamp(dir.path(), publish::HELDOUT_REPO).expect("again");
    assert_eq!(
        std::fs::read(dir.path().join("manifest.json")).expect("m"),
        once
    );
}

#[test]
fn restamp_refuses_with_counts_when_the_tools_text_is_not_in_the_records() {
    let dir = unstamped();
    // val was rendered with something else: one record holds the block, one does not
    let other = json!({"id": "val-00-2", "render": {"text": "<|im_start|>system\n# Tools\n\nan older tools block"}}).to_string();
    let body = zst(&[&record("val-00-1"), &other]);
    let entry = put(dir.path(), "data/val.jsonl.zst", &body);
    let mut m: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.path().join("manifest.json")).expect("m"),
    )
    .expect("json");
    m["files"]["data/val.jsonl.zst"] = entry;
    std::fs::write(dir.path().join("manifest.json"), m.to_string()).expect("write");
    let manifest_before = std::fs::read(dir.path().join("manifest.json")).expect("m");
    let err = contract::restamp(dir.path(), publish::HELDOUT_REPO)
        .expect_err("refused")
        .to_string();
    assert!(
        err.contains("val: 1 of 2 records hold the tools block"),
        "{err}"
    );
    assert!(!err.contains("train:"), "{err}");
    // nothing was changed: no contract/, the manifest as it was
    assert!(!dir.path().join("contract").exists());
    assert_eq!(
        std::fs::read(dir.path().join("manifest.json")).expect("m"),
        manifest_before
    );
    // a different mode's block is not the block either
    let dir = unstamped();
    let mut m: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.path().join("manifest.json")).expect("m"),
    )
    .expect("json");
    m["tools_block"]["mode"] = json!("s2");
    std::fs::write(dir.path().join("manifest.json"), m.to_string()).expect("write");
    let err = contract::restamp(dir.path(), publish::HELDOUT_REPO)
        .expect_err("refused")
        .to_string();
    assert!(
        err.contains("train: 0 of 1") && err.contains("val: 0 of 1"),
        "{err}"
    );
}
