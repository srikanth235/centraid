use std::path::{Path, PathBuf};

use super::*;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

const SHELL: &str = "<!doctype html>\n<html><head><title>T</title></head><body><x-dc>\n<helmet>\n<link rel=\"stylesheet\" href=\"./tokens.css\">\n</helmet>\n";

fn board(body: &str) -> String {
    format!("{SHELL}<div style=\"width: 390px;\">\n{body}\n</div>\n</x-dc></body></html>\n")
}

/// A scratch tree: `design/mockups/<files>`, the wording table, and a canvas placing every board on `light`.
fn tree(files: &[(&str, String)]) -> PathBuf {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let root = std::env::temp_dir().join(format!(
        "xtask-boards-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let dir = root.join(MOCKUPS);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::create_dir_all(root.join(".claude/skills/design")).unwrap();
    std::fs::write(
        root.join(WORDING),
        "| Say | Never |\n| --- | --- |\n| backup device | gateway, laptop |\n| try again | Retry |\n",
    )
    .unwrap();
    let mut boards = serde_json::Map::new();
    for (name, text) in files {
        std::fs::write(dir.join(name), text).unwrap();
        let page = if name.starts_with("Part") {
            "parts"
        } else {
            "light"
        };
        boards.insert(
            (*name).to_owned(),
            serde_json::json!({"h": 844, "page": page, "title": name, "w": 390, "x": 0, "y": 0}),
        );
    }
    std::fs::write(
        dir.join(CANVAS),
        serde_json::json!({"boards": boards}).to_string(),
    )
    .unwrap();
    root
}

fn problems(files: &[(&str, String)]) -> Vec<String> {
    let root = tree(files);
    let tokens = Tokens::load(&repo()).unwrap();
    let generated = generate(&root, &tokens).unwrap();
    let _ = std::fs::remove_dir_all(&root);
    generated.problems
}

#[test]
fn a_raw_colour_is_found_wherever_it_is_written() {
    for raw in [
        "color: #1C1B19",
        "background: rgba(0,0,0,0.5)",
        "border: 1px solid white",
        "box-shadow: 0 1px 2px rgb(0 0 0 / 10%)",
        "background: linear-gradient(red, var(--a))",
    ] {
        assert!(writes_raw_colour(raw), "{raw}");
    }
    for clean in [
        "color: var(--text-ink)",
        "background: transparent",
        "white-space: nowrap",
        "font-family: 'Geist Mono', monospace",
        "background: url(\"data:image/svg+xml,%23fff\")",
        "content: \"#fff\"",
        "fill: currentColor",
    ] {
        assert!(!writes_raw_colour(clean), "{clean}");
    }
}

#[test]
fn a_raw_colour_fails_unless_its_element_is_kept() {
    let found = problems(&[(
        "A.dc.html",
        board(
            "<div style=\"color: #FFF\"></div>\n<div data-keep style=\"background: #123456\"><i style=\"color: red\"></i></div>",
        ),
    )]);
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].contains("raw colour"), "{found:?}");
}

#[test]
fn a_link_to_no_board_and_a_button_in_a_link_fail_and_data_next_waits() {
    let found = problems(&[
        (
            "A.dc.html",
            board(
                "<a href=\"Nowhere.dc.html\"><button>Go</button></a>\n<a data-next=\"Later\">x</a>\n<a href=\"B.dc.html\">b</a>",
            ),
        ),
        ("B.dc.html", board("<a data-next=\"A\">a</a>")),
    ]);
    let all = found.join("\n");
    assert!(
        all.contains("A.dc.html: a link to Nowhere.dc.html, which is no board"),
        "{all}"
    );
    assert!(all.contains("a <button> inside a board link"), "{all}");
    assert!(
        all.contains("B.dc.html: data-next=\"A\" names a board that exists now"),
        "{all}"
    );
    assert!(!all.contains("Later"), "{all}");
}

#[test]
fn the_retired_words_and_every_never_word_fail_but_the_command_a_member_types_does_not() {
    let found = problems(&[(
        "A.dc.html",
        board(
            "<p>Agenda</p><p>What Docs may read</p><p aria-label=\"Retry\">x</p><p>Run centraid-gateway pair</p><p>A gateway, a laptop</p>",
        ),
    )]);
    let all = found.join("\n");
    assert!(all.contains("the retired word \"Agenda\""), "{all}");
    assert!(all.contains("\"What … may read\" row"), "{all}");
    assert!(all.contains("\"Retry\""), "{all}");
    assert!(all.contains("\"gateway\""), "{all}");
    assert!(all.contains("\"laptop\""), "{all}");
    let clean = problems(&[("A.dc.html", board("<p>Run centraid-gateway pair</p>"))]);
    assert!(clean.is_empty(), "{clean:?}");
}

