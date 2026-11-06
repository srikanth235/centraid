//! Fail before generation when a native literal would trap in the role lookup.
use std::{fs, path::Path};

use anyhow::{Context, Result, ensure};

use super::{ANDROID, IOS, Tokens};
use crate::rules::{relative, source_files};

#[derive(Clone, Copy)]
enum Language {
    Swift,
    Kotlin,
}

pub(super) fn validate(root: &Path, values: &Tokens) -> Result<()> {
    let mut swift = Vec::new();
    for directory in ["Sources", "AgendaWidget", "WidgetShared"] {
        swift.extend(source_files(&root.join(IOS).join(directory), "swift"));
    }
    swift.retain(|path| !relative(root, path).contains("/Generated/"));
    let kotlin = source_files(&root.join(ANDROID), "kt");
    let colors = values.colors(false);
    let dark_colors = values.colors(true);
    let mut findings = Vec::new();
    for (files, language) in [(swift, Language::Swift), (kotlin, Language::Kotlin)] {
        for path in files {
            let source = fs::read_to_string(&path)
                .with_context(|| format!("read native design roles in {}", path.display()))?;
            for (kind, role, line) in references(&source, language) {
                let known = match kind {
                    Kind::Type => values.typography.contains_key(&role),
                    Kind::Color => colors.contains_key(&role) && dark_colors.contains_key(&role),
                };
                if !known {
                    findings.push(format!(
                        "{}:{line}: unknown {} role {role:?}",
                        relative(root, &path),
                        kind.name()
                    ));
                }
            }
        }
    }
    ensure!(
        findings.is_empty(),
        "native literals must name roles emitted from design/tokens.toml:\n{}",
        findings.join("\n")
    );
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Type,
    Color,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Type => "typography",
            Self::Color => "color",
        }
    }
}

struct Token<'a> {
    text: &'a str,
    line: usize,
}

/// Only a whole literal argument or conditional result is a reference. A
/// predicate's comparison string, interpolation, or concatenation prefix is not.
fn references(source: &str, language: Language) -> Vec<(Kind, String, usize)> {
    let tokens = lex(source, language);
    let mut result = Vec::new();
    for (at, token) in tokens.iter().enumerate() {
        let (kind, open) = match token.text {
            "centraidType" => (Kind::Type, at + 1),
            "centraidColor" => (Kind::Color, at + 1),
            "Theme" if text_at(&tokens, at + 1) == "." => {
                let kind = match text_at(&tokens, at + 2) {
                    "style" | "font" | "uiFont" | "baseFont" | "resolve" => Kind::Type,
                    "color" => Kind::Color,
                    _ => continue,
                };
                (kind, at + 3)
            }
            _ => continue,
        };
        if text_at(&tokens, open) != "(" {
            continue;
        }
        for token in role_literals(role_argument(&tokens[open + 1..]), language) {
            if let Some(role) = literal(token.text, language) {
                result.push((kind, role, token.line));
            }
        }
    }
    result
}

fn role_argument<'a, 'b>(tokens: &'a [Token<'b>]) -> &'a [Token<'b>] {
    let mut first = &tokens[..0];
    let mut start = 0;
    let mut depth = 0i32;
    for (at, token) in tokens.iter().enumerate() {
        if depth != 0 || !matches!(token.text, "," | ")") {
            match token.text {
                "(" | "[" | "{" => depth += 1,
                ")" | "]" | "}" => depth -= 1,
                _ => {}
            }
            continue;
        }
        let argument = &tokens[start..at];
        if start == 0 {
            first = argument;
        }
        if text_at(argument, 0) == "role" && matches!(text_at(argument, 1), ":" | "=") {
            return &argument[2..];
        }
        if token.text == ")" {
            break;
        }
        start = at + 1;
    }
    first
}

fn top_level<'a, 'b>(tokens: &'a [Token<'b>]) -> Vec<(usize, &'a Token<'b>)> {
    let mut depth = 0i32;
    let mut found = Vec::new();
    for (at, token) in tokens.iter().enumerate() {
        if depth == 0 {
            found.push((at, token));
            if token.text == ")" {
                break;
            }
        }
        match token.text {
            "(" | "[" | "{" => depth += 1,
            ")" | "]" | "}" => {
                depth -= 1;
                if depth == 0 {
                    found.push((at, token));
                }
            }
            _ => {}
        }
    }
    found
}

