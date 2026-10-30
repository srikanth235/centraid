//! Demonstrated reds for `native-shell-parity`: the census, the spellings, and
//! each verdict of the register's ratchet over a fixture tree that must be
//! caught, and one that must be clean.

use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use crate::rules::RuleState;
use crate::testing::fixture_dir;

const PROTO: &str = "crates/api-proto/proto/centraid/core/v1/card_screens.proto";
const KOTLIN: &str = "mobile/androidApp/src/main/kotlin/dev/centraid/android/Card.kt";
const SWIFT: &str = "mobile/iosApp/Sources/Card.swift";

const NO_FLOOR: Floors = Floors {
    items: 0,
    kotlin: 0,
    swift: 0,
};

fn write(root: &Path, relative: &str, contents: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("a parent")).expect("create fixture dirs");
    fs::write(path, contents).expect("write fixture");
}

fn findings(report: &RuleReport) -> String {
    report.findings.join("\n")
}

/// A tree whose one message has a plain field, three with a spelling to
/// resolve, a oneof arm and a nested message.
fn tree(name: &str, kotlin: &str, swift: &str) -> PathBuf {
    let root = fixture_dir(name);
    write(
        &root,
        PROTO,
        r#"syntax = "proto3";
package centraid.core.v1;

message Card {
  string title = 1;
  string photo_id = 2;
  bool has_value = 3;
  string open_url = 4;
  oneof kind {
    ClipboardSet clipboard_set = 5;
  }
  message Inner {
    string deep_label = 1;
  }
}
"#,
    );
    write(&root, KOTLIN, kotlin);
    write(&root, SWIFT, swift);
    root
}

/// Both shells read every field of [`tree`], each in its own spelling.
const KOTLIN_ALL: &str = "fun draw(card: Card) {\n  card.title\n  card.photo_id\n  card.has_value\n  card.open_url\n  card.clipboard_set\n  card.deep_label\n}\n";
const SWIFT_ALL: &str = "func draw(_ card: Card) {\n  card.title\n  card.photoID\n  card.hasValue_p\n  card.openURL\n  card.deepLabel\n  switch card.kind {\n  case .clipboardSet(let set)?: use(set)\n  }\n}\n";

fn run(root: &Path, register: &[Entry]) -> RuleReport {
    check(root, register, NO_FLOOR)
}

// ---- the clean tree ----

#[test]
fn a_tree_both_shells_read_is_clean_in_every_spelling() {
    let root = tree("parity-green", KOTLIN_ALL, SWIFT_ALL);
    let report = run(&root, &[]);
    assert!(matches!(report.state, RuleState::Applied(3)));
    assert!(report.findings.is_empty(), "{}", findings(&report));
    assert!(
        report.note.contains("6 item(s)"),
        "the note counts the census: {}",
        report.note
    );
}

// ---- (a) a one-sided or unread item with no entry ----

#[test]
fn a_field_one_shell_reads_and_the_other_does_not_is_caught_both_ways() {
    let kotlin = KOTLIN_ALL.replace("  card.open_url\n", "");
    let swift = SWIFT_ALL.replace("  card.deepLabel\n", "");
    let root = tree("parity-one-sided", &kotlin, &swift);
    let report = run(&root, &[]);
    let text = findings(&report);
    assert_eq!(report.findings.len(), 2, "{text}");
    assert!(
        text.contains("Card.open_url: only SwiftUI reads it"),
        "{text}"
    );
    assert!(
        text.contains("Card.Inner.deep_label: only Compose reads it"),
        "{text}"
    );
    assert!(
        text.contains("`openURL`"),
        "names the Swift spelling: {text}"
    );
}

#[test]
fn a_field_neither_shell_reads_is_caught() {
    let kotlin = KOTLIN_ALL.replace("  card.title\n", "");
    let swift = SWIFT_ALL.replace("  card.title\n", "");
    let root = tree("parity-neither", &kotlin, &swift);
    let report = run(&root, &[]);
    assert_eq!(report.findings.len(), 1, "{}", findings(&report));
    assert!(
        findings(&report).contains("Card.title: neither shell reads it"),
        "{}",
        findings(&report)
    );
}

// ---- the register's three verdicts: accepted, stale, disagreeing ----