#[test]
fn a_comment_is_a_problem_but_a_part_marker_is_not() {
    let found = problems(&[("A.dc.html", board("<!-- history -->\n<p>x</p>"))]);
    assert!(
        found.iter().any(|p| p.contains("HTML comment")),
        "{found:?}"
    );
}

fn part(variants: &[(&str, &str)]) -> String {
    let body: String = variants
        .iter()
        .map(|(name, html)| format!("<!-- variant:{name} -->\n{html}\n<!-- /variant -->\n"))
        .collect();
    board(&body)
}

#[test]
fn a_part_marker_fills_the_variant_and_its_slots_and_a_hand_edit_names_the_part_file() {
    let row = part(&[
        (
            "plain",
            "<div class=\"row\"><span data-slot=\"title\">Title</span></div>",
        ),
        (
            "dimmed",
            "<div class=\"row dim\"><span data-slot=\"title\">Title</span></div>",
        ),
    ]);
    let ok = board(
        "  <!-- part:Row variant=\"dimmed\" title=\"Dentist\" -->\n  <div class=\"row dim\"><span data-slot=\"title\">Dentist</span></div>\n  <!-- /part -->",
    );
    let hand_edited = board(
        "  <!-- part:Row variant=\"dimmed\" title=\"Dentist\" -->\n  <div class=\"row\"><span data-slot=\"title\">Dentist</span></div>\n  <!-- /part -->",
    );
    assert!(problems(&[("PartRow.dc.html", row.clone()), ("A.dc.html", ok)]).is_empty());
    let found = problems(&[("PartRow.dc.html", row), ("A.dc.html", hand_edited)]);
    assert!(
        found.iter().any(|p| p.contains("A.dc.html: part Row is not what the generator writes; edit PartRow.dc.html, not A.dc.html")),
        "{found:?}"
    );
}

#[test]
fn an_unknown_an_unclosed_and_a_stray_part_marker_fail() {
    let row = part(&[("plain", "<p>x</p>")]);
    for (body, expect) in [
        ("<!-- part:Nope -->\n<!-- /part -->", "unknown part Nope"),
        ("<!-- part:Row -->\n<p>x</p>", "no closing"),
        ("<p>x</p>\n<!-- /part -->", "no opening marker"),
        (
            "<!-- part:Row variant=\"none\" -->\n<!-- /part -->",
            "no variant none",
        ),
    ] {
        let found = problems(&[("PartRow.dc.html", row.clone()), ("A.dc.html", board(body))]);
        assert!(
            found.iter().any(|p| p.contains(expect)),
            "{expect}: {found:?}"
        );
    }
}

#[test]
fn a_dark_twin_is_the_same_board_with_the_theme_set_and_its_links_kept_in_dark() {
    let twins: BTreeSet<String> = ["A.dc.html", "B.dc.html"].map(String::from).into();
    let text = board("<a href=\"B.dc.html\">b</a><a href=\"Elsewhere.dc.html\">e</a>");
    let twin = twin_text(&text, &twins).unwrap();
    assert!(twin.contains("<title>T (dark)</title>"));
    assert!(twin.contains("<div data-theme=\"dark\" style=\"width: 390px;\">"));
    assert!(twin.contains("href=\"BDark.dc.html\""));
    assert!(twin.contains("href=\"Elsewhere.dc.html\""));
}

#[test]
fn the_never_column_is_read_from_the_wording_table() {
    let table = "| Say | Never |\n| --- | --- |\n| backup device | gateway, laptop, NAS |\n| photo | photograph |\n\nprose";
    assert_eq!(
        never_words(table),
        ["gateway", "laptop", "NAS", "photograph"]
    );
}

#[test]
fn the_committed_tokens_css_has_every_role_in_both_schemes() {
    let tokens = Tokens::load(&repo()).unwrap();
    let css = tokens_css(&tokens);
    let (light, dark) = css.split_once("[data-theme=\"dark\"]").unwrap();
    for role in css_roles(&tokens) {
        assert!(
            light.contains(&format!("--{}: {};", role.name, role.light)),
            "{}",
            role.name
        );
        assert!(
            dark.contains(&format!("--{}: {};", role.name, role.dark)),
            "{}",
            role.name
        );
    }
}
