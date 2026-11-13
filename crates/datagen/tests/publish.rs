//! H8: publish checks first and uploads last. A version is laid out the way the trainer fetches it (train and val apart
//! from test), described by a generated card, and refused for every reason a version must not leave the machine. The
//! dry run sends nothing; the upload hands a stub transport the staged tree and the token only through its environment.

use std::path::Path;

use centraid_datagen::publish::{self, Source};
use serde_json::{Value, json};

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
        ("data/train.jsonl.zst", zst(&["{\"id\":\"train-00-1\"}"])),
        (
            "data/train-1000.jsonl.zst",
            zst(&["{\"id\":\"train-00-1\"}"]),
        ),
        ("data/val.jsonl.zst", zst(&["{\"id\":\"val-00-1\"}"])),
        (
            "data/noise.jsonl.zst",
            zst(&["{\"id\":\"val-00-1~noise\"}"]),
        ),
        ("data/test.jsonl.zst", zst(&["{\"id\":\"test-00-1\"}"])),
    ] {
        files.insert(rel.to_owned(), put(dir, rel, &body));
    }
    put(dir, "worlds/train-00.json", b"{\"people\":[]}");
    put(dir, "worlds/test-00.json", b"{\"people\":[]}");
    put(dir, "build/messages.txt", b"report");
    put(dir, "build/packed-cache.tar.zst", b"not uploaded");
    let manifest = json!({
        "version": "v0.9",
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
    publish::prepare(dir, publish::EXAMPLE_REPO)
        .expect_err("refused")
        .to_string()
}

#[test]
fn a_version_is_laid_out_with_train_and_val_apart_from_test() {
    let dir = good();
    let p = publish::prepare(dir.path(), publish::EXAMPLE_REPO).expect("prepares");
    let remote: Vec<&str> = p.files.iter().map(|f| f.remote.as_str()).collect();
    for want in [
        "manifest.json",
        "README.md",
        "data/train.jsonl.zst",
        "data/val.jsonl.zst",
        "data/train-1000.jsonl.zst",
        "data/noise.jsonl.zst",
        "worlds/train-00.json",
        "test/test.jsonl.zst",
        "test/worlds/test-00.json",
        "build/messages.txt",
    ] {
        assert!(remote.contains(&want), "{want} missing from {remote:?}");
    }
    // nothing of test is reachable by the paths the trainer asks for, or by the data/ and worlds/ folders
    for r in &remote {
        assert!(
            !(r.contains("test") && (r.starts_with("data/") || r.starts_with("worlds/"))),
            "{r} lets a fetch of data/ or worlds/ pull test"
        );
    }
    assert!(!remote.iter().any(|r| r.contains("packed-cache")));
    let hashes: Vec<&str> = p.files.iter().map(|f| f.blake3.as_str()).collect();
    assert!(hashes.iter().all(|h| h.len() == 64));
}

#[test]
fn the_card_says_what_the_data_is_and_what_it_was_built_from() {
    let dir = good();
    let p = publish::prepare(dir.path(), publish::EXAMPLE_REPO).expect("prepares");
    let Some(Source::Text(card)) = p
        .files
        .iter()
        .find(|f| f.remote == "README.md")
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
    ] {
        assert!(card.contains(want), "the card lacks `{want}`:\n{card}");
    }
}

#[test]
fn a_dry_run_lists_every_file_with_size_and_hash_and_sends_nothing() {
    let dir = good();
    let p = publish::prepare(dir.path(), publish::EXAMPLE_REPO).expect("prepares");
    let text = publish::dry_run(&p, None, true, None);
    assert!(text.contains("dry run: nothing is uploaded"));
    assert!(text.contains("private"));
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
    assert!(why.contains("worlds/train-00.json"), "{why}");
}

#[cfg(unix)]
#[test]
fn an_upload_hands_the_transport_the_staged_tree_and_the_token_only_through_its_environment() {
    use std::os::unix::fs::PermissionsExt;
    let dir = good();
    let p = publish::prepare(dir.path(), publish::EXAMPLE_REPO).expect("prepares");
    // a stand-in for python: it records its arguments, its standard input and whether the token is in its environment
    let bin = tempfile::tempdir().expect("bin");
    let record = bin.path().join("record.txt");
    let stub = bin.path().join("stub");
    std::fs::write(
        &stub,
        format!(
            "#!/bin/sh\nif [ $# -eq 2 ]; then cat > /dev/null; echo '[\".gitattributes\", \"data/test.jsonl.zst\", \"worlds/test-00.json\"]'; exit 0; fi\necho \"args: $@\" > {r}\ncat >> {r}\necho \"env: $HF_TOKEN\" >> {r}\necho \"deletes: $(cat \"$6\")\" >> {r}\n[ -f \"$4/manifest.json\" ] && echo staged >> {r}\nls -R \"$4\" >> {r}\necho done\n",
            r = record.display()
        ),
    )
    .expect("stub");
    std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let token = "hf_secret_value_123";
    let done = publish::upload(
        &p,
        publish::EXAMPLE_REPO,
        true,
        stub.to_str().expect("path"),
        token,
    )
    .expect("uploads");
    assert_eq!(done, "done");
    let seen = std::fs::read_to_string(&record).expect("record");
    let first = seen.lines().next().expect("args line");
    assert!(
        first.contains("srikanth235/centraid-native-data")
            && first.contains("v0.9")
            && first.contains("private")
    );
    assert!(!first.contains(token), "the token is on a command line");
    assert!(
        !seen.contains("hf_secret_value_123\nimport") && seen.contains("env: hf_secret_value_123")
    );
    let script_has_token = seen
        .lines()
        .skip(1)
        .take_while(|l| !l.starts_with("env:"))
        .any(|l| l.contains(token));
    assert!(!script_has_token, "the token is in the script");
    assert!(seen.contains("staged") && seen.contains("test.jsonl.zst"));
    // the remote listing's strays go to the commit as deletes; plumbing and the publish set do not
    assert!(
        seen.contains("deletes: [\"data/test.jsonl.zst\",\"worlds/test-00.json\"]"),
        "{seen}"
    );
    // a repo that is not owner/name is refused before anything runs
    assert!(publish::upload(&p, "nope", true, "false", token).is_err());
}

#[test]
fn a_transport_failure_is_reported_without_the_token() {
    let dir = good();
    let p = publish::prepare(dir.path(), publish::EXAMPLE_REPO).expect("prepares");
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

fn paths(list: &[&str]) -> Vec<String> {
    list.iter().map(|p| (*p).to_owned()).collect()
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
fn a_dry_run_that_knows_the_remote_lists_the_paths_it_would_remove() {
    let dir = good();
    let p = publish::prepare(dir.path(), publish::EXAMPLE_REPO).expect("prepares");
    let mut remote = publish::publish_set(&p);
    remote.extend(paths(&[".gitattributes", "data/test.jsonl.zst"]));
    let text = publish::dry_run(&p, Some(publish::EXAMPLE_REPO), true, Some(&remote));
    assert!(text.contains("1 path(s)") && text.contains("remove  data/test.jsonl.zst"));
    assert!(!text.contains("remove  .gitattributes"));
}