#[test]
fn a_register_entry_that_matches_what_the_census_sees_is_accepted() {
    let kotlin = KOTLIN_ALL.replace("  card.open_url\n", "");
    let swift = SWIFT_ALL.replace("  card.title\n", "");
    let kotlin = kotlin.replace("  card.title\n", "");
    let root = tree("parity-accepted", &kotlin, &swift);
    let register = [
        ("Card.open_url", gap("B", Missing::Android)),
        ("Card.title", gap("F", Missing::Both)),
    ];
    let report = run(&root, &register);
    assert!(report.findings.is_empty(), "{}", findings(&report));
}

#[test]
fn a_platform_entry_holds_only_while_the_other_shell_reads_nothing() {
    let kotlin = KOTLIN_ALL.replace("  card.open_url\n", "");
    let root = tree("parity-platform", &kotlin, SWIFT_ALL);
    let ios_only = [(
        "Card.open_url",
        platform(Shell::Ios, "Android has no URL to open"),
    )];
    assert!(run(&root, &ios_only).findings.is_empty());
    // The same item, registered as Android's: the census disagrees.
    let wrong = [(
        "Card.open_url",
        platform(Shell::Android, "Android has the URL"),
    )];
    let report = run(&root, &wrong);
    assert_eq!(report.findings.len(), 1, "{}", findings(&report));
    assert!(
        findings(&report).contains("registered as only Android has it"),
        "{}",
        findings(&report)
    );
}

#[test]
fn a_gap_that_closed_must_leave_the_register() {
    let root = tree("parity-stale", KOTLIN_ALL, SWIFT_ALL);
    let register = [
        ("Card.open_url", gap("A", Missing::Android)),
        ("Card.title", platform(Shell::Ios, "no longer true")),
    ];
    let report = run(&root, &register);
    let text = findings(&report);
    assert_eq!(report.findings.len(), 2, "{text}");
    for key in ["Card.open_url", "Card.title"] {
        assert!(
            text.contains(&format!(
                "{key}: both shells read it now; delete its register entry"
            )),
            "{text}"
        );
    }
}

#[test]
fn a_gap_whose_missing_side_moved_is_caught() {
    let swift = SWIFT_ALL.replace("  card.openURL\n", "");
    let root = tree("parity-moved", KOTLIN_ALL, &swift);
    // Registered as Android missing; in fact iOS is the one missing now.
    let register = [("Card.open_url", gap("D", Missing::Android))];
    let report = run(&root, &register);
    assert_eq!(report.findings.len(), 1, "{}", findings(&report));
    assert!(
        findings(&report)
            .contains("registered as a lane D gap missing on Android, but only Compose reads it"),
        "{}",
        findings(&report)
    );
}

// ---- (d) an entry for nothing ----

#[test]
fn an_entry_naming_no_proto_item_and_a_duplicate_are_caught() {
    let root = tree("parity-ghost", KOTLIN_ALL, SWIFT_ALL);
    let register = [
        ("Card.vanished", gap("F", Missing::Both)),
        ("Card.Inner.deep_label", gap("F", Missing::Both)),
        ("Card.Inner.deep_label", gap("F", Missing::Both)),
    ];
    let text = findings(&run(&root, &register));
    assert!(
        text.contains("Card.vanished: in the register, but no such field is in the screens protos"),
        "{text}"
    );
    assert!(
        text.contains("Card.Inner.deep_label: in the register twice"),
        "{text}"
    );
}

// ---- comments ----

#[test]
fn a_name_in_a_comment_is_not_a_read() {
    let kotlin = "fun draw(card: Card) {\n  card.title\n  // card.photo_id\n  /* card.has_value */\n  /**\n   * Draws `open_url` and `.clipboard_set`.\n   * /* nested: card.deep_label */\n   */\n}\n";
    let swift = "func draw(_ card: Card) {\n  card.title\n  /// card.photoID\n  // card.hasValue_p\n  /* card.openURL /* card.deepLabel */ still a comment: .clipboardSet */\n}\n";
    let root = tree("parity-comments", kotlin, swift);
    let report = run(&root, &[]);
    let text = findings(&report);
    for key in [
        "Card.photo_id",
        "Card.has_value",
        "Card.open_url",
        "Card.clipboard_set",
        "Card.Inner.deep_label",
    ] {
        assert!(
            text.contains(&format!("{key}: neither shell reads it")),
            "{key} must not be read through a comment:\n{text}"
        );
    }
    assert!(!text.contains("Card.title"), "{text}");
}