fn role_literals<'a, 'b>(mut tokens: &'a [Token<'b>], language: Language) -> Vec<&'a Token<'b>> {
    let mut top = top_level(tokens);
    if matches!(text_at(tokens, 0), "(" | "{") && top.len() == 2 && top[1].0 + 1 == tokens.len() {
        tokens = &tokens[1..tokens.len() - 1];
        top = top_level(tokens);
    }
    if tokens.len() == 1 {
        return vec![&tokens[0]];
    }
    let branches = match language {
        Language::Swift => {
            let question = |at: usize| {
                text_at(tokens, at) == "?"
                    && !matches!(text_at(tokens, at + 1), "?" | ".")
                    && at
                        .checked_sub(1)
                        .is_none_or(|before| text_at(tokens, before) != "?")
            };
            let Some((start, _)) = top.iter().find(|(at, _)| question(*at)) else {
                return Vec::new();
            };
            let mut nested = 0;
            let end = top.iter().find_map(|(at, token)| {
                if at <= start {
                    return None;
                }
                if question(*at) {
                    nested += 1;
                }
                if token.text == ":" {
                    if nested == 0 {
                        return Some(*at);
                    }
                    nested -= 1;
                }
                None
            });
            end.map(|end| (&tokens[start + 1..end], &tokens[end + 1..]))
        }
        Language::Kotlin if text_at(tokens, 0) == "if" && text_at(tokens, 1) == "(" => {
            let Some((condition_end, _)) = top.iter().find(|(_, token)| token.text == ")") else {
                return Vec::new();
            };
            let mut nested = 0;
            let end = top.iter().find_map(|(at, token)| {
                if at <= condition_end {
                    return None;
                }
                if token.text == "if" {
                    nested += 1;
                }
                if token.text == "else" {
                    if nested == 0 {
                        return Some(*at);
                    }
                    nested -= 1;
                }
                None
            });
            end.map(|end| (&tokens[condition_end + 1..end], &tokens[end + 1..]))
        }
        Language::Kotlin => None,
    };
    branches.map_or_else(Vec::new, |(yes, no)| {
        let mut result = role_literals(yes, language);
        result.extend(role_literals(no, language));
        result
    })
}

