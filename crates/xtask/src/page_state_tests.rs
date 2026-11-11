//! Demonstrated reds for the `page-state` rule: a fixture tree that must be caught, and one that
//! must be clean.

use std::fs;
use std::path::Path;

use super::*;
use crate::testing::fixture_dir;

fn write(root: &Path, relative: &str, contents: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("a parent")).expect("create fixture dirs");
    fs::write(path, contents).expect("write fixture");
}

const PROTO: &str = "crates/api-proto/proto/centraid/core/v1";

const SCREENS: &str = "message ViewState {\n  oneof kind {\n    ListState list = 1;\n    NoteState note = 2;\n  }\n  uint64 instance = 9;\n}\n";

fn clean(name: &str) -> std::path::PathBuf {
    let root = fixture_dir(name);
    write(&root, &format!("{PROTO}/screens.proto"), SCREENS);
    write(
        &root,
        &format!("{PROTO}/list_screens.proto"),
        "message ListState {\n  PageState page = 1;\n  repeated Row rows = 2;\n}\nmessage Row {\n  string title = 1;\n}\nmessage NoteState {\n  string title = 1;\n}\n",
    );
    write(
        &root,
        &format!("{PROTO}/kit_screens.proto"),
        "message PageState {\n  oneof state {\n    Loading loading = 1;\n    Failure failed = 2;\n    Denied refused = 3;\n  }\n}\n",
    );
    write(
        &root,
        "crates/screens/src/list.rs",
        "fn view() { let _ = ctx.load(&q); let _ = view_state::Kind::List(x); }\n",
    );
    write(
        &root,
        "crates/screens/src/kit/read.rs",
        "pub enum Page { Loading, Failed, Empty }\n",
    );
    root
}

#[test]
fn a_tree_whose_reads_all_carry_the_page_is_clean() {
    let root = clean("page-state-clean");
    let report = page_state(&root);
    assert!(report.findings.is_empty(), "{:?}", report.findings);
}

#[test]
fn a_screen_with_its_own_read_arms_is_caught() {
    let root = clean("page-state-arms");
    write(
        &root,
        &format!("{PROTO}/list_screens.proto"),
        "message ListState {\n  PageState page = 1;\n  oneof content {\n    Loading loading = 2;\n    Rows data = 3;\n  }\n}\nmessage Rows {\n  repeated string rows = 1;\n}\nmessage NoteState {\n  string title = 1;\n}\n",
    );
    let report = page_state(&root);
    assert!(
        report
            .findings
            .iter()
            .any(|f| f.contains("ListState.loading")),
        "{:?}",
        report.findings
    );
}

#[test]
fn a_failure_and_a_denial_side_by_side_are_caught() {
    let root = clean("page-state-denied");
    write(
        &root,
        &format!("{PROTO}/list_screens.proto"),
        "message ListState {\n  PageState page = 1;\n  Failure failure = 2;\n  Denied denied = 3;\n}\nmessage NoteState {\n  string title = 1;\n}\n",
    );
    let report = page_state(&root);
    assert!(
        report
            .findings
            .iter()
            .any(|f| f.contains("ListState.denied")),
        "{:?}",
        report.findings
    );
}

#[test]
fn a_lone_failure_is_a_writes_refusal_not_a_read() {
    let root = clean("page-state-lone");
    write(
        &root,
        &format!("{PROTO}/list_screens.proto"),
        "message ListState {\n  PageState page = 1;\n  Failure refusal = 2;\n}\nmessage NoteState {\n  string title = 1;\n}\n",
    );
    let report = page_state(&root);
    assert!(report.findings.is_empty(), "{:?}", report.findings);
}

#[test]
fn a_screen_that_reads_and_has_no_page_is_caught() {
    let root = clean("page-state-no-page");
    write(
        &root,
        &format!("{PROTO}/list_screens.proto"),
        "message ListState {\n  repeated Row rows = 1;\n}\nmessage Row {\n  string title = 1;\n}\nmessage NoteState {\n  string title = 1;\n}\n",
    );
    let report = page_state(&root);
    assert!(
        report
            .findings
            .iter()
            .any(|f| f.contains("ListState") && f.contains("no `PageState page`")),
        "{:?}",
        report.findings
    );
}

#[test]
fn a_page_on_a_message_the_state_holds_counts() {
    let root = clean("page-state-nested");
    write(
        &root,
        &format!("{PROTO}/list_screens.proto"),
        "message ListState {\n  optional Tab tab = 1;\n}\nmessage Tab {\n  PageState page = 1;\n  repeated Row rows = 2;\n}\nmessage Row {\n  string title = 1;\n}\nmessage NoteState {\n  string title = 1;\n}\n",
    );
    let report = page_state(&root);
    assert!(report.findings.is_empty(), "{:?}", report.findings);
}

#[test]
fn a_screen_that_reads_nothing_needs_no_page() {
    let root = clean("page-state-reads-nothing");
    write(
        &root,
        &format!("{PROTO}/list_screens.proto"),
        "message ListState {\n  repeated Row rows = 1;\n}\nmessage Row {\n  string title = 1;\n}\nmessage NoteState {\n  string title = 1;\n}\n",
    );
    write(
        &root,
        "crates/screens/src/list.rs",
        "fn view() { let _ = view_state::Kind::List(x); }\n",
    );
    let report = page_state(&root);
    assert!(report.findings.is_empty(), "{:?}", report.findings);
}

#[test]
fn a_private_loading_and_failed_enum_is_caught_outside_the_kit() {
    let root = clean("page-state-enum");
    write(
        &root,
        "crates/screens/src/list.rs",
        "enum Phase { Loading, Failed, Ready }\nfn view() { let _ = view_state::Kind::List(x); }\n",
    );
    let report = page_state(&root);
    assert!(
        report.findings.iter().any(|f| f.contains("enum Phase")),
        "{:?}",
        report.findings
    );
}

#[test]
fn an_enum_in_a_files_unit_tests_is_not_a_screens() {
    let root = clean("page-state-enum-tests");
    write(
        &root,
        "crates/screens/src/list.rs",
        "fn view() { let _ = view_state::Kind::List(x); }\n#[cfg(test)]\nmod tests { enum Phase { Loading, Failed } }\n",
    );
    let report = page_state(&root);
    assert!(report.findings.is_empty(), "{:?}", report.findings);
}