#[test]
fn a_comment_marker_inside_a_string_opens_no_comment() {
    let kotlin = format!("fun media() = \"*/*\"\nfun other() = '\"'\n{KOTLIN_ALL}");
    let swift = format!("let any = \"/* not a comment\"\n{SWIFT_ALL}");
    let root = tree("parity-strings", &kotlin, &swift);
    let report = run(&root, &[]);
    assert!(report.findings.is_empty(), "{}", findings(&report));
}

#[test]
fn comments_are_cut_and_strings_and_lines_are_kept() {
    let cut = without_comments("a // x\nb /* y\nz */ c \"// s\" '\\'' d\n/* /* n */ e */ f\n");
    assert_eq!(cut, "a \nb \n c \"// s\" '\\'' d\n f\n");
}

// ---- spellings ----

#[test]
fn kotlin_reads_a_dot_a_named_argument_and_wires_underscore_but_not_a_local() {
    let mut names = BTreeSet::new();
    kotlin_reads(
        "val title = 1\nvar draft = 2\nfun f() { show(label = x, other_ = y); card.deep?.data_ ; if (a == b) {}; c.d(e = 1) }",
        &mut names,
    );
    for read in ["label", "other_", "deep", "data_", "e", "d"] {
        assert!(names.contains(read), "{read} in {names:?}");
    }
    for local in ["title", "draft", "a", "b"] {
        assert!(!names.contains(local), "{local} is no read: {names:?}");
    }
}

#[test]
fn swift_reads_a_receiver_a_label_and_an_arm_but_not_a_bare_member_or_a_declaration() {
    let mut reads = SwiftReads::default();
    swift_reads(
        "let shown: Int = 1\nvar held: Bool\nx.scrollContentBackground(.hidden)\nf(label: card.title)\ncase .clipboardSet(let s)?: break\nlet y = (z)?.chained",
        &mut reads,
    );
    assert!(reads.receiver.contains("title"));
    assert!(reads.receiver.contains("chained"));
    assert!(reads.label.contains("label"));
    assert!(reads.implicit.contains("clipboardSet"));
    assert!(reads.implicit.contains("hidden"));
    assert!(!reads.receiver.contains("hidden"));
    assert!(!reads.label.contains("shown") && !reads.label.contains("held"));
}

#[test]
fn a_bare_member_reads_a_oneof_arm_and_nothing_else() {
    // `.hidden` is SwiftUI's; `Card.hidden` is a plain field, so it needs a receiver.
    let proto = "message Card {\n  bool hidden = 1;\n  oneof kind { Hide hide = 2; }\n}\n";
    let root = fixture_dir("parity-implicit");
    write(&root, PROTO, proto);
    write(&root, KOTLIN, "fun f() = c.hidden + c.hide\n");
    write(
        &root,
        SWIFT,
        "func f() { w.scrollContentBackground(.hidden); if case .hide? = k {} }\n",
    );
    let report = run(&root, &[]);
    let text = findings(&report);
    assert_eq!(report.findings.len(), 1, "{text}");
    assert!(
        text.contains("Card.hidden: only Compose reads it"),
        "{text}"
    );
}

#[test]
fn swiftprotobuf_spellings_resolve_initialisms_and_the_p_suffix() {
    assert_eq!(
        swift_spellings("photo_id").into_iter().collect::<Vec<_>>(),
        ["photoID", "photoId"]
    );
    assert!(swift_spellings("open_url").contains("openURL"));
    assert!(swift_spellings("effect_id").contains("effectID"));
    assert!(swift_spellings("clear_after_ms").contains("clearAfterMs"));
    // A leading `id`/`url` stays lower-case.
    assert_eq!(
        swift_spellings("id").into_iter().collect::<Vec<_>>(),
        ["id"]
    );
    let root = tree(
        "parity-p-suffix",
        "fun f() = c.has_value + c.data_\n",
        "func f() { c.hasValue_p; c.clearAfterMs_p }\n",
    );
    let report = run(&root, &[]);
    // `has_value` resolved through `hasValue_p`: the only one both shells read.
    assert!(
        !findings(&report).contains("Card.has_value"),
        "{}",
        findings(&report)
    );
}

// ---- the census ----