fn text_at<'a>(tokens: &'a [Token<'_>], at: usize) -> &'a str {
    tokens.get(at).map_or("", |token| token.text)
}

fn literal(text: &str, language: Language) -> Option<String> {
    let hashes = text.bytes().take_while(|byte| *byte == b'#').count();
    let quote = if text.get(hashes..)?.starts_with("\"\"\"") {
        "\"\"\""
    } else {
        "\""
    };
    let inside = text
        .strip_prefix(&format!("{}{quote}", "#".repeat(hashes)))?
        .strip_suffix(&format!("{quote}{}", "#".repeat(hashes)))?;
    let interpolation = match language {
        Language::Swift => format!("\\{}(", "#".repeat(hashes)),
        Language::Kotlin => "$".to_owned(),
    };
    if inside.contains(&interpolation) {
        return None;
    }
    if hashes > 0 || quote.len() == 3 {
        return Some(inside.to_owned());
    }
    serde_json::from_str(text).ok()
}

/// Tiny lexer for call sites, not a Swift/Kotlin parser. Keeping each literal as
/// one token prevents quoted code examples from becoming fictitious references.
fn lex(source: &str, language: Language) -> Vec<Token<'_>> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut at = 0;
    let mut line = 1;
    while at < bytes.len() {
        let start = at;
        let rest = &bytes[at..];
        let skip = if rest.starts_with(b"//") {
            at += rest
                .iter()
                .position(|byte| *byte == b'\n')
                .unwrap_or(rest.len());
            true
        } else if rest.starts_with(b"/*") {
            at += 2;
            let mut depth = 1;
            while at < bytes.len() && depth > 0 {
                if bytes[at..].starts_with(b"/*") {
                    depth += 1;
                    at += 2;
                } else if bytes[at..].starts_with(b"*/") {
                    depth -= 1;
                    at += 2;
                } else {
                    at += 1;
                }
            }
            true
        } else if bytes[at].is_ascii_whitespace() {
            at += 1;
            true
        } else {
            let hashes = rest.iter().take_while(|byte| **byte == b'#').count();
            if rest.get(hashes) == Some(&b'"') {
                let width = if rest[hashes..].starts_with(b"\"\"\"") {
                    3
                } else {
                    1
                };
                let close = format!("{}{}", "\"".repeat(width), "#".repeat(hashes));
                let escape = format!("\\{}", "#".repeat(hashes));
                at += hashes + width;
                while at < bytes.len() {
                    if bytes[at..].starts_with(close.as_bytes()) {
                        at += close.len();
                        break;
                    }
                    if !(matches!(language, Language::Kotlin) && width == 3)
                        && bytes[at..].starts_with(escape.as_bytes())
                    {
                        at = (at + escape.len() + 1).min(bytes.len());
                    } else {
                        at += 1;
                    }
                }
            } else if rest[0].is_ascii_alphabetic() || rest[0] == b'_' {
                at += rest
                    .iter()
                    .take_while(|byte| byte.is_ascii_alphanumeric() || **byte == b'_')
                    .count();
            } else if rest[0] == b'\'' {
                at += 1;
                while at < bytes.len() {
                    let byte = bytes[at];
                    at = (at + if byte == b'\\' { 2 } else { 1 }).min(bytes.len());
                    if byte == b'\'' || byte == b'\n' {
                        break;
                    }
                }
            } else {
                at += source[at..].chars().next().map_or(1, char::len_utf8);
            }
            false
        };
        if !skip {
            tokens.push(Token {
                text: &source[start..at],
                line,
            });
        }
        line += bytes[start..at]
            .iter()
            .filter(|byte| **byte == b'\n')
            .count();
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN_SOURCE: &str = include_str!("../../../../design/tokens.toml");

    fn write(root: &Path, path: &str, source: &str) -> Result<()> {
        let path = root.join(path);
        fs::create_dir_all(path.parent().context("fixture parent")?)?;
        fs::write(path, source)?;
        Ok(())
    }

    #[test]
    fn rejects_runtime_crash_roles_on_both_platforms_with_file_and_line() -> Result<()> {
        let tree = tempfile::tempdir()?;
        write(
            tree.path(),
            "mobile/iosApp/Sources/View.swift",
            "Text(value)\n .centraidType(\"meta\")\n .foregroundStyle(Theme.color(\"bgRaised\", scheme))",
        )?;
        write(
            tree.path(),
            "mobile/androidApp/src/main/kotlin/View.kt",
            "centraidType(role = \"section\")\ncentraidColor(\"bgRaised\")",
        )?;
        let values: Tokens = toml::from_str(TOKEN_SOURCE)?;
        let error = validate(tree.path(), &values)
            .expect_err("unknown roles must fail")
            .to_string();
        for expected in [
            "View.swift:2: unknown typography role \"meta\"",
            "View.swift:3: unknown color role \"bgRaised\"",
            "View.kt:1: unknown typography role \"section\"",
            "View.kt:2: unknown color role \"bgRaised\"",
        ] {
            assert!(error.contains(expected), "{error}");
        }
        Ok(())
    }

    #[test]
    fn follows_source_roles_and_checks_widgets_without_checking_generated_protocols() -> Result<()>
    {
        let tree = tempfile::tempdir()?;
        let source = format!(
            "{TOKEN_SOURCE}\n[type.fixtureRole]\nfamily = \"sans\"\nsize = 13\nline_height = 16\nweight = 400\n"
        );
        let values: Tokens = toml::from_str(&source)?;
        values.validate()?;
        write(
            tree.path(),
            "mobile/iosApp/AgendaWidget/Widget.swift",
            ".centraidType(\"fixtureRole\")\nTheme.color(\"agendaText\", scheme)",
        )?;
        write(
            tree.path(),
            "mobile/iosApp/WidgetShared/Shared.swift",
            "Theme.uiFont(\"body\", scheme, size)",
        )?;
        write(
            tree.path(),
            "mobile/iosApp/Sources/Generated/Protocol.swift",
            ".centraidType(\"not-a-role\")",
        )?;
        write(
            tree.path(),
            "mobile/androidApp/src/main/kotlin/View.kt",
            "centraidType(\"body\")\ncentraidColor(\"bgElev\")\ncentraidColor(\"listRaspberry\")",
        )?;
        validate(tree.path(), &values)?;
        let original: Tokens = toml::from_str(TOKEN_SOURCE)?;
        let error = validate(tree.path(), &original)
            .expect_err("removed token must fail")
            .to_string();
        assert!(
            error.contains("AgendaWidget/Widget.swift:1: unknown typography role \"fixtureRole\""),
            "{error}"
        );
        Ok(())
    }

    #[test]
    fn recognizes_helpers_multiline_named_and_raw_literals_without_comment_false_positives() {
        let source = r####"
// centraidType("line-comment")
/* Theme.color("block-comment", scheme) /* centraidType("nested") */ */
let example = "centraidType(\"quoted-code\")"
let rawExample = #"Theme.color("raw-code", scheme)"#
let tripleExample = """centraidType("triple-code")"""
let quote = '"'
not_centraidType("another-function")
Theme.other("another-method")
centraidType(dynamicRole)
centraidType(flag ? firstRole : otherRole)
centraidType("prefix" + suffix)
centraidType("\(dynamicRole)")
Theme /* nested /* comment */ */ . uiFont(
  "small", scheme, size)
Theme.style("body", scheme)
Theme.font("title", scheme)
Theme.baseFont("reading", scheme)
Theme.resolve("control", scheme, size)
centraidType(role: "labelOn")
centraidType(#"mono"#)
Theme.color("text", scheme)
"####;
        let found = references(source, Language::Swift);
        assert_eq!(
            found
                .iter()
                .map(|(kind, value, _)| (*kind, value.as_str()))
                .collect::<Vec<_>>(),
            [
                (Kind::Type, "small"),
                (Kind::Type, "body"),
                (Kind::Type, "title"),
                (Kind::Type, "reading"),
                (Kind::Type, "control"),
                (Kind::Type, "labelOn"),
                (Kind::Type, "mono"),
                (Kind::Color, "text"),
            ]
        );
        assert_eq!(found[0].2, 15);
        assert_eq!(
            references(
                r#"centraidType(role = "small")
centraidColor(
    role = "agendaText")
centraidType("$dynamicRole")
centraidType("${dynamicRole}")
centraidType("""mono""")"#,
                Language::Kotlin
            )
            .iter()
            .map(|(kind, value, _)| (*kind, value.as_str()))
            .collect::<Vec<_>>(),
            [
                (Kind::Type, "small"),
                (Kind::Color, "agendaText"),
                (Kind::Type, "mono"),
            ]
        );
    }

    #[test]
    fn checks_conditional_results_without_treating_comparisons_as_roles() -> Result<()> {
        let tree = tempfile::tempdir()?;
        write(
            tree.path(),
            "mobile/iosApp/Sources/View.swift",
            r#"
Theme.color(operation == "Download" ? "errorFill" : "bgElev", scheme)
Theme.color(kind == "delete" ? "dangerFill" : "text", scheme)
Theme.color(onPage ? (selected ? "text" : "textSoft") : "onStage", scheme)
Theme.color(dynamic?.role ?? fallback, scheme)
.centraidType(flag ? "section" : dynamicRole)
"#,
        )?;
        write(
            tree.path(),
            "mobile/androidApp/src/main/kotlin/View.kt",
            r#"
centraidColor(if (operation == "Download") "errorFill" else "bgElev")
centraidColor(if (kind == "delete") "dangerFill" else "text")
centraidColor(if (onPage) "text" else if (selected) "textSoft" else "onStage")
centraidType(scales = false, role = if (flag) "section" else dynamicRole)
"#,
        )?;
        let values: Tokens = toml::from_str(TOKEN_SOURCE)?;
        let error = validate(tree.path(), &values)
            .expect_err("bad result literals must fail")
            .to_string();
        assert_eq!(
            error.matches("unknown color role \"errorFill\"").count(),
            2,
            "{error}"
        );
        assert_eq!(
            error.matches("unknown typography role \"section\"").count(),
            2,
            "{error}"
        );
        assert_eq!(error.lines().count(), 5, "{error}");
        Ok(())
    }

    #[test]
    fn design_generation_and_check_reject_bad_roles_before_writing_artifacts() -> Result<()> {
        let tree = tempfile::tempdir()?;
        write(tree.path(), "design/tokens.toml", TOKEN_SOURCE)?;
        write(
            tree.path(),
            "mobile/iosApp/Sources/View.swift",
            ".centraidType(\"meta\")",
        )?;
        for check in [false, true] {
            let error = super::super::generate(tree.path(), check)
                .expect_err("role validation precedes output")
                .to_string();
            assert!(
                error.contains("unknown typography role \"meta\""),
                "{error}"
            );
        }
        assert!(!tree.path().join("mobile/iosApp/Design").exists());
        Ok(())
    }
}