#[test]
fn the_census_qualifies_nested_messages_and_skips_enums_reserved_and_options() {
    let items = proto_items(
        r#"
syntax = "proto3";
import "centraid/core/v1/route.proto";
option java_package = "x";
// message Ghost { string nope = 1; }
message Outer {
  reserved 4;
  reserved "gone";
  string a = 1;
  repeated string b = 2 [deprecated = true];
  map<string, string> txt = 3;
  optional bool c = 5;
  oneof kind {
    Inner inner = 6;
    Other other = 7;
  }
  enum Mode {
    MODE_UNSPECIFIED = 0;
    MODE_ON = 1;
  }
  message Inner {
    string deep = 1;
    message Deeper { string deepest = 1; }
  }
}
enum Top { TOP_UNSPECIFIED = 0; }
message Empty {}
"#,
    );
    let keys: Vec<&str> = items.iter().map(|item| item.key.as_str()).collect();
    assert_eq!(
        keys,
        [
            "Outer.a",
            "Outer.b",
            "Outer.txt",
            "Outer.c",
            "Outer.inner",
            "Outer.other",
            "Outer.Inner.deep",
            "Outer.Inner.Deeper.deepest",
        ]
    );
    let arms: Vec<&str> = items
        .iter()
        .filter(|item| item.arm)
        .map(|item| item.field.as_str())
        .collect();
    assert_eq!(arms, ["inner", "other"]);
}

// ---- which sources are the shells' ----

#[test]
fn generated_swift_tests_and_the_ios_main_set_are_not_a_shell_read() {
    let root = tree(
        "parity-scope",
        "fun f() = c.title\n",
        "func f() { c.title }\n",
    );
    write(
        &root,
        "mobile/iosApp/Sources/Generated/Card.pb.swift",
        "var photoID: String\nc.photoID\n",
    );
    write(
        &root,
        "mobile/androidApp/src/test/kotlin/CardTest.kt",
        "fun t() = c.photo_id\n",
    );
    write(
        &root,
        "mobile/core/src/iosMain/kotlin/dev/centraid/core/Ios.kt",
        "fun i() = c.photo_id\n",
    );
    write(
        &root,
        "mobile/core/src/jnaMain/kotlin/dev/centraid/core/Jna.kt",
        "fun j() = c.open_url\n",
    );
    let text = findings(&run(&root, &[]));
    assert!(
        text.contains("Card.photo_id: neither shell reads it"),
        "{text}"
    );
    assert!(
        text.contains("Card.open_url: only Compose reads it"),
        "{text}"
    );
}

#[test]
fn only_the_screens_protos_are_the_census() {
    let root = tree("parity-protos", KOTLIN_ALL, SWIFT_ALL);
    write(
        &root,
        "crates/api-proto/proto/centraid/core/v1/money.proto",
        "message Row { string never_drawn = 1; }\n",
    );
    write(
        &root,
        "crates/api-proto/proto/centraid/core/v1/screens.proto",
        "message Top { string seen = 1; }\n",
    );
    let text = findings(&run(&root, &[]));
    assert!(!text.contains("never_drawn"), "{text}");
    assert!(text.contains("Top.seen: neither shell reads it"), "{text}");
}

// ---- the rule refuses to pass over nothing ----

#[test]
fn a_census_over_too_little_fails_and_a_missing_subject_is_pending() {
    let root = tree("parity-floor", KOTLIN_ALL, SWIFT_ALL);
    let report = check(&root, &[], FLOORS);
    assert!(
        findings(&report).contains("a rule over too little passes forever"),
        "{}",
        findings(&report)
    );
    let bare = fixture_dir("parity-pending");
    assert!(matches!(
        check(&bare, &[], FLOORS).state,
        RuleState::Pending(_)
    ));
    write(&bare, PROTO, "message A { string b = 1; }\n");
    assert!(matches!(
        check(&bare, &[], FLOORS).state,
        RuleState::Pending(_)
    ));
}

// ---- the checked-in register ----

#[test]
fn the_register_is_well_formed() {
    let mut seen = BTreeSet::new();
    for (key, status) in REGISTER {
        assert!(seen.insert(*key), "{key} twice");
        assert!(key.contains('.'), "{key} is Message.field");
        match status {
            Status::Platform { why, .. } => {
                assert!(
                    why.len() > 20,
                    "{key}: a Platform row says why the platform has no such thing"
                )
            }
            Status::Gap { lane, .. } => assert!(
                matches!(*lane, "A" | "B" | "C" | "D" | "F"),
                "{key}: lane {lane}"
            ),
        }
    }
    let keys: Vec<&str> = REGISTER.iter().map(|(key, _)| *key).collect();
    assert!(
        REGISTER
            .iter()
            .any(|(_, status)| matches!(status, Status::Platform { .. }))
            && keys.len() > 100,
        "the register stopped being read"
    );
}
